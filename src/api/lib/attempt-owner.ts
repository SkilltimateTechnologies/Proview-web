/**
 * "Does this attempt belong to this student?" — answered without a round trip.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two student proctoring routes authorize the caller and then never look at the
 * attempt again:
 *
 *   POST /student/attempts/:attemptId/events        → only needs `attemptId`
 *   POST /student/attempts/:attemptId/snapshot-url  → only needs `attemptId`
 *
 * Both did this first:
 *
 *   await db.select().from(attempts).where(and(eq(id, aid), eq(studentId, sid))).limit(1)
 *
 * A bare `select()` with no projection, so every column came back — including
 * `section_snapshot` and `option_order`, which are JSON text blobs holding the
 * student's whole paper layout. None of it was read. The row was fetched to
 * decide a single boolean.
 *
 * The volume is the problem, not the row. A webcam frame is captured roughly
 * every 27s per student, and each one costs BOTH routes: one call for the
 * presigned URL, one to attach the event. At 1000 students that is ~74
 * authorization-only SELECTs per second, on the student write path — the path
 * that must stay responsive during an exam and the one whose budget is scarce
 * (25M writes/month vs 2.5B reads). Over a 90-minute exam with 1000 students it
 * is ~400,000 SELECTs that exist purely to re-derive a fact that never changes.
 *
 * WHY CACHING IS SAFE HERE: THE MAPPING IS IMMUTABLE.
 * An attempt's `student_id` is written once at creation and **never updated** —
 * no route, sweep or admin path assigns an existing attempt to a different
 * student. So `attemptId → studentId` cannot go stale in the usual sense. That
 * is what makes this different from caching, say, attempt status, which changes
 * constantly and is deliberately NOT cached here.
 *
 * Note the cache is keyed by attempt and stores the OWNER, not a yes/no per
 * caller. A request from the wrong student is answered `false` from the same
 * cached entry rather than falling through to the database, so a probing client
 * cannot use a mismatch to force round trips.
 *
 * THE ONE UNSAFE DIRECTION: DELETES.
 * If an attempt is deleted, a cached entry would keep authorizing its former
 * owner, and `/events` would then insert `integrity_events` rows pointing at an
 * attempt that no longer exists. Those rows are invisible to every read path
 * (the monitor and the reports join `attempts`), but they are junk in a table
 * that is kept forever by decision. Bounded two ways:
 *
 *   - every admin path that deletes attempts calls `attemptOwners.invalidateAll()`,
 *     the same six places that invalidate the integrity rollup, so in practice
 *     the window is zero;
 *   - `OWNER_TTL_MS` expires entries anyway, so even a delete path added later
 *     and wired up by nobody self-heals within five minutes.
 *
 * Misses are NOT cached. A request for an attempt that does not exist pays its
 * SELECT and 404s every time, exactly as before — caching a negative would mean
 * a freshly created attempt could be rejected, which is far worse than a
 * repeated query on a path that only a broken or deleted client takes.
 *
 * Takes `db` as a parameter and never imports the app singleton, so tests drive
 * the real SQL against in-memory libSQL.
 */
import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/libsql";
import * as schema from "../database/schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * How long an owner lookup is trusted. The mapping itself is immutable, so this
 * is purely the self-healing bound on deletes; invalidation from the admin paths
 * is what actually keeps it correct.
 */
export const OWNER_TTL_MS = 5 * 60_000;

/** Hard ceiling on entries, so a long-running process cannot grow without bound. */
export const MAX_ENTRIES = 20_000;

type Entry = { studentId: string; expiresAtMs: number };

export class AttemptOwnerCache {
  private owners = new Map<string, Entry>();

  /**
   * True when `attemptId` exists and belongs to `studentId`.
   *
   * Hits answer from memory. Misses read ONE column of ONE row by primary key
   * and remember the owner.
   */
  async authorize(db: Db, attemptId: string, studentId: string, nowMs = Date.now()): Promise<boolean> {
    if (!attemptId || !studentId) return false;
    const hit = this.owners.get(attemptId);
    if (hit && hit.expiresAtMs > nowMs) return hit.studentId === studentId;
    if (hit) this.owners.delete(attemptId);

    const [row] = await db
      .select({ studentId: schema.attempts.studentId })
      .from(schema.attempts)
      .where(eq(schema.attempts.id, attemptId))
      .limit(1);
    // Not found: nothing to cache. See the header — negatives are never cached.
    if (!row?.studentId) return false;

    this.prune(nowMs);
    this.owners.set(attemptId, { studentId: row.studentId, expiresAtMs: nowMs + OWNER_TTL_MS });
    return row.studentId === studentId;
  }

  /** Forget one attempt. Called when a specific attempt is deleted or reset. */
  invalidate(attemptId: string): void {
    this.owners.delete(attemptId);
  }

  /** Forget everything. Called by the admin paths that delete attempts in bulk. */
  invalidateAll(): void {
    this.owners.clear();
  }

  /** Test/diagnostic view. */
  size(): number {
    return this.owners.size;
  }

  /**
   * Drop expired entries, and if the map is still at the ceiling drop the
   * oldest-expiring ones. Insertion order is expiry order (TTL is constant), so
   * the first keys are the nearest to expiring.
   */
  private prune(nowMs: number): void {
    for (const [k, v] of this.owners) {
      if (v.expiresAtMs <= nowMs) this.owners.delete(k);
    }
    if (this.owners.size < MAX_ENTRIES) return;
    const drop = this.owners.size - MAX_ENTRIES + 1;
    let i = 0;
    for (const k of this.owners.keys()) {
      if (i++ >= drop) break;
      this.owners.delete(k);
    }
  }
}

/** Process-wide singleton used by the routes. */
export const attemptOwners = new AttemptOwnerCache();
