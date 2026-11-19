import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { auth } from "../auth";
import { db } from "../database";
import * as schema from "../database/schema";
import { AuthCache, type CachedIdentity } from "../lib/auth-cache";

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

/**
 * Identity is cached for a few seconds per credential set (see lib/auth-cache.ts):
 * it used to cost 3 database statements on EVERY staff request, including each
 * 5-second Live Monitor poll. Exported so account-changing writes can invalidate.
 */
export const authCache = new AuthCache<SessionUser, ProfileCtx>(Number(process.env.AUTH_CACHE_MS) || 10_000);

async function loadIdentity(headers: Headers): Promise<CachedIdentity<SessionUser, ProfileCtx>> {
  const session = await auth.api.getSession({ headers });
  const user = (session?.user ?? null) as SessionUser | null;
  let profile: ProfileCtx | null = null;
  let defaultTenantId: string | null = null;
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
      // A super admin with no college of their own: remember the sole tenant (if
      // there is exactly one) so the per-request default below needs no query.
      if (p.role === "super_admin" && !p.tenantId) {
        const ts = await db.select({ id: schema.tenants.id }).from(schema.tenants).limit(2);
        if (ts.length === 1) defaultTenantId = ts[0].id;
      }
    }
  }
  return { user, profile, defaultTenantId };
}

export const authMiddleware = createMiddleware(async (c, next) => {
  if (STUDENT_PATH.test(c.req.path)) {
    c.set("user", null);
    c.set("profile", null);
    return next();
  }
  const key = AuthCache.keyOf(c.req.header("authorization"), c.req.header("cookie"));
  const { user, profile, defaultTenantId } = await authCache.resolve(key, () => loadIdentity(c.req.raw.headers));
  c.set("user", user);
  // Super admin may scope to a specific college via X-Tenant-Id header. `profile`
  // is a per-request copy, so this never leaks into another request.
  if (profile && profile.role === "super_admin") {
    const scope = c.req.header("x-tenant-id");
    if (scope) {
      profile.tenantId = scope;
    } else if (!profile.tenantId) {
      // No explicit scope yet (e.g. first paint before the college switcher
      // has resolved). Default to the sole tenant when exactly one exists so
      // analytics/lists populate instead of returning an empty payload.
      if (defaultTenantId) profile.tenantId = defaultTenantId;
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
