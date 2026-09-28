import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { hashPassword } from "better-auth/crypto";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import * as schema from "../database/schema";

export const resetScopeSchema = z.discriminatedUnion("scope", [
  z.object({ tenantId: z.string().min(1), scope: z.literal("all"), mustChangePassword: z.boolean().default(true) }).strict(),
  z.object({ tenantId: z.string().min(1), scope: z.literal("selected"), studentIds: z.array(z.string().min(1)).min(1).max(10000), mustChangePassword: z.boolean().default(true) }).strict(),
]);
export type ResetScope = z.input<typeof resetScopeSchema>;
export type ResetActor = { userId: string; tenantId: string | null; role: string; enabled: boolean; permissions: Record<string, boolean> | null };
type Db = LibSQLDatabase<typeof schema>;
type Target = { id: string; password: string; mustChangePassword: boolean; enabled: boolean };
const DEFAULT_PASSWORD = "Welcome@123";
const TTL = 5 * 60 * 1000;

export function authorizeReset(actor: ResetActor | null, tenantId: string): ResetActor {
  if (!actor) throw new ORPCError("UNAUTHORIZED", { message: "Sign in to manage student passwords." });
  if (!actor.enabled || !(actor.role === "super_admin" || actor.role === "college_admin" || (actor.role === "tpo" && actor.permissions?.users))) {
    throw new ORPCError("FORBIDDEN", { message: "You do not have permission to manage users." });
  }
  if (!actor.tenantId || actor.tenantId !== tenantId) throw new ORPCError("FORBIDDEN", { message: "College scope changed. Reopen the reset dialog in the correct college." });
  return actor;
}

/** No app DB singleton: tests and preview use isolated databases. Never touches staff or exams. */
export function createBulkStudentPasswords(deps: {
  db: Db; secret: () => string; invalidate: (tenantId: string) => void;
  now?: () => number; hash?: (password: string) => Promise<string>;
}) {
  const now = deps.now ?? Date.now;
  function signature(value: string) {
    const secret = deps.secret();
    if (secret.length < 16) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Password reset signing is not configured." });
    return createHmac("sha256", secret).update(value).digest("base64url");
  }
  function condition(input: ResetScope) {
    return input.scope === "all" ? eq(schema.students.tenantId, input.tenantId) : and(
      eq(schema.students.tenantId, input.tenantId),
      sql`${schema.students.id} IN (SELECT value FROM json_each(${JSON.stringify([...new Set(input.studentIds)])}))`,
    );
  }
  async function targets(db: Pick<Db, "select">, input: ResetScope): Promise<Target[]> {
    const rows = await db.select({ id: schema.students.id, password: schema.students.password, mustChangePassword: schema.students.mustChangePassword, enabled: schema.students.enabled })
      .from(schema.students).where(condition(input));
    if (!rows.length) throw new ORPCError("BAD_REQUEST", { message: "No students match this reset." });
    if (input.scope === "selected" && rows.length !== new Set(input.studentIds).size) {
      throw new ORPCError("BAD_REQUEST", { message: "A selected student is missing or belongs to another college. Refresh the list." });
    }
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }
  // HMAC, not a public hash of password hashes. Confirmation never exposes credentials.
  function digest(rows: Target[]) { return signature(JSON.stringify(rows)); }
  function scopeKey(input: ResetScope) { return signature(JSON.stringify(input.scope === "all" ? input : { ...input, studentIds: [...new Set(input.studentIds)].sort() })); }
  function decode(token: string) {
    try {
      const [payload, mac, extra] = token.split(".");
      if (!payload || !mac || extra) throw new Error();
      const actual = Buffer.from(mac); const expected = Buffer.from(signature(payload));
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
      return z.object({ actorId: z.string(), scope: z.string(), digest: z.string(), expiresAt: z.number() }).parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
    } catch { throw new ORPCError("BAD_REQUEST", { message: "Invalid confirmation. Review the affected students again." }); }
  }
  return {
    async preview(actorArg: ResetActor | null, inputArg: ResetScope) {
      const input = resetScopeSchema.parse(inputArg);
      const actor = authorizeReset(actorArg, input.tenantId);
      const [tenant] = await deps.db.select({ name: schema.tenants.name }).from(schema.tenants).where(eq(schema.tenants.id, input.tenantId));
      if (!tenant) throw new ORPCError("NOT_FOUND", { message: "College not found." });
      const rows = await targets(deps.db, input);
      const expiresAt = now() + TTL;
      const payload = Buffer.from(JSON.stringify({ actorId: actor.userId, scope: scopeKey(input), digest: digest(rows), expiresAt })).toString("base64url");
      return { count: rows.length, disabledCount: rows.filter(r => !r.enabled).length, collegeName: tenant.name, tenantId: input.tenantId, mustChangePassword: input.mustChangePassword, expiresAt, confirmationToken: `${payload}.${signature(payload)}` };
    },
    async reset(actorArg: ResetActor | null, inputArg: ResetScope, confirmationToken: string) {
      const input = resetScopeSchema.parse(inputArg);
      const actor = authorizeReset(actorArg, input.tenantId);
      const confirmation = decode(confirmationToken);
      if (confirmation.actorId !== actor.userId || confirmation.scope !== scopeKey(input)) throw new ORPCError("FORBIDDEN", { message: "Confirmation does not match this admin, college or selection." });
      if (confirmation.expiresAt <= now()) throw new ORPCError("CONFLICT", { message: "Confirmation expired. Review the affected students again." });
      // One salted hash per bulk operation, matching existing bulk student provisioning.
      // Compute before acquiring the DB write transaction to keep its lock brief.
      const password = await (deps.hash ?? hashPassword)(DEFAULT_PASSWORD);
      const count = await deps.db.transaction(async tx => {
        const rows = await targets(tx, input);
        if (confirmation.expiresAt <= now() || digest(rows) !== confirmation.digest) {
          throw new ORPCError("CONFLICT", { message: "Student accounts changed, or this reset was already applied. Refresh and review again." });
        }
        const updated = await tx.update(schema.students).set({ password, mustChangePassword: input.mustChangePassword })
          .where(condition(input)).returning({ id: schema.students.id });
        if (updated.length !== rows.length) throw new Error("Reset target count changed inside transaction");
        return updated.length;
      });
      deps.invalidate(input.tenantId);
      // No passwords, hashes, tokens, names or student IDs in logs/response.
      console.info("[bulk-student-password-reset]", JSON.stringify({ actorId: actor.userId, tenantId: input.tenantId, scope: input.scope, count, mustChangePassword: input.mustChangePassword }));
      return { count, mustChangePassword: input.mustChangePassword };
    },
  };
}
export type BulkStudentPasswords = ReturnType<typeof createBulkStudentPasswords>;
