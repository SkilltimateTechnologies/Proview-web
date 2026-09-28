import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { Hono } from "hono";
import * as schema from "../database/schema";
import { createBulkStudentPasswords, type ResetActor, type ResetScope } from "./bulk-student-passwords";
import { bulkResetHandler, type BulkResetClient } from "../routes/bulk-student-passwords";

const actor: ResetActor = { userId: "admin-a", tenantId: "a", role: "college_admin", enabled: true, permissions: null };
const all: ResetScope = { tenantId: "a", scope: "all" };
const selected: ResetScope = { tenantId: "a", scope: "selected", studentIds: ["a1", "a2"] };
let client: Client;
let db: ReturnType<typeof drizzle<typeof schema>>;
let service: ReturnType<typeof createBulkStudentPasswords>;
let time: number;
let invalidated: string[];
let serial: number;
let tempDir: string;
beforeEach(async () => {
  // libSQL closes/reopens its SQLite connection after a transaction; :memory:
  // then loses the schema. Use an isolated, disposable local file instead.
  tempDir = mkdtempSync(join(tmpdir(), "proview-reset-test-"));
  client = createClient({ url: `file:${join(tempDir, "test.db")}` });
  db = drizzle(client, { schema }); time = 1000; invalidated = []; serial = 0;
  await client.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE students (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, class_id TEXT, original_class_id TEXT, roll_no TEXT NOT NULL, name TEXT NOT NULL, email TEXT, phone TEXT, gender TEXT, password TEXT NOT NULL, must_change_password INTEGER NOT NULL, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE staff (id TEXT PRIMARY KEY, password TEXT);
    CREATE TABLE exams (id TEXT PRIMARY KEY, data TEXT);
    INSERT INTO tenants VALUES ('a', 'College A'), ('b', 'College B'), ('empty', 'Empty college');
    INSERT INTO staff VALUES ('staff', 'untouched');
    INSERT INTO exams VALUES ('exam', 'answers untouched');
  `);
  await db.insert(schema.students).values([
    { id: "a1", tenantId: "a", name: "Student One", rollNo: "1", classId: "regular", password: "old", mustChangePassword: false },
    { id: "a2", tenantId: "a", name: "Student Two", rollNo: "2", classId: "elite", password: "old", mustChangePassword: false, enabled: false },
    { id: "a3", tenantId: "a", name: "Student Three", rollNo: "3", password: "old", mustChangePassword: false },
    { id: "b1", tenantId: "b", name: "Other College", rollNo: "1", password: "old", mustChangePassword: false },
  ]);
  service = makeService();
});
afterEach(() => { client.close(); rmSync(tempDir, { recursive: true, force: true }); });
function makeService(hash = async (password: string) => `${password}-salt-${++serial}`) {
  return createBulkStudentPasswords({ db, secret: () => "synthetic-test-only-secret", invalidate: id => invalidated.push(id), now: () => time, hash });
}
async function snapshot() { return db.select().from(schema.students).orderBy(schema.students.id); }
async function confirm(input = all, who: ResetActor | null = actor) { return service.preview(who, input); }

describe("bulk student passwords: isolated SQLite", () => {
  test("omitted policy defaults to requiring a change, equivalent to explicit true", async () => {
    const review = await confirm();
    expect(review.mustChangePassword).toBe(true);
    expect(await service.reset(actor, { ...all, mustChangePassword: true }, review.confirmationToken)).toEqual({ count: 3, mustChangePassword: true });
  });
  test.each(["all", "selected"] as const)("%s can skip next-login change and clear existing required flags only for targets", async scope => {
    await db.update(schema.students).set({ mustChangePassword: true });
    const target: ResetScope = { ...(scope === "all" ? all : selected), mustChangePassword: false };
    const before = await snapshot(); const review = await confirm(target);
    expect(review.mustChangePassword).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(await service.reset(actor, target, review.confirmationToken)).toEqual({ count: scope === "all" ? 3 : 2, mustChangePassword: false });
    const after = await snapshot();
    for (let i = 0; i < after.length; i++) {
      const row = after[i]!;
      const included = row.tenantId === "a" && (scope === "all" || ["a1", "a2"].includes(row.id));
      expect(row).toEqual(included ? { ...before[i], password: "Welcome@123-salt-1", mustChangePassword: false } : before[i]);
    }
    expect((await client.execute("SELECT * FROM staff")).rows).toEqual([{ id: "staff", password: "untouched" }]);
    expect((await client.execute("SELECT * FROM exams")).rows).toEqual([{ id: "exam", data: "answers untouched" }]);
    expect(invalidated).toEqual(["a"]);
    await expect(service.reset(actor, target, review.confirmationToken)).rejects.toThrow("already applied");
  });
  test.each([true, false])("confirmation binds policy %s and refuses toggling it without re-review", async mustChangePassword => {
    const target = { ...selected, mustChangePassword };
    const review = await confirm(target); const before = await snapshot();
    await expect(service.reset(actor, { ...target, mustChangePassword: !mustChangePassword }, review.confirmationToken)).rejects.toThrow("does not match");
    expect(await snapshot()).toEqual(before); expect(invalidated).toEqual([]);
  });
  test.each([null, "false", 0])("rejects non-boolean next-login policy %s", async value => {
    await expect(confirm({ ...all, mustChangePassword: value } as unknown as ResetScope)).rejects.toThrow();
  });
  test("preview reports all, elite and disabled, writes nothing and leaks no credentials", async () => {
    const before = await snapshot(); const review = await confirm();
    expect(review).toMatchObject({ count: 3, disabledCount: 1, collegeName: "College A", tenantId: "a", expiresAt: 301000 });
    expect(await snapshot()).toEqual(before); expect(invalidated).toEqual([]);
    expect(JSON.stringify(review)).not.toContain('"password"');
  });
  test("selected deduplicates IDs and changes exactly those accounts", async () => {
    const target: ResetScope = { ...selected, studentIds: ["a1", "a2", "a1"] };
    const before = await snapshot(); const review = await confirm(target);
    expect(review.count).toBe(2);
    expect(await service.reset(actor, target, review.confirmationToken)).toEqual({ count: 2, mustChangePassword: true });
    const after = await snapshot();
    for (let i = 0; i < after.length; i++) {
      if (["a1", "a2"].includes(after[i]!.id)) expect(after[i]).toEqual({ ...before[i], password: "Welcome@123-salt-1", mustChangePassword: true });
      else expect(after[i]).toEqual(before[i]);
    }
    expect(invalidated).toEqual(["a"]);
    expect((await client.execute("SELECT * FROM staff")).rows).toEqual([{ id: "staff", password: "untouched" }]);
    expect((await client.execute("SELECT * FROM exams")).rows).toEqual([{ id: "exam", data: "answers untouched" }]);
  });
  test("all includes every section, leaves other tenant untouched, real hashes verify", async () => {
    service = makeService(hashPassword);
    const review = await confirm(); await service.reset(actor, all, review.confirmationToken);
    const rows = await snapshot();
    for (const row of rows.filter(r => r.tenantId === "a")) {
      expect(row.mustChangePassword).toBe(true);
      expect(await verifyPassword({ hash: row.password, password: "Welcome@123" })).toBe(true);
      expect(await verifyPassword({ hash: row.password, password: "old" })).toBe(false);
    }
    expect(rows.find(r => r.id === "b1")!.password).toBe("old");
    expect(rows.find(r => r.id === "a2")!.enabled).toBe(false);
  });
  test.each([
    ["signed out", null], ["disabled", { ...actor, enabled: false }],
    ["student role", { ...actor, role: "student" }], ["TPO without users", { ...actor, role: "tpo" }],
    ["wrong tenant", { ...actor, tenantId: "b" }], ["unscoped superadmin", { ...actor, tenantId: null, role: "super_admin" }],
  ] as const)("rejects %s at preview and reset", async (_label, who) => {
    const review = await confirm(); const before = await snapshot();
    await expect(confirm(all, who)).rejects.toThrow();
    await expect(service.reset(who, all, review.confirmationToken)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  test.each(["super_admin", "college_admin", "tpo"])("allows scoped %s with permission", async role => {
    expect((await confirm(all, { ...actor, role, permissions: { users: true } })).count).toBe(3);
  });
  test("rejects mixed tenants, missing IDs, empty or extra input fields", async () => {
    for (const studentIds of [["a1", "b1"], ["missing"], []]) {
      await expect(confirm({ ...selected, studentIds })).rejects.toThrow();
    }
    await expect(confirm({ ...all, password: "custom" } as ResetScope)).rejects.toThrow();
    await expect(confirm({ tenantId: "empty", scope: "all" }, { ...actor, tenantId: "empty" })).rejects.toThrow("No students");
    await expect(confirm({ tenantId: "missing", scope: "all" }, { ...actor, tenantId: "missing" })).rejects.toThrow("College not found");
  });
  test("confirmation binds actor and exact selection/scope", async () => {
    const review = await confirm(selected);
    await expect(service.reset({ ...actor, userId: "different-admin" }, selected, review.confirmationToken)).rejects.toThrow("does not match");
    await expect(service.reset(actor, all, review.confirmationToken)).rejects.toThrow("does not match");
    await expect(service.reset(actor, { ...selected, studentIds: ["a1"] }, review.confirmationToken)).rejects.toThrow("does not match");
  });
  test("expired, tampered and replayed confirmations fail", async () => {
    const review = await confirm();
    await expect(service.reset(actor, all, review.confirmationToken + "x")).rejects.toThrow("Invalid confirmation");
    time = review.expiresAt;
    await expect(service.reset(actor, all, review.confirmationToken)).rejects.toThrow("expired");
    time = 1000; await service.reset(actor, all, review.confirmationToken);
    await expect(service.reset(actor, all, review.confirmationToken)).rejects.toThrow("already applied");
    expect(invalidated).toEqual(["a"]);
  });
  test.each(["password", "enabled", "mustChangePassword", "added", "deleted"])("rejects stale %s snapshot without partial writes", async change => {
    const review = await confirm();
    if (change === "added") await db.insert(schema.students).values({ id: "new", tenantId: "a", rollNo: "4", name: "New", password: "old" });
    else if (change === "deleted") await db.delete(schema.students).where(eq(schema.students.id, "a1"));
    else await db.update(schema.students).set(change === "password" ? { password: "changed" } : change === "enabled" ? { enabled: false } : { mustChangePassword: true }).where(eq(schema.students.id, "a1"));
    const before = await snapshot();
    await expect(service.reset(actor, all, review.confirmationToken)).rejects.toThrow("Student accounts changed");
    expect(await snapshot()).toEqual(before); expect(invalidated).toEqual([]);
  });
  test("database failure rolls back every row", async () => {
    await client.executeMultiple(`CREATE TRIGGER reject_reset BEFORE UPDATE ON students WHEN new.id = 'a2' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`);
    const review = await confirm(); const before = await snapshot();
    await expect(service.reset(actor, all, review.confirmationToken)).rejects.toThrow();
    expect(await snapshot()).toEqual(before); expect(invalidated).toEqual([]);
  });
  test("hashing failure makes no writes; expiry during hashing is checked again", async () => {
    const review = await confirm(); const before = await snapshot();
    service = makeService(async () => { throw new Error("hash failed"); });
    await expect(service.reset(actor, all, review.confirmationToken)).rejects.toThrow("hash failed");
    service = makeService(async () => { time = review.expiresAt; return "new"; });
    await expect(service.reset(actor, all, review.confirmationToken)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  test("missing signing configuration fails closed", async () => {
    service = createBulkStudentPasswords({ db, secret: () => "", invalidate: () => {} });
    await expect(confirm()).rejects.toThrow("not configured");
  });
  test("oRPC wire + Hono mount: validates acknowledgment, permission and returns exact counts", async () => {
    let profile: ResetActor | null = actor;
    const app = new Hono().basePath("api").all("/rpc/*", async c => {
      const result = await bulkResetHandler.handle(c.req.raw, { prefix: "/api/rpc", context: { profile, service } });
      return result.response ?? c.json({ message: "Not found" }, 404);
    });
    const rpc: BulkResetClient = createORPCClient(new RPCLink({ url: "http://localhost/api/rpc", fetch: request => app.fetch(request) }));
    const review = await rpc.bulkStudentPasswords.preview(selected);
    const input = { target: selected, confirmationToken: review.confirmationToken, acknowledged: true as const };
    await expect(rpc.bulkStudentPasswords.reset({ ...input, acknowledged: false } as unknown as typeof input)).rejects.toThrow();
    profile = null; await expect(rpc.bulkStudentPasswords.reset(input)).rejects.toThrow("Sign in");
    profile = { ...actor, role: "tpo" }; await expect(rpc.bulkStudentPasswords.reset(input)).rejects.toThrow("permission");
    profile = actor;
    expect(await rpc.bulkStudentPasswords.reset(input)).toEqual({ count: 2, mustChangePassword: true });
    const optionalTarget = { ...selected, mustChangePassword: false };
    const optionalReview = await rpc.bulkStudentPasswords.preview(optionalTarget);
    expect(optionalReview.mustChangePassword).toBe(false);
    expect(await rpc.bulkStudentPasswords.reset({ target: optionalTarget, confirmationToken: optionalReview.confirmationToken, acknowledged: true })).toEqual({ count: 2, mustChangePassword: false });
    expect((await snapshot()).filter(row => ["a1", "a2"].includes(row.id)).every(row => !row.mustChangePassword)).toBe(true);
    expect((await app.request("/api/rpc/nonexistent")).status).toBe(404);
  });
});
