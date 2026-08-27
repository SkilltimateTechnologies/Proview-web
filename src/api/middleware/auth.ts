import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { auth } from "../auth";
import { db } from "../database";
import * as schema from "../database/schema";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
};

export type ProfileCtx = {
  userId: string;
  tenantId: string | null;
  role: string;
  enabled: boolean;
  permissions: Record<string, boolean> | null;
};

/**
 * Routes the running exam client calls, which authenticate with the HMAC
 * `x-student-token` (see lib/student-token.ts) and never read `user`/`profile`.
 *
 * Students are not Better Auth users, so resolving a session for them was work
 * with no consumer: at 1000 concurrent students these paths carry hundreds of
 * requests a second (autosave, heartbeat, events, snapshots) and each one ran
 * `getSession` on the way in. Skipping it here removes that from the hot path.
 * `user`/`profile` are still set (to null) so any handler that reads them keeps
 * seeing a well-defined value rather than undefined.
 */
const STUDENT_PATH = /^\/api\/student\//;

export const authMiddleware = createMiddleware(async (c, next) => {
  if (STUDENT_PATH.test(c.req.path)) {
    c.set("user", null);
    c.set("profile", null);
    return next();
  }
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const user = (session?.user ?? null) as SessionUser | null;
  c.set("user", user);
  let profile: ProfileCtx | null = null;
  if (user) {
    const [p] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, user.id));
    if (p) {
      profile = {
        userId: p.userId,
        tenantId: p.tenantId,
        role: p.role,
        enabled: p.enabled,
        permissions: p.permissions ?? null,
      };
    }
  }
  // Super admin may scope to a specific college via X-Tenant-Id header.
  if (profile && profile.role === "super_admin") {
    const scope = c.req.header("x-tenant-id");
    if (scope) {
      profile.tenantId = scope;
    } else if (!profile.tenantId) {
      // No explicit scope yet (e.g. first paint before the college switcher
      // has resolved). Default to the sole tenant when exactly one exists so
      // analytics/lists populate instead of returning an empty payload.
      const ts = await db.select({ id: schema.tenants.id }).from(schema.tenants).limit(2);
      if (ts.length === 1) profile.tenantId = ts[0].id;
    }
  }
  c.set("profile", profile);
  return next();
});

export const requireAuth = createMiddleware(async (c, next) => {
  const user = c.get("user");
  const profile = c.get("profile");
  if (!user || !profile) return c.json({ message: "Unauthorized" }, 401);
  if (!profile.enabled) return c.json({ message: "Account disabled" }, 403);
  return next();
});

export const requireSuperAdmin = createMiddleware(async (c, next) => {
  const profile = c.get("profile");
  if (!profile || profile.role !== "super_admin") return c.json({ message: "Forbidden" }, 403);
  return next();
});

/** Require a TPO module permission (super_admin always passes). */
export function requirePermission(module: string) {
  return createMiddleware(async (c, next) => {
    const profile = c.get("profile") as ProfileCtx | null;
    if (!profile) return c.json({ message: "Unauthorized" }, 401);
    if (profile.role === "super_admin") return next();
    // College admin has full access within their own college.
    if (profile.role === "college_admin") return next();
    if (profile.role === "tpo" && profile.permissions?.[module]) return next();
    return c.json({ message: "Forbidden" }, 403);
  });
}
