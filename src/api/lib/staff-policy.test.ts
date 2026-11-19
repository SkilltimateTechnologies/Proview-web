/**
 * Pins the staff-account rules that closed the takeover path found in review:
 * a TPO with the `users` permission could create a super admin, promote anyone
 * (themselves included) to super admin, or reset the super admin's password.
 */
import { describe, expect, test } from "bun:test";
import { assignableRoles, canChangeRole, canManageStaff, inCollege } from "./staff-policy";

const superAdmin = { userId: "u_super", role: "super_admin", tenantId: null };
const collegeAdminA = { userId: "u_ca", role: "college_admin", tenantId: "ten_a" };
const tpoA = { userId: "u_tpo", role: "tpo", tenantId: "ten_a" };
const tpoA2 = { userId: "u_tpo2", role: "tpo", tenantId: "ten_a" };
const tpoB = { userId: "u_tpob", role: "tpo", tenantId: "ten_b" };

describe("who may manage whom", () => {
  test("nobody but a super admin can touch a super admin", () => {
    for (const actor of [collegeAdminA, tpoA, tpoB]) expect(canManageStaff(actor, superAdmin)).toBe(false);
    expect(canManageStaff(superAdmin, superAdmin)).toBe(true);
  });

  test("never across colleges", () => {
    expect(canManageStaff(tpoA, tpoB)).toBe(false);
    expect(canManageStaff(collegeAdminA, tpoB)).toBe(false);
    expect(canManageStaff(superAdmin, tpoB)).toBe(true);
  });

  test("a TPO cannot manage a college admin, but a college admin can manage a TPO", () => {
    expect(canManageStaff(tpoA, collegeAdminA)).toBe(false);
    expect(canManageStaff(collegeAdminA, tpoA)).toBe(true);
    expect(canManageStaff(tpoA, tpoA2)).toBe(true);
  });

  test("an actor without a college manages no one unless super admin", () => {
    expect(canManageStaff({ userId: "x", role: "tpo", tenantId: null }, { userId: "y", role: "tpo", tenantId: null })).toBe(false);
  });

  test("unknown roles rank lowest and grant nothing", () => {
    const odd = { userId: "u_odd", role: "student", tenantId: "ten_a" };
    expect(assignableRoles(odd)).toEqual([]);
    expect(canManageStaff(odd, tpoA)).toBe(false);
  });
});

describe("which roles may be handed out", () => {
  test("only a super admin can create or grant super admin", () => {
    expect(assignableRoles(superAdmin)).toContain("super_admin");
    expect(assignableRoles(collegeAdminA)).not.toContain("super_admin");
    expect(assignableRoles(tpoA)).toEqual(["tpo"]);
  });

  test("no self-promotion below super admin", () => {
    expect(canChangeRole(tpoA, tpoA, "super_admin")).toBe(false);
    expect(canChangeRole(tpoA, tpoA, "college_admin")).toBe(false);
    expect(canChangeRole(collegeAdminA, collegeAdminA, "super_admin")).toBe(false);
  });

  test("a TPO cannot promote a colleague to college admin; a college admin can", () => {
    expect(canChangeRole(tpoA, tpoA2, "college_admin")).toBe(false);
    expect(canChangeRole(collegeAdminA, tpoA, "college_admin")).toBe(true);
    expect(canChangeRole(collegeAdminA, tpoA, "super_admin")).toBe(false);
  });
});

describe("inCollege", () => {
  test("own college only, super admin everywhere, unowned records super admin only", () => {
    expect(inCollege(tpoA, "ten_a")).toBe(true);
    expect(inCollege(tpoA, "ten_b")).toBe(false);
    expect(inCollege(tpoA, undefined)).toBe(false);
    expect(inCollege(tpoA, null)).toBe(false);
    expect(inCollege(superAdmin, "ten_b")).toBe(true);
    expect(inCollege(null, "ten_a")).toBe(false);
  });
});
