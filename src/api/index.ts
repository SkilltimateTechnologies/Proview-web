import { Hono } from "hono";
import { cors } from "hono/cors";
import { eq, ne, and, or, desc, inArray, like, sql as dsql } from "drizzle-orm";
import { auth } from "./auth";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { db } from "./database";
import * as schema from "./database/schema";
import { authMiddleware, requireAuth, requireSuperAdmin, requirePermission } from "./middleware/auth";
import type { SessionUser, ProfileCtx } from "./middleware/auth";
import { id, displayId, autoGrade, computeYear, effectiveEndMs } from "./lib/util";
import { generateQuestions } from "./lib/ai";
import { queueAttemptGrading, finalizeAttempt } from "./lib/grade-queue";
import { presignPut, getObject } from "./lib/s3";
import { signStudentToken, verifyStudentToken } from "./lib/student-token";
import { judge0Queue, resolveJudge0Config } from "./lib/judge0-queue";

type Vars = { user: SessionUser | null; profile: ProfileCtx | null };

/** Platform-global settings live in a single row (id = "global"). */
const GLOBAL_SETTINGS = "global";
async function getGlobalSettings() {
  let [s] = await db.select().from(schema.settings).where(eq(schema.settings.id, GLOBAL_SETTINGS));
  if (!s) [s] = await db.insert(schema.settings).values({ id: GLOBAL_SETTINGS }).returning();
  return s;
}

// Resolve the tenant for the public registration page from a URL code.
// Accepts (case-insensitive) the college short code (shortName), the slug, or the raw tenant id.
async function resolveRegisterTenant(codeRaw: string) {
  const code = String(codeRaw ?? "").trim();
  if (!code) return null;
  const lower = code.toLowerCase();
  const [byCode] = await db
    .select()
    .from(schema.tenants)
    .where(
      and(
        eq(schema.tenants.enabled, true),
        or(
          dsql`lower(${schema.tenants.shortName}) = ${lower}`,
          dsql`lower(${schema.tenants.slug}) = ${lower}`,
          eq(schema.tenants.id, code),
        ),
      ),
    );
  return byCode ?? null;
}

const app = new Hono<{ Variables: Vars }>()
  .use(cors({ origin: (origin) => origin ?? "*", credentials: true, exposeHeaders: ["set-auth-token"] }))
  .on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
  .basePath("api")
  .use("*", authMiddleware)
  .get("/health", (c) => c.json({ status: "ok" }, 200))

  // ---- TEMP diagnostic: verify DB connectivity + env presence ----
  .get("/__diag", async (c) => {
    const env = {
      DATABASE_URL: process.env.DATABASE_URL
        ? `${process.env.DATABASE_URL.slice(0, 14)}… (len ${process.env.DATABASE_URL.length})`
        : "MISSING",
      DATABASE_AUTH_TOKEN: process.env.DATABASE_AUTH_TOKEN
        ? `set (len ${process.env.DATABASE_AUTH_TOKEN.length})`
        : "MISSING",
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ? "set" : "MISSING",
      WEBSITE_URL: process.env.WEBSITE_URL ?? "MISSING",
    };
    try {
      const [u] = await db.select().from(schema.user).limit(1);
      return c.json({ db: "ok", userFound: !!u, env }, 200);
    } catch (e) {
      return c.json(
        { db: "error", error: e instanceof Error ? e.message : String(e), env },
        500,
      );
    }
  })

  // ---- current session context ----
  .get("/me", requireAuth, async (c) => {
    const user = c.get("user")!;
    const profile = c.get("profile")!;
    let tenant = null;
    if (profile.tenantId) {
      const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, profile.tenantId));
      tenant = t ?? null;
    }
    return c.json({ user, profile, tenant }, 200);
  })

  // ---- file upload presign (client -> tigris directly) ----
  .post("/upload/presign", requireAuth, async (c) => {
    const { name, contentType } = await c.req.json();
    const key = `uploads/${Date.now()}-${id()}-${(name ?? "file").replace(/[^\w.-]/g, "_")}`;
    const url = await presignPut(key, contentType ?? "application/octet-stream");
    // Tigris objects are not public-read (raw endpoint URL returns 403), so we
    // serve uploads through our own same-origin proxy route below.
    return c.json({ url, key, publicUrl: `/api/files/${key}` }, 200);
  })

  // ---- public file proxy (streams object from S3; no auth needed to view) ----
  .get("/files/*", async (c) => {
    const key = c.req.path.replace(/^\/api\/files\//, "");
    if (!key) return c.text("Not found", 404);
    try {
      const out = await getObject(key);
      if (!out.Body) return c.text("Not found", 404);
      const buf = await out.Body.transformToByteArray();
      return c.body(buf, 200, {
        "Content-Type": out.ContentType ?? "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
    } catch {
      return c.text("Not found", 404);
    }
  })

  // =================== PUBLIC SELF-REGISTRATION (no auth) ===================
  // Meta for the public registration page: tenant name + section dropdown list.
  // The URL uses the college short code (e.g. /register/tkr), resolved below.
  .get("/register/:code/meta", async (c) => {
    const t = await resolveRegisterTenant(c.req.param("code"));
    if (!t) return c.json({ message: "Invalid registration link" }, 404);
    const rows = await db
      .select({ id: schema.classes.id, code: schema.classes.code })
      .from(schema.classes)
      .where(eq(schema.classes.tenantId, t.id));
    rows.sort((a, b) => a.code.localeCompare(b.code));
    return c.json({ tenant: { id: t.id, name: t.name, code: t.shortName }, sections: rows }, 200);
  })
  // Check whether a student already exists for this tenant — by roll number OR name.
  .get("/register/:code/check", async (c) => {
    const raw = String(c.req.query("q") ?? c.req.query("rollNo") ?? "").trim();
    if (!raw) return c.json({ message: "Enter a roll number or name" }, 400);
    const t = await resolveRegisterTenant(c.req.param("code"));
    if (!t) return c.json({ message: "Invalid registration link" }, 404);
    const tid = t.id;

    const roll = raw.replace(/\s+/g, "").toUpperCase();
    const nameQ = raw.replace(/\s+/g, " ");
    // A query containing a digit is treated as a roll number; otherwise a name.
    const looksLikeRoll = /\d/.test(raw);

    const rows = await db
      .select({ name: schema.students.name, rollNo: schema.students.rollNo })
      .from(schema.students)
      .where(
        and(
          eq(schema.students.tenantId, tid),
          or(eq(schema.students.rollNo, roll), like(schema.students.name, `%${nameQ}%`)),
        ),
      )
      .limit(6);

    return c.json(
      {
        query: raw,
        looksLikeRoll,
        exists: rows.length > 0,
        matches: rows,
        name: rows[0]?.name ?? null,
        rollNo: looksLikeRoll ? roll : (rows[0]?.rollNo ?? ""),
      },
      200,
    );
  })
  // Register a new student (only if the roll number is not already present).
  .post("/register/:code", async (c) => {
    const rt = await resolveRegisterTenant(c.req.param("code"));
    if (!rt) return c.json({ message: "Invalid registration link" }, 404);
    const tid = rt.id;
    const b = await c.req.json();

    const roll = String(b.rollNo ?? "").trim().replace(/\s+/g, "").toUpperCase();
    const name = String(b.name ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
    const email = String(b.email ?? "").trim().toLowerCase();
    const phone = String(b.phone ?? "").trim();
    const gender = String(b.gender ?? "").trim().toLowerCase();
    const classId = b.classId ? String(b.classId) : null;

    if (!roll) return c.json({ message: "Roll number is required" }, 400);
    if (!name) return c.json({ message: "Name is required" }, 400);
    if (!classId) return c.json({ message: "Please select your section" }, 400);
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return c.json({ message: "A valid email is required" }, 400);
    if (!/^\d{10}$/.test(phone.replace(/\D/g, "").slice(-10))) return c.json({ message: "A valid phone number is required" }, 400);
    if (gender !== "male" && gender !== "female") return c.json({ message: "Please select gender" }, 400);

    // Section must belong to this tenant.
    const [cls] = await db
      .select({ id: schema.classes.id })
      .from(schema.classes)
      .where(and(eq(schema.classes.id, classId), eq(schema.classes.tenantId, tid)));
    if (!cls) return c.json({ message: "Invalid section" }, 400);

    // Block duplicates by roll number (case-insensitive; already upper-cased).
    const [dupRoll] = await db
      .select({ id: schema.students.id })
      .from(schema.students)
      .where(and(eq(schema.students.tenantId, tid), eq(schema.students.rollNo, roll)));
    if (dupRoll) return c.json({ message: "This roll number is already registered", exists: true }, 409);

    // Block duplicate email within the tenant.
    const [dupEmail] = await db
      .select({ id: schema.students.id })
      .from(schema.students)
      .where(and(eq(schema.students.tenantId, tid), eq(schema.students.email, email)));
    if (dupEmail) return c.json({ message: "This email is already registered" }, 409);

    await db.insert(schema.students).values({
      id: id("stu"),
      tenantId: tid,
      classId,
      rollNo: roll,
      name,
      email,
      phone: phone.replace(/\D/g, "").slice(-10),
      gender,
      password: await hashPassword("Welcome@123"),
    });
    return c.json({ ok: true, name, rollNo: roll }, 201);
  })

  // =================== TENANTS (super admin) ===================
  .get("/tenants", requireAuth, requireSuperAdmin, async (c) => {
    const rows = await db.select().from(schema.tenants).orderBy(desc(schema.tenants.createdAt));
    const withCounts = await Promise.all(
      rows.map(async (t) => {
        const [u] = await db
          .select({ n: dsql<number>`count(*)` })
          .from(schema.profiles)
          .where(eq(schema.profiles.tenantId, t.id));
        return { ...t, userCount: u?.n ?? 0 };
      }),
    );
    return c.json({ tenants: withCounts }, 200);
  })
  .post("/tenants", requireAuth, requireSuperAdmin, async (c) => {
    const b = await c.req.json();
    const tid = id("ten");
    const [t] = await db
      .insert(schema.tenants)
      .values({
        id: tid,
        name: b.name,
        shortName: b.shortName || b.name.slice(0, 2).toUpperCase(),
        slug: (b.slug || b.name).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        primaryColor: b.primaryColor || "#1e3a5f",
        logoUrl: b.logoUrl ?? null,
      })
      .returning();
    return c.json({ tenant: t }, 201);
  })
  .patch("/tenants/:id", requireAuth, requireSuperAdmin, async (c) => {
    const tid = c.req.param("id");
    const b = await c.req.json();
    const [t] = await db.update(schema.tenants).set(b).where(eq(schema.tenants.id, tid)).returning();
    return c.json({ tenant: t }, 200);
  })

  // ---- branding (own tenant) ----
  .get("/branding", requireAuth, requirePermission("branding"), async (c) => {
    const p = c.get("profile")!;
    if (!p.tenantId) return c.json({ tenant: null }, 200);
    const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, p.tenantId));
    return c.json({ tenant: t ?? null }, 200);
  })
  .patch("/branding", requireAuth, requirePermission("branding"), async (c) => {
    const p = c.get("profile")!;
    if (!p.tenantId) return c.json({ message: "No tenant" }, 400);
    const b = await c.req.json();
    const [t] = await db
      .update(schema.tenants)
      .set({ name: b.name, shortName: b.shortName, primaryColor: b.primaryColor, logoUrl: b.logoUrl })
      .where(eq(schema.tenants.id, p.tenantId))
      .returning();
    return c.json({ tenant: t }, 200);
  })

  // =================== USERS ===================
  .get("/users", requireAuth, requirePermission("users"), async (c) => {
    const p = c.get("profile")!;
    const tenantFilter = p.role === "super_admin" && c.req.query("tenantId") ? c.req.query("tenantId")! : p.tenantId;
    const profs = tenantFilter
      ? await db.select().from(schema.profiles).where(eq(schema.profiles.tenantId, tenantFilter)).orderBy(desc(schema.profiles.createdAt))
      : await db.select().from(schema.profiles).orderBy(desc(schema.profiles.createdAt));
    const ids = profs.map((x) => x.userId);
    const users = ids.length ? await db.select().from(schema.user).where(inArray(schema.user.id, ids)) : [];
    const umap = new Map(users.map((u) => [u.id, u]));
    const rows = profs
      .filter((x) => x.role !== "student")
      .map((x) => ({
        ...x,
        name: umap.get(x.userId)?.name ?? "",
        email: umap.get(x.userId)?.email ?? "",
      }));
    return c.json({ users: rows }, 200);
  })
  .post("/users", requireAuth, requirePermission("users"), async (c) => {
    const actor = c.get("profile")!;
    const b = await c.req.json();
    const tenantId = actor.role === "super_admin" ? (b.tenantId ?? actor.tenantId) : actor.tenantId;
    // create auth user
    const res = await auth.api.signUpEmail({ body: { email: b.email, password: b.password, name: b.name } });
    const newUserId = (res as { user?: { id: string } }).user?.id;
    if (!newUserId) return c.json({ message: "Failed to create user" }, 400);
    const [cnt] = await db.select({ n: dsql<number>`count(*)` }).from(schema.profiles);
    const defaultPerms =
      b.role === "tpo"
        ? (b.permissions ?? { dashboard: true, liveMonitor: true, reports: true })
        : null;
    const [prof] = await db
      .insert(schema.profiles)
      .values({
        userId: newUserId,
        tenantId,
        role: b.role, // tpo | student (super_admin seeded only)
        displayId: displayId("USR", (cnt?.n ?? 0) + 1),
        phone: b.phone ?? null,
        permissions: defaultPerms,
      })
      .returning();
    return c.json({ user: { ...prof, name: b.name, email: b.email } }, 201);
  })
  .patch("/users/:id", requireAuth, requirePermission("users"), async (c) => {
    const uid = c.req.param("id");
    const b = await c.req.json();
    const patch: Record<string, unknown> = {};
    if (b.enabled !== undefined) patch.enabled = b.enabled;
    if (b.permissions !== undefined) patch.permissions = b.permissions;
    if (b.role !== undefined) patch.role = b.role;
    if (b.phone !== undefined) patch.phone = b.phone;
    if (Object.keys(patch).length) await db.update(schema.profiles).set(patch).where(eq(schema.profiles.userId, uid));
    const userPatch: Record<string, unknown> = {};
    if (b.name !== undefined) userPatch.name = b.name;
    if (b.email !== undefined) userPatch.email = b.email;
    if (Object.keys(userPatch).length) {
      userPatch.updatedAt = new Date();
      await db.update(schema.user).set(userPatch).where(eq(schema.user.id, uid));
    }
    const [prof] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, uid));
    return c.json({ user: prof }, 200);
  })
  .post("/users/:id/reset-password", requireAuth, requirePermission("users"), async (c) => {
    const uid = c.req.param("id");
    const b = await c.req.json();
    const newPassword: string = b.password && String(b.password).length >= 8 ? b.password : "Welcome@123";
    const hash = await hashPassword(newPassword);
    const [acc] = await db.select().from(schema.account).where(and(eq(schema.account.userId, uid), eq(schema.account.providerId, "credential")));
    if (!acc) return c.json({ message: "No credential account" }, 404);
    await db.update(schema.account).set({ password: hash, updatedAt: new Date() }).where(eq(schema.account.id, acc.id));
    return c.json({ ok: true, password: newPassword }, 200);
  })

  // =================== CLASSES ===================
  .get("/classes", requireAuth, async (c) => {
    const p = c.get("profile")!;
    const tid = p.role === "super_admin" && c.req.query("tenantId") ? c.req.query("tenantId")! : p.tenantId;
    if (!tid) return c.json({ classes: [] }, 200);
    const rows = await db.select().from(schema.classes).where(eq(schema.classes.tenantId, tid)).orderBy(desc(schema.classes.createdAt));
    const withYear = rows.map((r) => ({ ...r, year: computeYear(r.batchStartYear) }));
    return c.json({ classes: withYear }, 200);
  })
  .post("/classes", requireAuth, requirePermission("users"), async (c) => {
    const p = c.get("profile")!;
    const b = await c.req.json();
    const tid = p.role === "super_admin" ? (b.tenantId ?? p.tenantId) : p.tenantId;
    const code = `${b.branch}-${b.section}`;
    const [row] = await db
      .insert(schema.classes)
      .values({ id: id("cls"), tenantId: tid!, branch: b.branch, batchStartYear: b.batchStartYear, section: b.section, code })
      .returning();
    return c.json({ class: row }, 201);
  })
  .patch("/classes/:id", requireAuth, requirePermission("users"), async (c) => {
    const cid = c.req.param("id");
    const b = await c.req.json();
    const code = `${b.branch}-${b.section}`;
    const [row] = await db
      .update(schema.classes)
      .set({ branch: b.branch, section: b.section, batchStartYear: b.batchStartYear, code })
      .where(eq(schema.classes.id, cid))
      .returning();
    return c.json({ class: row }, 200);
  })
  .delete("/classes/:id", requireAuth, requirePermission("users"), async (c) => {
    const cid = c.req.param("id");
    // Unassign any students in this section, then delete it.
    await db.update(schema.students).set({ classId: null }).where(eq(schema.students.classId, cid));
    await db.delete(schema.classes).where(eq(schema.classes.id, cid));
    return c.json({ ok: true }, 200);
  })

  // =================== STUDENTS ===================
  .get("/students", requireAuth, async (c) => {
    const p = c.get("profile")!;
    const tid = p.role === "super_admin" && c.req.query("tenantId") ? c.req.query("tenantId")! : p.tenantId;
    if (!tid) return c.json({ students: [] }, 200);
    // NOTE: never return the password hash to the client.
    const rows = await db
      .select({
        id: schema.students.id,
        tenantId: schema.students.tenantId,
        classId: schema.students.classId,
        rollNo: schema.students.rollNo,
        name: schema.students.name,
        email: schema.students.email,
        enabled: schema.students.enabled,
        createdAt: schema.students.createdAt,
      })
      .from(schema.students)
      .where(eq(schema.students.tenantId, tid))
      .orderBy(desc(schema.students.createdAt));
    return c.json({ students: rows }, 200);
  })
  .post("/students", requireAuth, requirePermission("users"), async (c) => {
    const p = c.get("profile")!;
    const b = await c.req.json();
    const tid = p.role === "super_admin" ? (b.tenantId ?? p.tenantId) : p.tenantId;
    const plain = b.password && String(b.password).length >= 6 ? String(b.password) : "Welcome@123";
    const [row] = await db
      .insert(schema.students)
      .values({
        id: id("stu"),
        tenantId: tid!,
        classId: b.classId ?? null,
        rollNo: b.rollNo,
        name: b.name,
        email: b.email ?? null,
        password: await hashPassword(plain),
      })
      .returning({
        id: schema.students.id,
        tenantId: schema.students.tenantId,
        classId: schema.students.classId,
        rollNo: schema.students.rollNo,
        name: schema.students.name,
        email: schema.students.email,
        enabled: schema.students.enabled,
        createdAt: schema.students.createdAt,
      });
    return c.json({ student: row }, 201);
  })
  .post("/students/bulk", requireAuth, requirePermission("users"), async (c) => {
    const p = c.get("profile")!;
    const b = await c.req.json(); // { rows: [{name, rollNo, email, classCode}] }
    const tid = p.tenantId!;

    // Normalise a raw class value ("CSE - A", "cse-a", "CSE  A") to canonical "CSE-A".
    const normCode = (raw: string): string => {
      const cleaned = String(raw ?? "").trim().toUpperCase().replace(/\s+/g, " ");
      if (!cleaned) return "";
      // Split branch + section on hyphen or space; rejoin with a single hyphen.
      const m = cleaned.match(/^([A-Z]+)\s*-?\s*([A-Z0-9]*)$/);
      if (m) return m[2] ? `${m[1]}-${m[2]}` : m[1];
      return cleaned.replace(/\s*-\s*/g, "-").replace(/\s+/g, "-");
    };

    const classes = await db.select().from(schema.classes).where(eq(schema.classes.tenantId, tid));
    const codeMap = new Map(classes.map((cl) => [cl.code, cl.id]));

    // Existing roll numbers for this tenant — used to skip already-registered students.
    const existing = await db.select({ rollNo: schema.students.rollNo }).from(schema.students).where(eq(schema.students.tenantId, tid));
    const seenRolls = new Set(existing.map((e) => e.rollNo.trim().toUpperCase()));

    const clean = (b.rows as Array<Record<string, string>>)
      .map((r) => ({ name: String(r.name ?? "").trim(), rollNo: String(r.rollNo ?? "").trim(), email: String(r.email ?? "").trim(), code: normCode(r.classCode ?? "") }))
      .filter((r) => r.name && r.rollNo);

    // Hash the default password ONCE — hashing per row (scrypt) would hang the
    // request for large CSVs (hundreds of rows).
    const defaultHash = await hashPassword("Welcome@123");

    let inserted = 0, skipped = 0, createdSections = 0;
    const values: (typeof schema.students.$inferInsert)[] = [];
    for (const r of clean) {
      const key = r.rollNo.toUpperCase();
      if (seenRolls.has(key)) { skipped++; continue; }
      seenRolls.add(key); // guard against duplicates within the same file

      // Auto-create the section if the class code is present but unknown.
      let classId: string | null = null;
      if (r.code) {
        classId = codeMap.get(r.code) ?? null;
        if (!classId) {
          const [branch, section] = r.code.includes("-") ? r.code.split("-") : [r.code, ""];
          const [row] = await db
            .insert(schema.classes)
            .values({ id: id("cls"), tenantId: tid, branch, section, code: r.code, batchStartYear: new Date().getFullYear() })
            .returning();
          classId = row.id;
          codeMap.set(r.code, row.id);
          createdSections++;
        }
      }

      values.push({
        id: id("stu"),
        tenantId: tid,
        classId,
        rollNo: r.rollNo,
        name: r.name,
        email: r.email || null,
        password: defaultHash,
      });
      inserted++;
    }
    // Insert in chunks to stay well under SQLite's variable limit.
    for (let i = 0; i < values.length; i += 200) {
      await db.insert(schema.students).values(values.slice(i, i + 200));
    }
    return c.json({ inserted, skipped, createdSections }, 201);
  })
  .patch("/students/:id", requireAuth, requirePermission("users"), async (c) => {
    const sid = c.req.param("id");
    const b = await c.req.json();
    const patch: Record<string, unknown> = {};
    for (const k of ["name", "rollNo", "email", "classId", "enabled"]) {
      if (k in b) patch[k] = b[k];
    }
    const [row] = await db.update(schema.students).set(patch).where(eq(schema.students.id, sid)).returning();
    return c.json({ student: row }, 200);
  })
  .post("/students/:id/reset-password", requireAuth, requirePermission("users"), async (c) => {
    const sid = c.req.param("id");
    const b = await c.req.json();
    const newPassword: string = b.password && String(b.password).length >= 6 ? String(b.password) : "Welcome@123";
    await db.update(schema.students).set({ password: await hashPassword(newPassword), mustChangePassword: true }).where(eq(schema.students.id, sid));
    // Return the plaintext ONCE so the admin can hand it to the student; never stored/readable after.
    return c.json({ ok: true, password: newPassword }, 200);
  })
  // Student login verification for the Phase 2 desktop client. Public (no staff session).
  // Body: { identifier: rollNo|email, password }. Returns student (no hash) on success.
  .post("/students/verify-login", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const identifier = String(b.identifier ?? "").trim();
    const password = String(b.password ?? "");
    if (!identifier || !password) return c.json({ ok: false, message: "Enter your roll number / email and password." }, 400);
    const [stu] = await db
      .select()
      .from(schema.students)
      .where(or(eq(schema.students.rollNo, identifier), eq(schema.students.email, identifier)))
      .limit(1);
    if (!stu || !stu.enabled) return c.json({ ok: false, message: "No account found for this roll number / email." }, 401);
    const valid = await verifyPassword({ hash: stu.password, password });
    if (!valid) return c.json({ ok: false, message: "Incorrect password. Please try again." }, 401);
    const token = await signStudentToken(stu.id);
    const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, stu.tenantId)).limit(1);
    return c.json({
      ok: true,
      token,
      student: {
        id: stu.id,
        tenantId: stu.tenantId,
        classId: stu.classId,
        rollNo: stu.rollNo,
        name: stu.name,
        email: stu.email,
        collegeName: tenant?.name ?? "",
        collegeShort: tenant?.shortName ?? "",
        primaryColor: tenant?.primaryColor ?? "#1e3a5f",
        logoUrl: tenant?.logoUrl ?? null,
        mustChangePassword: !!stu.mustChangePassword,
      },
    }, 200);
  })

  // Student changes their own password (forced on first login, or from Profile).
  // Requires the current password. Clears the must-change flag on success.
  .post("/student/change-password", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const [stu] = await db.select().from(schema.students).where(eq(schema.students.id, sid)).limit(1);
    if (!stu || !stu.enabled) return c.json({ message: "Unauthorized" }, 401);
    const b = await c.req.json().catch(() => ({}));
    const currentPassword = String(b.currentPassword ?? "");
    const newPassword = String(b.newPassword ?? "");
    if (newPassword.length < 6) return c.json({ ok: false, message: "New password must be at least 6 characters." }, 400);
    const valid = await verifyPassword({ hash: stu.password, password: currentPassword });
    if (!valid) return c.json({ ok: false, message: "Your current password is incorrect." }, 400);
    if (newPassword === currentPassword) return c.json({ ok: false, message: "Choose a password different from your current one." }, 400);
    await db.update(schema.students).set({ password: await hashPassword(newPassword), mustChangePassword: false }).where(eq(schema.students.id, sid));
    return c.json({ ok: true }, 200);
  })

  // =================== STUDENT (desktop client) ===================
  // All student routes authenticate via the "X-Student-Token" header (HMAC token
  // minted at /students/verify-login). No Better Auth session involved.

  // List exams visible to the logged-in student (their class/section), with
  // attempt state so the client can show scheduled vs finished.
  .get("/student/exams", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const [stu] = await db.select().from(schema.students).where(eq(schema.students.id, sid)).limit(1);
    if (!stu || !stu.enabled) return c.json({ message: "Unauthorized" }, 401);

    const allExams = await db
      .select()
      .from(schema.exams)
      .where(and(eq(schema.exams.tenantId, stu.tenantId), inArray(schema.exams.status, ["scheduled", "live", "finished"])))
      .orderBy(desc(schema.exams.createdAt));

    // Only exams targeting the student's class (or all-class exams), and matching section if scoped.
    const visible = allExams.filter((e) => {
      if (e.classId && stu.classId && e.classId !== stu.classId) return false;
      if (Array.isArray(e.sectionIds) && e.sectionIds.length && stu.classId && !e.sectionIds.includes(stu.classId)) return false;
      return true;
    });

    const exIds = visible.map((e) => e.id);
    const myAttempts = exIds.length
      ? await db.select().from(schema.attempts).where(and(inArray(schema.attempts.examId, exIds), eq(schema.attempts.studentId, sid)))
      : [];
    const aMap = new Map(myAttempts.map((a) => [a.examId, a]));
    const qCounts = exIds.length
      ? await db.select({ examId: schema.examQuestions.examId, n: dsql<number>`count(*)` }).from(schema.examQuestions).where(inArray(schema.examQuestions.examId, exIds)).groupBy(schema.examQuestions.examId)
      : [];
    const qMap = new Map(qCounts.map((r) => [r.examId, Number(r.n)]));

    const now = Date.now();
    const exams = visible.map((e) => {
      const a = aMap.get(e.id);
      const startMs = e.startAt ? new Date(e.startAt).getTime() : null;
      const endMs = e.endAt ? new Date(e.endAt).getTime() : null;
      let phase: string;
      if (a && (a.status === "submitted" || a.status === "graded")) phase = "finished";
      else if (a && a.status === "in_progress") phase = "in_progress";
      // Exam window has closed and the student never submitted → Absent.
      else if (endMs && now > endMs) phase = "absent";
      // Only show the full-screen "live" gate when the exam is actually live:
      // either the admin flipped it to "live", or it's scheduled and its start
      // time has arrived. A scheduled exam with no start time (or a future
      // start) is still just upcoming — never auto-treated as live.
      else if (e.status === "live" || (startMs && now >= startMs)) phase = "available";
      else phase = "upcoming";
      // Results stay locked until the exam closes for everyone — either the
      // admin flipped it to "finished", or its deadline has passed. This stops
      // early finishers from leaking the answer key to students still writing.
      const resultsReady = e.status === "finished" || (endMs != null && now > endMs);
      return {
        id: e.id,
        title: e.title,
        status: e.status,
        durationMin: e.durationMin,
        totalPoints: e.totalPoints,
        questionCount: qMap.get(e.id) ?? 0,
        startAt: e.startAt,
        endAt: e.endAt,
        phase,
        resultsReady,
        attempt: a ? { id: a.id, status: a.status, score: a.score, submittedAt: a.submittedAt } : null,
      };
    });
    return c.json({ exams, student: { id: stu.id, name: stu.name, rollNo: stu.rollNo, email: stu.email } }, 200);
  })

  // Full exam bundle for offline download: all questions with options (no answers).
  .get("/student/exams/:id/bundle", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const [stu] = await db.select().from(schema.students).where(eq(schema.students.id, sid)).limit(1);
    if (!stu) return c.json({ message: "Unauthorized" }, 401);
    const eid = c.req.param("id");
    const [exam] = await db.select().from(schema.exams).where(and(eq(schema.exams.id, eid), eq(schema.exams.tenantId, stu.tenantId))).limit(1);
    if (!exam) return c.json({ message: "Not found" }, 404);

    const eqs = await db.select().from(schema.examQuestions).where(eq(schema.examQuestions.examId, eid)).orderBy(schema.examQuestions.order);
    const qids = eqs.map((q) => q.questionId);
    const qs = qids.length ? await db.select().from(schema.questions).where(inArray(schema.questions.id, qids)) : [];
    const qById = new Map(qs.map((q) => [q.id, q]));
    // Ship only what the client needs to render — never the correct answer.
    const questions = eqs.map((eq2) => {
      const q = qById.get(eq2.questionId);
      const meta = (q?.meta ?? {}) as Record<string, unknown>;
      const safeMeta: Record<string, unknown> = {};
      if (q?.type === "coding") {
        safeMeta.language = meta.language;
        safeMeta.starter = meta.starter;
      }
      return {
        id: eq2.questionId,
        order: eq2.order,
        points: eq2.points,
        type: q?.type ?? "short",
        prompt: q?.prompt ?? "",
        options: q?.options ?? null,
        difficulty: q?.difficulty ?? "medium",
        topic: q?.topic ?? null,
        meta: safeMeta,
      };
    });
    // Randomise question order per student — same questions, different sequence.
    // Deterministic seed (student + exam) keeps the order stable across reloads/resume.
    let seed = 0;
    const seedStr = `${stu.id}:${exam.id}`;
    for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
    const shuffled = [...questions];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const gs = await getGlobalSettings();
    const proctoring = { ...schema.DEFAULT_PROCTORING, ...(gs.proctoring ?? {}) };
    return c.json({
      exam: { id: exam.id, title: exam.title, durationMin: exam.durationMin, totalPoints: exam.totalPoints, startAt: exam.startAt, endAt: exam.endAt },
      questions: shuffled,
      proctoring,
    }, 200);
  })

  // Start (or resume) an attempt. Returns a server-anchored absolute endAt so the
  // timer can't be cheated by clock changes or app restarts.
  .post("/student/attempts/:examId/start", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const eid = c.req.param("examId");
    const [exam] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!exam) return c.json({ message: "Not found" }, 404);

    let [attempt] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, sid))).limit(1);
    if (attempt && (attempt.status === "submitted" || attempt.status === "graded")) {
      return c.json({ message: "Already submitted" }, 409);
    }
    const now = Date.now();
    if (!attempt) {
      const startedAt = new Date(now);
      [attempt] = await db.insert(schema.attempts).values({ id: id("att"), examId: eid, studentId: sid, status: "in_progress", startedAt }).returning();
    } else if (attempt.status === "not_started") {
      [attempt] = await db.update(schema.attempts).set({ status: "in_progress", startedAt: new Date(now) }).where(eq(schema.attempts.id, attempt.id)).returning();
    }
    // Mark the student as seen (drives Live Monitor online/offline).
    await db.update(schema.attempts).set({ lastSeenAt: new Date(now) }).where(eq(schema.attempts.id, attempt.id));
    // Absolute deadline includes admin extra-minutes + global hold time.
    const endAtMs = effectiveEndMs(exam, attempt, now);
    return c.json({ attemptId: attempt.id, startedAt: attempt.startedAt, endAt: new Date(endAtMs), serverNow: new Date(now), durationMin: exam.durationMin, pausedMs: attempt.pausedMs ?? 0, held: !!exam.heldAt }, 200);
  })

  // Read-only status probe. Used by the client on mount to detect an in-progress
  // attempt after a page refresh WITHOUT mutating state (never transitions
  // not_started -> in_progress like /start does). Returns the server-anchored
  // endAt when the attempt is already running, so the timer stays un-cheatable.
  .get("/student/attempts/:examId/status", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const eid = c.req.param("examId");
    const [exam] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!exam) return c.json({ message: "Not found" }, 404);
    const [attempt] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, sid))).limit(1);
    const now = Date.now();
    if (!attempt) {
      return c.json({ status: "not_started", attemptId: null, startedAt: null, endAt: null, serverNow: new Date(now), held: false }, 200);
    }
    if (attempt.status === "in_progress") {
      // Refresh the seen timestamp (drives the Live Monitor online dot) and
      // return the live deadline. This is the only side effect here.
      await db.update(schema.attempts).set({ lastSeenAt: new Date(now) }).where(eq(schema.attempts.id, attempt.id));
      const endAtMs = effectiveEndMs(exam, attempt, now);
      return c.json({ status: "in_progress", attemptId: attempt.id, startedAt: attempt.startedAt, endAt: new Date(endAtMs), serverNow: new Date(now), held: !!exam.heldAt }, 200);
    }
    return c.json({ status: attempt.status, attemptId: attempt.id, startedAt: attempt.startedAt, endAt: null, serverNow: new Date(now), held: false, score: attempt.score }, 200);
  })

  // Resume a locked exam after an internet drop. The client reports how long it
  // was offline (offlineMs); we add that to pausedMs so the deadline shifts by the
  // same amount (timer effectively froze during the outage). Returns the new endAt.
  .post("/student/attempts/:examId/resume", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const eid = c.req.param("examId");
    const [exam] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!exam) return c.json({ message: "Not found" }, 404);
    const [attempt] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, sid))).limit(1);
    if (!attempt) return c.json({ message: "No attempt to resume" }, 404);
    if (attempt.status === "submitted" || attempt.status === "graded") return c.json({ message: "Already submitted" }, 409);
    const b = await c.req.json().catch(() => ({}));
    const now = Date.now();
    // Prefer server-measured pause (lastPausedAt) when present; fall back to the
    // client-reported offline duration. Clamp to the exam's total duration.
    let offlineMs = Number(b.offlineMs);
    if (!Number.isFinite(offlineMs) || offlineMs < 0) offlineMs = 0;
    if (attempt.lastPausedAt) {
      const serverGap = now - new Date(attempt.lastPausedAt).getTime();
      if (serverGap > offlineMs) offlineMs = serverGap;
    }
    offlineMs = Math.min(offlineMs, exam.durationMin * 60_000);
    const newPaused = (attempt.pausedMs ?? 0) + Math.round(offlineMs);
    await db.update(schema.attempts).set({ pausedMs: newPaused, lastPausedAt: null }).where(eq(schema.attempts.id, attempt.id));
    const startedMs = attempt.startedAt ? new Date(attempt.startedAt).getTime() : now;
    // Base = startedAt + duration capped by the window; add pausedMs on top so the
    // outage time extends the deadline beyond the window cap.
    let base = startedMs + exam.durationMin * 60_000;
    if (exam.endAt) base = Math.min(base, new Date(exam.endAt).getTime());
    const endAtMs = base + newPaused;
    return c.json({ attemptId: attempt.id, endAt: new Date(endAtMs), serverNow: new Date(now), pausedMs: newPaused }, 200);
  })

  // Mark that an exam was paused (internet lost). Records lastPausedAt so the
  // server can measure the true outage even if the client under-reports.
  .post("/student/attempts/:examId/pause", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const eid = c.req.param("examId");
    const [attempt] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, sid))).limit(1);
    if (!attempt) return c.json({ message: "No attempt" }, 404);
    if (attempt.status === "submitted" || attempt.status === "graded") return c.json({ ok: true }, 200);
    if (!attempt.lastPausedAt) {
      await db.update(schema.attempts).set({ lastPausedAt: new Date() }).where(eq(schema.attempts.id, attempt.id));
    }
    return c.json({ ok: true }, 200);
  })

  // Heartbeat: the running client pings this every ~15s. Records lastSeenAt (for
  // the Live Monitor online/offline dot) and returns the current hold state +
  // the up-to-date absolute deadline (so an admin hold/resume or extra-time grant
  // is picked up by every student without a page reload).
  .post("/student/heartbeat/:examId", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const eid = c.req.param("examId");
    const [exam] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!exam) return c.json({ message: "Not found" }, 404);
    const [attempt] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, sid))).limit(1);
    if (!attempt) return c.json({ message: "No attempt" }, 404);
    const now = Date.now();
    await db.update(schema.attempts).set({ lastSeenAt: new Date(now) }).where(eq(schema.attempts.id, attempt.id));
    const endAtMs = effectiveEndMs(exam, attempt, now);
    return c.json({ held: !!exam.heldAt, endAt: new Date(endAtMs), serverNow: new Date(now) }, 200);
  })

  // Submit an attempt: persist answers, auto-grade objective questions
  // immediately, and AI-grade subjective/coding on submit.
  .post("/student/attempts/:attemptId/submit", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const aid = c.req.param("attemptId");
    const [attempt] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.id, aid), eq(schema.attempts.studentId, sid))).limit(1);
    if (!attempt) return c.json({ message: "Not found" }, 404);
    if (attempt.status === "submitted" || attempt.status === "graded") return c.json({ ok: true, alreadySubmitted: true }, 200);

    const body = await c.req.json().catch(() => ({}));
    const respArr: { questionId: string; response: unknown }[] = Array.isArray(body.answers) ? body.answers : [];

    // Global AI provider for grading (single global settings row).
    let provider: string | null = null;
    try {
      const s = await getGlobalSettings();
      provider = s?.aiProvider ?? null;
    } catch { /* ignore */ }

    // Persist + grade through the shared path. Objective graded inline; subjective
    // + coding deferred to the background queue. The same path is reused by the
    // server-side auto-submit sweep for abandoned attempts.
    const { score } = await finalizeAttempt(attempt, respArr, provider);

    return c.json({ ok: true, attemptId: aid, score }, 200);
  })

  // Review a finished attempt: per-question response, score, correct answer + AI notes.
  .get("/student/attempts/:attemptId/review", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const aid = c.req.param("attemptId");
    const [attempt] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.id, aid), eq(schema.attempts.studentId, sid))).limit(1);
    if (!attempt) return c.json({ message: "Not found" }, 404);
    const [exam] = await db.select().from(schema.exams).where(eq(schema.exams.id, attempt.examId)).limit(1);
    // Gate results until the exam closes for everyone (admin finished it, or the
    // deadline passed) — prevents early finishers leaking the answer key.
    const endMs = exam?.endAt ? new Date(exam.endAt).getTime() : null;
    const resultsReady = exam?.status === "finished" || (endMs != null && Date.now() > endMs);
    if (!resultsReady) return c.json({ message: "Results are locked until this exam closes. Please check back later." }, 403);
    const ans = await db.select().from(schema.answers).where(eq(schema.answers.attemptId, aid));
    const aMap = new Map(ans.map((a) => [a.questionId, a]));
    const eqs = await db.select().from(schema.examQuestions).where(eq(schema.examQuestions.examId, attempt.examId)).orderBy(schema.examQuestions.order);
    const qids = eqs.map((q) => q.questionId);
    const qs = qids.length ? await db.select().from(schema.questions).where(inArray(schema.questions.id, qids)) : [];
    const qById = new Map(qs.map((q) => [q.id, q]));

    const questions = eqs.map((eq2) => {
      const q = qById.get(eq2.questionId);
      const a = aMap.get(eq2.questionId);
      return {
        id: eq2.questionId,
        type: q?.type ?? "short",
        prompt: q?.prompt ?? "",
        options: q?.options ?? null,
        correct: q?.correct ?? null,
        points: eq2.points,
        response: a?.response ?? null,
        score: a?.score ?? null,
        maxScore: a?.maxScore ?? eq2.points,
        aiNotes: a?.aiNotes ?? null,
        explanation: (q?.meta as any)?.explanation ?? null,
      };
    });
    return c.json({
      attempt: { id: attempt.id, status: attempt.status, score: attempt.score, submittedAt: attempt.submittedAt },
      exam: exam ? { id: exam.id, title: exam.title, totalPoints: exam.totalPoints } : null,
      questions,
    }, 200);
  })

  // Run a student's code against Judge0 (RapidAPI) — lets them test before submit.
  // Returns stdout / stderr / compile output; never reveals hidden test cases.
  .post("/student/run-code", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const b = await c.req.json().catch(() => ({}));
    const source = String(b.source ?? "");
    const language = String(b.language ?? "python").toLowerCase();
    const stdin = b.stdin != null ? String(b.stdin) : "";
    if (!source.trim()) return c.json({ ok: false, message: "Write some code before running." }, 400);

    // Judge0 CE language IDs (compatible across RapidAPI CE and self-hosted CE).
    const LANG: Record<string, number> = {
      python: 71, python3: 71, py: 71,
      javascript: 63, js: 63, node: 63,
      java: 62, c: 50, cpp: 54, "c++": 54, csharp: 51, "c#": 51,
      go: 60, ruby: 72, php: 68, typescript: 74, ts: 74, kotlin: 78, swift: 83, rust: 73,
    };
    const reqLangId = Number(b.languageId);
    const languageId = Number.isFinite(reqLangId) && reqLangId > 0 ? reqLangId : (LANG[language] ?? 71);

    // Resolve the RapidAPI key (settings first, then env). The config provider is
    // re-evaluated at drain time so a settings change takes effect without restart.
    let key: string | null = null;
    try { key = (await getGlobalSettings())?.judge0Key ?? null; } catch { /* ignore */ }
    if (!key) key = process.env.JUDGE0_KEY || null;
    if (!resolveJudge0Config(key)) {
      return c.json({ ok: false, message: "Code execution is not configured. Contact your administrator." }, 503);
    }

    // Enqueue on the global server-side queue. The queue throttles all students
    // together (<=10 req/s), batches runs (<=20) into single HTTP calls, polls
    // each batch, and retries transient failures with backoff. The student's
    // request stays synchronous — it just waits in line (bounded by MAX_WAIT_MS).
    const result = await judge0Queue.run(
      { source, languageId, stdin },
      () => resolveJudge0Config(key),
    );

    if (!result.ok) {
      return c.json({ ok: false, message: result.message ?? "Couldn't run your code. Try again." }, (result.httpStatus ?? 502) as never);
    }

    // Best-effort usage counter.
    try { await db.update(schema.settings).set({ judge0Used: dsql`${schema.settings.judge0Used} + 1` }).where(eq(schema.settings.id, "global")); } catch { /* ignore */ }
    return c.json({
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
      compileOutput: result.compileOutput,
      status: result.status,
      time: result.time,
      memory: result.memory,
    }, 200);
  })

  // =================== QUESTIONS ===================
  // =================== CATEGORIES ===================
  .get("/categories", requireAuth, requirePermission("questionBank"), async (c) => {
    const p = c.get("profile")!;
    const tid = p.role === "super_admin" && c.req.query("tenantId") ? c.req.query("tenantId")! : p.tenantId;
    if (!tid) return c.json({ categories: [] }, 200);
    const rows = await db.select().from(schema.categories).where(eq(schema.categories.tenantId, tid)).orderBy(desc(schema.categories.createdAt));
    const counts = await db
      .select({ categoryId: schema.questions.categoryId, n: dsql<number>`count(*)` })
      .from(schema.questions)
      .where(eq(schema.questions.tenantId, tid))
      .groupBy(schema.questions.categoryId);
    const cmap = new Map(counts.map((x) => [x.categoryId, x.n]));
    return c.json({ categories: rows.map((r) => ({ ...r, questionCount: cmap.get(r.id) ?? 0 })) }, 200);
  })
  .post("/categories", requireAuth, requirePermission("questionBank"), async (c) => {
    const p = c.get("profile")!;
    const b = await c.req.json();
    const tid = p.role === "super_admin" ? (b.tenantId ?? p.tenantId) : p.tenantId;
    if (!tid) return c.json({ message: "No tenant" }, 400);
    const [row] = await db
      .insert(schema.categories)
      .values({ id: id("cat"), tenantId: tid, name: b.name, description: b.description ?? null, color: b.color ?? "#1e3a5f" })
      .returning();
    return c.json({ category: row }, 201);
  })
  .patch("/categories/:id", requireAuth, requirePermission("questionBank"), async (c) => {
    const b = await c.req.json();
    const [row] = await db
      .update(schema.categories)
      .set({ name: b.name, description: b.description ?? null, color: b.color ?? "#1e3a5f" })
      .where(eq(schema.categories.id, c.req.param("id")))
      .returning();
    return c.json({ category: row }, 200);
  })
  .delete("/categories/:id", requireAuth, requirePermission("questionBank"), async (c) => {
    const cid = c.req.param("id");
    // Detach questions from this category (keep the questions).
    await db.update(schema.questions).set({ categoryId: null }).where(eq(schema.questions.categoryId, cid));
    await db.delete(schema.categories).where(eq(schema.categories.id, cid));
    return c.json({ ok: true }, 200);
  })

  .get("/questions", requireAuth, requirePermission("questionBank"), async (c) => {
    const p = c.get("profile")!;
    const tid = p.role === "super_admin" && c.req.query("tenantId") ? c.req.query("tenantId")! : p.tenantId;
    if (!tid) return c.json({ questions: [] }, 200);
    const catFilter = c.req.query("categoryId");
    // Visible = own tenant's questions OR any global question from other colleges.
    const visibility = or(eq(schema.questions.tenantId, tid), eq(schema.questions.isGlobal, true));
    const where = catFilter
      ? and(visibility, eq(schema.questions.categoryId, catFilter))
      : visibility;
    const rows = await db
      .select({ q: schema.questions, catName: schema.categories.name, ownerName: schema.tenants.name })
      .from(schema.questions)
      .leftJoin(schema.categories, eq(schema.categories.id, schema.questions.categoryId))
      .leftJoin(schema.tenants, eq(schema.tenants.id, schema.questions.tenantId))
      .where(where)
      .orderBy(desc(schema.questions.createdAt));
    const questions = rows.map((r) => ({
      ...r.q,
      categoryName: r.catName ?? null,
      ownedByOther: r.q.tenantId !== tid,
      ownerName: r.q.tenantId !== tid ? r.ownerName ?? null : null,
    }));
    return c.json({ questions }, 200);
  })
  .post("/questions", requireAuth, requirePermission("questionBank"), async (c) => {
    const p = c.get("profile")!;
    const b = await c.req.json();
    const tid = p.tenantId!;
    const [row] = await db
      .insert(schema.questions)
      .values({
        id: id("q"),
        tenantId: tid,
        categoryId: b.categoryId ?? null,
        isGlobal: b.isGlobal ?? true,
        type: b.type,
        prompt: b.prompt,
        options: b.options ?? null,
        correct: b.correct ?? null,
        meta: b.meta ?? null,
        points: b.points ?? 1,
        difficulty: b.difficulty ?? "medium",
        topic: b.topic ?? null,
        aiGenerated: !!b.aiGenerated,
        createdBy: p.userId,
      })
      .returning();
    return c.json({ question: row }, 201);
  })
  .patch("/questions/:id", requireAuth, requirePermission("questionBank"), async (c) => {
    const b = await c.req.json();
    const patch: Record<string, unknown> = {};
    for (const k of ["type", "prompt", "options", "correct", "meta", "points", "difficulty", "topic", "isGlobal", "categoryId"]) {
      if (k in b) patch[k] = b[k];
    }
    const [row] = await db
      .update(schema.questions)
      .set(patch)
      .where(eq(schema.questions.id, c.req.param("id")))
      .returning();
    return c.json({ question: row }, 200);
  })
  .delete("/questions/:id", requireAuth, requirePermission("questionBank"), async (c) => {
    await db.delete(schema.questions).where(eq(schema.questions.id, c.req.param("id")));
    return c.json({ ok: true }, 200);
  })
  // AI question generation (preview, not saved)
  .post("/questions/generate", requireAuth, requirePermission("questionBank"), async (c) => {
    const b = await c.req.json();
    const gs = await getGlobalSettings();
    const items = await generateQuestions({
      topic: b.topic,
      type: b.type,
      count: Math.min(Number(b.count) || 5, 15),
      difficulty: b.difficulty || "medium",
      provider: gs.aiProvider,
    });
    // track AI usage
    await db.update(schema.settings).set({ aiUsed: dsql`${schema.settings.aiUsed} + 1` }).where(eq(schema.settings.id, GLOBAL_SETTINGS));
    return c.json({ questions: items }, 200);
  })
  .post("/questions/bulk", requireAuth, requirePermission("questionBank"), async (c) => {
    const p = c.get("profile")!;
    const b = await c.req.json(); // { questions: [...] }
    const tid = p.tenantId!;
    const values = (b.questions as Array<Record<string, unknown>>).map((q) => ({
      id: id("q"),
      tenantId: tid,
      categoryId: (q.categoryId as string) ?? null,
      type: String(q.type),
      prompt: String(q.prompt),
      options: (q.options as string[]) ?? null,
      correct: q.correct ?? null,
      meta: (q.meta as Record<string, unknown>) ?? null,
      points: Number(q.points) || 1,
      difficulty: String(q.difficulty ?? "medium"),
      topic: (q.topic as string) ?? null,
      aiGenerated: true,
      createdBy: p.userId,
    }));
    if (values.length) await db.insert(schema.questions).values(values);
    return c.json({ inserted: values.length }, 201);
  })

  // =================== EXAMS ===================
  .get("/exams", requireAuth, requirePermission("exams"), async (c) => {
    const p = c.get("profile")!;
    const tid = p.role === "super_admin" && c.req.query("tenantId") ? c.req.query("tenantId")! : p.tenantId;
    if (!tid) return c.json({ exams: [] }, 200);
    const rows = await db.select().from(schema.exams).where(eq(schema.exams.tenantId, tid)).orderBy(desc(schema.exams.createdAt));
    // Newest assessment date first (startAt if scheduled, else createdAt).
    const dateVal = (e: (typeof rows)[number]) => {
      const d = e.startAt ?? e.createdAt;
      return d ? new Date(d as any).getTime() : 0;
    };
    rows.sort((a, b) => dateVal(b) - dateVal(a));
    return c.json({ exams: rows }, 200);
  })
  // Single exam with its selected question IDs (for the edit page).
  .get("/exams/:id", requireAuth, requirePermission("exams"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("id");
    const [row] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!row || (p.role !== "super_admin" && row.tenantId !== p.tenantId)) return c.json({ error: "not found" }, 404);
    const eqs = await db
      .select({ questionId: schema.examQuestions.questionId })
      .from(schema.examQuestions)
      .where(eq(schema.examQuestions.examId, eid))
      .orderBy(schema.examQuestions.order);
    return c.json({ exam: row, questionIds: eqs.map((e) => e.questionId) }, 200);
  })
  .post("/exams", requireAuth, requirePermission("exams"), async (c) => {
    const p = c.get("profile")!;
    const b = await c.req.json();
    const tid = p.tenantId!;
    const qids: string[] = b.questionIds ?? [];
    const qs = qids.length ? await db.select().from(schema.questions).where(inArray(schema.questions.id, qids)) : [];
    const total = qs.reduce((s, q) => s + q.points, 0);
    const eid = id("ex");
    const [row] = await db
      .insert(schema.exams)
      .values({
        id: eid,
        tenantId: tid,
        title: b.title,
        classId: b.classId ?? null,
        sectionIds: Array.isArray(b.sectionIds) && b.sectionIds.length ? b.sectionIds : null,
        status: b.status ?? "scheduled",
        startAt: b.startAt ? new Date(b.startAt) : null,
        // The exam window closes at startAt + duration. After that the window is
        // closed and any student who never showed up is marked absent. (Offline
        // lost time is added back per-attempt beyond this cap at /start & /resume.)
        endAt: b.startAt ? new Date(new Date(b.startAt).getTime() + (b.durationMin ?? 60) * 60_000) : null,
        durationMin: b.durationMin ?? 60,
        totalPoints: total,
        createdBy: p.userId,
      })
      .returning();
    if (qids.length) {
      await db.insert(schema.examQuestions).values(
        qids.map((q, i) => ({ id: id("eq"), examId: eid, questionId: q, order: i, points: qs.find((x) => x.id === q)?.points ?? 1 })),
      );
    }
    return c.json({ exam: row }, 201);
  })
  .patch("/exams/:id", requireAuth, requirePermission("exams"), async (c) => {
    const eid = c.req.param("id");
    const b = await c.req.json();
    const patch: Record<string, unknown> = {};
    for (const k of ["title", "status", "durationMin"]) if (b[k] !== undefined) patch[k] = b[k];
    if (b.sectionIds !== undefined) patch.sectionIds = Array.isArray(b.sectionIds) && b.sectionIds.length ? b.sectionIds : null;
    if (b.startAt !== undefined || b.durationMin !== undefined) {
      // Keep the exam window (endAt = startAt + duration) in sync whenever EITHER
      // the start time OR the duration changes. Editing only the duration must
      // still move the window, otherwise the deadline stays stale and students
      // can be cut off early / late. Fall back to the exam's stored values for
      // whichever field the request did not include.
      let startAtVal: Date | null | undefined;
      let durMin = b.durationMin;
      if (b.startAt !== undefined) {
        patch.startAt = b.startAt ? new Date(b.startAt) : null;
        startAtVal = patch.startAt as Date | null;
      }
      if (startAtVal === undefined || durMin === undefined) {
        const [ex] = await db
          .select({ startAt: schema.exams.startAt, durationMin: schema.exams.durationMin })
          .from(schema.exams)
          .where(eq(schema.exams.id, eid))
          .limit(1);
        if (startAtVal === undefined) startAtVal = ex?.startAt ?? null;
        if (durMin === undefined) durMin = ex?.durationMin ?? 60;
      }
      patch.endAt = startAtVal ? new Date(new Date(startAtVal).getTime() + durMin * 60_000) : null;
    } else if (b.endAt !== undefined) {
      patch.endAt = b.endAt ? new Date(b.endAt) : null;
    }
    // Optionally replace the exam's question set and recompute total points.
    if (Array.isArray(b.questionIds)) {
      const qids: string[] = b.questionIds;
      const qs = qids.length ? await db.select().from(schema.questions).where(inArray(schema.questions.id, qids)) : [];
      patch.totalPoints = qs.reduce((s, q) => s + q.points, 0);
      await db.delete(schema.examQuestions).where(eq(schema.examQuestions.examId, eid));
      if (qids.length) {
        await db.insert(schema.examQuestions).values(
          qids.map((q, i) => ({ id: id("eq"), examId: eid, questionId: q, order: i, points: qs.find((x) => x.id === q)?.points ?? 1 })),
        );
      }
    }
    const [row] = await db.update(schema.exams).set(patch).where(eq(schema.exams.id, eid)).returning();
    return c.json({ exam: row }, 200);
  })

  // ---- Admin exam controls: global hold / resume / extra time (outage handling) ----
  // Hold the WHOLE exam (e.g. a venue-wide internet/power outage). Every running
  // student's timer freezes; the held duration is added back to the deadline on resume.
  .post("/exams/:id/hold", requireAuth, requirePermission("exams"), async (c) => {
    const eid = c.req.param("id");
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!ex) return c.json({ message: "Not found" }, 404);
    if (!ex.heldAt) await db.update(schema.exams).set({ heldAt: new Date() }).where(eq(schema.exams.id, eid));
    return c.json({ ok: true, held: true }, 200);
  })
  // Resume a held exam: fold the elapsed hold into holdMs and clear heldAt so
  // deadlines shift forward by exactly the outage duration.
  .post("/exams/:id/unhold", requireAuth, requirePermission("exams"), async (c) => {
    const eid = c.req.param("id");
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!ex) return c.json({ message: "Not found" }, 404);
    if (ex.heldAt) {
      const elapsed = Math.max(0, Date.now() - new Date(ex.heldAt).getTime());
      await db.update(schema.exams).set({ heldAt: null, holdMs: (ex.holdMs ?? 0) + elapsed }).where(eq(schema.exams.id, eid));
    }
    return c.json({ ok: true, held: false }, 200);
  })
  // Grant extra minutes to the whole exam (shifts every deadline forward).
  .post("/exams/:id/extra-time", requireAuth, requirePermission("exams"), async (c) => {
    const eid = c.req.param("id");
    const b = await c.req.json().catch(() => ({}));
    let minutes = Number(b.minutes);
    if (!Number.isFinite(minutes)) minutes = 0;
    minutes = Math.round(minutes);
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!ex) return c.json({ message: "Not found" }, 404);
    const next = Math.max(0, (ex.extraMin ?? 0) + minutes);
    const [row] = await db.update(schema.exams).set({ extraMin: next }).where(eq(schema.exams.id, eid)).returning();
    return c.json({ ok: true, extraMin: row.extraMin }, 200);
  })

  // Reopen a single accidentally-submitted attempt. Flips submitted/graded back
  // to in_progress WITHOUT wiping the student's work — their answers stay in the
  // DB and their timer resumes from the original startedAt (via effectiveEndMs).
  // Optional addMinutes grants extra time to THIS student only by bumping the
  // per-attempt pausedMs (does not affect anyone else in the exam).
  .post("/exams/:id/attempts/:attemptId/reopen", requireAuth, requirePermission("liveMonitor"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("id");
    const aid = c.req.param("attemptId");
    const b = await c.req.json().catch(() => ({}));
    let addMinutes = Number(b.addMinutes);
    if (!Number.isFinite(addMinutes) || addMinutes < 0) addMinutes = 0;
    addMinutes = Math.round(addMinutes);

    const [exam] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!exam || exam.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
    const [attempt] = await db.select().from(schema.attempts).where(eq(schema.attempts.id, aid)).limit(1);
    if (!attempt || attempt.examId !== eid) return c.json({ message: "Attempt not found" }, 404);
    if (attempt.status !== "submitted" && attempt.status !== "graded") {
      return c.json({ message: "Only a submitted or graded attempt can be reopened." }, 400);
    }

    const now = Date.now();
    const addMs = addMinutes * 60_000;

    // Shared exam-window end that everyone still writing is bound to:
    // endAt + admin extra time + accumulated hold + any currently-running hold.
    // This is independent of THIS attempt's (possibly skewed) startedAt, so a
    // reset student picks up exactly the time still left on the room's clock.
    let sharedEnd = 0;
    if (exam.endAt) {
      sharedEnd =
        new Date(exam.endAt).getTime() + (exam.extraMin ?? 0) * 60_000 + (exam.holdMs ?? 0);
      if (exam.heldAt) sharedEnd += Math.max(0, now - new Date(exam.heldAt).getTime());
    }

    // Deadline if we simply resumed this attempt's own timer.
    const naturalEnd = effectiveEndMs(exam, { startedAt: attempt.startedAt, pausedMs: attempt.pausedMs ?? 0 }, now);

    // Target deadline = the later of the shared window end and this attempt's
    // natural end, plus any admin-granted minutes for THIS student only. Using
    // the shared end means a student who submitted early (or whose start time is
    // skewed) resumes with the SAME leftover time as the rest of the room — e.g.
    // 30 min left on the window + 20 min admin extra = 50 min — never a fresh
    // full duration.
    let target = Math.max(sharedEnd, naturalEnd) + addMs;

    // Only if the whole window has already closed (nothing left for anyone) do we
    // grant a fresh writable window so the student can still finish: the added
    // minutes if given, else the exam's normal duration.
    const MIN_WRITABLE_MS = 60_000; // 1 min floor of usable time
    if (target - now < MIN_WRITABLE_MS) {
      const grantMin = addMinutes > 0 ? addMinutes : exam.durationMin;
      target = now + grantMin * 60_000;
    }

    // Realise `target` via pausedMs (added AFTER the exam-window cap inside
    // effectiveEndMs), keeping startedAt untouched. pausedMs affects only this
    // attempt.
    const floorEnd = effectiveEndMs(exam, { startedAt: attempt.startedAt, pausedMs: 0 }, now);
    const newPaused = Math.max(0, target - floorEnd);

    await db
      .update(schema.attempts)
      .set({
        status: "in_progress",
        score: null,
        submittedAt: null,
        pausedMs: newPaused,
        lastPausedAt: null,
        lastSeenAt: new Date(),
      })
      .where(eq(schema.attempts.id, aid));

    const endAtMs = effectiveEndMs(exam, { startedAt: attempt.startedAt, pausedMs: newPaused }, now);
    return c.json({ ok: true, endAt: new Date(endAtMs), grantedUntil: new Date(endAtMs), addedMinutes: addMinutes }, 200);
  })

  // =================== LIVE MONITOR ===================
  .get("/monitor", requireAuth, requirePermission("liveMonitor"), async (c) => {
    const p = c.get("profile")!;
    const tid = p.tenantId;
    if (!tid) return c.json({ live: [], nextScheduled: null }, 200);
    const now = Date.now();
    // An exam is effectively live when its DB status is "live", OR when it is
    // still "scheduled" but its start time has already passed (students can start
    // it at that point). This mirrors the "LIVE / In progress" badge on the
    // Schedule Assessment list, which is derived the same way. Without this, a
    // scheduled exam whose start time passed would show as live on the list but
    // never appear in the Live Monitor.
    const startMs = (e: { startAt: number | string | null }) => {
      if (e.startAt == null) return null;
      const ms = typeof e.startAt === "number" ? e.startAt : new Date(e.startAt).getTime();
      return Number.isNaN(ms) ? null : ms;
    };
    const dbLive = await db.select().from(schema.exams).where(and(eq(schema.exams.tenantId, tid), eq(schema.exams.status, "live")));
    const scheduled = await db
      .select()
      .from(schema.exams)
      .where(and(eq(schema.exams.tenantId, tid), eq(schema.exams.status, "scheduled")))
      .orderBy(schema.exams.startAt);
    const startedScheduled = scheduled.filter((e) => {
      const ms = startMs(e);
      return ms !== null && now >= ms;
    });
    // An exam is OVER once its window (endAt + any admin extra time + total hold
    // time) has fully elapsed. A currently-held exam is paused, not over. Over
    // exams must drop off the Live Monitor entirely — there is nothing live.
    const isOver = (e: { endAt: number | string | Date | null; extraMin?: number | null; holdMs?: number | null; heldAt?: number | string | Date | null }) => {
      if (e.heldAt) return false;
      if (e.endAt == null) return false;
      const end = e.endAt instanceof Date ? e.endAt.getTime() : typeof e.endAt === "number" ? e.endAt : new Date(e.endAt).getTime();
      if (Number.isNaN(end)) return false;
      const extra = (e.extraMin ?? 0) * 60_000 + (e.holdMs ?? 0);
      return now > end + extra;
    };
    const liveExams = [...dbLive, ...startedScheduled].filter((e) => !isOver(e));

    // Next scheduled exam (for empty-state messaging when nothing is live).
    let nextScheduled: { examId: string; title: string; startAt: number | null } | null = null;
    if (!liveExams.length) {
      const upcoming = scheduled
        .filter((e) => {
          const ms = startMs(e);
          return ms !== null && ms >= now;
        })
        .sort((a, b) => startMs(a)! - startMs(b)!)[0];
      if (upcoming) nextScheduled = { examId: upcoming.id, title: upcoming.title, startAt: startMs(upcoming) };
    }

    // All enabled students in the tenant — used to compute the assigned cohort
    // per exam so we can surface who hasn't started yet.
    const allStudents = await db.select().from(schema.students).where(and(eq(schema.students.tenantId, tid), eq(schema.students.enabled, true)));
    // Resolve a student's classId to a readable section code (e.g. "CSE-C").
    const allClasses = await db.select().from(schema.classes).where(eq(schema.classes.tenantId, tid));
    const classCodeById = new Map(allClasses.map((cl) => [cl.id, cl.code]));
    const sectionOf = (classId: string | null) => (classId ? classCodeById.get(classId) ?? "" : "");
    const assignedStudents = (e: { classId: string | null; sectionIds: string[] | null }) =>
      allStudents.filter((stu) => {
        if (e.classId && stu.classId && e.classId !== stu.classId) return false;
        if (Array.isArray(e.sectionIds) && e.sectionIds.length && stu.classId && !e.sectionIds.includes(stu.classId)) return false;
        return true;
      });

    const out = await Promise.all(
      liveExams.map(async (ex) => {
        const atts = await db.select().from(schema.attempts).where(eq(schema.attempts.examId, ex.id));
        // Everyone who has engaged with the exam (in progress or already submitted/graded).
        const engaged = atts.filter((a) => a.status !== "not_started");
        const enriched = await Promise.all(
          engaged.map(async (a) => {
            const [stu] = await db.select().from(schema.students).where(eq(schema.students.id, a.studentId));
            const status = a.status === "in_progress" ? "in_progress" : "finished";
            // Online = a heartbeat within the last 40s (heartbeat interval is ~15s).
            const online = a.status === "in_progress" && !!a.lastSeenAt && now - new Date(a.lastSeenAt).getTime() < 40_000;
            return {
              attemptId: a.id,
              examId: ex.id,
              student: stu?.name ?? "—",
              rollNo: stu?.rollNo ?? "",
              section: sectionOf(stu?.classId ?? null),
              status,
              online,
              lastSeenAt: a.lastSeenAt,
              startedAt: a.startedAt,
              submittedAt: a.submittedAt,
              score: a.status === "graded" ? a.score : null,
              graded: a.status === "graded",
              snapshot: null as string | null,
            };
          }),
        );
        // Assigned students who have not started. If the exam window has closed
        // (now > endAt) they never showed up → "absent"; otherwise they can still
        // begin → "not_started".
        const endMs = ex.endAt ? new Date(ex.endAt).getTime() : null;
        const windowClosed = endMs !== null && !Number.isNaN(endMs) && now > endMs;
        const engagedIds = new Set(engaged.map((a) => a.studentId));
        const notStarted = assignedStudents(ex)
          .filter((stu) => !engagedIds.has(stu.id))
          .map((stu) => ({
            attemptId: `ns-${stu.id}`,
            examId: ex.id,
            student: stu.name ?? "—",
            rollNo: stu.rollNo ?? "",
            section: sectionOf(stu.classId ?? null),
            status: (windowClosed ? "absent" : "not_started") as "absent" | "not_started",
            online: false,
            lastSeenAt: null as string | null,
            startedAt: null as string | null,
            submittedAt: null as string | null,
            snapshot: null as string | null,
          }));
        const absentCount = windowClosed ? notStarted.length : 0;
        return {
          examId: ex.id,
          title: ex.title,
          held: !!ex.heldAt,
          heldAt: ex.heldAt,
          extraMin: ex.extraMin ?? 0,
          active: engaged.filter((a) => a.status === "in_progress").length,
          online: enriched.filter((s) => s.online).length,
          submitted: engaged.filter((a) => a.status !== "in_progress").length,
          notStarted: windowClosed ? 0 : notStarted.length,
          absent: absentCount,
          students: [...enriched, ...notStarted],
        };
      }),
    );
    return c.json({ live: out, nextScheduled }, 200);
  })

  // =================== DASHBOARD ===================
  .get("/dashboard", requireAuth, requirePermission("dashboard"), async (c) => {
    const p = c.get("profile")!;
    const tid = p.tenantId;
    if (!tid) return c.json({ stats: null, classAvg: [], trend: [], topStudents: [], classToppers: [] }, 200);

    // An exam counts toward results once it is either explicitly finished OR its
    // window has closed (deadline passed). Drafts never count. This mirrors the
    // effective-status logic used by the reports endpoint so the dashboard stays
    // consistent with what admins see under Reports.
    const nowMs = Date.now();
    const allExams = await db.select().from(schema.exams).where(and(eq(schema.exams.tenantId, tid), ne(schema.exams.status, "draft"))).orderBy(schema.exams.createdAt);
    const finishedExams = allExams.filter((e) => {
      if (e.status === "finished") return true;
      const end = e.endAt ? new Date(e.endAt).getTime() : null;
      return end != null && !Number.isNaN(end) && nowMs > end;
    });
    const examIds = finishedExams.map((e) => e.id);
    const atts = examIds.length ? await db.select().from(schema.attempts).where(inArray(schema.attempts.examId, examIds)) : [];
    const graded = atts.filter((a) => a.score != null);

    const avg = graded.length ? graded.reduce((s, a) => s + (a.score ?? 0), 0) / graded.length : 0;
    const passRate = graded.length ? (graded.filter((a) => (a.score ?? 0) >= 40).length / graded.length) * 100 : 0;

    // class-wise average
    const classes = await db.select().from(schema.classes).where(eq(schema.classes.tenantId, tid));
    const students = await db.select().from(schema.students).where(eq(schema.students.tenantId, tid));
    const stuClass = new Map(students.map((s) => [s.id, s.classId]));
    const classScores = new Map<string, number[]>();
    for (const a of graded) {
      const cid = stuClass.get(a.studentId);
      if (!cid) continue;
      if (!classScores.has(cid)) classScores.set(cid, []);
      classScores.get(cid)!.push(a.score ?? 0);
    }
    const classAvg = classes
      .map((cl) => {
        const arr = classScores.get(cl.id) ?? [];
        if (!arr.length) return null;
        return { code: cl.code, avg: Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10 };
      })
      .filter((x): x is { code: string; avg: number } => x != null);

    // trend across finished exams (avg per exam)
    const trend = finishedExams.slice(-6).map((e) => {
      const ea = graded.filter((a) => a.examId === e.id);
      return { name: e.title.length > 8 ? e.title.slice(0, 8) : e.title, avg: ea.length ? Math.round((ea.reduce((s, a) => s + (a.score ?? 0), 0) / ea.length) * 10) / 10 : 0 };
    });

    // top students overall (avg score per student)
    const stuScores = new Map<string, number[]>();
    for (const a of graded) {
      if (!stuScores.has(a.studentId)) stuScores.set(a.studentId, []);
      stuScores.get(a.studentId)!.push(a.score ?? 0);
    }
    const smap = new Map(students.map((s) => [s.id, s]));
    const clmap = new Map(classes.map((cl) => [cl.id, cl]));
    const topStudents = [...stuScores.entries()]
      .map(([sid, arr]) => {
        const s = smap.get(sid);
        const cl = s?.classId ? clmap.get(s.classId) : null;
        return { name: s?.name ?? "—", rollNo: s?.rollNo ?? "", classCode: cl?.code ?? "—", avg: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 };
      })
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 8);

    // class toppers (only classes that actually have a graded student)
    const classToppers = classes
      .map((cl) => {
        const best = [...stuScores.entries()]
          .map(([sid, arr]) => ({ s: smap.get(sid), avg: arr.reduce((a, b) => a + b, 0) / arr.length }))
          .filter((x) => x.s?.classId === cl.id)
          .sort((a, b) => b.avg - a.avg)[0];
        if (!best?.s) return null;
        return { code: cl.code, name: best.s.name, score: Math.round(best.avg * 10) / 10 };
      })
      .filter((t): t is { code: string; name: string; score: number } => t != null);

    // settings for limit alert (platform-global)
    const s = await getGlobalSettings();
    const judge0Pct = s ? Math.round((s.judge0Used / Math.max(1, s.judge0Limit)) * 100) : 0;
    const aiPct = s ? Math.round((s.aiUsed / Math.max(1, s.aiLimit)) * 100) : 0;

    return c.json(
      {
        stats: {
          totalStudents: students.length,
          avg: Math.round(avg * 10) / 10,
          passRate: Math.round(passRate),
          completed: finishedExams.length,
        },
        classAvg,
        trend,
        topStudents,
        classToppers,
        limits: { judge0Pct, aiPct, judge0Used: s?.judge0Used ?? 0, judge0Limit: s?.judge0Limit ?? 0, aiUsed: s?.aiUsed ?? 0, aiLimit: s?.aiLimit ?? 0 },
      },
      200,
    );
  })

  // =================== REPORTS (finished only for TPO) ===================
  .get("/reports", requireAuth, requirePermission("reports"), async (c) => {
    const p = c.get("profile")!;
    const tid = p.tenantId;
    if (!tid) return c.json({ exams: [] }, 200);
    // Reports only cover CONDUCTED assessments — never drafts/scheduled-in-future.
    // TPO sees finished only; others see finished + live (in-progress). A scheduled
    // exam whose start time has passed is effectively live, so include it for
    // non-TPO roles too (mirrors the Live Monitor / Schedule list behaviour).
    const now = Date.now();
    const startMs = (e: { startAt: number | string | null }) => {
      if (e.startAt == null) return null;
      const ms = typeof e.startAt === "number" ? e.startAt : new Date(e.startAt).getTime();
      return Number.isNaN(ms) ? null : ms;
    };
    const isStarted = (e: { startAt: number | string | null }) => {
      const ms = startMs(e);
      return ms !== null && now >= ms;
    };
    const endMs = (e: { endAt: number | string | null }) => {
      if (e.endAt == null) return null;
      const ms = typeof e.endAt === "number" ? e.endAt : new Date(e.endAt).getTime();
      return Number.isNaN(ms) ? null : ms;
    };
    // A scheduled exam whose start time has passed is effectively LIVE — until its
    // window (endAt + admin extra time + hold time) closes, after which it has ENDED.
    const effStatus = (e: { status: string; startAt: number | string | null; endAt: number | string | null; extraMin?: number | null; holdMs?: number | null; heldAt?: number | string | Date | null }) => {
      if (e.status === "draft" || e.status === "finished") return e.status;
      const end = endMs(e);
      if (!e.heldAt && end !== null) {
        const extra = (e.extraMin ?? 0) * 60_000 + (e.holdMs ?? 0);
        if (now > end + extra) return "ended";
      }
      if (e.status === "live") return "live";
      if (e.status === "scheduled" && isStarted(e)) return "live";
      return e.status;
    };
    const allExams = await db.select().from(schema.exams).where(eq(schema.exams.tenantId, tid)).orderBy(desc(schema.exams.createdAt));
    const rows =
      p.role === "tpo"
        ? allExams.filter((e) => e.status === "finished")
        : allExams.filter((e) => e.status === "finished" || e.status === "live" || (e.status === "scheduled" && isStarted(e)));
    // All students in the tenant — used to size the "assigned" cohort per exam.
    const allStudents = await db.select().from(schema.students).where(and(eq(schema.students.tenantId, tid), eq(schema.students.enabled, true)));
    const assignedFor = (e: { classId: string | null; sectionIds: string[] | null }) =>
      allStudents.filter((stu) => {
        if (e.classId && stu.classId && e.classId !== stu.classId) return false;
        if (Array.isArray(e.sectionIds) && e.sectionIds.length && stu.classId && !e.sectionIds.includes(stu.classId)) return false;
        return true;
      }).length;
    const PASS_MARK = 40; // percentage
    const withStats = await Promise.all(
      rows.map(async (e) => {
        const atts = await db.select().from(schema.attempts).where(eq(schema.attempts.examId, e.id));
        const assigned = assignedFor(e);
        // finished = submitted/graded; inProgress = actively taking it
        const finished = atts.filter((a) => a.status === "submitted" || a.status === "graded").length;
        const inProgress = atts.filter((a) => a.status === "in_progress").length;
        // absent = assigned students who never finished nor are in progress, but ONLY
        // once the exam deadline has passed (before that they may still show up).
        const deadline = endMs(e);
        const deadlineOver = e.status === "finished" || (deadline !== null && now >= deadline);
        const absent = deadlineOver ? Math.max(0, assigned - finished - inProgress) : 0;
        const graded = atts.filter((a) => a.score != null);
        const passed = graded.filter((a) => (a.score ?? 0) >= PASS_MARK).length;
        const failed = graded.filter((a) => (a.score ?? 0) < PASS_MARK).length;
        const avg = graded.length ? Math.round((graded.reduce((s, a) => s + (a.score ?? 0), 0) / graded.length) * 10) / 10 : 0;
        // "wrote" retained for backward compat (== finished).
        return { ...e, status: effStatus(e), attempts: atts.length, assigned, finished, inProgress, absent, wrote: finished, graded: graded.length, passed, failed, avg };
      }),
    );
    // Newest assessment date first (startAt if set, else createdAt).
    const dateVal = (e: (typeof withStats)[number]) => {
      const d = e.startAt ?? e.createdAt;
      return d ? new Date(d as any).getTime() : 0;
    };
    withStats.sort((a, b) => dateVal(b) - dateVal(a));
    return c.json({ exams: withStats }, 200);
  })
  .get("/reports/:examId", requireAuth, requirePermission("reports"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("examId");
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid));
    if (!ex || ex.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
    if (p.role === "tpo" && ex.status !== "finished") return c.json({ message: "Report not available until finished" }, 403);
    const atts = await db.select().from(schema.attempts).where(eq(schema.attempts.examId, eid));
    const students = await db.select().from(schema.students).where(eq(schema.students.tenantId, p.tenantId!));
    const smap = new Map(students.map((s) => [s.id, s]));
    const classes = await db.select().from(schema.classes).where(eq(schema.classes.tenantId, p.tenantId!));
    const clmap = new Map(classes.map((cl) => [cl.id, cl]));
    const sectionOf = (sid: string) => {
      const cid = smap.get(sid)?.classId;
      return cid ? clmap.get(cid)?.code ?? "" : "";
    };
    const rows = atts
      .map((a) => ({ attemptId: a.id, studentId: a.studentId, name: smap.get(a.studentId)?.name ?? "—", rollNo: smap.get(a.studentId)?.rollNo ?? "", email: smap.get(a.studentId)?.email ?? null, section: sectionOf(a.studentId), score: a.score, status: a.status, submittedAt: a.submittedAt }))
      .sort((x, y) => (y.score ?? -1) - (x.score ?? -1));
    return c.json({ exam: ex, results: rows }, 200);
  })
  .get("/reports/:examId/attempt/:attemptId", requireAuth, requirePermission("reports"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("examId");
    const aid = c.req.param("attemptId");
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid));
    if (!ex || ex.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
    const [att] = await db.select().from(schema.attempts).where(eq(schema.attempts.id, aid));
    if (!att || att.examId !== eid) return c.json({ message: "Not found" }, 404);
    const [stu] = await db.select().from(schema.students).where(eq(schema.students.id, att.studentId));
    const ans = await db.select().from(schema.answers).where(eq(schema.answers.attemptId, aid));
    const aMap = new Map(ans.map((a) => [a.questionId, a]));
    // Order questions by the exam's question order so the answer sheet reads top-to-bottom.
    const eqs = await db.select().from(schema.examQuestions).where(eq(schema.examQuestions.examId, eid)).orderBy(schema.examQuestions.order);
    const orderedQids = eqs.length ? eqs.map((e) => e.questionId) : ans.map((a) => a.questionId);
    const qs = orderedQids.length ? await db.select().from(schema.questions).where(inArray(schema.questions.id, orderedQids)) : [];
    const qmap = new Map(qs.map((q) => [q.id, q]));
    const answers = orderedQids.map((qid, i) => {
      const q = qmap.get(qid);
      const a = aMap.get(qid);
      const eqRow = eqs.find((e) => e.questionId === qid);
      return {
        id: a?.id ?? `q-${i}`,
        prompt: q?.prompt ?? "—",
        type: q?.type ?? "—",
        topic: q?.topic ?? null,
        options: q?.options ?? null,
        correct: q?.correct ?? null,
        explanation: (q?.meta as any)?.explanation ?? null,
        response: a?.response ?? null,
        score: a?.score ?? null,
        maxScore: a?.maxScore ?? eqRow?.points ?? q?.points ?? null,
        aiNotes: a?.aiNotes ?? null,
        autoGraded: a?.autoGraded ?? null,
      };
    });
    return c.json({
      exam: { id: ex.id, title: ex.title },
      student: { name: stu?.name ?? "—", rollNo: stu?.rollNo ?? "", email: stu?.email ?? null },
      attempt: { score: att.score, status: att.status, submittedAt: att.submittedAt, startedAt: att.startedAt },
      answers,
    }, 200);
  })

  // =================== SETTINGS ===================
  .post("/change-password", requireAuth, async (c) => {
    const user = c.get("user")!;
    const b = await c.req.json();
    const currentPassword = String(b.currentPassword ?? "");
    const newPassword = String(b.newPassword ?? "");
    if (newPassword.length < 8) return c.json({ message: "New password must be at least 8 characters" }, 400);
    const [acc] = await db.select().from(schema.account).where(and(eq(schema.account.userId, user.id), eq(schema.account.providerId, "credential")));
    if (!acc || !acc.password) return c.json({ message: "No credential account" }, 404);
    const valid = await verifyPassword({ hash: acc.password, password: currentPassword });
    if (!valid) return c.json({ message: "Current password is incorrect" }, 400);
    await db.update(schema.account).set({ password: await hashPassword(newPassword), updatedAt: new Date() }).where(eq(schema.account.id, acc.id));
    return c.json({ ok: true }, 200);
  })

  .get("/settings", requireAuth, requireSuperAdmin, async (c) => {
    const s = await getGlobalSettings();
    // mask keys
    const mask = (v: string | null) => (v ? `${v.slice(0, 4)}••••${v.slice(-3)}` : null);
    return c.json(
      {
        settings: {
          ...s,
          judge0Key: mask(s.judge0Key),
          claudeKey: mask(s.claudeKey),
          geminiKey: mask(s.geminiKey),
          openaiKey: mask(s.openaiKey),
          proctoring: { ...schema.DEFAULT_PROCTORING, ...(s.proctoring ?? {}) },
        },
      },
      200,
    );
  })
  .patch("/settings", requireAuth, requireSuperAdmin, async (c) => {
    const b = await c.req.json();
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["aiProvider", "judge0Limit", "aiLimit"]) if (b[k] !== undefined) patch[k] = b[k];
    // only overwrite keys if a non-masked value is provided
    for (const k of ["judge0Key", "claudeKey", "geminiKey", "openaiKey"]) {
      if (b[k] !== undefined && b[k] !== null && !String(b[k]).includes("••")) patch[k] = b[k];
    }
    if (b.proctoring !== undefined) {
      const cur = await getGlobalSettings();
      patch.proctoring = { ...schema.DEFAULT_PROCTORING, ...(cur.proctoring ?? {}), ...b.proctoring };
    }
    await getGlobalSettings(); // ensure row exists
    const [s] = await db.update(schema.settings).set(patch).where(eq(schema.settings.id, GLOBAL_SETTINGS)).returning();
    return c.json({ ok: true, aiProvider: s.aiProvider }, 200);
  })

  // =================== AI EVALUATION (manual re-grade demo) ===================
  .post("/ai/grade", requireAuth, requirePermission("questionBank"), async (c) => {
    const p = c.get("profile")!;
    const b = await c.req.json();
    let provider: string | null = null;
    if (p.tenantId) {
      const [s] = await db.select().from(schema.settings).where(eq(schema.settings.tenantId, p.tenantId));
      provider = s?.aiProvider ?? null;
      await db.update(schema.settings).set({ aiUsed: dsql`${schema.settings.aiUsed} + 1` }).where(eq(schema.settings.tenantId, p.tenantId));
    }
    const res = await gradeSubjective({
      question: b.question,
      rubric: b.rubric,
      studentAnswer: b.studentAnswer,
      maxPoints: b.maxPoints ?? 10,
      isCode: b.isCode,
      language: b.language,
      provider,
    });
    return c.json(res, 200);
  });

export type AppType = typeof app;
export default app;
