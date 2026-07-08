import { eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/** Minimal exam shape needed for cohort matching. */
export type CohortExam = { classId: string | null; sectionIds: string[] | null };
/** Minimal student shape needed for cohort matching. */
export type CohortStudent = { classId: string | null };

/**
 * Base cohort eligibility: an exam targets a class (optionally scoped to a
 * subset of sections). A null/empty classId means "all classes"; a null/empty
 * sectionIds means "all sections of that class".
 */
export function matchesCohort(exam: CohortExam, stu: CohortStudent): boolean {
  if (exam.classId && stu.classId && exam.classId !== stu.classId) return false;
  if (Array.isArray(exam.sectionIds) && exam.sectionIds.length && stu.classId && !exam.sectionIds.includes(stu.classId)) return false;
  return true;
}

/** Per-exam roster overrides: which students were explicitly added / removed. */
export type Roster = { add: Set<string>; remove: Set<string> };

const EMPTY_ROSTER: Roster = { add: new Set(), remove: new Set() };

/**
 * Final eligibility for an exam, honouring ad-hoc roster overrides.
 *  - an explicit "add" always wins (eligible regardless of cohort)
 *  - an explicit "remove" excludes the student (even if the cohort matches)
 *  - otherwise fall back to plain cohort matching
 */
export function isEligible(exam: CohortExam, stu: CohortStudent & { id: string }, roster: Roster = EMPTY_ROSTER): boolean {
  if (roster.add.has(stu.id)) return true;
  if (roster.remove.has(stu.id)) return false;
  return matchesCohort(exam, stu);
}

/** Load the add/remove override sets for a single exam. */
export async function loadRoster(examId: string): Promise<Roster> {
  const rows = await db.select().from(schema.examRoster).where(eq(schema.examRoster.examId, examId));
  const add = new Set<string>();
  const remove = new Set<string>();
  for (const r of rows) {
    if (r.mode === "add") add.add(r.studentId);
    else if (r.mode === "remove") remove.add(r.studentId);
  }
  return { add, remove };
}

/** Load roster overrides for many exams at once, keyed by examId. */
export async function loadRosters(examIds: string[]): Promise<Map<string, Roster>> {
  const out = new Map<string, Roster>();
  if (!examIds.length) return out;
  const rows = await db.select().from(schema.examRoster).where(inArray(schema.examRoster.examId, examIds));
  for (const r of rows) {
    let entry = out.get(r.examId);
    if (!entry) { entry = { add: new Set(), remove: new Set() }; out.set(r.examId, entry); }
    if (r.mode === "add") entry.add.add(r.studentId);
    else if (r.mode === "remove") entry.remove.add(r.studentId);
  }
  return out;
}

export { EMPTY_ROSTER };
