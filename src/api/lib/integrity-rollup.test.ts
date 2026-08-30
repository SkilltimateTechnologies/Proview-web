/**
 * Proves the Live Monitor's incremental evidence cache reads each integrity event
 * exactly once and still returns what a from-scratch aggregate would.
 *
 * The dangerous properties of a carried-forward aggregate are not "is the number
 * plausible" — they are:
 *
 *   1. Nothing is counted twice. A violation double-counted on every 3s poll turns
 *      into a student accused of 400 violations by the end of an exam.
 *   2. Nothing is missed. An event that lands while the aggregate is being pinned
 *      must show up in the next read, not vanish.
 *   3. The cursor advances past OTHER exams' rows, or the tail it re-reads grows
 *      without bound whenever a second exam is live — which is exactly when the
 *      monitor is most loaded.
 *   4. Deletes are the one direction the watermark cannot follow (SQLite reuses
 *      rowids under the max), so invalidation and the periodic full rebuild must
 *      actually heal the drift.
 *
 * `applyEvents` is also used as the oracle: the SQL path must agree with folding
 * every row in JavaScript.
 *
 * Runs against @libsql/client in-memory, NOT the app's `db` singleton.
 */
import { createClient, type Client } from "@libsql/client";
import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as schema from "../database/schema";
import {
  EMPTY_EVIDENCE,
  EXAM_IDLE_MS,
  FULL_REBUILD_MS,
  IntegrityRollup,
  applyEvents,
  type AttemptEvidence,
  type Db,
} from "./integrity-rollup";

/** Mirrors schema.ts. `attempts` DDL is duplicated in several test files — keep in sync. */
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
  `CREATE TABLE integrity_events (
     id TEXT PRIMARY KEY,
     attempt_id TEXT NOT NULL,
     type TEXT NOT NULL,
     detail TEXT,
     photo_url TEXT,
     at INTEGER NOT NULL
   )`,
  `CREATE INDEX integrity_attempt_type_idx ON integrity_events (attempt_id, type)`,
  `CREATE INDEX integrity_attempt_at_idx ON integrity_events (attempt_id, at)`,
];

/** The production set, abbreviated to what these tests exercise. */
const NON_VIOLATION = new Set(["periodic_snapshot", "camera_restored", "focus_loss", "snapshot_failed"]);

let clients: Client[] = [];
let evSeq = 0;

async function freshDb(): Promise<Db> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  for (const stmt of DDL) await client.execute(stmt);
  return drizzle(client, { schema });
}

async function attempt(db: Db, id: string, examId: string, status = "in_progress") {
  await db.insert(schema.attempts).values({ id, examId, studentId: `stu_${id}`, status, createdAt: new Date(0) });
}

type Ev = { attemptId: string; type: string; atMs: number; photoKey?: string | null };

async function events(db: Db, rows: Ev[]) {
  if (!rows.length) return;
  await db.insert(schema.integrityEvents).values(
    rows.map((r) => ({
      id: `iev_${evSeq++}`,
      attemptId: r.attemptId,
      type: r.type,
      detail: null,
      photoUrl: r.photoKey ?? null,
      at: new Date(r.atMs),
    })),
  );
}

/** The oracle: fold every row in JS, the way the old full aggregate did. */
function oracle(rows: Ev[]): Map<string, AttemptEvidence> {
  const out = new Map<string, AttemptEvidence>();
  applyEvents(
    out,
    rows.map((r) => ({ attemptId: r.attemptId, type: r.type, photoUrl: r.photoKey ?? null, atMs: r.atMs })),
    NON_VIOLATION,
  );
  return out;
}

beforeEach(() => {
  clients = [];
  evSeq = 0;
});
afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
});

describe("a full build agrees with folding every row", () => {
  test("violations exclude evidence-only types, and the newest snapshot wins", async () => {
    const db = await freshDb();
    const roll = new IntegrityRollup();
    await attempt(db, "att_a", "exam_1");
    await attempt(db, "att_b", "exam_1");
    const rows: Ev[] = [
      { attemptId: "att_a", type: "periodic_snapshot", atMs: 1_000, photoKey: "k/old.jpg" },
      { attemptId: "att_a", type: "tab_switch", atMs: 1_500 },
      { attemptId: "att_a", type: "periodic_snapshot", atMs: 2_000, photoKey: "k/new.jpg" },
      { attemptId: "att_a", type: "focus_loss", atMs: 2_100 },
      { attemptId: "att_a", type: "phone", atMs: 2_200 },
      { attemptId: "att_b", type: "snapshot_failed", atMs: 1_100 },
    ];
    await events(db, rows);

    const got = await roll.load(db, "exam_1", NON_VIOLATION, 10_000);
    expect(got).toEqual(oracle(rows));
    expect(got.get("att_a")).toEqual({ violations: 2, lastKey: "k/new.jpg", lastAtMs: 2_000 });
    // A dead camera leaves rows but no thumbnail, and no violation for the fault.
    // lastAtMs tracks the newest *snapshot*, so a photo-less row leaves it at 0.
    expect(got.get("att_b")).toEqual({ violations: 0, lastKey: null, lastAtMs: 0 });
  });

  test("an attempt with no events at all is absent, and EMPTY_EVIDENCE reads as clean", async () => {
    const db = await freshDb();
    const roll = new IntegrityRollup();
    await attempt(db, "att_a", "exam_1");
    const got = await roll.load(db, "exam_1", NON_VIOLATION, 1);
    expect(got.size).toBe(0);
    const ev = got.get("att_a") ?? EMPTY_EVIDENCE;
    expect(ev.violations).toBe(0);
    expect(ev.lastKey).toBeNull();
  });

  test("events of other exams and of not_started attempts are not counted", async () => {
    const db = await freshDb();
    const roll = new IntegrityRollup();
    await attempt(db, "att_a", "exam_1");
    await attempt(db, "att_other", "exam_2");
    await attempt(db, "att_ns", "exam_1", "not_started");
    await events(db, [
      { attemptId: "att_a", type: "phone", atMs: 1 },
      { attemptId: "att_other", type: "phone", atMs: 2 },
      { attemptId: "att_ns", type: "phone", atMs: 3 },
    ]);
    const got = await roll.load(db, "exam_1", NON_VIOLATION, 1);
    expect([...got.keys()]).toEqual(["att_a"]);
    expect(got.get("att_a")!.violations).toBe(1);
  });
});

describe("the incremental path", () => {
  test("re-reading with nothing new changes nothing — no double counting", async () => {
    const db = await freshDb();
    const roll = new IntegrityRollup();
    await attempt(db, "att_a", "exam_1");
    await events(db, [
      { attemptId: "att_a", type: "phone", atMs: 1 },
      { attemptId: "att_a", type: "periodic_snapshot", atMs: 2, photoKey: "k/1.jpg" },
    ]);

    const first = await roll.load(db, "exam_1", NON_VIOLATION, 1_000);
    expect(first.get("att_a")!.violations).toBe(1);
    // Twenty polls later, with no new evidence, the numbers must be identical.
    for (let i = 1; i <= 20; i++) {
      const again = await roll.load(db, "exam_1", NON_VIOLATION, 1_000 + i * 3_000);
      expect(again.get("att_a")).toEqual({ violations: 1, lastKey: "k/1.jpg", lastAtMs: 2 });
    }
  });

  test("new events are added exactly once, and the result matches a full fold", async () => {
    const db = await freshDb();
    const roll = new IntegrityRollup();
    await attempt(db, "att_a", "exam_1");
    await attempt(db, "att_b", "exam_1");
    const all: Ev[] = [];

    // Ten polls, each with a fresh flush in between — the live-exam shape.
    for (let tick = 1; tick <= 10; tick++) {
      const batch: Ev[] = [
        { attemptId: "att_a", type: "periodic_snapshot", atMs: tick * 1_000, photoKey: `k/${tick}.jpg` },
        { attemptId: "att_b", type: tick % 2 ? "tab_switch" : "focus_loss", atMs: tick * 1_000 },
      ];
      all.push(...batch);
      await events(db, batch);
      const got = await roll.load(db, "exam_1", NON_VIOLATION, tick * 3_000);
      expect(got).toEqual(oracle(all));
    }
    const final = await roll.load(db, "exam_1", NON_VIOLATION, 40_000);
    expect(final.get("att_a")).toEqual({ violations: 0, lastKey: "k/10.jpg", lastAtMs: 10_000 });
    expect(final.get("att_b")!.violations).toBe(5); // five tab_switch, five focus_loss ignored
  });

  test("a late event with an older timestamp does not replace a newer thumbnail", async () => {
    const db = await freshDb();
    const roll = new IntegrityRollup();
    await attempt(db, "att_a", "exam_1");
    await events(db, [{ attemptId: "att_a", type: "periodic_snapshot", atMs: 5_000, photoKey: "k/new.jpg" }]);
    await roll.load(db, "exam_1", NON_VIOLATION, 1_000);
    // Arrives later, but was captured earlier (a retried flush).
    await events(db, [{ attemptId: "att_a", type: "periodic_snapshot", atMs: 1_000, photoKey: "k/stale.jpg" }]);
    const got = await roll.load(db, "exam_1", NON_VIOLATION, 4_000);
    expect(got.get("att_a")!.lastKey).toBe("k/new.jpg");
  });

  test("an attempt that starts mid-exam is picked up by the tail", async () => {
    const db = await freshDb();
    const roll = new IntegrityRollup();
    await attempt(db, "att_a", "exam_1");
    await events(db, [{ attemptId: "att_a", type: "phone", atMs: 1 }]);
    await roll.load(db, "exam_1", NON_VIOLATION, 1_000);

    await attempt(db, "att_late", "exam_1");
    await events(db, [{ attemptId: "att_late", type: "multi_face", atMs: 2 }]);
    const got = await roll.load(db, "exam_1", NON_VIOLATION, 4_000);
    expect(got.get("att_late")!.violations).toBe(1);
  });

  test("the cursor advances past another exam's rows, so the tail cannot grow", async () => {
    const db = await freshDb();
    const roll = new IntegrityRollup();
    await attempt(db, "att_a", "exam_1");
    await attempt(db, "att_busy", "exam_2");
    await events(db, [{ attemptId: "att_a", type: "phone", atMs: 1 }]);
    await roll.load(db, "exam_1", NON_VIOLATION, 1_000);

    // The other live exam writes 500 events. exam_1's next read must skip them.
    await events(db, Array.from({ length: 500 }, (_, i) => ({ attemptId: "att_busy", type: "periodic_snapshot", atMs: i })));
    await roll.load(db, "exam_1", NON_VIOLATION, 4_000);

    const [state] = roll.snapshot().filter((s) => s.examId === "exam_1");
    const [{ n }] = await db.all<{ n: number }>(dsql`select max(rowid) as n from integrity_events`);
    expect(state.cursor).toBe(Number(n));
  });
});

describe("deletes, which the watermark cannot follow on its own", () => {
  test("invalidateAll forces a full rebuild and drops the deleted evidence", async () => {
    const db = await freshDb();
    const roll = new IntegrityRollup();
    await attempt(db, "att_a", "exam_1");
    await events(db, [
      { attemptId: "att_a", type: "phone", atMs: 1 },
      { attemptId: "att_a", type: "phone", atMs: 2 },
    ]);
    expect((await roll.load(db, "exam_1", NON_VIOLATION, 1_000)).get("att_a")!.violations).toBe(2);

    await db.run(dsql`delete from integrity_events where attempt_id = 'att_a'`);
    // Without invalidation the carried aggregate still shows the old count — the
    // documented trade-off, healed by the admin paths and by FULL_REBUILD_MS.
    expect((await roll.load(db, "exam_1", NON_VIOLATION, 2_000)).get("att_a")!.violations).toBe(2);

    roll.invalidateAll();
    const healed = await roll.load(db, "exam_1", NON_VIOLATION, 3_000);
    expect(healed.size).toBe(0);
  });

  test("a full rebuild happens on its own after FULL_REBUILD_MS", async () => {
    const db = await freshDb();
    const roll = new IntegrityRollup();
    await attempt(db, "att_a", "exam_1");
    await events(db, [{ attemptId: "att_a", type: "phone", atMs: 1 }]);
    await roll.load(db, "exam_1", NON_VIOLATION, 1_000);
    await db.run(dsql`delete from integrity_events`);

    const justBefore = await roll.load(db, "exam_1", NON_VIOLATION, 1_000 + FULL_REBUILD_MS - 1);
    expect(justBefore.get("att_a")!.violations).toBe(1);
    const after = await roll.load(db, "exam_1", NON_VIOLATION, 1_000 + FULL_REBUILD_MS);
    expect(after.size).toBe(0);
  });
});

describe("memory", () => {
  test("an exam nobody has watched for EXAM_IDLE_MS is forgotten", async () => {
    const db = await freshDb();
    const roll = new IntegrityRollup();
    await attempt(db, "att_a", "exam_1");
    await events(db, [{ attemptId: "att_a", type: "phone", atMs: 1 }]);
    await roll.load(db, "exam_1", NON_VIOLATION, 1_000);
    expect(roll.snapshot().length).toBe(1);

    await attempt(db, "att_b", "exam_2");
    await roll.load(db, "exam_2", NON_VIOLATION, 1_000 + EXAM_IDLE_MS);
    expect(roll.snapshot().map((s) => s.examId)).toEqual(["exam_2"]);
  });
});
