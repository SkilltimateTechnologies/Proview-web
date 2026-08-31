/**
 * Proves the quota system is inert by default, correct when configured, and
 * incapable of the two failures that would matter on an exam day:
 *
 *   1. An unconfigured platform must behave EXACTLY as before, and must not pay
 *      per-request queries for a feature nobody switched on.
 *   2. A ceiling of 0 — an empty form field, a cleared input — must never be read
 *      as "refuse every student in the college".
 *
 * Plus the semantics that make the ceilings safe: the concurrency count sees only
 * this tenant's in-progress attempts, and the evidence ledger counts only
 * non-violation rows so misconduct can never be squeezed out by a quota.
 *
 * Runs against @libsql/client in-memory, NOT the app's `db` singleton.
 */
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as schema from "../database/schema";
import {
  ATTEMPT_TENANT_TTL_MS,
  AttemptTenantCache,
  CONCURRENCY_TTL_MS,
  ConcurrencyGate,
  EvidenceMeter,
  QUOTA_TTL_MS,
  TenantQuotaCache,
  UNLIMITED_QUOTA,
  quotaIsUnlimited,
  resolveLimit,
  resolveQuota,
  type Db,
} from "./tenant-quota";

/** Mirrors schema.ts. `attempts` DDL is duplicated in several test files — keep in sync. */
const DDL = [
  `CREATE TABLE tenants (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     short_name TEXT NOT NULL,
     slug TEXT NOT NULL UNIQUE,
     logo_url TEXT,
     primary_color TEXT NOT NULL DEFAULT '#1e3a5f',
     enabled INTEGER NOT NULL DEFAULT 1,
     max_concurrent_attempts INTEGER,
     max_evidence_per_attempt INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE exams (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL,
     title TEXT NOT NULL,
     class_id TEXT,
     section_ids TEXT,
     assign_mode TEXT NOT NULL DEFAULT 'cohort',
     status TEXT NOT NULL DEFAULT 'draft',
     start_at INTEGER,
     end_at INTEGER,
     duration_min INTEGER NOT NULL DEFAULT 60,
     total_points INTEGER NOT NULL DEFAULT 0,
     held_at INTEGER,
     hold_ms INTEGER NOT NULL DEFAULT 0,
     extra_min INTEGER NOT NULL DEFAULT 0,
     grading_mode TEXT,
     created_by TEXT,
     created_at INTEGER NOT NULL
   )`,
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
  `CREATE INDEX attempts_status_idx ON attempts (status)`,
];

const EVIDENCE_TYPES = new Set(["periodic_snapshot", "snapshot_failed", "focus_loss", "camera_restored", "evidence_capped"]);

let clients: Client[] = [];

/** Wraps a db so a test can assert how many SELECTs actually reached the database. */
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

async function seedTenant(db: Db, id: string, over: { concurrent?: number | null; evidence?: number | null } = {}) {
  await db.insert(schema.tenants).values({
    id,
    name: id,
    shortName: id.slice(0, 2).toUpperCase(),
    slug: id,
    maxConcurrentAttempts: over.concurrent ?? null,
    maxEvidencePerAttempt: over.evidence ?? null,
    createdAt: new Date(1),
  });
}

async function seedExam(db: Db, examId: string, tenantId: string) {
  await db.insert(schema.exams).values({ id: examId, tenantId, title: examId, createdAt: new Date(1) });
}

async function seedAttempt(db: Db, attemptId: string, examId: string, status: string) {
  await db.insert(schema.attempts).values({
    id: attemptId,
    examId,
    studentId: `stu_${attemptId}`,
    status,
    createdAt: new Date(1),
  });
}

async function seedEvents(db: Db, attemptId: string, type: string, n: number) {
  for (let i = 0; i < n; i++) {
    await db.insert(schema.integrityEvents).values({
      id: `${attemptId}_${type}_${i}`,
      attemptId,
      type,
      detail: null,
      photoUrl: null,
      at: new Date(1000 + i),
    });
  }
}

beforeEach(() => {
  clients = [];
});
afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
});

describe("resolveLimit", () => {
  test("tenant value wins over the global default", () => {
    expect(resolveLimit(300, 1000)).toBe(300);
  });

  test("null tenant value inherits the global default", () => {
    expect(resolveLimit(null, 1000)).toBe(1000);
    expect(resolveLimit(undefined, 1000)).toBe(1000);
  });

  test("nothing set anywhere is unlimited", () => {
    expect(resolveLimit(null, null)).toBeNull();
    expect(resolveLimit(undefined, undefined)).toBeNull();
  });

  /**
   * The single most dangerous input in this module. A cleared number field posts 0
   * or "", and reading that as a ceiling would refuse every student in a college
   * the moment their exam opened.
   */
  test("zero is 'not set', never 'block everything'", () => {
    expect(resolveLimit(0, null)).toBeNull();
    expect(resolveLimit(0, 500)).toBe(500); // falls through to the global default
    expect(resolveLimit(null, 0)).toBeNull();
    expect(resolveLimit(0, 0)).toBeNull();
  });

  test("negatives and junk are ignored the same way", () => {
    expect(resolveLimit(-5, null)).toBeNull();
    expect(resolveLimit(-5, 200)).toBe(200);
    expect(resolveLimit(Number.NaN, null)).toBeNull();
    expect(resolveLimit("abc", null)).toBeNull();
    expect(resolveLimit(Number.POSITIVE_INFINITY, null)).toBeNull();
  });

  test("fractions floor rather than throw", () => {
    expect(resolveLimit(10.9, null)).toBe(10);
    expect(resolveLimit(0.4, null)).toBeNull(); // floors to 0 => not set
  });

  test("string numbers from a form body still work", () => {
    expect(resolveLimit("250", null)).toBe(250);
  });
});

describe("resolveQuota", () => {
  test("resolves both ceilings independently", () => {
    const q = resolveQuota({ maxConcurrentAttempts: 100, maxEvidencePerAttempt: null }, { maxConcurrentAttempts: 999, maxEvidencePerAttempt: 300 });
    expect(q).toEqual({ maxConcurrentAttempts: 100, maxEvidencePerAttempt: 300 });
    expect(quotaIsUnlimited(q)).toBe(false);
  });

  test("no tenant and no globals is fully unlimited", () => {
    const q = resolveQuota(null, null);
    expect(q).toEqual(UNLIMITED_QUOTA);
    expect(quotaIsUnlimited(q)).toBe(true);
  });
});

describe("TenantQuotaCache", () => {
  test("unconfigured platform: unlimited, and the tenant row is never read", async () => {
    const raw = await freshDb();
    await seedTenant(raw, "ten_a");
    const { db, queries } = counted(raw);
    const cache = new TenantQuotaCache();

    const q = await cache.load(db, "ten_a", { maxConcurrentAttempts: null, maxEvidencePerAttempt: null }, 1_000);
    expect(q).toEqual(UNLIMITED_QUOTA);
    // Exactly one query: the cached "does any tenant have an override?" count.
    // The tenant row itself is not read, because nothing could be inherited.
    expect(queries()).toBe(1);
  });

  test("repeated loads inside the TTL cost nothing at all", async () => {
    const raw = await freshDb();
    await seedTenant(raw, "ten_a");
    const { db, queries } = counted(raw);
    const cache = new TenantQuotaCache();

    for (let i = 0; i < 200; i++) await cache.load(db, "ten_a", null, 1_000 + i);
    expect(queries()).toBe(1);
  });

  test("a global default is inherited, and a tenant override beats it", async () => {
    const raw = await freshDb();
    await seedTenant(raw, "ten_plain");
    await seedTenant(raw, "ten_capped", { concurrent: 50 });
    const cache = new TenantQuotaCache();
    const globals = { maxConcurrentAttempts: 800, maxEvidencePerAttempt: 400 };

    expect(await cache.load(raw, "ten_plain", globals, 1_000)).toEqual({ maxConcurrentAttempts: 800, maxEvidencePerAttempt: 400 });
    expect(await cache.load(raw, "ten_capped", globals, 1_000)).toEqual({ maxConcurrentAttempts: 50, maxEvidencePerAttempt: 400 });
  });

  test("a tenant override works with NO global default at all", async () => {
    const raw = await freshDb();
    await seedTenant(raw, "ten_a", { evidence: 120 });
    const cache = new TenantQuotaCache();

    // The overrides count finds the row, so the tenant read happens even though
    // there is nothing to inherit.
    const q = await cache.load(raw, "ten_a", null, 1_000);
    expect(q).toEqual({ maxConcurrentAttempts: null, maxEvidencePerAttempt: 120 });
  });

  test("a zero stored on the tenant row is ignored, not enforced", async () => {
    const raw = await freshDb();
    await seedTenant(raw, "ten_a", { concurrent: 0 });
    const cache = new TenantQuotaCache();

    const q = await cache.load(raw, "ten_a", { maxConcurrentAttempts: 700, maxEvidencePerAttempt: null }, 1_000);
    expect(q.maxConcurrentAttempts).toBe(700); // inherits, does NOT block
  });

  test("invalidate re-reads, so an admin change applies immediately", async () => {
    const raw = await freshDb();
    await seedTenant(raw, "ten_a", { concurrent: 100 });
    const cache = new TenantQuotaCache();
    expect((await cache.load(raw, "ten_a", null, 1_000)).maxConcurrentAttempts).toBe(100);

    await raw.update(schema.tenants).set({ maxConcurrentAttempts: 25 }).where(eq(schema.tenants.id, "ten_a"));
    // Without the invalidate the old number would stand for up to QUOTA_TTL_MS;
    // the admin write path calls it, so a change lands on the next request.
    expect((await cache.load(raw, "ten_a", null, 1_001)).maxConcurrentAttempts).toBe(100); // still cached
    cache.invalidate("ten_a");
    expect((await cache.load(raw, "ten_a", null, 1_002)).maxConcurrentAttempts).toBe(25);
  });

  test("the TTL expires an entry", async () => {
    const raw = await freshDb();
    await seedTenant(raw, "ten_a", { concurrent: 100 });
    const { db, queries } = counted(raw);
    const cache = new TenantQuotaCache();

    await cache.load(db, "ten_a", null, 1_000);
    const afterFirst = queries();
    await cache.load(db, "ten_a", null, 1_000 + QUOTA_TTL_MS);
    expect(queries()).toBeGreaterThan(afterFirst);
  });

  test("markTenantOverridesExist forces the tenant read without waiting for the count", async () => {
    const raw = await freshDb();
    await seedTenant(raw, "ten_a");
    const cache = new TenantQuotaCache();
    // Prime the "no overrides" answer.
    expect(await cache.load(raw, "ten_a", null, 1_000)).toEqual(UNLIMITED_QUOTA);

    // An admin sets an override on this tenant.
    await raw.insert(schema.tenants).values({ id: "ten_b", name: "b", shortName: "B", slug: "b", maxEvidencePerAttempt: 10, createdAt: new Date(1) });
    cache.markTenantOverridesExist(1_100);
    cache.invalidate("ten_a");
    // ten_a still has no override of its own, so it is still unlimited — but the
    // row was read to find that out rather than assumed.
    expect(await cache.load(raw, "ten_a", null, 1_100)).toEqual(UNLIMITED_QUOTA);
    expect(await cache.load(raw, "ten_b", null, 1_100)).toEqual({ maxConcurrentAttempts: null, maxEvidencePerAttempt: 10 });
  });

  test("an empty tenant id is unlimited and never queries", async () => {
    const raw = await freshDb();
    const { db, queries } = counted(raw);
    const cache = new TenantQuotaCache();
    expect(await cache.load(db, "", { maxConcurrentAttempts: 10, maxEvidencePerAttempt: 10 }, 1_000)).toEqual(UNLIMITED_QUOTA);
    expect(queries()).toBe(0);
  });
});

describe("ConcurrencyGate", () => {
  async function seedLive(db: Db, tenantId: string, examId: string, n: number, status = "in_progress") {
    await seedExam(db, examId, tenantId);
    for (let i = 0; i < n; i++) await seedAttempt(db, `${examId}_a${i}`, examId, status);
  }

  test("counts only this tenant's in-progress attempts", async () => {
    const raw = await freshDb();
    await seedLive(raw, "ten_a", "ex_a", 3);
    await seedLive(raw, "ten_b", "ex_b", 40); // another college, irrelevant
    await seedLive(raw, "ten_a", "ex_a2", 5, "submitted"); // finished, not live
    await seedLive(raw, "ten_a", "ex_a3", 2, "not_started"); // rostered, not live

    const gate = new ConcurrencyGate();
    const res = await gate.check(raw, "ten_a", 10, 1_000);
    expect(res.live).toBe(3);
    expect(res.allowed).toBe(true);
  });

  test("refuses at the ceiling, admits below it", async () => {
    const raw = await freshDb();
    await seedLive(raw, "ten_a", "ex_a", 5);
    const gate = new ConcurrencyGate();

    expect((await gate.check(raw, "ten_a", 6, 1_000)).allowed).toBe(true);
    gate.invalidate("ten_a");
    const atCeiling = await gate.check(raw, "ten_a", 5, 2_000);
    expect(atCeiling.allowed).toBe(false);
    expect(atCeiling.live).toBe(5);
    expect(atCeiling.limit).toBe(5);
  });

  test("a start burst inside one cache window is gated on admissions, not a stale count", async () => {
    const raw = await freshDb();
    await seedLive(raw, "ten_a", "ex_a", 8);
    const { db, queries } = counted(raw);
    const gate = new ConcurrencyGate();

    // Ceiling 10, already 8 live. Two more may start; the third must be refused,
    // even though the database count has not been re-read.
    expect((await gate.check(db, "ten_a", 10, 1_000)).allowed).toBe(true);
    gate.note("ten_a", 1_000);
    expect((await gate.check(db, "ten_a", 10, 1_001)).allowed).toBe(true);
    gate.note("ten_a", 1_001);
    const third = await gate.check(db, "ten_a", 10, 1_002);
    expect(third.allowed).toBe(false);
    expect(third.live).toBe(10);
    expect(queries()).toBe(1); // one count for the whole burst
  });

  test("the count is re-read once the TTL passes", async () => {
    const raw = await freshDb();
    await seedLive(raw, "ten_a", "ex_a", 2);
    const { db, queries } = counted(raw);
    const gate = new ConcurrencyGate();

    await gate.check(db, "ten_a", 100, 1_000);
    expect(queries()).toBe(1);
    await gate.check(db, "ten_a", 100, 1_000 + CONCURRENCY_TTL_MS);
    expect(queries()).toBe(2);
  });

  test("note() on an expired window is dropped rather than inflating the next count", async () => {
    const raw = await freshDb();
    await seedLive(raw, "ten_a", "ex_a", 1);
    const gate = new ConcurrencyGate();
    await gate.check(raw, "ten_a", 100, 1_000);
    gate.note("ten_a", 1_000 + CONCURRENCY_TTL_MS + 1); // window gone
    expect(gate.peek("ten_a")).toBe(1);
  });

  test("a tenant with nothing live is not blocked", async () => {
    const raw = await freshDb();
    await seedExam(raw, "ex_a", "ten_a");
    const gate = new ConcurrencyGate();
    const res = await gate.check(raw, "ten_a", 1, 1_000);
    expect(res.live).toBe(0);
    expect(res.allowed).toBe(true);
  });
});

describe("EvidenceMeter", () => {
  test("an uncapped attempt costs no query and has infinite room", async () => {
    const raw = await freshDb();
    const { db, queries } = counted(raw);
    const meter = new EvidenceMeter();
    expect(await meter.room(db, "att_1", null, EVIDENCE_TYPES, 1_000)).toBe(Number.POSITIVE_INFINITY);
    expect(queries()).toBe(0);
  });

  test("room is the ceiling minus the evidence already stored", async () => {
    const raw = await freshDb();
    await seedEvents(raw, "att_1", "periodic_snapshot", 40);
    const meter = new EvidenceMeter();
    expect(await meter.room(raw, "att_1", 100, EVIDENCE_TYPES, 1_000)).toBe(60);
  });

  /** The rule that must never bend: misconduct does not consume the evidence ceiling. */
  test("violations already on record do not eat the ceiling", async () => {
    const raw = await freshDb();
    await seedEvents(raw, "att_1", "periodic_snapshot", 10);
    await seedEvents(raw, "att_1", "tab_switch", 25);
    await seedEvents(raw, "att_1", "copy_paste", 15);
    const meter = new EvidenceMeter();
    expect(await meter.room(raw, "att_1", 100, EVIDENCE_TYPES, 1_000)).toBe(90);
  });

  test("another attempt's evidence is not counted", async () => {
    const raw = await freshDb();
    await seedEvents(raw, "att_1", "periodic_snapshot", 5);
    await seedEvents(raw, "att_2", "periodic_snapshot", 500);
    const meter = new EvidenceMeter();
    expect(await meter.room(raw, "att_1", 50, EVIDENCE_TYPES, 1_000)).toBe(45);
  });

  test("inserted rows are carried in memory: one seed query for a whole exam", async () => {
    const raw = await freshDb();
    await seedEvents(raw, "att_1", "periodic_snapshot", 0);
    const { db, queries } = counted(raw);
    const meter = new EvidenceMeter();

    let room = await meter.room(db, "att_1", 10, EVIDENCE_TYPES, 1_000);
    expect(room).toBe(10);
    for (let i = 0; i < 10; i++) {
      meter.add("att_1", 1, 1_000 + i);
      room = await meter.room(db, "att_1", 10, EVIDENCE_TYPES, 1_000 + i);
    }
    expect(room).toBe(0);
    expect(queries()).toBe(1);
  });

  test("room never goes negative, so a caller can always trim by it", async () => {
    const raw = await freshDb();
    await seedEvents(raw, "att_1", "periodic_snapshot", 90);
    const meter = new EvidenceMeter();
    expect(await meter.room(raw, "att_1", 10, EVIDENCE_TYPES, 1_000)).toBe(0);
  });

  test("the capped marker is written exactly once per attempt", async () => {
    const raw = await freshDb();
    const meter = new EvidenceMeter();
    await meter.room(raw, "att_1", 1, EVIDENCE_TYPES, 1_000);
    expect(meter.noticeOnce("att_1")).toBe(true);
    expect(meter.noticeOnce("att_1")).toBe(false);
    expect(meter.noticeOnce("att_1")).toBe(false);
  });

  test("noticeOnce on an untracked attempt is false — no marker without a ceiling", () => {
    const meter = new EvidenceMeter();
    expect(meter.noticeOnce("att_unknown")).toBe(false);
  });

  test("add() on an untracked attempt is a no-op rather than a phantom entry", () => {
    const meter = new EvidenceMeter();
    meter.add("att_unknown", 5);
    expect(meter.size()).toBe(0);
  });

  /**
   * Deletes push the carried count too HIGH (the safe direction — the ceiling
   * engages early), and the admin delete paths clear it so a re-sit starts fresh.
   */
  test("a re-sit after a delete is not stuck at the old ceiling", async () => {
    const raw = await freshDb();
    await seedEvents(raw, "att_1", "periodic_snapshot", 50);
    const meter = new EvidenceMeter();
    expect(await meter.room(raw, "att_1", 50, EVIDENCE_TYPES, 1_000)).toBe(0);

    await raw.delete(schema.integrityEvents);
    expect(await meter.room(raw, "att_1", 50, EVIDENCE_TYPES, 1_100)).toBe(0); // stale, documented
    meter.invalidateAll();
    expect(await meter.room(raw, "att_1", 50, EVIDENCE_TYPES, 1_200)).toBe(50); // healed
  });
});

describe("AttemptTenantCache", () => {
  test("resolves the owning tenant through the exam", async () => {
    const raw = await freshDb();
    await seedExam(raw, "ex_a", "ten_a");
    await seedAttempt(raw, "att_1", "ex_a", "in_progress");
    const cache = new AttemptTenantCache();
    expect(await cache.load(raw, "att_1", 1_000)).toBe("ten_a");
  });

  test("400 lookups of one attempt cost a single query", async () => {
    const raw = await freshDb();
    await seedExam(raw, "ex_a", "ten_a");
    await seedAttempt(raw, "att_1", "ex_a", "in_progress");
    const { db, queries } = counted(raw);
    const cache = new AttemptTenantCache();
    for (let i = 0; i < 400; i++) expect(await cache.load(db, "att_1", 1_000 + i)).toBe("ten_a");
    expect(queries()).toBe(1);
  });

  test("an unknown attempt returns null and is not remembered", async () => {
    const raw = await freshDb();
    const { db, queries } = counted(raw);
    const cache = new AttemptTenantCache();
    expect(await cache.load(db, "att_missing", 1_000)).toBeNull();
    expect(await cache.load(db, "att_missing", 1_001)).toBeNull();
    expect(queries()).toBe(2); // negatives are not cached
    expect(cache.size()).toBe(0);
  });

  test("an empty attempt id never reaches the database", async () => {
    const raw = await freshDb();
    const { db, queries } = counted(raw);
    const cache = new AttemptTenantCache();
    expect(await cache.load(db, "", 1_000)).toBeNull();
    expect(queries()).toBe(0);
  });

  test("the entry expires at the TTL", async () => {
    const raw = await freshDb();
    await seedExam(raw, "ex_a", "ten_a");
    await seedAttempt(raw, "att_1", "ex_a", "in_progress");
    const { db, queries } = counted(raw);
    const cache = new AttemptTenantCache();
    await cache.load(db, "att_1", 1_000);
    await cache.load(db, "att_1", 1_000 + ATTEMPT_TENANT_TTL_MS);
    expect(queries()).toBe(2);
  });
});
