/**
 * Durable grading queue: the persistence layer for background AI grading.
 *
 * WHY
 * ---
 * Scheduling used to live entirely in this process — an in-flight `Set`, a
 * `retryCounts` Map and `setTimeout` backoff (see grade-queue.ts). Three
 * consequences, all of them real:
 *
 *  1. A deploy mid-batch dropped the schedule. The recovery sweep found the work
 *     again, but the retry counter reset to zero on every restart, so an answer
 *     the AI could never grade was retried forever — and billed forever.
 *  2. It cannot be run on more than one process. The concurrency cap and the
 *     in-flight set are per process, so N replicas each sweep the same
 *     `submitted` attempts and grade them N times, concurrently, into the same
 *     answer rows. That is what blocks horizontal scaling.
 *  3. A give-up was a `console.error`. No admin could ever find the students
 *     whose answers were zeroed for manual review.
 *
 * A row per attempt fixes all three. Every function here takes the database as a
 * parameter (never the app's `db` singleton) so the tests can drive the exact same
 * code against in-memory libSQL.
 *
 * CONCURRENCY MODEL — read this before changing claimGradeJobs
 * ------------------------------------------------------------
 * There is no row-level locking here and no MVCC. Exclusivity comes from SQLite's
 * (and Turso's) SINGLE WRITER: write statements against a database are serialized,
 * so two workers issuing the identical claim UPDATE cannot interleave. The first
 * flips the rows to `claimed`; the second runs afterwards, its subquery re-reads
 * the table and those rows no longer match `status = 'pending'`, so it claims a
 * different set (or nothing). The `RETURNING` clause is what tells each worker
 * which rows it actually got — never assume the rows you selected are the rows you
 * won.
 */
import { and, eq, inArray, notInArray, or, sql as dsql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/libsql";
import * as schema from "../database/schema";
import { id } from "./util";

/** Any Drizzle libSQL handle over our schema — the app singleton or a test one. */
export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Bounded retries per attempt before we give up and flag for manual review. */
export const MAX_GRADE_TRIES = 3;

/**
 * How long a claim is honoured before another worker may steal it back.
 *
 * This is the crash story: a worker that claims 12 jobs and is then killed
 * mid-grade (deploy, OOM, Railway moving the container) leaves those rows
 * `claimed` forever. The lease turns "claimed" into "claimed until", so the work
 * is recovered instead of stuck. Must be comfortably longer than the slowest
 * realistic grading pass for one attempt — ~20 subjective answers at ~5s each
 * through the concurrency limiter — or a healthy worker's own jobs get stolen
 * while it is still grading them, and we pay the provider twice.
 */
export const CLAIM_LEASE_MS = 5 * 60_000;

/** Exponential-ish backoff, capped. Mirrors the delay the in-memory retry used. */
export function backoffMs(tries: number): number {
  return Math.min(120_000, 20_000 * Math.max(1, tries));
}

export type GradeJob = {
  id: string;
  attemptId: string;
  examId: string;
  tries: number;
};

/**
 * Record that an attempt needs background grading. Called on the submit path, so
 * it is exactly ONE statement (submit goes from 7 round trips to 8).
 *
 * Idempotent on `attempt_id` via `grade_jobs_attempt_uq`: a re-submit after a
 * reopen converges on the same row rather than queueing the attempt twice.
 *
 * The conflict clause deliberately does NOT reset `tries` in general. Resetting it
 * unconditionally would reopen the retry-forever hole — a submit path that keeps
 * being re-entered would keep clearing the counter and we would keep paying the AI
 * provider for an answer it can never grade. Never resetting it would be just as
 * wrong the other way: an attempt legitimately reopened and re-sat weeks later
 * would inherit an exhausted counter and hit the cap immediately. So: reset only
 * when the previous job already finished (`status = 'done'`), which is precisely
 * the "this is new work, not a retry" case.
 */
export async function enqueueGradeJob(
  db: Db,
  args: { attemptId: string; examId: string; delayMs?: number; now?: number },
): Promise<void> {
  const nowMs = args.now ?? Date.now();
  const runAt = new Date(nowMs + (args.delayMs ?? 0));
  await db
    .insert(schema.gradeJobs)
    .values({
      id: id("gjob"),
      attemptId: args.attemptId,
      examId: args.examId,
      status: "pending",
      tries: 0,
      nextRunAt: runAt,
      claimedAt: null,
      claimedBy: null,
      lastError: null,
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .onConflictDoUpdate({
      target: schema.gradeJobs.attemptId,
      set: {
        status: "pending",
        nextRunAt: dsql`excluded.next_run_at`,
        claimedAt: null,
        claimedBy: null,
        lastError: null,
        // See the note above: only a finished job's counter is cleared.
        tries: dsql`CASE WHEN ${schema.gradeJobs.status} = 'done' THEN 0 ELSE ${schema.gradeJobs.tries} END`,
        updatedAt: dsql`excluded.updated_at`,
      },
    });
}

/**
 * Atomically take up to `limit` due jobs for this worker.
 *
 * Claims two kinds of row:
 *  - `pending` and due (`next_run_at <= now`) — normal work and retries.
 *  - `claimed` past its lease — work orphaned by a worker that died mid-grade.
 *
 * Returns only the rows this worker actually won (see the concurrency note at the
 * top of the file). A competing worker running the identical statement gets a
 * disjoint set, so an attempt is never graded twice concurrently.
 */
export async function claimGradeJobs(
  db: Db,
  args: { workerId: string; limit: number; now?: number; leaseMs?: number },
): Promise<GradeJob[]> {
  const nowMs = args.now ?? Date.now();
  const leaseCutoff = nowMs - (args.leaseMs ?? CLAIM_LEASE_MS);
  const rows = await db.all<{ id: string; attempt_id: string; exam_id: string; tries: number }>(
    dsql`UPDATE grade_jobs
           SET status = 'claimed', claimed_by = ${args.workerId}, claimed_at = ${nowMs}, updated_at = ${nowMs}
         WHERE id IN (
           SELECT id FROM grade_jobs
            WHERE (status = 'pending' AND next_run_at <= ${nowMs})
               OR (status = 'claimed' AND claimed_at <= ${leaseCutoff})
            ORDER BY next_run_at
            LIMIT ${args.limit}
         )
         RETURNING id, attempt_id, exam_id, tries`,
  );
  return rows.map((r) => ({ id: r.id, attemptId: r.attempt_id, examId: r.exam_id, tries: Number(r.tries ?? 0) }));
}

/** Mark a job finished. Terminal: nothing re-claims a `done` row. */
export async function completeGradeJob(db: Db, jobId: string, now?: number): Promise<void> {
  const nowMs = now ?? Date.now();
  await db
    .update(schema.gradeJobs)
    .set({ status: "done", claimedBy: null, claimedAt: null, lastError: null, updatedAt: new Date(nowMs) })
    .where(eq(schema.gradeJobs.id, jobId));
}

/**
 * Mark an attempt's job finished by attempt id.
 *
 * Used by the submit path, which grades immediately and therefore often finishes
 * the work before any worker claims the row. No-op when there is no job row.
 */
export async function completeGradeJobByAttempt(db: Db, attemptId: string, now?: number): Promise<void> {
  const nowMs = now ?? Date.now();
  await db
    .update(schema.gradeJobs)
    .set({ status: "done", claimedBy: null, claimedAt: null, lastError: null, updatedAt: new Date(nowMs) })
    .where(eq(schema.gradeJobs.attemptId, attemptId));
}

/**
 * Record a failed grading pass.
 *
 * The retry decision lives in the ROW, not in a Map and not in a `setTimeout`:
 * `tries` is incremented and `next_run_at` is pushed out by the backoff, so the
 * schedule survives a restart and the counter can no longer be wiped by a deploy.
 * Past the cap the job becomes terminal `failed` with `last_error` kept, which is
 * the first time a give-up leaves anything an admin can query.
 *
 * Returns whether this failure was terminal, so the caller knows to run its
 * give-up path (zero the ungraded answers, flip the attempt to `graded` so
 * students stop polling).
 */
export async function failGradeJob(
  db: Db,
  args: { jobId: string; tries: number; error: string; now?: number; maxTries?: number },
): Promise<{ terminal: boolean; tries: number }> {
  const nowMs = args.now ?? Date.now();
  const tries = args.tries + 1;
  const maxTries = args.maxTries ?? MAX_GRADE_TRIES;
  const terminal = tries >= maxTries;
  await db
    .update(schema.gradeJobs)
    .set({
      status: terminal ? "failed" : "pending",
      tries,
      // A terminal row keeps its next_run_at as-is; nothing reads it again.
      nextRunAt: new Date(nowMs + (terminal ? 0 : backoffMs(tries))),
      claimedAt: null,
      claimedBy: null,
      lastError: args.error.slice(0, 500),
      updatedAt: new Date(nowMs),
    })
    .where(eq(schema.gradeJobs.id, args.jobId));
  return { terminal, tries };
}

/** Queue depth by status, for /api/health and the admin surface. */
export async function countGradeJobs(db: Db): Promise<Record<string, number>> {
  const rows = await db.all<{ status: string; c: number }>(
    dsql`SELECT status, COUNT(*) AS c FROM grade_jobs GROUP BY status`,
  );
  const out: Record<string, number> = { pending: 0, claimed: 0, done: 0, failed: 0 };
  for (const r of rows) out[r.status] = Number(r.c ?? 0);
  return out;
}

/** Terminally failed jobs — the students whose papers need a human. */
export async function listFailedGradeJobs(db: Db, limit = 50) {
  return db
    .select()
    .from(schema.gradeJobs)
    .where(eq(schema.gradeJobs.status, "failed"))
    .orderBy(schema.gradeJobs.updatedAt)
    .limit(limit);
}

/**
 * One bounded pass creating job rows for attempts that were left `submitted`
 * before this table existed (or while it was unavailable).
 *
 * Bounded on purpose: this runs at boot on an exam server, so it must be a fixed,
 * small amount of work rather than "however many rows the incident left behind".
 * Anything beyond the limit is picked up by the next reconcile sweep.
 */
export async function backfillGradeJobs(db: Db, limit = 200): Promise<number> {
  const existing = await db.select({ attemptId: schema.gradeJobs.attemptId }).from(schema.gradeJobs);
  const known = existing.map((e) => e.attemptId);
  const rows = await db
    .select({ id: schema.attempts.id, examId: schema.attempts.examId })
    .from(schema.attempts)
    .where(
      known.length
        ? and(eq(schema.attempts.status, "submitted"), notInArray(schema.attempts.id, known))
        : eq(schema.attempts.status, "submitted"),
    )
    .limit(limit);
  if (!rows.length) return 0;

  const nowMs = Date.now();
  const values = rows.map((r) => ({
    id: id("gjob"),
    attemptId: r.id,
    examId: r.examId,
    status: "pending",
    tries: 0,
    nextRunAt: new Date(nowMs),
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  }));
  // Chunked: libSQL caps bound variables per statement, same reason the answer
  // upsert chunks at 50.
  for (let i = 0; i < values.length; i += 50) {
    await db.insert(schema.gradeJobs).values(values.slice(i, i + 50)).onConflictDoNothing({
      target: schema.gradeJobs.attemptId,
    });
  }
  return values.length;
}

/**
 * Jobs whose attempt no longer needs grading (already `graded`, or reopened to
 * `in_progress`) — closed out so the queue does not carry dead rows forever.
 */
export async function closeStaleGradeJobs(db: Db, limit = 200): Promise<number> {
  const open = await db
    .select({ id: schema.gradeJobs.id, attemptId: schema.gradeJobs.attemptId })
    .from(schema.gradeJobs)
    .where(or(eq(schema.gradeJobs.status, "pending"), eq(schema.gradeJobs.status, "claimed")))
    .limit(limit);
  if (!open.length) return 0;
  const attemptIds = open.map((o) => o.attemptId);
  const live = await db
    .select({ id: schema.attempts.id })
    .from(schema.attempts)
    .where(and(inArray(schema.attempts.id, attemptIds), eq(schema.attempts.status, "submitted")));
  const liveSet = new Set(live.map((l) => l.id));
  const stale = open.filter((o) => !liveSet.has(o.attemptId)).map((o) => o.id);
  if (!stale.length) return 0;
  for (let i = 0; i < stale.length; i += 50) {
    await db
      .update(schema.gradeJobs)
      .set({ status: "done", claimedBy: null, claimedAt: null, updatedAt: new Date() })
      .where(inArray(schema.gradeJobs.id, stale.slice(i, i + 50)));
  }
  return stale.length;
}
