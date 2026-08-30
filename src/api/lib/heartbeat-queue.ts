/**
 * Heartbeat coalescing: turn 67 writes a second into one write every 5 seconds.
 *
 * WHY
 * ---
 * Every running client pings `POST /student/heartbeat/:examId` about every 15s so
 * the Live Monitor can show an online/offline dot. At 1000 concurrent students
 * that is ~67 requests a second, and each one used to be a WRITE:
 *
 *     UPDATE attempts SET last_seen_at = ? WHERE exam_id = ? AND student_id = ?
 *
 * The endpoint was already down to a single round trip (the exam row comes from a
 * 3s coalesced cache and the UPDATE ... RETURNING doubled as the attempt read), so
 * what is left is the *kind* of round trip. Writes are the scarce resource here on
 * two counts: the plan's write quota is 100x smaller than the read quota
 * (25M/month vs 2.5B), and Turso/SQLite serializes writers — every heartbeat write
 * queues behind every submit, autosave and grade write happening at the same time.
 *
 * `last_seen_at` is the cheapest possible thing to make durable: it is presence,
 * not evidence. Losing a few seconds of it costs nothing (the worst case is a dot
 * in the monitor going grey a moment late), and it is rewritten from scratch 4
 * times a minute per student. So the heartbeat route now does a narrow READ and
 * hands the timestamp to this module, which folds every student's pings into ONE
 * batched UPDATE every `HEARTBEAT_FLUSH_MS`. 67 writes/s becomes ~0.2/s.
 *
 * STALENESS BUDGET — read this before changing the flush period
 * -------------------------------------------------------------
 * The Live Monitor calls an attempt online when `last_seen_at` is within 40s.
 * Worst case staleness in the database is heartbeat interval (15s) + flush period
 * (5s) = 20s, and 25s if one flush fails and lands on the next tick. Both are
 * comfortably inside 40s, which is why the monitor's threshold did NOT have to
 * change. Widening this period eats that margin: at 10s the worst case is 25s
 * (35s after a retry) and the monitor starts calling live students offline.
 * Separately, the monitor overlays `peekSeen()` on top of what it reads, so within
 * one process it actually sees zero staleness.
 *
 * MONOTONIC GUARD
 * ---------------
 * Other paths still write `last_seen_at` directly and must keep doing so — the
 * autosave endpoint writes it together with `answeredCount` (it needs the write
 * anyway), and /start, resume and pause stamp it. A pending heartbeat is by
 * definition older than a write that happens after it, so the flush writes
 * `MAX(COALESCE(last_seen_at, 0), <coalesced>)`: it can move presence forward,
 * never backwards. Without this, a flush landing 3s after an autosave would drag
 * `last_seen_at` back to the older heartbeat.
 *
 * State is per process and deliberately not durable. On a restart the map is lost
 * and every client re-pings within 15s. Nothing here touches Hono, and every
 * function takes the database as a parameter (never the app singleton) so the
 * tests can drive the real SQL against in-memory libSQL.
 */
import { inArray, sql as dsql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/libsql";
import * as schema from "../database/schema";

/** Any Drizzle libSQL handle over our schema — the app singleton or a test one. */
export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** How often pending heartbeats are written. See the staleness budget above. */
export const HEARTBEAT_FLUSH_MS = 5_000;

/**
 * Attempts per UPDATE statement. Each id appears twice in the CASE plus once in
 * the IN list, so 200 ids is ~600 bound parameters — well under SQLite's default
 * cap of 999 and small enough that one failed chunk loses little.
 */
export const HEARTBEAT_FLUSH_CHUNK = 200;

export class HeartbeatQueue {
	/** attemptId -> latest heartbeat instant not yet written. */
	private readonly pending = new Map<string, number>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private flushing = false;

	/** Coalesced writes performed / entries folded away, for /api/health. */
	private stats = { flushes: 0, rows: 0, coalesced: 0, failures: 0 };

	/**
	 * Record a heartbeat. Keeps the LATEST instant per attempt: a student pinging
	 * twice inside one flush window costs one write, and out-of-order arrivals
	 * (retry after a slow request) cannot move presence backwards.
	 */
	markSeen(attemptId: string, atMs: number): void {
		const prev = this.pending.get(attemptId);
		if (prev !== undefined) {
			this.stats.coalesced++;
			if (prev >= atMs) return;
		}
		this.pending.set(attemptId, atMs);
	}

	/**
	 * The pending instant for an attempt, if any. The Live Monitor overlays this
	 * on the `last_seen_at` it read, so a heartbeat that has not been flushed yet
	 * still shows the student as online.
	 */
	peekSeen(attemptId: string): number | undefined {
		return this.pending.get(attemptId);
	}

	/** Number of attempts with an unwritten heartbeat (≈ concurrent students). */
	pendingCount(): number {
		return this.pending.size;
	}

	/** Drain the map. The caller owns the entries and must re-merge on failure. */
	takePending(): Map<string, number> {
		const taken = new Map(this.pending);
		this.pending.clear();
		return taken;
	}

	/**
	 * Put entries back after a failed write, keeping whichever instant is newer —
	 * a heartbeat that arrived while the flush was in flight is fresher than the
	 * one being returned and must win.
	 */
	mergePending(entries: Iterable<[string, number]>): void {
		for (const [attemptId, atMs] of entries) this.markSeen(attemptId, atMs);
	}

	snapshot(): { pending: number } & typeof this.stats {
		return { pending: this.pending.size, ...this.stats };
	}

	/**
	 * Write every pending heartbeat in batches and return how many attempts were
	 * stamped. Non-throwing: on failure the chunk goes back into the map so the
	 * next tick retries it, because presence lost is a monitor dot that lies.
	 */
	async flushSeen(db: Db): Promise<number> {
		if (this.pending.size === 0) return 0;
		const taken = this.takePending();
		const entries = [...taken];
		let written = 0;
		for (let i = 0; i < entries.length; i += HEARTBEAT_FLUSH_CHUNK) {
			const chunk = entries.slice(i, i + HEARTBEAT_FLUSH_CHUNK);
			try {
				await db
					.update(schema.attempts)
					.set({ lastSeenAt: lastSeenExpression(chunk) })
					.where(
						inArray(
							schema.attempts.id,
							chunk.map(([attemptId]) => attemptId),
						),
					);
				written += chunk.length;
			} catch (err) {
				this.stats.failures++;
				this.mergePending(chunk);
				console.error(`[heartbeat] flush of ${chunk.length} attempt(s) failed, will retry`, err);
			}
		}
		this.stats.flushes++;
		this.stats.rows += written;
		return written;
	}

	/**
	 * Start the periodic flusher. MUST run on every process that serves student
	 * traffic — heartbeats arrive on the web process, so unlike grading this is
	 * not `ROLE`-gated background work. Idempotent, and unref'd so it never holds
	 * the process open. Ticks are skipped while a flush is still in flight rather
	 * than stacking writes on a slow database.
	 */
	start(db: Db, periodMs = HEARTBEAT_FLUSH_MS): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			if (this.flushing) return;
			this.flushing = true;
			void this.flushSeen(db).finally(() => {
				this.flushing = false;
			});
		}, periodMs);
		this.timer.unref?.();
	}

	/** Stop the flusher and write whatever is pending (best effort, on shutdown). */
	async stop(db: Db): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		await this.flushSeen(db).catch(() => 0);
	}
}

/**
 * `last_seen_at = MAX(COALESCE(last_seen_at, 0), CASE id WHEN … THEN … END)`.
 *
 * One statement for the whole chunk. SQLite's two-argument `max()` is the scalar
 * function, not the aggregate, so this is a plain per-row comparison — see the
 * MONOTONIC GUARD note above for why it is there. The CASE is exhaustive over the
 * ids in the WHERE clause, so no row can match with a NULL branch.
 */
export function lastSeenExpression(entries: [string, number][]) {
	const cases = entries.map(([attemptId, atMs]) => dsql`when ${attemptId} then ${atMs}`);
	return dsql`max(coalesce(${schema.attempts.lastSeenAt}, 0), case ${schema.attempts.id} ${dsql.join(cases, dsql` `)} end)`;
}

/**
 * The process-wide queue. The heartbeat route and the Live Monitor read the same
 * instance, which is what makes the monitor's overlay exact.
 */
export const heartbeats = new HeartbeatQueue();
