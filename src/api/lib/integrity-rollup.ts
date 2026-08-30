/**
 * Per-attempt proctoring evidence for the Live Monitor, read incrementally.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Live Monitor shows, per student, a violation count and the newest webcam
 * thumbnail. Both used to be recomputed from scratch on every snapshot build:
 *
 *   SELECT attempt_id, COUNT(*) … WHERE exam_id = ? AND type NOT IN (…)  GROUP BY attempt_id
 *   ROW_NUMBER() OVER (PARTITION BY attempt_id ORDER BY at DESC) … WHERE photo_url IS NOT NULL
 *
 * Those are already grouped in SQLite (an earlier fix — they used to ship every
 * row to JS), but they still *touch every integrity_events row of every engaged
 * attempt, every time*. A 90-minute exam leaves a snapshot roughly every 27s per
 * student, so one exam accumulates tens of thousands of rows — "Elite Assessment
 * – 1" held 27,153 — and the monitor rebuilds at most every 3s while an admin has
 * the page open. The read cost therefore grows with EXAM DURATION multiplied by
 * WATCH TIME, which is the worst possible shape: the longer you watch, the more
 * each look costs, and the second half of every exam is more expensive than the
 * first. The photo query is worse than the count: `photo_url IS NOT NULL` matches
 * no index, so it reads full rows (photo keys are ~60 bytes of text each) and then
 * sorts them.
 *
 * THE FIX: read each event row ONCE, ever.
 * Evidence is monotonic — a violation never un-happens and a snapshot never
 * un-arrives — so the aggregate can be carried forward and only the rows that
 * appeared since the last build need reading. `integrity_events` is a rowid table
 * and rowids are assigned increasing, so `rowid` is a natural insert watermark:
 *
 *   build 1:  full aggregate  (rowid <= W)                 → cursor = W
 *   build 2:  only rowid in (W, W']                        → cursor = W'
 *
 * At 200 students flushing every 10s, a 3s tail is ~60 rows instead of ~27,000.
 *
 * WHY A WATERMARK AND NOT AN IN-PROCESS COUNTER. The events are written by the
 * student POST path, which may be a different process than the one serving the
 * monitor. Reading the tail out of the database keeps this EXACT across processes
 * — anything any process inserted is in the tail — whereas an in-memory counter
 * fed by the writer would silently under-report on a split deploy. The cache
 * holds only the aggregate, never the authority.
 *
 * THE ONE UNSAFE DIRECTION: DELETES. SQLite reuses rowids below the maximum after
 * the top row is deleted, and several admin paths delete an attempt's events
 * (student delete, roster removal, mark-absent, reset). A reused rowid could land
 * *below* the cursor and never be read. So every one of those paths calls
 * `integrityRollup.invalidateAll()`, and `FULL_REBUILD_MS` forces a from-scratch
 * rebuild every 10 minutes regardless, so any drift is bounded and self-healing.
 * Deletes are rare and admin-driven; a full rebuild there costs nothing.
 *
 * Takes `db` as a parameter and never imports the app singleton, so tests drive
 * the real SQL against in-memory libSQL.
 */
import { sql as dsql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/libsql";
import type * as schema from "../database/schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** What the monitor renders per attempt. */
export type AttemptEvidence = {
  /** Events that count as misconduct — NON_VIOLATION_TYPES excluded. */
  violations: number;
  /** Object key of the newest snapshot, or null when the camera produced none. */
  lastKey: string | null;
  /** `at` of that snapshot, in ms. Only used to decide which snapshot is newest. */
  lastAtMs: number;
};

export const EMPTY_EVIDENCE: AttemptEvidence = Object.freeze({ violations: 0, lastKey: null, lastAtMs: 0 });

/** Rebuild from scratch at least this often, so delete-induced drift cannot persist. */
export const FULL_REBUILD_MS = 10 * 60_000;

/** Forget an exam nobody has looked at for this long. */
export const EXAM_IDLE_MS = 30 * 60_000;

type EventRow = { attemptId: string; type: string; photoUrl: string | null; atMs: number };

/**
 * Fold event rows into per-attempt evidence. Used by the incremental path and, in
 * tests, as the oracle the SQL is compared against.
 *
 * Newest-snapshot rule: `atMs >= lastAtMs` — later-inserted rows win ties, which
 * is what the original `ORDER BY at DESC, rowid DESC` did. Non-violation types
 * (timed frames, `snapshot_failed`, `focus_loss`, …) are evidence, not misconduct:
 * they must not touch the count, but they DO feed the thumbnail.
 */
export function applyEvents(into: Map<string, AttemptEvidence>, rows: EventRow[], nonViolation: ReadonlySet<string>): void {
  for (const r of rows) {
    const cur = into.get(r.attemptId) ?? { violations: 0, lastKey: null, lastAtMs: 0 };
    if (!nonViolation.has(r.type)) cur.violations += 1;
    const key = (r.photoUrl ?? "").trim();
    if (key && r.atMs >= cur.lastAtMs) {
      cur.lastKey = key;
      cur.lastAtMs = r.atMs;
    }
    into.set(r.attemptId, cur);
  }
}

type ExamState = { cursor: number; builtAtMs: number; touchedAtMs: number; byAttempt: Map<string, AttemptEvidence> };

export class IntegrityRollup {
  private exams = new Map<string, ExamState>();

  /** Per-exam evidence. Reads only the rows inserted since the previous call. */
  async load(db: Db, examId: string, nonViolation: ReadonlySet<string>, nowMs = Date.now()): Promise<Map<string, AttemptEvidence>> {
    this.prune(nowMs);
    const prev = this.exams.get(examId);
    const stale = !prev || nowMs - prev.builtAtMs >= FULL_REBUILD_MS;

    // Pin the watermark BEFORE aggregating. Rows inserted while these statements
    // run are above it and get picked up by the next tail read — never dropped,
    // never counted twice.
    const [head] = await db.all<{ maxRowid: number | null }>(
      dsql`select max(rowid) as maxRowid from integrity_events`,
    );
    const watermark = Number(head?.maxRowid ?? 0) || 0;

    const byAttempt = stale ? new Map<string, AttemptEvidence>() : new Map(prev!.byAttempt);
    const from = stale ? 0 : prev!.cursor;

    if (watermark > from) {
      const rows = await db.all<{ attemptId: string; type: string; photoUrl: string | null; at: number }>(dsql`
        SELECT ie.attempt_id AS attemptId, ie.type AS type, ie.photo_url AS photoUrl, ie.at AS at
        FROM integrity_events ie
        JOIN attempts a ON a.id = ie.attempt_id
        WHERE a.exam_id = ${examId}
          AND a.status <> 'not_started'
          AND ie.rowid > ${from}
          AND ie.rowid <= ${watermark}
      `);
      applyEvents(
        byAttempt,
        rows.map((r) => ({ attemptId: r.attemptId, type: r.type, photoUrl: r.photoUrl, atMs: Number(r.at) || 0 })),
        nonViolation,
      );
    }

    this.exams.set(examId, {
      cursor: Math.max(watermark, from),
      builtAtMs: stale ? nowMs : prev!.builtAtMs,
      touchedAtMs: nowMs,
      byAttempt,
    });
    return byAttempt;
  }

  /**
   * Drop everything, forcing a full rebuild on the next load. Called by the admin
   * paths that DELETE integrity events — see the header on rowid reuse.
   */
  invalidateAll(): void {
    this.exams.clear();
  }

  /** Test/inspection helper: cursor and size per exam, no event data. */
  snapshot(): { examId: string; cursor: number; attempts: number; builtAtMs: number }[] {
    return [...this.exams].map(([examId, s]) => ({ examId, cursor: s.cursor, attempts: s.byAttempt.size, builtAtMs: s.builtAtMs }));
  }

  private prune(nowMs: number): void {
    for (const [examId, s] of this.exams) {
      if (nowMs - s.touchedAtMs >= EXAM_IDLE_MS) this.exams.delete(examId);
    }
  }
}

/** Process-wide instance. The monitor is the only reader. */
export const integrityRollup = new IntegrityRollup();
