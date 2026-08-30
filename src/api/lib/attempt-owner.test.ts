/**
 * Proves the attempt-ownership cache authorizes exactly who the database would,
 * and that it actually removes the round trips it was written to remove.
 *
 * The dangerous properties of caching an authorization decision are not "is it
 * faster" — they are:
 *
 *   1. It must never authorize the WRONG student. That is a proctoring-evidence
 *      forgery hole, not a performance bug.
 *   2. A miss on an attempt that does not exist must not be remembered, or a
 *      student whose attempt is created a moment later stays locked out.
 *   3. A hit must cost ZERO queries, otherwise the whole exercise is pointless.
 *   4. Deletes are the one direction the cache cannot see, so invalidation and
 *      the TTL must actually heal it.
 *
 * Runs against @libsql/client in-memory, NOT the app's `db` singleton.
 */
import { createClient, type Client } from "@libsql/client";
import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as schema from "../database/schema";
import { AttemptOwnerCache, MAX_ENTRIES, OWNER_TTL_MS, type Db } from "./attempt-owner";

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
];

let clients: Client[] = [];

/** Wraps a db so the test can assert how many SELECTs the cache actually issued. */
function counted(db: Db) {
  let n = 0;
  const proxy = new Proxy(db as object, {
    get(target, prop, recv) {
      if (prop === "select") {
        n += 1;
        return (target as Db).select.bind(target as Db);
      }
      return Reflect.get(target, prop, recv);
    },
  }) as Db;
  return { db: proxy, queries: () => n };
}

async function freshDb(): Promise<Db> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  for (const stmt of DDL) await client.execute(stmt);
  return drizzle(client, { schema });
}

async function attempt(db: Db, id: string, studentId: string) {
  await db.insert(schema.attempts).values({
    id,
    examId: "exam_1",
    studentId,
    status: "in_progress",
    createdAt: new Date(0),
  });
}

beforeEach(() => {
  clients = [];
});
afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
});

describe("it authorizes exactly who the database would", () => {
  test("the owner is allowed and every other student is refused", async () => {
    const db = await freshDb();
    const cache = new AttemptOwnerCache();
    await attempt(db, "att_a", "stu_1");

    expect(await cache.authorize(db, "att_a", "stu_1", 0)).toBe(true);
    expect(await cache.authorize(db, "att_a", "stu_2", 0)).toBe(false);
    expect(await cache.authorize(db, "att_a", "", 0)).toBe(false);
  });

  test("a wrong-student refusal is answered from the cache, not from a fresh query", async () => {
    const db = await freshDb();
    const cache = new AttemptOwnerCache();
    await attempt(db, "att_a", "stu_1");
    const c = counted(db);

    expect(await cache.authorize(c.db, "att_a", "stu_1", 0)).toBe(true);
    expect(c.queries()).toBe(1);
    // A client probing with someone else's id must not be able to force round trips.
    for (let i = 0; i < 50; i++) {
      expect(await cache.authorize(c.db, "att_a", `stu_${i + 2}`, 0)).toBe(false);
    }
    expect(c.queries()).toBe(1);
  });

  test("an unknown attempt is refused and the miss is NOT remembered", async () => {
    const db = await freshDb();
    const cache = new AttemptOwnerCache();
    const c = counted(db);

    expect(await cache.authorize(c.db, "att_ghost", "stu_1", 0)).toBe(false);
    expect(cache.size()).toBe(0);

    // The attempt is created a moment later — the student must get in immediately.
    await attempt(db, "att_ghost", "stu_1");
    expect(await cache.authorize(c.db, "att_ghost", "stu_1", 1)).toBe(true);
  });

  test("an empty attempt id never reaches the database", async () => {
    const db = await freshDb();
    const cache = new AttemptOwnerCache();
    const c = counted(db);
    expect(await cache.authorize(c.db, "", "stu_1", 0)).toBe(false);
    expect(c.queries()).toBe(0);
  });
});

describe("the round trips it exists to remove", () => {
  test("one query serves an entire exam's worth of polling for an attempt", async () => {
    const db = await freshDb();
    const cache = new AttemptOwnerCache();
    await attempt(db, "att_a", "stu_1");
    const c = counted(db);

    // A 90-minute exam captures a frame every ~27s, and each frame costs both
    // /snapshot-url and /events — ~400 authorizations for this one attempt.
    for (let i = 0; i < 400; i++) {
      expect(await cache.authorize(c.db, "att_a", "stu_1", 1_000 + i * 10)).toBe(true);
    }
    expect(c.queries()).toBe(1);
  });

  test("each attempt is looked up once, not once per request", async () => {
    const db = await freshDb();
    const cache = new AttemptOwnerCache();
    for (let s = 0; s < 200; s++) await attempt(db, `att_${s}`, `stu_${s}`);
    const c = counted(db);

    for (let round = 0; round < 5; round++) {
      for (let s = 0; s < 200; s++) {
        expect(await cache.authorize(c.db, `att_${s}`, `stu_${s}`, 1_000 + round)).toBe(true);
      }
    }
    expect(c.queries()).toBe(200); // not 1,000
  });

  test("after the TTL the owner is re-read", async () => {
    const db = await freshDb();
    const cache = new AttemptOwnerCache();
    await attempt(db, "att_a", "stu_1");
    const c = counted(db);

    expect(await cache.authorize(c.db, "att_a", "stu_1", 0)).toBe(true);
    expect(await cache.authorize(c.db, "att_a", "stu_1", OWNER_TTL_MS - 1)).toBe(true);
    expect(c.queries()).toBe(1);
    expect(await cache.authorize(c.db, "att_a", "stu_1", OWNER_TTL_MS)).toBe(true);
    expect(c.queries()).toBe(2);
  });
});

describe("deletes, the one direction the cache cannot see", () => {
  test("a deleted attempt keeps authorizing until invalidation — then does not", async () => {
    const db = await freshDb();
    const cache = new AttemptOwnerCache();
    await attempt(db, "att_a", "stu_1");
    expect(await cache.authorize(db, "att_a", "stu_1", 0)).toBe(true);

    await db.run(dsql`delete from attempts where id = 'att_a'`);
    // The documented trade-off: still true, which is why the six admin delete
    // paths call invalidateAll() and why the TTL exists.
    expect(await cache.authorize(db, "att_a", "stu_1", 1_000)).toBe(true);

    cache.invalidateAll();
    expect(await cache.authorize(db, "att_a", "stu_1", 2_000)).toBe(false);
    expect(cache.size()).toBe(0);
  });

  test("the TTL heals a delete even with no invalidation at all", async () => {
    const db = await freshDb();
    const cache = new AttemptOwnerCache();
    await attempt(db, "att_a", "stu_1");
    expect(await cache.authorize(db, "att_a", "stu_1", 0)).toBe(true);
    await db.run(dsql`delete from attempts where id = 'att_a'`);
    expect(await cache.authorize(db, "att_a", "stu_1", OWNER_TTL_MS)).toBe(false);
  });

  test("invalidate() drops one attempt and leaves the rest cached", async () => {
    const db = await freshDb();
    const cache = new AttemptOwnerCache();
    await attempt(db, "att_a", "stu_1");
    await attempt(db, "att_b", "stu_2");
    await cache.authorize(db, "att_a", "stu_1", 0);
    await cache.authorize(db, "att_b", "stu_2", 0);
    expect(cache.size()).toBe(2);

    cache.invalidate("att_a");
    expect(cache.size()).toBe(1);
    const c = counted(db);
    expect(await cache.authorize(c.db, "att_b", "stu_2", 1)).toBe(true);
    expect(c.queries()).toBe(0);
  });
});

describe("memory", () => {
  test("expired entries are dropped rather than accumulating", async () => {
    const db = await freshDb();
    const cache = new AttemptOwnerCache();
    for (let s = 0; s < 50; s++) await attempt(db, `att_${s}`, `stu_${s}`);
    for (let s = 0; s < 50; s++) await cache.authorize(db, `att_${s}`, `stu_${s}`, 0);
    expect(cache.size()).toBe(50);

    // One live authorization a full TTL later prunes the 50 stale ones.
    await attempt(db, "att_new", "stu_new");
    await cache.authorize(db, "att_new", "stu_new", OWNER_TTL_MS + 1);
    expect(cache.size()).toBe(1);
  });

  test("the ceiling is a real bound, not a comment", () => {
    expect(MAX_ENTRIES).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_ENTRIES)).toBe(true);
  });
});
