/**
 * Proves the batched answer upsert on the submit path is byte-identical to the
 * per-row loop it replaced.
 *
 * Why this file exists: `finalizeAttempt` used to issue one
 * `insert(...).onConflictDoUpdate({ set: { score: r.score, ... } })` per
 * question. On a local SQLite file that is free; on Turso over HTTP every
 * iteration is a remote round trip, so a 15-question paper burned 15 sequential
 * latencies inside a student's submit. It is now ONE statement per 50 rows using
 * `excluded.*`.
 *
 * The risk of that rewrite is subtle and would be invisible in a smoke test: if
 * `excluded.*` did not resolve per row, every row in the batch would land the
 * SAME score, and a whole class would be mis-marked while the endpoint still
 * returned 200. So these tests run both writers against two real in-memory libSQL
 * databases and compare every column of every row.
 *
 * Runs against @libsql/client in-memory, NOT the app's `db` singleton — no
 * DATABASE_URL, no network, no fixtures.
 */
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, sql as dsql } from "drizzle-orm";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import * as schema from "../database/schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;
type Row = typeof schema.answers.$inferInsert;

/** DDL mirroring schema.ts's `answers` table, including the unique index the upsert targets. */
const DDL = [
  `CREATE TABLE answers (
     id TEXT PRIMARY KEY,
     attempt_id TEXT NOT NULL,
     question_id TEXT NOT NULL,
     response TEXT,
     score REAL,
     max_score REAL,
     ai_notes TEXT,
     auto_graded INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX answers_attempt_idx ON answers (attempt_id)`,
  `CREATE UNIQUE INDEX answers_attempt_question_uq ON answers (attempt_id, question_id)`,
];

let clients: Client[] = [];

async function freshDb(): Promise<Db> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  for (const stmt of DDL) await client.execute(stmt);
  return drizzle(client, { schema });
}

beforeEach(() => {
  clients = [];
});
afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
});

/** The OLD writer: one statement per row. Kept here purely as the test oracle. */
async function writePerRow(db: Db, rows: Row[]) {
  for (const r of rows) {
    await db.insert(schema.answers).values(r).onConflictDoUpdate({
      target: [schema.answers.attemptId, schema.answers.questionId],
      set: { response: r.response, score: r.score, maxScore: r.maxScore, aiNotes: r.aiNotes, autoGraded: r.autoGraded },
    });
  }
}

/**
 * The NEW writer, mirroring finalizeAttempt: dedupe by questionId, chunk in 50s,
 * one statement per chunk. Returns the number of statements issued so the tests
 * can assert the round-trip saving that is the entire point of the change.
 */
async function writeBatched(db: Db, rows: Row[]): Promise<number> {
  const writeRows = [...new Map(rows.map((r) => [r.questionId, r])).values()];
  let statements = 0;
  for (let i = 0; i < writeRows.length; i += 50) {
    await db.insert(schema.answers).values(writeRows.slice(i, i + 50)).onConflictDoUpdate({
      target: [schema.answers.attemptId, schema.answers.questionId],
      set: {
        response: dsql`excluded.response`,
        score: dsql`excluded.score`,
        maxScore: dsql`excluded.max_score`,
        aiNotes: dsql`excluded.ai_notes`,
        autoGraded: dsql`excluded.auto_graded`,
      },
    });
    statements++;
  }
  return statements;
}

/** Every column except `id`, which is a fresh random id on each finalize by design. */
async function dump(db: Db, attemptId: string) {
  const rows = await db.select().from(schema.answers).where(eq(schema.answers.attemptId, attemptId));
  return rows
    .map((r) => ({
      questionId: r.questionId,
      response: r.response,
      score: r.score,
      maxScore: r.maxScore,
      aiNotes: r.aiNotes,
      autoGraded: r.autoGraded,
    }))
    .sort((a, b) => a.questionId.localeCompare(b.questionId));
}

/**
 * A realistic 15-question paper: mixed types, deliberately DIFFERENT values in
 * every column of every row. If `excluded.*` collapsed to one value per batch,
 * this fixture makes it obvious.
 */
function paper(attemptId = "att_1", n = 15): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ans_${attemptId}_${i}`,
    attemptId,
    questionId: `q_${String(i).padStart(3, "0")}`,
    response: i % 4 === 0 ? null : i % 3 === 0 ? { text: `essay ${i}` } : `opt-${i}`,
    score: i % 5 === 0 ? null : i,
    maxScore: (i % 3) + 1,
    aiNotes: i % 6 === 0 ? "needs review" : null,
    autoGraded: i % 2 === 0,
  }));
}

describe("batched answer upsert vs the per-row loop it replaced", () => {
  test("inserting a fresh paper produces identical rows both ways", async () => {
    const [a, b] = [await freshDb(), await freshDb()];
    const rows = paper();

    await writePerRow(a, rows);
    const statements = await writeBatched(b, rows);

    expect(await dump(b, "att_1")).toEqual(await dump(a, "att_1"));
    // The whole point: 15 round trips became 1.
    expect(statements).toBe(1);
  });

  test("each row keeps its OWN score — excluded.* is per row, not per batch", async () => {
    const db = await freshDb();
    await writeBatched(db, paper());
    const rows = await dump(db, "att_1");

    // Distinct scores survived the single statement (the failure mode this
    // whole file exists to catch would flatten these to one value).
    expect(rows.map((r) => r.score)).toEqual([null, 1, 2, 3, 4, null, 6, 7, 8, 9, null, 11, 12, 13, 14]);
    expect(rows.map((r) => r.maxScore)).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3]);
    expect(rows.filter((r) => r.autoGraded).length).toBe(8);
    expect(rows.filter((r) => r.aiNotes === "needs review").length).toBe(3);
  });

  test("re-finalizing the same attempt converges on the same rows, not duplicates", async () => {
    // A student submit racing the auto-submit sweep, or a double submit. The
    // unique index means the second pass must UPDATE, never insert a twin —
    // blank twins beside real answers is the bug that once scored a student 0.
    const [a, b] = [await freshDb(), await freshDb()];
    const first = paper();
    const second = paper().map((r) => ({ ...r, id: `redo_${r.questionId}`, score: (r.score ?? 0) + 0.5 }));

    await writePerRow(a, first);
    await writePerRow(a, second);
    await writeBatched(b, first);
    await writeBatched(b, second);

    const dumpB = await dump(b, "att_1");
    expect(dumpB).toEqual(await dump(a, "att_1"));
    expect(dumpB.length).toBe(15); // no twins
    expect(dumpB[1]!.score).toBe(1.5); // second pass won, per row
  });

  test("an autosaved answer is overwritten by the merged submit value, both ways", async () => {
    // finalizeAttempt merges before it writes (client response wins only when it
    // hasContent, else the prior autosaved answer is preserved). Whatever it
    // decided, the write must land it verbatim over the autosaved row.
    const [a, b] = [await freshDb(), await freshDb()];
    const autosaved: Row[] = [
      { id: "as_1", attemptId: "att_1", questionId: "q_000", response: "typed while sitting", score: null, maxScore: null, aiNotes: null, autoGraded: false },
      { id: "as_2", attemptId: "att_1", questionId: "q_001", response: { text: "long essay draft" }, score: null, maxScore: null, aiNotes: null, autoGraded: false },
    ];
    for (const db of [a, b]) await db.insert(schema.answers).values(autosaved);

    // The merged rows a real finalize would produce: q_000 graded, q_001 deferred
    // to the background grader (score null) but its content preserved.
    const merged: Row[] = [
      { id: "f_1", attemptId: "att_1", questionId: "q_000", response: "typed while sitting", score: 2, maxScore: 2, aiNotes: null, autoGraded: true },
      { id: "f_2", attemptId: "att_1", questionId: "q_001", response: { text: "long essay draft" }, score: null, maxScore: 5, aiNotes: null, autoGraded: false },
    ];
    await writePerRow(a, merged);
    await writeBatched(b, merged);

    const dumpB = await dump(b, "att_1");
    expect(dumpB).toEqual(await dump(a, "att_1"));
    expect(dumpB.length).toBe(2);
    expect(dumpB[0]).toMatchObject({ response: "typed while sitting", score: 2, maxScore: 2, autoGraded: true });
    // The student's work is still there and still awaiting the AI grader.
    expect(dumpB[1]).toMatchObject({ response: { text: "long essay draft" }, score: null, maxScore: 5, autoGraded: false });
  });

  test("nulls round-trip as nulls, not as the string 'null'", async () => {
    const [a, b] = [await freshDb(), await freshDb()];
    const rows: Row[] = [
      { id: "n_1", attemptId: "att_1", questionId: "q_000", response: null, score: 0, maxScore: 1, aiNotes: null, autoGraded: true },
    ];
    await writePerRow(a, rows);
    await writeBatched(b, rows);

    const [only] = await dump(b, "att_1");
    expect(await dump(b, "att_1")).toEqual(await dump(a, "att_1"));
    expect(only!.response).toBeNull();
    expect(only!.aiNotes).toBeNull();
  });

  test("a 120-question paper chunks into 3 statements and stays identical", async () => {
    // libSQL caps bound variables per statement, hence the 50-row chunks.
    const [a, b] = [await freshDb(), await freshDb()];
    const rows = paper("att_big", 120);

    await writePerRow(a, rows);
    const statements = await writeBatched(b, rows);

    expect(await dump(b, "att_big")).toEqual(await dump(a, "att_big"));
    expect(statements).toBe(3); // 120 round trips became 3
    expect((await dump(b, "att_big")).length).toBe(120);
  });

  test("duplicate questionIds are collapsed instead of crashing the statement", async () => {
    // SQLite refuses to apply ON CONFLICT twice to the same row inside one
    // statement ("ON CONFLICT DO UPDATE command cannot affect row a second
    // time"), which would 500 the submit. The dedupe keeps the LAST occurrence.
    const db = await freshDb();
    const rows: Row[] = [
      { id: "d_1", attemptId: "att_1", questionId: "q_dup", response: "first", score: 1, maxScore: 2, aiNotes: null, autoGraded: true },
      { id: "d_2", attemptId: "att_1", questionId: "q_dup", response: "second", score: 2, maxScore: 2, aiNotes: null, autoGraded: true },
    ];

    const statements = await writeBatched(db, rows);
    expect(statements).toBe(1);
    const out = await dump(db, "att_1");
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ response: "second", score: 2 });
  });

  test("an empty paper issues zero statements", async () => {
    const db = await freshDb();
    expect(await writeBatched(db, [])).toBe(0);
    expect(await dump(db, "att_1")).toEqual([]);
  });

  test("another attempt's answers are never touched", async () => {
    const db = await freshDb();
    await writeBatched(db, paper("att_other"));
    await writeBatched(db, paper("att_1"));

    expect((await dump(db, "att_other")).length).toBe(15);
    expect(await dump(db, "att_other")).toEqual(await dump(db, "att_1"));
  });
});
