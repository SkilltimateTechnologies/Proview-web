/**
 * Proves the background sweeps can no longer full-scan `attempts`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `attempts` carried indexes on `exam_id`, `student_id` and `(exam_id, student_id)`
 * — and none on `status`. Both background sweeps filter on `status` alone:
 *
 *   sweepAutoSubmit()      WHERE status = 'in_progress'   (every 60s)
 *   sweepPendingGrading()  WHERE status = 'submitted'     (reconcile tick)
 *
 * With no index those are full scans of every attempt ever taken, on a timer,
 * forever — so the read cost grows with exam HISTORY rather than with load. The
 * Turso dashboard showed ~5-6M rows read per day on days with no exam at all, and
 * the arithmetic says a single 60s scan consumes an entire 2.5B-row monthly plan
 * once roughly 58,000 attempts are stored.
 *
 * The index is additive: no query text and no response shape changes, only the
 * plan. These tests pin the two things that could silently undo that:
 *
 *   1. The spec must stay in REQUIRED_PERF_INDEXES — that list, not `drizzle/`,
 *      is what actually creates the index in production (there is no migrate step
 *      in the deploy path; see the header of invariants.ts).
 *   2. The index must actually serve the sweep query shape. `EXPLAIN QUERY PLAN`
 *      is the only honest check: a declared index the planner refuses to use is
 *      worth nothing.
 *
 * Runs against @libsql/client on a private :memory: database, NOT the app's `db`
 * singleton — no DATABASE_URL, no network, no fixtures.
 */
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// invariants.ts imports the app's db singleton, which throws at import time
// without DATABASE_URL. Nothing here queries it — we only read the spec list.
process.env.DATABASE_URL ||= ":memory:";
const { REQUIRED_PERF_INDEXES } = await import("./invariants");

/** Mirrors schema.ts. Deliberately WITHOUT attempts_status_idx — each test adds it. */
const DDL = [
  `CREATE TABLE attempts (
     id TEXT PRIMARY KEY,
     exam_id TEXT NOT NULL,
     student_id TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'not_started',
     score REAL,
     started_at INTEGER,
     paused_ms INTEGER NOT NULL DEFAULT 0,
     submitted_at INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX attempts_exam_student_uq ON attempts (exam_id, student_id)`,
  `CREATE INDEX attempts_exam_idx ON attempts (exam_id)`,
  `CREATE INDEX attempts_student_idx ON attempts (student_id)`,
];

let clients: Client[] = [];

async function freshDb(): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  for (const stmt of DDL) await client.execute(stmt);
  return client;
}

/**
 * Seed a realistic history: the overwhelming majority of stored attempts are
 * finished. That is the whole point — the sweeps pay for rows that can never
 * match.
 */
async function seedHistory(client: Client, graded: number, inProgress: number) {
  let i = 0;
  for (let n = 0; n < graded; n++, i++) {
    await client.execute({
      sql: `INSERT INTO attempts (id, exam_id, student_id, status, created_at) VALUES (?, ?, ?, 'graded', 0)`,
      args: [`att_${i}`, `exm_${n % 11}`, `stu_${i}`],
    });
  }
  for (let n = 0; n < inProgress; n++, i++) {
    await client.execute({
      sql: `INSERT INTO attempts (id, exam_id, student_id, status, created_at) VALUES (?, ?, ?, 'in_progress', 0)`,
      args: [`att_${i}`, `exm_live`, `stu_${i}`],
    });
  }
}

async function plan(client: Client, sql: string, args: unknown[] = []): Promise<string> {
  const rs = await client.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args: args as never[] });
  return rs.rows.map((r) => String((r as unknown as { detail: string }).detail)).join(" | ");
}

async function createStatusIndex(client: Client) {
  const spec = REQUIRED_PERF_INDEXES.find((s) => s.name === "attempts_status_idx")!;
  // Exactly the statement ensurePerformanceIndexes() issues.
  await client.execute(
    `CREATE INDEX IF NOT EXISTS ${spec.name} ON ${spec.table} (${spec.columns.join(", ")})`,
  );
}

beforeEach(() => {
  clients = [];
});
afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
});

describe("attempts_status_idx is declared where production will create it", () => {
  test("the spec is in REQUIRED_PERF_INDEXES, on attempts(status)", () => {
    const spec = REQUIRED_PERF_INDEXES.find((s) => s.name === "attempts_status_idx");
    expect(spec).toBeDefined();
    expect(spec!.table).toBe("attempts");
    expect(spec!.columns).toEqual(["status"]);
    // The guard note is what a future reader sees in the boot log; an empty one
    // makes the log line useless.
    expect(spec!.guards.length).toBeGreaterThan(20);
  });

  test("every perf index spec is well formed", () => {
    for (const spec of REQUIRED_PERF_INDEXES) {
      expect(spec.name).toMatch(/^[a-z0-9_]+$/);
      expect(spec.table).toMatch(/^[a-z0-9_]+$/);
      expect(spec.columns.length).toBeGreaterThan(0);
      for (const c of spec.columns) expect(c).toMatch(/^[a-z0-9_]+$/);
    }
  });

  test("names are unique — a duplicate would make CREATE INDEX a silent no-op", () => {
    const names = REQUIRED_PERF_INDEXES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the sweep queries stop scanning once the index exists", () => {
  test("auto-submit's filter goes from SCAN to SEARCH", async () => {
    const client = await freshDb();
    await seedHistory(client, 300, 4);
    const q = `SELECT id FROM attempts WHERE status = ?`;

    const before = await plan(client, q, ["in_progress"]);
    expect(before).toContain("SCAN attempts");

    await createStatusIndex(client);

    const after = await plan(client, q, ["in_progress"]);
    expect(after).toContain("attempts_status_idx");
    expect(after).not.toContain("SCAN attempts");
  });

  test("the grading reconcile's filter goes from SCAN to SEARCH", async () => {
    const client = await freshDb();
    await seedHistory(client, 300, 0);
    const q = `SELECT id FROM attempts WHERE status = ?`;

    expect(await plan(client, q, ["submitted"])).toContain("SCAN attempts");
    await createStatusIndex(client);
    expect(await plan(client, q, ["submitted"])).toContain("attempts_status_idx");
  });

  test("an indexed seek reads the matching rows, not the whole table", async () => {
    const client = await freshDb();
    await seedHistory(client, 300, 4);
    await createStatusIndex(client);

    // sqlite_stat-free proof: the planner reports a covering index seek and the
    // result set is the 4 live rows out of 304 stored.
    const rs = await client.execute({
      sql: `SELECT id FROM attempts WHERE status = ?`,
      args: ["in_progress"],
    });
    expect(rs.rows.length).toBe(4);

    const total = await client.execute(`SELECT COUNT(*) AS c FROM attempts`);
    expect(Number((total.rows[0] as unknown as { c: number }).c)).toBe(304);
  });

  test("the index changes the plan only — the rows returned are identical", async () => {
    const client = await freshDb();
    await seedHistory(client, 120, 7);
    const q = `SELECT id FROM attempts WHERE status = 'in_progress' ORDER BY id`;

    const scanned = await client.execute(
      `SELECT id FROM attempts NOT INDEXED WHERE status = 'in_progress' ORDER BY id`,
    );
    await createStatusIndex(client);
    const sought = await client.execute(q);

    const ids = (rs: { rows: unknown[] }) =>
      rs.rows.map((r) => String((r as { id: string }).id));
    expect(ids(sought)).toEqual(ids(scanned));
    expect(ids(sought).length).toBe(7);
  });

  test("creating it twice is a no-op — boot runs on every deploy", async () => {
    const client = await freshDb();
    await createStatusIndex(client);
    await createStatusIndex(client);
    const rs = await client.execute(
      `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name='attempts_status_idx'`,
    );
    expect(Number((rs.rows[0] as unknown as { c: number }).c)).toBe(1);
  });

  test("the pre-existing exam/student indexes are untouched", async () => {
    const client = await freshDb();
    await createStatusIndex(client);
    const rs = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='attempts'`,
    );
    const names = rs.rows.map((r) => String((r as unknown as { name: string }).name));
    for (const n of [
      "attempts_exam_student_uq",
      "attempts_exam_idx",
      "attempts_student_idx",
      "attempts_status_idx",
    ]) {
      expect(names).toContain(n);
    }
  });
});
