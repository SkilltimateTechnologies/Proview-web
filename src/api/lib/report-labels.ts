/**
 * Branch and home-section labels for report rows.
 *
 * The report used to label each student with a section code only ("CSE-A",
 * "ELITE"). Colleges follow up by department, and ELITE is a cross-branch cohort,
 * so "ELITE" alone tells a CSE coordinator nothing about whose student it is.
 *
 * - section:     the section the student sat the exam in (unchanged: the attempt's
 *                frozen snapshot, else their current section).
 * - branch:      the student's real department. For a student moved into a special
 *                cohort (ELITE) it is the branch of their HOME section
 *                (originalClassId), not the cohort's.
 * - homeSection: that home section's code, only when it differs from `section`.
 */
export type ClassLike = { id: string; code: string; branch: string };
export type StudentLike = { classId: string | null; originalClassId?: string | null };

/** "CSE-A" -> "CSE"; used only when a section code has no class row behind it. */
export function branchFromCode(code: string): string {
  const c = (code ?? "").trim();
  if (!c) return "";
  const i = c.search(/[-\s/]/);
  return (i > 0 ? c.slice(0, i) : c).toUpperCase();
}

export function labelRow(
  sectionCode: string,
  student: StudentLike | undefined,
  classById: Map<string, ClassLike>,
  classByCode: Map<string, ClassLike>,
): { branch: string; homeSection: string | null } {
  const sectionCls = classByCode.get(sectionCode) ?? (student?.classId ? classById.get(student.classId) : undefined);
  const home = student?.originalClassId ? classById.get(student.originalClassId) : undefined;
  const cls = home ?? sectionCls;
  const branch = (cls?.branch ?? "").trim() || branchFromCode(cls?.code ?? sectionCode);
  const homeSection = home && home.code !== sectionCode ? home.code : null;
  return { branch, homeSection };
}
