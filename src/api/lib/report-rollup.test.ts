/**
 * Proves the grouped aggregate behind `GET /reports` returns exactly what the
 * per-exam JavaScript counting returned.
 *
 * Why this file exists: the reports list used to read every attempt row of every
 * exam (one round trip each) and count in JS. It now issues ONE grouped aggregate
 * with conditional SUM(CASE …) columns. The failure mode of that rewrite is
 * silent and awful — a card showing 190 attempts, 41% pass rate and an average of
 * 62 is completely believable whether or not the SQL is right, and nobody
 * reconciles a dashboard against the database by hand.
 *
 * So `rollupFromAttempts` (the old computation, preserved verbatim) is kept as an
 * oracle, and these tests assert the SQL agrees with it exam by exam over data
 * shaped like production: mixed statuses, ungraded attempts, scores exactly on the
 * pass mark, and exams with no attempts at all.
 *
 * The subtle invariant, guarded explicitly below: `graded`/`passed`/`failed` key
 * off `score IS NOT NULL`, NOT off status. A terminally-failed grading run leaves
 * status `graded` with a null score, and counting those as failures would quietly
 * move the pass rate.
 *
 * Runs against @libsql/client in-memory, NOT the app's `db` singleton.
 */
import { createClient, type Client } from "@libsql/client";
import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as schema from "../database/schema";
import {
  EMPTY_ROLLUP,
  PASS_MARK,
  ROLLUP_CHUNK,
  loadAttemptRollups,
  rollupAvg,
  rollupFromAttempts,
  type AttemptRollup,
  type Db,
} from "./report-rollup";

const DDL = [
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
     user_agent TEXT,
     submitted_at INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX attempts_exam_idx ON attempts (exam_id)`,
  `CREATE UNIQUE INDEX attempts_exam_student_uq ON attempts (exam_id, student_id)`,
];

let clients: Client[] = [];
let seq = 0;

async function freshDb(): Promise<Db> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  for (const stmt of DDL) await client.execute(stmt);
  return drizzle(client, { schema });
}

type Att = { examId: string; status: string; score: number | null };

async function seed(db: Db, rows: Att[]) {
  if (!rows.length) return;
  await db.insert(schema.attempts).values(
    rows.map((r) => ({
      id: `att_${seq++}`,
      examId: r.examId,
      studentId: `stu_${seq++}`,
      status: r.status,
      score: r.score,
      createdAt: new Date(0),
    })),
  );
}

/** The oracle, grouped the way the route consumes it. */
function expectedRollups(rows: Att[]): Map<string, AttemptRollup> {
  const byExam = new Map<string, Att[]>();
  for (const r of rows) {
    const list = byExam.get(r.examId) ?? [];
    list.push(r);
    byExam.set(r.examId, list);
  }
  return new Map([...byExam].map(([examId, list]) => [examId, rollupFromAttempts(list)]));
}

beforeEach(() => {
  clients = [];
  seq = 0;
});
afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
});

describe("the SQL agrees with the JavaScript it replaced", () => {
  test("over production-shaped data across several exams", async () => {
    const db = await freshDb();
    const rows: Att[] = [
      // exam_1: a full spread
      { examId: "exam_1", status: "graded", score: 95 },
      { examId: "exam_1", status: "graded", score: 40 }, // exactly the pass mark
      { examId: "exam_1", status: "graded", score: 39.5 },
      { examId: "exam_1", status: "graded", score: 0 },
      { examId: "exam_1", status: "graded", score: null }, // grading gave up
      { examId: "exam_1", status: "submitted", score: null }, // awaiting the batch
      { examId: "exam_1", status: "in_progress", score: null },
      { examId: "exam_1", status: "not_started", score: null },
      // exam_2: everyone still writing
      { examId: "exam_2", status: "in_progress", score: null },
      { examId: "exam_2", status: "in_progress", score: null },
      // exam_3: one graded attempt
      { examId: "exam_3", status: "graded", score: 72.5 },
    ];
    await seed(db, rows);

    const got = await loadAttemptRollups(db, ["exam_1", "exam_2", "exam_3"]);
    const want = expectedRollups(rows);
    expect(got).toEqual(want);

    // And spelled out, so a future reader can see the numbers, not just equality.
    expect(got.get("exam_1")).toEqual({
      attempts: 8,
      finished: 6, // 5 graded + 1 submitted
      inProgress: 1,
      graded: 4, // score IS NOT NULL
      passed: 2, // 95 and 40
      failed: 2, // 39.5 and 0
      scoreSum: 174.5,
    });
    expect(rollupAvg(got.get("exam_1")!)).toBe(43.6);
  });

  test("a graded attempt with a null score is neither passed nor failed", async () => {
    const db = await freshDb();
    const rows: Att[] = [
      { examId: "exam_1", status: "graded", score: null },
      { examId: "exam_1", status: "graded", score: null },
      { examId: "exam_1", status: "graded", score: 80 },
    ];
    await seed(db, rows);
    const r = (await loadAttemptRollups(db, ["exam_1"]))!.get("exam_1")!;
    expect(r).toEqual(expectedRollups(rows).get("exam_1")!);
    expect(r.finished).toBe(3);
    expect(r.graded).toBe(1);
    expect(r.passed + r.failed).toBe(r.graded);
    expect(rollupAvg(r)).toBe(80); // not diluted to 26.7 by the ungraded rows
  });

  test("passed + failed always equals graded, on both sides of the pass mark", async () => {
    const db = await freshDb();
    const rows: Att[] = [
      { examId: "exam_1", status: "graded", score: PASS_MARK },
      { examId: "exam_1", status: "graded", score: PASS_MARK - 0.1 },
      { examId: "exam_1", status: "graded", score: PASS_MARK + 0.1 },
      { examId: "exam_1", status: "graded", score: 100 },
    ];
    await seed(db, rows);
    const r = (await loadAttemptRollups(db, ["exam_1"]))!.get("exam_1")!;
    expect(r).toEqual(expectedRollups(rows).get("exam_1")!);
    expect(r.passed).toBe(3);
    expect(r.failed).toBe(1);
  });

  test("counts only the exam asked for", async () => {
    const db = await freshDb();
    await seed(db, [
      { examId: "exam_1", status: "graded", score: 10 },
      { examId: "exam_other", status: "graded", score: 90 },
    ]);
    const got = await loadAttemptRollups(db, ["exam_1"]);
    expect(got.size).toBe(1);
    expect(got.get("exam_1")!.scoreSum).toBe(10);
  });
});

describe("edges", () => {
  test("an exam with no attempts is absent from the map, and EMPTY_ROLLUP renders zeros", async () => {
    const db = await freshDb();
    await seed(db, [{ examId: "exam_1", status: "graded", score: 50 }]);
    const got = await loadAttemptRollups(db, ["exam_1", "exam_untouched"]);
    expect(got.has("exam_untouched")).toBe(false);
    const r = got.get("exam_untouched") ?? EMPTY_ROLLUP;
    expect(r.attempts).toBe(0);
    expect(rollupAvg(r)).toBe(0); // never NaN from a 0/0 division
  });

  test("no exam ids means no query and an empty map", async () => {
    const broken = {
      select: () => {
        throw new Error("should not have queried");
      },
    } as unknown as Db;
    expect((await loadAttemptRollups(broken, [])).size).toBe(0);
  });

  test("a duplicated exam id does not double its counts", async () => {
    const db = await freshDb();
    await seed(db, [
      { examId: "exam_1", status: "graded", score: 50 },
      { examId: "exam_1", status: "graded", score: 50 },
    ]);
    const got = await loadAttemptRollups(db, ["exam_1", "exam_1", "exam_1"]);
    expect(got.get("exam_1")!.attempts).toBe(2);
    expect(got.get("exam_1")!.scoreSum).toBe(100);
  });

  test("more exams than fit in one statement are all rolled up", async () => {
    const db = await freshDb();
    const n = ROLLUP_CHUNK * 2 + 13;
    const ids = Array.from({ length: n }, (_, i) => `exam_${i}`);
    const rows: Att[] = ids.flatMap((examId, i) => [
      { examId, status: "graded", score: i % 101 },
      { examId, status: "in_progress", score: null },
    ]);
    await seed(db, rows);

    const got = await loadAttemptRollups(db, ids);
    expect(got.size).toBe(n);
    expect(got).toEqual(expectedRollups(rows));
  });

  test("the aggregate rides attempts_exam_idx instead of scanning every attempt", async () => {
    const db = await freshDb();
    await seed(db, [{ examId: "exam_1", status: "graded", score: 50 }]);
    // Literal ids rather than placeholders: the plan for an IN list is exactly
    // what we care about, and EXPLAIN is only honest about the shape it is given.
    const plan = await db.all<{ detail: string }>(
      dsql`explain query plan select exam_id, count(*) from attempts where exam_id in ('exam_1', 'exam_2') group by exam_id`,
    );
    const detail = plan.map((r) => r.detail).join(" | ");
    expect(detail).toContain("attempts_exam_idx");
    expect(detail).not.toContain("SCAN attempts");
  });
});
