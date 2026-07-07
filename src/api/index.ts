import { Hono } from "hono";
import { cors } from "hono/cors";
import { eq, and, or, desc, inArray, sql as dsql } from "drizzle-orm";
import { auth } from "./auth";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { db } from "./database";
import * as schema from "./database/schema";
import { authMiddleware, requireAuth, requireSuperAdmin, requirePermission } from "./middleware/auth";
import type { SessionUser, ProfileCtx } from "./middleware/auth";
import { id, displayId, autoGrade, computeYear } from "./lib/util";
import { generateQuestions, gradeSubjective } from "./lib/ai";
import { presignPut, getObject } from "./lib/s3";
import { signStudentToken, verifyStudentToken } from "./lib/student-token";

type Vars = { user: SessionUser | null; profile: ProfileCtx | null };

/** Platform-global settings live in a single row (id = "global"). */
const GLOBAL_SETTINGS = "global";
async function getGlobalSettings() {
  let [s] = await db.select().from(schema.settings).where(eq(schema.settings.id, GLOBAL_SETTINGS));
  if (!s) [s] = await db.insert(schema.settings).values({ id: GLOBAL_SETTINGS }).returning();
  return s;
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
    // Absolute deadline = startedAt + duration + pausedMs (network-loss pauses),
    // capped by exam.endAt. pausedMs freezes the clock while the exam is locked.
    const startedMs = attempt.startedAt ? new Date(attempt.startedAt).getTime() : now;
    let endAtMs = startedMs + exam.durationMin * 60_000 + (attempt.pausedMs ?? 0);
    if (exam.endAt) endAtMs = Math.min(endAtMs, new Date(exam.endAt).getTime());
    return c.json({ attemptId: attempt.id, startedAt: attempt.startedAt, endAt: new Date(endAtMs), serverNow: new Date(now), durationMin: exam.durationMin, pausedMs: attempt.pausedMs ?? 0 }, 200);
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
    let endAtMs = startedMs + exam.durationMin * 60_000 + newPaused;
    if (exam.endAt) endAtMs = Math.min(endAtMs, new Date(exam.endAt).getTime());
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

    // Load exam questions (with correct answers + meta) for grading.
    const eqs = await db.select().from(schema.examQuestions).where(eq(schema.examQuestions.examId, attempt.examId)).orderBy(schema.examQuestions.order);
    const qids = eqs.map((q) => q.questionId);
    const qs = qids.length ? await db.select().from(schema.questions).where(inArray(schema.questions.id, qids)) : [];
    const qById = new Map(qs.map((q) => [q.id, q]));
    const pointsById = new Map(eqs.map((e) => [e.questionId, e.points]));

    // Global AI provider for grading (single global settings row).
    let provider: string | null = null;
    try {
      const s = await getGlobalSettings();
      provider = s?.aiProvider ?? null;
    } catch { /* ignore */ }

    // Wipe any prior answers for idempotency, then insert fresh.
    await db.delete(schema.answers).where(eq(schema.answers.attemptId, aid));

    let earned = 0;
    let max = 0;
    for (const eq2 of eqs) {
      const q = qById.get(eq2.questionId);
      if (!q) continue;
      const maxScore = pointsById.get(eq2.questionId) ?? q.points ?? 1;
      max += maxScore;
      const given = respArr.find((r) => r.questionId === eq2.questionId);
      const response = given?.response ?? null;
      let score: number | null = null;
      let autoGraded = false;
      let aiNotes: string | null = null;

      const auto = autoGrade(q.type, q.correct, response, maxScore);
      if (auto !== null) {
        score = auto;
        autoGraded = true;
      } else if (response != null && String(response).trim() !== "") {
        // AI grade subjective / coding on submit.
        try {
          const meta = (q.meta ?? {}) as Record<string, unknown>;
          const res = await gradeSubjective({
            question: q.prompt,
            rubric: (meta.rubric as string) || (meta.solution as string) || undefined,
            studentAnswer: String(typeof response === "string" ? response : JSON.stringify(response)),
            maxPoints: maxScore,
            isCode: q.type === "coding",
            language: meta.language as string | undefined,
            provider,
          });
          score = res.score;
          aiNotes = res.notes;
          autoGraded = true;
        } catch {
          score = null; // leave ungraded on failure
        }
      } else {
        score = 0; // blank answer
        autoGraded = true;
      }
      if (score != null) earned += score;
      await db.insert(schema.answers).values({
        id: id("ans"),
        attemptId: aid,
        questionId: eq2.questionId,
        response,
        score,
        maxScore,
        aiNotes,
        autoGraded,
      });
    }

    const scorePct = max > 0 ? Math.round((earned / max) * 1000) / 10 : 0;
    const [updated] = await db.update(schema.attempts).set({
      status: "graded",
      score: scorePct,
      submittedAt: new Date(),
    }).where(eq(schema.attempts.id, aid)).returning();

    return c.json({ ok: true, attemptId: aid, score: updated.score }, 200);
  })

  // Review a finished attempt: per-question response, score, correct answer + AI notes.
  .get("/student/attempts/:attemptId/review", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const aid = c.req.param("attemptId");
    const [attempt] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.id, aid), eq(schema.attempts.studentId, sid))).limit(1);
    if (!attempt) return c.json({ message: "Not found" }, 404);
    const [exam] = await db.select().from(schema.exams).where(eq(schema.exams.id, attempt.examId)).limit(1);
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

    let key: string | null = null;
    try { key = (await getGlobalSettings())?.judge0Key ?? null; } catch { /* ignore */ }
    if (!key) return c.json({ ok: false, message: "Code execution is not configured. Contact your administrator." }, 503);

    // Judge0 CE language IDs (RapidAPI).
    const LANG: Record<string, number> = {
      python: 71, python3: 71, py: 71,
      javascript: 63, js: 63, node: 63,
      java: 62, c: 50, cpp: 54, "c++": 54, csharp: 51, "c#": 51,
      go: 60, ruby: 72, php: 68, typescript: 74, ts: 74, kotlin: 78, swift: 83, rust: 73,
    };
    const languageId = LANG[language] ?? 71;

    try {
      const res = await fetch("https://judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=true", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-RapidAPI-Key": key,
          "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com",
        },
        body: JSON.stringify({ source_code: source, language_id: languageId, stdin }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return c.json({ ok: false, message: `Runner error (${res.status}). Try again in a moment.`, detail: t.slice(0, 200) }, 502);
      }
      const j = await res.json() as {
        stdout?: string | null; stderr?: string | null; compile_output?: string | null;
        status?: { description?: string }; time?: string | null; memory?: number | null;
      };
      // Best-effort usage counter.
      try { await db.update(schema.settings).set({ judge0Used: dsql`${schema.settings.judge0Used} + 1` }).where(eq(schema.settings.id, "global")); } catch { /* ignore */ }
      return c.json({
        ok: true,
        stdout: j.stdout ?? "",
        stderr: j.stderr ?? "",
        compileOutput: j.compile_output ?? "",
        status: j.status?.description ?? "Done",
        time: j.time ?? null,
        memory: j.memory ?? null,
      }, 200);
    } catch (e) {
      return c.json({ ok: false, message: "Couldn't reach the code runner. Check your connection and try again." }, 502);
    }
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
        // Fixed 2-hour window: after start + 2h the exam window closes and
        // any student who hasn't submitted is marked absent.
        endAt: b.startAt ? new Date(new Date(b.startAt).getTime() + 2 * 60 * 60 * 1000) : null,
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
    if (b.startAt !== undefined) {
      patch.startAt = b.startAt ? new Date(b.startAt) : null;
      // Keep the fixed 2-hour window in sync with the start time.
      patch.endAt = b.startAt ? new Date(new Date(b.startAt).getTime() + 2 * 60 * 60 * 1000) : null;
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
    const liveExams = [...dbLive, ...startedScheduled];

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

    const out = await Promise.all(
      liveExams.map(async (ex) => {
        const atts = await db.select().from(schema.attempts).where(eq(schema.attempts.examId, ex.id));
        // Everyone who has engaged with the exam (in progress or already submitted/graded).
        const engaged = atts.filter((a) => a.status !== "not_started");
        const enriched = await Promise.all(
          engaged.map(async (a) => {
            const [stu] = await db.select().from(schema.students).where(eq(schema.students.id, a.studentId));
            const status = a.status === "in_progress" ? "in_progress" : "finished";
            return {
              attemptId: a.id,
              examId: ex.id,
              student: stu?.name ?? "—",
              rollNo: stu?.rollNo ?? "",
              status,
              startedAt: a.startedAt,
              submittedAt: a.submittedAt,
              snapshot: null as string | null,
            };
          }),
        );
        return {
          examId: ex.id,
          title: ex.title,
          active: engaged.filter((a) => a.status === "in_progress").length,
          submitted: engaged.filter((a) => a.status !== "in_progress").length,
          students: enriched,
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

    const finishedExams = await db.select().from(schema.exams).where(and(eq(schema.exams.tenantId, tid), eq(schema.exams.status, "finished"))).orderBy(schema.exams.createdAt);
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
    const classAvg = classes.map((cl) => {
      const arr = classScores.get(cl.id) ?? [];
      return { code: cl.code, avg: arr.length ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10 : 0 };
    });

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

    // class toppers
    const classToppers = classes.map((cl) => {
      const inClass = topStudents.filter((s) => s.classCode === cl.code);
      const best = [...stuScores.entries()]
        .map(([sid, arr]) => ({ s: smap.get(sid), avg: arr.reduce((a, b) => a + b, 0) / arr.length }))
        .filter((x) => x.s?.classId === cl.id)
        .sort((a, b) => b.avg - a.avg)[0];
      return { code: cl.code, name: best?.s?.name ?? "—", score: best ? Math.round(best.avg * 10) / 10 : 0 };
    });

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
    // A scheduled exam whose start time has passed is effectively LIVE.
    const effStatus = (e: { status: string; startAt: number | string | null }) =>
      e.status === "scheduled" && isStarted(e) ? "live" : e.status;
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
    const rows = atts
      .map((a) => ({ attemptId: a.id, studentId: a.studentId, name: smap.get(a.studentId)?.name ?? "—", rollNo: smap.get(a.studentId)?.rollNo ?? "", email: smap.get(a.studentId)?.email ?? null, score: a.score, status: a.status, submittedAt: a.submittedAt }))
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
