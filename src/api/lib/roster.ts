import { eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/** Minimal exam shape needed for cohort matching. */
export type CohortExam = { classId: string | null; sectionIds: string[] | null; assignMode?: string | null };
/** Minimal student shape needed for cohort matching. */
export type CohortStudent = { classId: string | null };

/**
 * Sections that are OPT-IN ONLY: a student in one of these is never picked up by a
 * broad "all sections" exam. They are only eligible when the exam explicitly names
 * their section (or an explicit roster "add" override).
 *
 * Why: the ELITE cohort is a merit group pulled out of the regular sections. They
 * must NOT see or write the regular-section assessments — including ones scoped to
 * "All sections", which otherwise match every student in the tenant.
 *
 * Populated at startup from the classes table (any class whose code/branch is ELITE).
 */
const OPT_IN_ONLY_CLASS_IDS = new Set<string>();

/** Register a class id as opt-in-only (called after loading classes). */
export function markOptInOnly(classId: string) {
  if (classId) OPT_IN_ONLY_CLASS_IDS.add(classId);
}

/** True when this class is opt-in-only (e.g. ELITE). */
export function isOptInOnlyClass(classId: string | null | undefined): boolean {
  return Boolean(classId && OPT_IN_ONLY_CLASS_IDS.has(classId));
}

/** Class code/branch values treated as opt-in-only cohorts. */
export function isOptInOnlyCode(codeOrBranch: string | null | undefined): boolean {
  return /^elite$/i.test((codeOrBranch ?? "").trim());
}

/**
 * Base cohort eligibility: an exam targets a class (optionally scoped to a
 * subset of sections). A null/empty classId means "all classes"; a null/empty
 * sectionIds means "all sections of that class".
 */
export function matchesCohort(exam: CohortExam, stu: CohortStudent): boolean {
  // "students" mode: nobody matches by cohort — only the explicit add-list is eligible.
  if (exam.assignMode === "students") return false;
  const explicitSections = Array.isArray(exam.sectionIds) && exam.sectionIds.length ? exam.sectionIds : null;
  // Opt-in-only cohort (ELITE): eligible ONLY when the exam explicitly targets that
  // section. A broad "all sections" exam (no sectionIds) must skip them entirely.
  if (isOptInOnlyClass(stu.classId)) {
    return Boolean(explicitSections && stu.classId && explicitSections.includes(stu.classId));
  }
  if (exam.classId && stu.classId && exam.classId !== stu.classId) return false;
  if (explicitSections && stu.classId && !explicitSections.includes(stu.classId)) return false;
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

/**
 * Load (and cache) the set of opt-in-only class ids from the classes table.
 * Cheap: one query, cached until a class is created/renamed/deleted, at which point
 * `invalidateOptInOnlyCache()` forces a reload. Must be awaited before any
 * eligibility check so ELITE students are correctly excluded from broad exams.
 */
let optInLoaded = false;
let optInLoading: Promise<void> | null = null;

export function invalidateOptInOnlyCache() {
  optInLoaded = false;
  optInLoading = null;
  OPT_IN_ONLY_CLASS_IDS.clear();
}

export async function ensureOptInOnlyLoaded(): Promise<void> {
  if (optInLoaded) return;
  if (optInLoading) return optInLoading;
  optInLoading = (async () => {
    const rows = await db.select().from(schema.classes);
    OPT_IN_ONLY_CLASS_IDS.clear();
    for (const cl of rows) {
      if (isOptInOnlyCode(cl.code) || isOptInOnlyCode(cl.branch)) OPT_IN_ONLY_CLASS_IDS.add(cl.id);
    }
    optInLoaded = true;
    optInLoading = null;
  })();
  return optInLoading;
}

/** Load the add/remove override sets for a single exam. */
export async function loadRoster(examId: string): Promise<Roster> {
  await ensureOptInOnlyLoaded();
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
  await ensureOptInOnlyLoaded();
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
