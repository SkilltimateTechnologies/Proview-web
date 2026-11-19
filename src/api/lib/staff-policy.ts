/**
 * Who may manage which staff account, and which college a record may be touched from.
 *
 * WHY THIS EXISTS (security review, 2026-11-19)
 * ---------------------------------------------
 * The staff-account endpoints only asked "does the caller have the `users`
 * permission?". They never asked WHOSE account was being changed or WHAT role was
 * being granted, so any TPO with that permission could:
 *   - create an account with role `super_admin` (POST /users took `role` from the body),
 *   - promote any account, including their own, to `super_admin` (PATCH /users/:id),
 *   - reset the platform super admin's password and receive it in the response
 *     (POST /users/:id/reset-password),
 * in their own college or any other. That is a full platform takeover from one TPO login.
 * Separately, many edit/delete endpoints looked a record up by id alone, so a staff
 * user of one college could change another college's exams, students or questions
 * by id. Both rules live here, pure and unit-tested, so every route asks the same way.
 */

export type StaffActor = { userId: string; role: string; tenantId: string | null };
export type StaffTarget = { userId: string; role: string; tenantId: string | null };

/** Higher outranks lower. Unknown roles rank lowest, so they can never escalate. */
const RANK: Record<string, number> = { tpo: 1, college_admin: 2, super_admin: 3 };
const rank = (role: string | null | undefined) => RANK[role ?? ""] ?? 0;

export const isSuperAdmin = (actor: { role: string } | null | undefined) => actor?.role === "super_admin";

/** Roles this actor may hand out (on create, or by changing someone's role). */
export function assignableRoles(actor: StaffActor): string[] {
  if (actor.role === "super_admin") return ["super_admin", "college_admin", "tpo"];
  if (actor.role === "college_admin") return ["college_admin", "tpo"];
  if (actor.role === "tpo") return ["tpo"];
  return [];
}

/**
 * May `actor` edit, reset the password of, or delete `target`?
 *  - a super admin may manage anyone;
 *  - everyone else only inside their own college, never a super admin, and only
 *    accounts that do not outrank them (a TPO cannot reset a college admin's password).
 */
export function canManageStaff(actor: StaffActor, target: StaffTarget): boolean {
  if (actor.role === "super_admin") return true;
  if (!actor.tenantId || target.tenantId !== actor.tenantId) return false;
  if (target.role === "super_admin") return false;
  return rank(target.role) <= rank(actor.role);
}

/**
 * Is a role change from `from` to `to` allowed for this actor on this target?
 * Nobody but a super admin changes their own role (no self-promotion).
 */
export function canChangeRole(actor: StaffActor, target: StaffTarget, to: string): boolean {
  if (!canManageStaff(actor, target)) return false;
  if (actor.role !== "super_admin" && actor.userId === target.userId) return false;
  return assignableRoles(actor).includes(to);
}

/**
 * May this staff profile touch a record that belongs to `recordTenantId`?
 * A super admin may (they work across colleges, scoped by the X-Tenant-Id header);
 * everyone else only within their own college. A record with no college is
 * treated as nobody's, so only a super admin can touch it.
 */
export function inCollege(profile: { role: string; tenantId: string | null } | null | undefined, recordTenantId: string | null | undefined): boolean {
  if (!profile) return false;
  if (profile.role === "super_admin") return true;
  return !!profile.tenantId && !!recordTenantId && profile.tenantId === recordTenantId;
}
