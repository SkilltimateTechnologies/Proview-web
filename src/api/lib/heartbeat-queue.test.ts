/**
 * Pins the heartbeat coalescing queue, which is the thing standing between 67
 * writes a second and ~0.2.
 *
 * Two classes of risk are covered, both of which would be invisible in a smoke
 * test because the endpoint keeps returning 200 either way:
 *
 *  1. The batched `CASE id WHEN … END` writing the WRONG timestamp to a row — one
 *     student's ping landing on another student's attempt would make the Live
 *     Monitor lie about who is present. The tests assert every row, not just one.
 *  2. The monotonic guard. Other paths (autosave, /start, resume) still write
 *     last_seen_at directly. A flush must never drag it BACKWARDS, or a student
 *     who just autosaved goes grey in the monitor for no reason.
 *
 * Plus the two failure modes that lose presence: a chunk that throws must go back
 * into the map, and >200 attempts must all be written rather than truncated at
 * the chunk boundary.
 *
 * Runs against @libsql/client in-memory, NOT the app's `db` singleton — no
 * DATABASE_URL, no network, no fixtures.
 */
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as schema from "../database/schema";
import {
  HEARTBEAT_FLUSH_CHUNK,
  HeartbeatQueue,
  type Db,
} from "./heartbeat-queue";

/** Enough of schema.ts's `attempts` for the flush; mirrors the real column set. */
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
  `CREATE UNIQUE INDEX attempts_exam_student_uq ON attempts (exam_id, student_id)`,
];

let clients: Client[] = [];

async function freshDb(): Promise<Db> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  for (const stmt of DDL) await client.execute(stmt);
  return drizzle(client, { schema });
}

/** Seed n attempts, optionally with an existing last_seen_at. */
async function seed(db: Db, rows: { id: string; lastSeenAt?: number | null }[]) {
  await db.insert(schema.attempts).values(
    rows.map((r, i) => ({
      id: r.id,
      examId: "exam_1",
      studentId: `stu_${i}`,
      status: "in_progress",
      lastSeenAt: r.lastSeenAt == null ? null : new Date(r.lastSeenAt),
      createdAt: new Date(0),
    })),
  );
}

async function readSeen(db: Db): Promise<Map<string, number | null>> {
  const rows = await db
    .select({ id: schema.attempts.id, lastSeenAt: schema.attempts.lastSeenAt })
    .from(schema.attempts);
  return new Map(rows.map((r) => [r.id, r.lastSeenAt ? r.lastSeenAt.getTime() : null]));
}

beforeEach(() => {
  clients = [];
});
afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
});

describe("coalescing map", () => {
  test("keeps the latest instant per attempt", () => {
    const q = new HeartbeatQueue();
    q.markSeen("att_a", 1_000);
    q.markSeen("att_a", 4_000);
    q.markSeen("att_a", 2_000); // out of order (a retried request) — must not win
    expect(q.peekSeen("att_a")).toBe(4_000);
    expect(q.pendingCount()).toBe(1);
  });

  test("many pings from many students collapse to one entry each", () => {
    const q = new HeartbeatQueue();
    for (let tick = 0; tick < 5; tick++) {
      for (let s = 0; s < 300; s++) q.markSeen(`att_${s}`, 1_000 + tick);
    }
    expect(q.pendingCount()).toBe(300); // 1500 pings, 300 pending writes
    expect(q.peekSeen("att_7")).toBe(1_004);
  });

  test("peekSeen is undefined for an attempt with nothing pending", () => {
    const q = new HeartbeatQueue();
    expect(q.peekSeen("att_missing")).toBeUndefined();
  });

  test("takePending drains", () => {
    const q = new HeartbeatQueue();
    q.markSeen("att_a", 1);
    const taken = q.takePending();
    expect([...taken]).toEqual([["att_a", 1]]);
    expect(q.pendingCount()).toBe(0);
    expect(q.peekSeen("att_a")).toBeUndefined();
  });

  test("mergePending keeps whichever instant is newer", () => {
    const q = new HeartbeatQueue();
    q.markSeen("att_a", 9_000); // arrived while the failed flush was in flight
    q.mergePending([
      ["att_a", 5_000],
      ["att_b", 5_000],
    ]);
    expect(q.peekSeen("att_a")).toBe(9_000);
    expect(q.peekSeen("att_b")).toBe(5_000);
  });
});

describe("flushSeen", () => {
  test("writes each attempt its OWN timestamp", async () => {
    const db = await freshDb();
    await seed(db, [{ id: "att_a" }, { id: "att_b" }, { id: "att_c" }]);
    const q = new HeartbeatQueue();
    q.markSeen("att_a", 1_000);
    q.markSeen("att_b", 2_000);
    q.markSeen("att_c", 3_000);

    expect(await q.flushSeen(db)).toBe(3);
    expect(await readSeen(db)).toEqual(
      new Map([
        ["att_a", 1_000],
        ["att_b", 2_000],
        ["att_c", 3_000],
      ]),
    );
    expect(q.pendingCount()).toBe(0);
  });

  test("stamps a row whose last_seen_at is NULL (the COALESCE branch)", async () => {
    const db = await freshDb();
    await seed(db, [{ id: "att_a", lastSeenAt: null }]);
    const q = new HeartbeatQueue();
    q.markSeen("att_a", 7_000);
    await q.flushSeen(db);
    expect((await readSeen(db)).get("att_a")).toBe(7_000);
  });

  test("never moves last_seen_at backwards over a fresher direct write", async () => {
    const db = await freshDb();
    // att_a autosaved (which writes last_seen_at) AFTER its pending heartbeat.
    await seed(db, [
      { id: "att_a", lastSeenAt: 9_000 },
      { id: "att_b", lastSeenAt: 1_000 },
    ]);
    const q = new HeartbeatQueue();
    q.markSeen("att_a", 5_000);
    q.markSeen("att_b", 5_000);
    await q.flushSeen(db);
    const seen = await readSeen(db);
    expect(seen.get("att_a")).toBe(9_000); // guard held
    expect(seen.get("att_b")).toBe(5_000); // moved forward
  });

  test("touches only the attempts it was given", async () => {
    const db = await freshDb();
    await seed(db, [
      { id: "att_a", lastSeenAt: null },
      { id: "att_untouched", lastSeenAt: 42 },
    ]);
    const q = new HeartbeatQueue();
    q.markSeen("att_a", 1_000);
    await q.flushSeen(db);
    expect((await readSeen(db)).get("att_untouched")).toBe(42);
  });

  test("a pending id with no attempt row is harmless", async () => {
    const db = await freshDb();
    await seed(db, [{ id: "att_a" }]);
    const q = new HeartbeatQueue();
    q.markSeen("att_a", 1_000);
    q.markSeen("att_deleted", 1_000);
    expect(await q.flushSeen(db)).toBe(2); // entries drained, 1 row matched
    expect((await readSeen(db)).get("att_a")).toBe(1_000);
    expect(q.pendingCount()).toBe(0);
  });

  test("writes every attempt across chunk boundaries", async () => {
    const db = await freshDb();
    const n = HEARTBEAT_FLUSH_CHUNK * 2 + 37;
    const ids = Array.from({ length: n }, (_, i) => `att_${i}`);
    await seed(db, ids.map((id) => ({ id })));
    const q = new HeartbeatQueue();
    ids.forEach((id, i) => q.markSeen(id, 1_000 + i));

    expect(await q.flushSeen(db)).toBe(n);
    const seen = await readSeen(db);
    expect(seen.size).toBe(n);
    for (let i = 0; i < n; i++) expect(seen.get(`att_${i}`)).toBe(1_000 + i);
  });

  test("flushing an empty queue is free and writes nothing", async () => {
    const db = await freshDb();
    const q = new HeartbeatQueue();
    expect(await q.flushSeen(db)).toBe(0);
  });

  test("a failed write puts the entries back instead of losing presence", async () => {
    const db = await freshDb();
    await seed(db, [{ id: "att_a" }]);
    const q = new HeartbeatQueue();
    q.markSeen("att_a", 1_000);

    const broken = {
      update: () => {
        throw new Error("socket hang up");
      },
    } as unknown as Db;
    expect(await q.flushSeen(broken)).toBe(0);
    expect(q.peekSeen("att_a")).toBe(1_000);

    // The next tick against a healthy database writes it.
    expect(await q.flushSeen(db)).toBe(1);
    expect((await readSeen(db)).get("att_a")).toBe(1_000);
  });

  test("a heartbeat arriving during a failed flush still wins", async () => {
    const db = await freshDb();
    await seed(db, [{ id: "att_a" }]);
    const q = new HeartbeatQueue();
    q.markSeen("att_a", 1_000);
    const broken = {
      update: () => {
        q.markSeen("att_a", 8_000); // the request that landed mid-flush
        throw new Error("socket hang up");
      },
    } as unknown as Db;
    await q.flushSeen(broken);
    expect(q.peekSeen("att_a")).toBe(8_000);
    await q.flushSeen(db);
    expect((await readSeen(db)).get("att_a")).toBe(8_000);
  });
});

describe("start/stop", () => {
  test("stop flushes what is pending", async () => {
    const db = await freshDb();
    await seed(db, [{ id: "att_a" }]);
    const q = new HeartbeatQueue();
    q.start(db, 60_000); // long period: only stop() can have written it
    q.markSeen("att_a", 1_000);
    await q.stop(db);
    expect((await readSeen(db)).get("att_a")).toBe(1_000);
  });

  test("the periodic flusher writes without anyone calling flushSeen", async () => {
    const db = await freshDb();
    await seed(db, [{ id: "att_a" }]);
    const q = new HeartbeatQueue();
    q.start(db, 5);
    q.start(db, 5); // idempotent — a second start must not double the writes
    q.markSeen("att_a", 1_000);
    await new Promise((r) => setTimeout(r, 60));
    expect((await readSeen(db)).get("att_a")).toBe(1_000);
    await q.stop(db);
  });
});
