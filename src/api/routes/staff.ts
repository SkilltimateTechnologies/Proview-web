/** Colleges, branding, staff users and classes. Split out of index.ts; behaviour unchanged. */
import { Hono } from "hono";
import { eq, and, desc, inArray, sql as dsql } from "drizzle-orm";
import { auth } from "../auth";
import { hashPassword } from "better-auth/crypto";
import { db } from "../database";
import * as schema from "../database/schema";
import { authCache, requireAuth, requireSuperAdmin, requirePermission } from "../middleware/auth";
import { id, displayId, computeYear } from "../lib/util";
import { invalidateOptInOnlyCache, isOptInOnlyCode } from "../lib/roster";
import { concurrencyGate, tenantQuotas } from "../lib/tenant-quota";
import { assignableRoles, canChangeRole, canManageStaff, inCollege } from "../lib/staff-policy";
import { type Vars, directory, tenantOf, NOT_FOUND } from "../core";

export const staffRoutes = new Hono<{ Variables: Vars }>()
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
    authCache.invalidate();
    return c.json({ tenant: t }, 201);
  })
  .patch("/tenants/:id", requireAuth, requireSuperAdmin, async (c) => {
    const tid = c.req.param("id");
    const b = await c.req.json();
    // Quota overrides are normalised instead of passed through raw: a cleared
    // field or a 0 means "inherit the global default", never "ceiling of zero",
    // which would refuse every student in this college. To stop a tenant
    // deliberately there is already `enabled = false`.
    for (const k of ["maxConcurrentAttempts", "maxEvidencePerAttempt"] as const) {
      if (b[k] === undefined) continue;
      const n = Math.floor(Number(b[k]));
      b[k] = b[k] === null || b[k] === "" || !Number.isFinite(n) || n <= 0 ? null : n;
    }
    // Only known, editable columns: the body used to go to the database as-is, so a
    // request could rewrite any column (id, slug, createdAt...).
    const tenantPatch: Record<string, unknown> = {};
    for (const k of ["name", "shortName", "slug", "primaryColor", "logoUrl", "enabled", "maxConcurrentAttempts", "maxEvidencePerAttempt"] as const) {
      if (b[k] !== undefined) tenantPatch[k] = b[k];
    }
    if (Object.keys(tenantPatch).length === 0) return c.json({ message: "Nothing to update" }, 400);
    const [t] = await db.update(schema.tenants).set(tenantPatch).where(eq(schema.tenants.id, tid)).returning();
    // Apply the new ceiling immediately rather than at the next cache expiry, and
    // latch "an override exists" so it is honoured even with no global default.
    tenantQuotas.invalidate(tid);
    concurrencyGate.invalidate(tid);
    if (t?.maxConcurrentAttempts != null || t?.maxEvidencePerAttempt != null) tenantQuotas.markTenantOverridesExist();
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
    // The role used to be taken from the body unchecked, so any TPO with the `users`
    // permission could create a super admin. Only roles the caller may hand out are
    // accepted (lib/staff-policy.ts), and it is checked BEFORE the login is created.
    const role = String(b.role ?? "tpo");
    if (!assignableRoles({ userId: actor.userId, role: actor.role, tenantId: actor.tenantId }).includes(role)) {
      return c.json({ message: "You are not allowed to create an account with that role." }, 403);
    }
    if (role !== "super_admin" && !tenantId) return c.json({ message: "Choose a college for this account." }, 400);
    // create auth user
    const res = await auth.api.signUpEmail({ body: { email: b.email, password: b.password, name: b.name } });
    const newUserId = (res as { user?: { id: string } }).user?.id;
    if (!newUserId) return c.json({ message: "Failed to create user" }, 400);
    const [cnt] = await db.select({ n: dsql<number>`count(*)` }).from(schema.profiles);
    const defaultPerms =
      role === "tpo"
        ? (b.permissions ?? { dashboard: true, liveMonitor: true, reports: true })
        : null;
    const [prof] = await db
      .insert(schema.profiles)
      .values({
        userId: newUserId,
        tenantId,
        role,
        displayId: displayId("USR", (cnt?.n ?? 0) + 1),
        phone: b.phone ?? null,
        permissions: defaultPerms,
      })
      .returning();
    return c.json({ user: { ...prof, name: b.name, email: b.email } }, 201);
  })
  .patch("/users/:id", requireAuth, requirePermission("users"), async (c) => {
    const uid = c.req.param("id");
    const me = c.get("profile")!;
    const b = await c.req.json();
    // Whose account, and what role: see lib/staff-policy.ts. Without these checks a
    // TPO could promote any account (their own included) to super admin.
    const [target] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, uid)).limit(1);
    if (!target) return c.json({ message: "User not found" }, 404);
    if (!canManageStaff(me, target)) return c.json({ message: "Not allowed" }, 403);
    if (b.role !== undefined && b.role !== target.role && !canChangeRole(me, target, String(b.role))) {
      return c.json({ message: "You are not allowed to give this account that role." }, 403);
    }
    if (b.enabled === false && uid === me.userId) return c.json({ message: "You cannot disable your own account." }, 400);
    const patch: Record<string, unknown> = {};
    if (b.enabled !== undefined) patch.enabled = b.enabled;
    if (b.permissions !== undefined) patch.permissions = b.permissions;
    if (b.role !== undefined) patch.role = String(b.role);
    if (b.phone !== undefined) patch.phone = b.phone;
    if (Object.keys(patch).length) await db.update(schema.profiles).set(patch).where(eq(schema.profiles.userId, uid));
    const userPatch: Record<string, unknown> = {};
    if (b.name !== undefined) userPatch.name = b.name;
    if (b.email !== undefined) userPatch.email = b.email;
    if (Object.keys(userPatch).length) {
      userPatch.updatedAt = new Date();
      await db.update(schema.user).set(userPatch).where(eq(schema.user.id, uid));
    }
    authCache.invalidate();
    const [prof] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, uid));
    return c.json({ user: prof }, 200);
  })
  .post("/users/:id/reset-password", requireAuth, requirePermission("users"), async (c) => {
    const uid = c.req.param("id");
    const me = c.get("profile")!;
    // This returns the new password in the response, so it must never work on an
    // account the caller does not manage (it used to work on the super admin).
    const [target] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, uid)).limit(1);
    if (!target) return c.json({ message: "User not found" }, 404);
    if (!canManageStaff(me, target)) return c.json({ message: "Not allowed" }, 403);
    const b = await c.req.json();
    const newPassword: string = b.password && String(b.password).length >= 8 ? b.password : "Welcome@123";
    const hash = await hashPassword(newPassword);
    const [acc] = await db.select().from(schema.account).where(and(eq(schema.account.userId, uid), eq(schema.account.providerId, "credential")));
    if (!acc) return c.json({ message: "No credential account" }, 404);
    authCache.invalidate();
    await db.update(schema.account).set({ password: hash, updatedAt: new Date() }).where(eq(schema.account.id, acc.id));
    return c.json({ ok: true, password: newPassword }, 200);
  })
  // Permanently delete a staff user (TPO / college admin) and their auth records.
  .delete("/users/:id", requireAuth, requirePermission("users"), async (c) => {
    const uid = c.req.param("id");
    const me = c.get("profile")!;
    if (uid === me.userId) return c.json({ message: "You cannot delete your own account." }, 400);
    const [target] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, uid));
    if (!target) return c.json({ message: "User not found" }, 404);
    if (target.role === "super_admin") return c.json({ message: "The super admin account cannot be deleted." }, 403);
    // Own college only, and never an account that outranks the caller.
    if (!canManageStaff(me, target)) return c.json({ message: "Not allowed" }, 403);
    // Remove auth rows first (session, credential account), then profile, then user.
    await db.delete(schema.session).where(eq(schema.session.userId, uid));
    await db.delete(schema.account).where(eq(schema.account.userId, uid));
    await db.delete(schema.profiles).where(eq(schema.profiles.userId, uid));
    authCache.invalidate();
    await db.delete(schema.user).where(eq(schema.user.id, uid));
    return c.json({ ok: true }, 200);
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
    // A section letter is optional: branch-wide cohorts (CIVIL, EEE, ELITE) have no
    // letter and their code is just the branch name.
    const sec = String(b.section ?? "").trim();
    const code = sec ? `${b.branch}-${sec}` : String(b.branch).trim();
    const [row] = await db
      .insert(schema.classes)
      .values({ id: id("cls"), tenantId: tid!, branch: b.branch, batchStartYear: b.batchStartYear, section: sec, code })
      .returning();
    // A new ELITE-style cohort changes who is opt-in-only — drop the cache.
    if (isOptInOnlyCode(code) || isOptInOnlyCode(b.branch)) invalidateOptInOnlyCache();
    directory.invalidateClasses(tid);
    return c.json({ class: row }, 201);
  })
  .patch("/classes/:id", requireAuth, requirePermission("users"), async (c) => {
    const cid = c.req.param("id");
    if (!inCollege(c.get("profile"), await tenantOf("class", cid))) return c.json(NOT_FOUND, 404);
    const b = await c.req.json();
    const sec = String(b.section ?? "").trim();
    const code = sec ? `${b.branch}-${sec}` : String(b.branch).trim();
    const [row] = await db
      .update(schema.classes)
      .set({ branch: b.branch, section: sec, batchStartYear: b.batchStartYear, code })
      .where(eq(schema.classes.id, cid))
      .returning();
    // Renaming a class can add/remove ELITE status — always drop the cache.
    invalidateOptInOnlyCache();
    // A renamed section changes the code every report labels rows with.
    directory.invalidateClasses(row?.tenantId);
    return c.json({ class: row }, 200);
  })
  .delete("/classes/:id", requireAuth, requirePermission("users"), async (c) => {
    const cid = c.req.param("id");
    if (!inCollege(c.get("profile"), await tenantOf("class", cid))) return c.json(NOT_FOUND, 404);
    // Unassign any students in this section, then delete it. Students promoted OUT of
    // this section keep their originalClassId pointer, so clear those too to avoid
    // dangling references breaking "restore to original section".
    await db.update(schema.students).set({ classId: null }).where(eq(schema.students.classId, cid));
    await db.update(schema.students).set({ originalClassId: null }).where(eq(schema.students.originalClassId, cid));
    await db.delete(schema.classes).where(eq(schema.classes.id, cid));
    invalidateOptInOnlyCache();
    // Touched BOTH tables (students were unassigned), and the tenant id is not in
    // scope here, so drop every tenant rather than risk serving a dangling classId.
    directory.invalidate();
    return c.json({ ok: true }, 200);
  });
