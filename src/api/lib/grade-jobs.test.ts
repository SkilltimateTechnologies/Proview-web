/**
 * Proves the durable grading queue's claim/retry semantics.
 *
 * Why this file exists: grading used to be scheduled entirely inside one
 * process — an in-flight `Set`, a `retryCounts` Map and `setTimeout` backoff.
 * Two bugs came out of that, and neither is visible in a smoke test:
 *
 *  1. A deploy mid-batch wiped `retryCounts`, so an answer the AI could never
 *     grade was retried forever and billed forever.
 *  2. Nothing stops N processes grading the same attempt. Two replicas each
 *     sweep the same `submitted` attempts, pay the provider twice and write the
 *     same answer rows concurrently.
 *
 * The fix moves the schedule into a `grade_jobs` row, so the things worth
 * testing are exactly the things a row can get wrong: two workers claiming the
 * same job, a lease that never expires (work stuck forever after a crash) or
 * expires too eagerly (double billing), a `tries` counter that resets when it
 * must not, and a give-up that leaves nothing queryable behind.
 *
 * Runs against @libsql/client, NOT the app's `db` singleton — no DATABASE_URL,
 * no network, no fixtures. The concurrency test needs two real connections to
 * one database, so it uses a temp file rather than `:memory:` (each `:memory:`
 * client is its own private database).
 */
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as schema from "../database/schema";
import {
  backfillGradeJobs,
  backoffMs,
  claimGradeJobs,
  closeStaleGradeJobs,
  completeGradeJob,
  completeGradeJobByAttempt,
  countGradeJobs,
  enqueueGradeJob,
  failGradeJob,
  listFailedGradeJobs,
  MAX_GRADE_TRIES,
  type Db,
} from "./grade-jobs";

/** DDL mirroring schema.ts. `grade_jobs_attempt_uq` is what makes enqueue idempotent. */
const DDL = [
  `CREATE TABLE grade_jobs (
     id TEXT PRIMARY KEY,
     attempt_id TEXT NOT NULL,
     exam_id TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     tries INTEGER NOT NULL DEFAULT 0,
     next_run_at INTEGER NOT NULL,
     claimed_at INTEGER,
     claimed_by TEXT,
     last_error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX grade_jobs_attempt_uq ON grade_jobs (attempt_id)`,
  `CREATE INDEX grade_jobs_status_next_idx ON grade_jobs (status, next_run_at)`,
  `CREATE TABLE attempts (
     id TEXT PRIMARY KEY,
     exam_id TEXT NOT NULL,
     student_id TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'not_started',
     score REAL,
     integrity_score REAL,
     started_at INTEGER,
     paused_ms INTEGER NOT NULL DEFAULT 0,
     last_paused_at INTEGER,
     last_seen_at INTEGER,
     answered_count INTEGER NOT NULL DEFAULT 0,
     disconnected INTEGER NOT NULL DEFAULT 0,
     section_snapshot TEXT,
     option_order TEXT,
     submitted_at INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX attempts_exam_student_uq ON attempts (exam_id, student_id)`,
];

let clients: Client[] = [];
let tmpDirs: string[] = [];

async function initSchema(client: Client) {
  for (const stmt of DDL) await client.execute(stmt);
}

async function freshDb(): Promise<Db> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  await initSchema(client);
  return drizzle(client, { schema });
}

/**
 * One database file, two independent connections — the only way to reproduce two
 * replicas racing for the same job.
 */
async function sharedFileDbs(n: number): Promise<Db[]> {
  const dir = mkdtempSync(join(tmpdir(), "gradejobs-"));
  tmpDirs.push(dir);
  const url = `file:${join(dir, "queue.db")}`;
  const out: Db[] = [];
  for (let i = 0; i < n; i++) {
    const client = createClient({ url });
    clients.push(client);
    if (i === 0) await initSchema(client);
    out.push(drizzle(client, { schema }));
  }
  return out;
}

async function seedAttempt(db: Db, i: number, status = "submitted") {
  await db.insert(schema.attempts).values({
    id: `att_${i}`,
    examId: "exm_1",
    studentId: `stu_${i}`,
    status,
    createdAt: new Date(),
  });
}

async function jobRow(db: Db, attemptId: string) {
  const [row] = await db.select().from(schema.gradeJobs).where(eq(schema.gradeJobs.attemptId, attemptId));
  return row;
}

beforeEach(() => {
  clients = [];
  tmpDirs = [];
});
afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe("claim exclusivity", () => {
  test("two claimers on the same database never win the same job", async () => {
    const [a, b] = await sharedFileDbs(2);
    for (let i = 0; i < 10; i++) await enqueueGradeJob(a, { attemptId: `att_${i}`, examId: "exm_1" });

    // Fired together on separate connections. SQLite serializes writers, so one
    // of these runs after the other and its subquery re-reads the table; a BUSY
    // rejection is an acceptable outcome too (that worker simply claims nothing
    // this tick). What is NOT acceptable is the same job id in both results.
    const settled = await Promise.allSettled([
      claimGradeJobs(a, { workerId: "worker-a", limit: 10 }),
      claimGradeJobs(b, { workerId: "worker-b", limit: 10 }),
    ]);
    const won = settled.map((s) => (s.status === "fulfilled" ? s.value.map((j) => j.id) : []));
    const all = [...won[0], ...won[1]];

    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all).size).toBe(all.length); // disjoint: no job claimed twice
    expect(all.length).toBeLessThanOrEqual(10);
    // And nothing is left claimable — every claimed row moved out of `pending`.
    const again = await claimGradeJobs(a, { workerId: "worker-c", limit: 10 });
    expect(again.map((j) => j.id).filter((id) => all.includes(id))).toEqual([]);
  });

  test("a claimed job is not handed out again while its lease is alive", async () => {
    const db = await freshDb();
    await enqueueGradeJob(db, { attemptId: "att_1", examId: "exm_1" });

    const first = await claimGradeJobs(db, { workerId: "worker-a", limit: 5 });
    expect(first).toHaveLength(1);
    const second = await claimGradeJobs(db, { workerId: "worker-b", limit: 5 });
    expect(second).toHaveLength(0);
  });

  test("a job whose lease expired is reclaimed (worker died mid-grade)", async () => {
    const db = await freshDb();
    const t0 = Date.now();
    await enqueueGradeJob(db, { attemptId: "att_1", examId: "exm_1", now: t0 });
    const claimed = await claimGradeJobs(db, { workerId: "dead-worker", limit: 5, now: t0 });
    expect(claimed).toHaveLength(1);

    // Still inside the lease: nobody may steal it, or a healthy worker's own job
    // gets graded twice and billed twice.
    expect(await claimGradeJobs(db, { workerId: "worker-b", limit: 5, now: t0 + 60_000 })).toHaveLength(0);

    // Past the lease: the work is recovered instead of stuck as `claimed` forever.
    const stolen = await claimGradeJobs(db, { workerId: "worker-b", limit: 5, now: t0 + 6 * 60_000 });
    expect(stolen).toHaveLength(1);
    expect(stolen[0]?.id).toBe(claimed[0]!.id);
    expect((await jobRow(db, "att_1"))?.claimedBy).toBe("worker-b");
    // The steal must not consume a retry — the pass never reported a failure.
    expect(stolen[0]?.tries).toBe(0);
  });

  test("done and failed jobs are terminal — nothing reclaims them", async () => {
    const db = await freshDb();
    await enqueueGradeJob(db, { attemptId: "att_1", examId: "exm_1" });
    await enqueueGradeJob(db, { attemptId: "att_2", examId: "exm_1" });
    const jobs = await claimGradeJobs(db, { workerId: "w", limit: 5 });
    expect(jobs).toHaveLength(2);

    await completeGradeJob(db, jobs[0]!.id);
    await failGradeJob(db, { jobId: jobs[1]!.id, tries: MAX_GRADE_TRIES - 1, error: "provider refused" });

    const later = Date.now() + 24 * 60 * 60_000;
    expect(await claimGradeJobs(db, { workerId: "w2", limit: 5, now: later })).toHaveLength(0);
    expect(await countGradeJobs(db)).toEqual({ pending: 0, claimed: 0, done: 1, failed: 1 });
  });
});

describe("retries survive a restart", () => {
  test("backoff and tries live in the row, not in process memory", async () => {
    const db = await freshDb();
    const t0 = Date.now();
    await enqueueGradeJob(db, { attemptId: "att_1", examId: "exm_1", now: t0 });

    const [job] = await claimGradeJobs(db, { workerId: "w", limit: 1, now: t0 });
    const outcome = await failGradeJob(db, { jobId: job!.id, tries: job!.tries, error: "AI rate limited", now: t0 });
    expect(outcome).toEqual({ terminal: false, tries: 1 });

    const row = await jobRow(db, "att_1");
    expect(row?.status).toBe("pending");
    expect(row?.tries).toBe(1);
    expect(row?.claimedBy).toBeNull(); // released, so the retry is claimable
    expect(row?.lastError).toBe("AI rate limited");
    expect(row?.nextRunAt?.getTime()).toBe(t0 + backoffMs(1));

    // A restart is exactly "a brand new process reads this table". Simulated by a
    // fresh Drizzle handle over the same client — no in-process state carried over.
    const restarted = drizzle(clients[0]!, { schema });

    // Before the backoff elapses the retry must NOT run. This is the bug that
    // used to cost money: the old counter reset on boot, so every restart
    // immediately retried an answer that could never be graded.
    expect(await claimGradeJobs(restarted, { workerId: "w-new", limit: 5, now: t0 + 1_000 })).toHaveLength(0);

    const due = await claimGradeJobs(restarted, { workerId: "w-new", limit: 5, now: t0 + backoffMs(1) });
    expect(due).toHaveLength(1);
    expect(due[0]?.tries).toBe(1); // counter carried across the "restart"
  });

  test("the counter is capped: the third failure is terminal and queryable", async () => {
    const db = await freshDb();
    let now = Date.now();
    await enqueueGradeJob(db, { attemptId: "att_1", examId: "exm_1", now });

    const outcomes: Array<{ terminal: boolean; tries: number }> = [];
    for (let pass = 0; pass < MAX_GRADE_TRIES; pass++) {
      const [job] = await claimGradeJobs(db, { workerId: `w${pass}`, limit: 1, now });
      expect(job).toBeDefined();
      const o = await failGradeJob(db, { jobId: job!.id, tries: job!.tries, error: `pass ${pass} failed`, now });
      outcomes.push(o);
      now += backoffMs(o.tries);
    }
    expect(outcomes.map((o) => o.terminal)).toEqual([false, false, true]);
    expect(outcomes.at(-1)?.tries).toBe(MAX_GRADE_TRIES);

    // Never retried again, however long we wait — this is the retry-forever fix.
    expect(await claimGradeJobs(db, { workerId: "w-late", limit: 5, now: now + 7 * 24 * 60 * 60_000 })).toHaveLength(0);

    // And the give-up is no longer just a console.error: the row names the
    // attempt and the reason, so the papers needing a human can be listed.
    const failed = await listFailedGradeJobs(db);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.attemptId).toBe("att_1");
    expect(failed[0]?.lastError).toBe(`pass ${MAX_GRADE_TRIES - 1} failed`);
  });

  test("backoff grows and is capped", () => {
    expect(backoffMs(1)).toBe(20_000);
    expect(backoffMs(2)).toBe(40_000);
    expect(backoffMs(99)).toBe(120_000);
    expect(backoffMs(0)).toBe(20_000); // never schedules a retry in the past
  });
});

describe("enqueue", () => {
  test("is idempotent per attempt — a re-submit does not queue twice", async () => {
    const db = await freshDb();
    await enqueueGradeJob(db, { attemptId: "att_1", examId: "exm_1" });
    await enqueueGradeJob(db, { attemptId: "att_1", examId: "exm_1" });
    await enqueueGradeJob(db, { attemptId: "att_1", examId: "exm_1" });

    const rows = await db.select().from(schema.gradeJobs);
    expect(rows).toHaveLength(1);
    expect(await countGradeJobs(db)).toMatchObject({ pending: 1 });
  });

  test("re-enqueueing an in-flight retry keeps its tries (no counter wipe)", async () => {
    const db = await freshDb();
    const t0 = Date.now();
    await enqueueGradeJob(db, { attemptId: "att_1", examId: "exm_1", now: t0 });
    const [job] = await claimGradeJobs(db, { workerId: "w", limit: 1, now: t0 });
    await failGradeJob(db, { jobId: job!.id, tries: job!.tries, error: "boom", now: t0 });
    expect((await jobRow(db, "att_1"))?.tries).toBe(1);

    // Submit path re-entered (or the worker handed the job back). If this reset
    // `tries` we would be back to retrying an ungradeable answer forever.
    await enqueueGradeJob(db, { attemptId: "att_1", examId: "exm_1", now: t0 + 1_000 });
    const row = await jobRow(db, "att_1");
    expect(row?.tries).toBe(1);
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toBeNull();
  });

  test("re-enqueueing after a completed job resets tries (a genuinely re-sat attempt)", async () => {
    const db = await freshDb();
    const t0 = Date.now();
    await enqueueGradeJob(db, { attemptId: "att_1", examId: "exm_1", now: t0 });
    const [job] = await claimGradeJobs(db, { workerId: "w", limit: 1, now: t0 });
    await failGradeJob(db, { jobId: job!.id, tries: job!.tries, error: "boom", now: t0 });
    await completeGradeJobByAttempt(db, "att_1", t0 + 5_000);
    expect((await jobRow(db, "att_1"))?.status).toBe("done");

    // Attempt reopened and re-sat weeks later: this is new work, not a retry, so
    // it must not inherit an exhausted counter and hit the cap immediately.
    await enqueueGradeJob(db, { attemptId: "att_1", examId: "exm_1", now: t0 + 60_000 });
    const row = await jobRow(db, "att_1");
    expect(row?.status).toBe("pending");
    expect(row?.tries).toBe(0);

    const claimed = await claimGradeJobs(db, { workerId: "w2", limit: 1, now: t0 + 60_000 });
    expect(claimed).toHaveLength(1);
  });

  test("a delay is honoured — a deferred job is not claimable yet", async () => {
    const db = await freshDb();
    const t0 = Date.now();
    await enqueueGradeJob(db, { attemptId: "att_1", examId: "exm_1", delayMs: 30_000, now: t0 });
    expect(await claimGradeJobs(db, { workerId: "w", limit: 5, now: t0 })).toHaveLength(0);
    expect(await claimGradeJobs(db, { workerId: "w", limit: 5, now: t0 + 30_000 })).toHaveLength(1);
  });

  test("completeGradeJobByAttempt is a no-op when the attempt has no job row", async () => {
    const db = await freshDb();
    await completeGradeJobByAttempt(db, "att_missing");
    expect(await db.select().from(schema.gradeJobs)).toHaveLength(0);
  });
});

describe("backfill and reconcile", () => {
  test("adopts submitted attempts that have no job row, and is idempotent", async () => {
    const db = await freshDb();
    for (let i = 0; i < 5; i++) await seedAttempt(db, i, "submitted");
    await seedAttempt(db, 90, "in_progress");
    await seedAttempt(db, 91, "graded");

    expect(await backfillGradeJobs(db)).toBe(5);
    const rows = await db.select().from(schema.gradeJobs);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.status === "pending" && r.tries === 0)).toBe(true);

    // Second pass sees nothing new — otherwise every boot would re-queue the
    // same papers and re-bill them.
    expect(await backfillGradeJobs(db)).toBe(0);
    expect(await db.select().from(schema.gradeJobs)).toHaveLength(5);
  });

  test("backfill is bounded — an incident backlog cannot make boot unbounded work", async () => {
    const db = await freshDb();
    for (let i = 0; i < 12; i++) await seedAttempt(db, i, "submitted");
    expect(await backfillGradeJobs(db, 5)).toBe(5);
    expect(await db.select().from(schema.gradeJobs)).toHaveLength(5);
  });

  test("does not disturb the tries of an attempt already in the queue", async () => {
    const db = await freshDb();
    await seedAttempt(db, 1, "submitted");
    const t0 = Date.now();
    await enqueueGradeJob(db, { attemptId: "att_1", examId: "exm_1", now: t0 });
    const [job] = await claimGradeJobs(db, { workerId: "w", limit: 1, now: t0 });
    await failGradeJob(db, { jobId: job!.id, tries: job!.tries, error: "boom", now: t0 });

    expect(await backfillGradeJobs(db)).toBe(0);
    expect((await jobRow(db, "att_1"))?.tries).toBe(1);
  });

  test("closeStaleGradeJobs retires open jobs whose attempt no longer needs grading", async () => {
    const db = await freshDb();
    await seedAttempt(db, 1, "submitted");
    await seedAttempt(db, 2, "graded"); // finished by the submit path
    await seedAttempt(db, 3, "in_progress"); // reopened by an admin
    for (const a of ["att_1", "att_2", "att_3", "att_4"]) {
      await enqueueGradeJob(db, { attemptId: a, examId: "exm_1" });
    }
    // att_4's attempt row does not exist at all (deleted roster reconcile).

    expect(await closeStaleGradeJobs(db)).toBe(3);
    expect(await countGradeJobs(db)).toEqual({ pending: 1, claimed: 0, done: 3, failed: 0 });
    expect((await jobRow(db, "att_1"))?.status).toBe("pending");

    expect(await closeStaleGradeJobs(db)).toBe(0);
  });

  test("closeStaleGradeJobs leaves terminal failures alone", async () => {
    const db = await freshDb();
    await seedAttempt(db, 1, "graded");
    await enqueueGradeJob(db, { attemptId: "att_1", examId: "exm_1" });
    const [job] = await claimGradeJobs(db, { workerId: "w", limit: 1 });
    await failGradeJob(db, { jobId: job!.id, tries: MAX_GRADE_TRIES - 1, error: "gave up" });

    expect(await closeStaleGradeJobs(db)).toBe(0);
    // The failed row must stay findable — it is the only record of a paper that
    // needs a human.
    expect(await listFailedGradeJobs(db)).toHaveLength(1);
  });
});
