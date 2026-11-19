/**
 * Shared state and helpers for the API route modules (routes/*.ts): caches,
 * settings, exam paper and student-list loaders, monitor snapshot, tenant
 * ownership checks. Split out of index.ts; behaviour unchanged.
 */
import { eq, and, or, desc, gte, inArray, sql as dsql } from "drizzle-orm";
import { db } from "./database";
import * as schema from "./database/schema";
import { allowedOrigins } from "./lib/http-guard";
import type { SessionUser, ProfileCtx } from "./middleware/auth";
import { id } from "./lib/util";
import { recordMonitorBuild } from "./lib/watchdog";
import { optionTranslator, tokenIsCurrent } from "./lib/option-order";
import { isEligible, loadRosters } from "./lib/roster";
import { TtlCache } from "./lib/ttl-cache";
import { heartbeats } from "./lib/heartbeat-queue";
import { integrityRollup } from "./lib/integrity-rollup";
import { attemptTenants, evidenceMeter, resolveLimit, tenantQuotas } from "./lib/tenant-quota";
import { TenantDirectory } from "./lib/tenant-directory";
import { studentLoginThrottle } from "./lib/login-throttle";
import { createBulkStudentPasswords } from "./lib/bulk-student-passwords";

export type Vars = { user: SessionUser | null; profile: ProfileCtx | null; requestId?: string };

/* ---------------------------------------------------------------------------
 * Read caches for the rows that 1000 students read simultaneously.
 *
 * The database is remote (Turso over HTTP), so every `await db.…` is a network
 * round trip. During an exam the client fleet re-reads the same handful of
 * admin-authored rows over and over — the exam row on every 15s heartbeat, the
 * exam's question list on every autosave, the single global settings row on every
 * bundle fetch and code run. At 1000 students that is hundreds of identical
 * queries a second for rows that change a couple of times an hour, and it is
 * what stopped pages from loading.
 *
 * TtlCache also coalesces concurrent misses, so a thundering herd on one exam id
 * collapses into ONE query rather than 67. Only admin-authored data is cached;
 * per-attempt state a student is actively mutating (answers, attempt status) is
 * always read live. Writes invalidate their key so an admin action still lands
 * immediately instead of waiting out the TTL.
 * ------------------------------------------------------------------------- */
/** Settings are edited from one admin screen; 5s stale is invisible there. */
export const SETTINGS_CACHE_MS = 5_000;
/** Holds/extra time must reach students fast, and the heartbeat is 15s anyway. */
export const EXAM_CACHE_MS = 3_000;
/** An exam's question set is frozen for the duration of the exam in practice. */
export const EXAM_QUESTIONS_CACHE_MS = 30_000;

export type SettingsRow = typeof schema.settings.$inferSelect;
export type ExamRow = typeof schema.exams.$inferSelect;
export type TranslatorQuestion = { id: string; type: string; options: unknown };

export const settingsCache = new TtlCache<SettingsRow>(SETTINGS_CACHE_MS);
export const examCache = new TtlCache<ExamRow | null>(EXAM_CACHE_MS);
export const examQuestionsCache = new TtlCache<{ questionIds: string[]; questions: TranslatorQuestion[] }>(
  EXAM_QUESTIONS_CACHE_MS,
);

/**
 * The admin side has the same round-trip problem the student side had, for a
 * different reason: nine staff endpoints (/dashboard, /reports, /reports/:examId,
 * /monitor, the roster pickers) each OPENED by reading the tenant's entire
 * students table plus the entire classes table, just to turn a studentId into a
 * name and a classId into a section code. Measured on prod that was 7.9 SQL
 * statements per admin request against 2.23 for the tuned student path.
 *
 * Students and classes are admin-authored and change on a human timescale, and
 * every write below invalidates its tenant, so the only staleness a real operator
 * can observe is a concurrent edit by a DIFFERENT admin landing up to 15s late on
 * a dashboard. Worth it to stop re-reading 1,124 rows per page load.
 */
export const DIRECTORY_CACHE_MS = 15_000;

export type StudentRow = typeof schema.students.$inferSelect;
export type ClassRow = typeof schema.classes.$inferSelect;

export const directory = new TenantDirectory<StudentRow, ClassRow>({
  ttlMs: DIRECTORY_CACHE_MS,
  loadStudents: (tid) => db.select().from(schema.students).where(eq(schema.students.tenantId, tid)),
  loadClasses: (tid) => db.select().from(schema.classes).where(eq(schema.classes.tenantId, tid)),
});

/** Platform-global settings live in a single row (id = "global"). */
export const GLOBAL_SETTINGS = "global";
/**
 * Whether a student is writing an exam right now ("Run code" is allowed only
 * then). Positive answers are cached briefly; a negative answer is re-checked on
 * the next run, so a student who just started is never refused for long.
 */
export const examInProgressCache = new TtlCache<boolean>(60_000, Date.now, 20_000);
export async function hasExamInProgress(studentId: string): Promise<boolean> {
  if (examInProgressCache.get(studentId)) return true;
  const [row] = await db
    .select({ id: schema.attempts.id })
    .from(schema.attempts)
    .where(and(eq(schema.attempts.status, "in_progress"), eq(schema.attempts.studentId, studentId)))
    .limit(1);
  if (row) examInProgressCache.set(studentId, true);
  return !!row;
}

/** Minimum minutes before a student may submit (Settings → Proctoring). */
export async function minSubmitMinutes(): Promise<number> {
  const gs = await getGlobalSettings();
  const v = Number({ ...schema.DEFAULT_PROCTORING, ...(gs.proctoring ?? {}) }.minSubmitMinutes);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 600) : 0;
}

export async function getGlobalSettings() {
  return settingsCache.load(GLOBAL_SETTINGS, async () => {
    let [s] = await db.select().from(schema.settings).where(eq(schema.settings.id, GLOBAL_SETTINGS));
    if (!s) [s] = await db.insert(schema.settings).values({ id: GLOBAL_SETTINGS }).returning();
    return s;
  });
}
/** Call after writing the settings row so the next read is authoritative. */
export function invalidateGlobalSettings() {
  settingsCache.invalidate(GLOBAL_SETTINGS);
}

/**
 * Exam row for the student polling paths (heartbeat / status).
 *
 * Deliberately NOT used by /start, /submit or any admin write: those must decide
 * against live state. Returns null (a cached negative) for an unknown id so a bogus
 * examId cannot be used to hammer the database.
 */
export async function getExamForPolling(eid: string): Promise<ExamRow | null> {
  return examCache.load(eid, async () => {
    const [exam] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    return exam ?? null;
  });
}
/** Call whenever an exam row changes (hold, resume, extra time, edit, delete). */
export function invalidateExam(eid: string) {
  examCache.invalidate(eid);
  invalidateStudentExamLists();
}

/**
 * The exam's question ids plus the fields option-order translation needs.
 *
 * One cached read now serves what used to be three separate queries per autosave
 * (the valid-question check, and the translator's own two reads).
 */
export async function getExamQuestionSet(examId: string) {
  return examQuestionsCache.load(examId, async () => {
    const eqs = await db
      .select({ questionId: schema.examQuestions.questionId })
      .from(schema.examQuestions)
      .where(eq(schema.examQuestions.examId, examId));
    const questionIds = eqs.map((e) => e.questionId);
    const questions = questionIds.length
      ? await db
          .select({ id: schema.questions.id, type: schema.questions.type, options: schema.questions.options })
          .from(schema.questions)
          .where(inArray(schema.questions.id, questionIds))
      : [];
    return { questionIds, questions };
  });
}
/** Call when an exam's question set or a question's options change. */
export function invalidateExamQuestions(examId: string) {
  examQuestionsCache.invalidate(examId);
  examPaperCache.invalidate(examId);
}

/**
 * The full paper for one exam: its exam_questions rows in order plus the question
 * rows. Identical for every student, and read by /bundle (every student at the
 * start bell) and by submit (every student at the final bell) — 2 statements each,
 * ~2,200 times inside a couple of minutes, for data that does not change during an
 * exam. Server-side only: it contains the answer key and is never sent as-is.
 * Same 30s TTL and invalidation as the question-set cache above.
 */
export type ExamQuestionRow = typeof schema.examQuestions.$inferSelect;
export type QuestionRow = typeof schema.questions.$inferSelect;
export const examPaperCache = new TtlCache<{ eqs: ExamQuestionRow[]; qs: QuestionRow[] }>(EXAM_QUESTIONS_CACHE_MS);
export async function getExamPaper(examId: string) {
  return examPaperCache.load(examId, async () => {
    const eqs = await db.select().from(schema.examQuestions).where(eq(schema.examQuestions.examId, examId)).orderBy(schema.examQuestions.order);
    const qids = eqs.map((q) => q.questionId);
    const qs = qids.length ? await db.select().from(schema.questions).where(inArray(schema.questions.id, qids)) : [];
    return { eqs, qs };
  });
}

/**
 * Tenant-wide half of the student dashboard (/student/exams): the tenant's exams,
 * their roster overrides and question counts. Every waiting student polls this
 * every 15s and ALL of them refetch at the exam's start time, and it is identical
 * for everyone in the college — 3 of the endpoint's 5 statements. Cached 5s;
 * dropped on any exam or roster write so an admin change still shows at once.
 */
export const STUDENT_EXAM_LIST_CACHE_MS = 5_000;
export type ExamListBase = { exams: ExamRow[]; rosters: Map<string, import("./lib/roster").Roster>; questionCounts: Map<string, number> };
export const studentExamListCache = new TtlCache<ExamListBase>(STUDENT_EXAM_LIST_CACHE_MS);
export async function getStudentExamListBase(tenantId: string): Promise<ExamListBase> {
  return studentExamListCache.load(tenantId, async () => {
    const exams = await db
      .select()
      .from(schema.exams)
      .where(and(eq(schema.exams.tenantId, tenantId), inArray(schema.exams.status, ["scheduled", "live", "finished"])))
      .orderBy(desc(schema.exams.createdAt));
    const ids = exams.map((e) => e.id);
    const rosters = await loadRosters(ids);
    const counts = ids.length
      ? await db
          .select({ examId: schema.examQuestions.examId, n: dsql<number>`count(*)` })
          .from(schema.examQuestions)
          .where(inArray(schema.examQuestions.examId, ids))
          .groupBy(schema.examQuestions.examId)
      : [];
    return { exams, rosters, questionCounts: new Map(counts.map((r) => [r.examId, Number(r.n)])) };
  });
}
/** Call after any write to exams or exam_roster. Rare, so it simply drops all tenants. */
export function invalidateStudentExamLists() {
  studentExamListCache.clear();
}

/**
 * One finalize per attempt at a time in this process. When the database is slow
 * the client's 20s timeout fires while the server is still grading, and the client
 * retries — so a single student could have two or three identical finalizes
 * running, each paying the full statement cost, exactly when the database can
 * least afford it. A repeat now waits for the one already running and returns its
 * answer. (Across processes the existing idempotent upserts still apply.)
 */
export const submitsInFlight = new Map<string, Promise<{ score: number; status: "submitted" | "graded"; gradeAt: number | null }>>();

// Resolve the tenant for the public registration page from a URL code.
// Accepts (case-insensitive) the college short code (shortName), the slug, or the raw tenant id.
export async function resolveRegisterTenant(codeRaw: string) {
  const code = String(codeRaw ?? "").trim();
  if (!code) return null;
  const lower = code.toLowerCase();
  const [byCode] = await db
    .select()
    .from(schema.tenants)
    .where(
      and(
        eq(schema.tenants.enabled, true),
        or(
          dsql`lower(${schema.tenants.shortName}) = ${lower}`,
          dsql`lower(${schema.tenants.slug}) = ${lower}`,
          eq(schema.tenants.id, code),
        ),
      ),
    );
  return byCode ?? null;
}

// ---- Proctoring evidence ----
// Persist integrity/violation events reported by the running student client
// (camera loss, tab switch, fullscreen exit, blocked copy/paste, extra monitor…).
// The client flushes events the moment they happen AND resends the full list at
// submit as a backstop, so we dedupe on (type, at) against what's already stored.
// `photoKey` is the object-storage key of the webcam snapshot captured at that
// moment; it is only accepted inside this attempt's own prefix.
export const INTEGRITY_PREFIX = (attemptId: string) => `integrity/${attemptId}/`;

// Timed camera frames: evidence, not misconduct. They belong in the Snapshots
// trail and must never inflate a violation count.
export const FRAME_EVENT_TYPES = ["periodic_snapshot", "preflight_snapshot"] as const;
export const isFrameEvent = (t: string) => (FRAME_EVENT_TYPES as readonly string[]).includes(t);
// Informational rows that belong on the integrity timeline (a reviewer wants to
// see when a blocked camera view cleared) but are not themselves violations.
// `camera_block_dismissed` is retired: it was the student's own claim that the room
// was merely dim, written when a covered lens was dismissable after 60s. Covering the
// lens now locks the exam outright and nothing emits this type any more. It stays in
// this set so the rows already in the table keep scoring the way they did when they
// were written — it was context for the `camera_obstructed` row that always precedes
// it, not a second offence, and counting it now would retroactively double-count a
// single episode for students who sat the exam under the old rule.
// `focus_loss` is window.blur, which fires for things the student does not control:
// an OS/antivirus/notification toast stealing focus. Measured live, 36 attempts logged
// it on a near-perfect 60s cadence (median gap 60.0s, each machine with its own fixed
// second-offset) while `tab_switch` fired only twice overall — i.e. the tab never left
// the foreground. Counting it produced ~15 phantom violations an hour for students who
// did nothing wrong, so it stays on the timeline as context but no longer scores.
// Real tab/app switching is still caught by `tab_switch` (visibilitychange).
// `snapshot_failed` is the client reporting that a timed capture produced no frame —
// a dead/absent webcam, a permission the browser never really granted, or an upload
// that never landed. It exists so a camera that never worked leaves a trail instead of
// silence (before it, "camera dead all exam" and "camera fine" were byte-identical in
// this table). It must NEVER score: it is a device fault the student may not even be
// able to see, and counting it would mark a broken laptop as cheating — roughly 18 rows
// per 90-minute exam at its 5-minute throttle, which would swamp every real violation.
// "evidence_capped" is the single marker written when a tenant's stored-evidence
// ceiling stops further frames (lib/tenant-quota.ts). It is a platform decision,
// not student behaviour, so like snapshot_failed it must never score.
export const NON_VIOLATION_TYPES = new Set<string>([...FRAME_EVENT_TYPES, "camera_restored", "camera_block_dismissed", "focus_loss", "snapshot_failed", "evidence_capped"]);

export type RawIntegrityEvent = { type?: unknown; detail?: unknown; at?: unknown; photoKey?: unknown; photoUrl?: unknown };

export async function persistIntegrityEvents(attemptId: string, raw: unknown): Promise<number> {
  if (!Array.isArray(raw) || raw.length === 0) return 0;
  const incoming = (raw as RawIntegrityEvent[]).slice(0, 300);

  // Existing (type|at) keys for this attempt so a resend can't double-insert.
  //
  // Bounded to `at >= the oldest incoming event`: nothing older than that can
  // possibly collide with this batch, and by the end of a 90-minute exam an attempt
  // has hundreds of rows (a snapshot every 27s) that the every-10s flush was
  // re-reading in full. `integrity_attempt_at_idx` makes this a narrow range scan.
  const incomingAtMs = incoming
    .map((ev) => Number(ev?.at))
    .filter((ms) => Number.isFinite(ms) && ms > 0);
  const sinceMs = incomingAtMs.length ? Math.min(...incomingAtMs) : 0;
  const existing = await db
    .select({ type: schema.integrityEvents.type, at: schema.integrityEvents.at })
    .from(schema.integrityEvents)
    .where(
      sinceMs > 0
        ? and(eq(schema.integrityEvents.attemptId, attemptId), gte(schema.integrityEvents.at, new Date(sinceMs)))
        : eq(schema.integrityEvents.attemptId, attemptId),
    );
  const seen = new Set(existing.map((e) => `${e.type}|${new Date(e.at).getTime()}`));

  const rows: { id: string; attemptId: string; type: string; detail: string | null; photoUrl: string | null; at: Date }[] = [];
  for (const ev of incoming) {
    const type = String(ev?.type ?? "").trim().slice(0, 40);
    if (!type) continue;
    const atMs = Number(ev?.at);
    const at = Number.isFinite(atMs) && atMs > 0 ? atMs : Date.now();
    const key = `${type}|${at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const detailRaw = ev?.detail == null ? "" : String(ev.detail).trim().slice(0, 300);
    const photoRaw = String(ev?.photoKey ?? ev?.photoUrl ?? "").trim();
    const photoUrl = photoRaw.startsWith(INTEGRITY_PREFIX(attemptId)) ? photoRaw.slice(0, 300) : null;
    rows.push({ id: id("iev"), attemptId, type, detail: detailRaw || null, photoUrl, at: new Date(at) });
  }
  if (rows.length === 0) return 0;

  // ---- Per-tenant stored-evidence ceiling (lib/tenant-quota.ts) ----
  // Bounds the one table that is kept forever by decision. VIOLATIONS ARE NEVER
  // TRIMMED — only periodic frames and device-fault rows are, and a single
  // `evidence_capped` marker records why they stop, so the silence §34 was
  // written to eliminate does not come back through the quota door.
  //
  // The whole block is skipped, at zero query cost, unless a ceiling is actually
  // configured: the settings row is already cached in-process, and the
  // "any tenant override at all?" question is one cached count a minute.
  let toInsert = rows;
  const gsQuota = await getGlobalSettings();
  const capPossible =
    resolveLimit(gsQuota.maxEvidencePerAttempt, null) !== null || (await tenantQuotas.overridesExist(db));
  if (capPossible) {
    const capTenant = await attemptTenants.load(db, attemptId);
    const cap = capTenant ? (await tenantQuotas.load(db, capTenant, gsQuota)).maxEvidencePerAttempt : null;
    if (cap !== null) {
      const room = await evidenceMeter.room(db, attemptId, cap, NON_VIOLATION_TYPES);
      const kept: typeof rows = [];
      let evidenceKept = 0;
      let dropped = 0;
      for (const r of rows) {
        if (!NON_VIOLATION_TYPES.has(r.type)) {
          kept.push(r); // misconduct: stored regardless of any ceiling
          continue;
        }
        if (evidenceKept < room) {
          kept.push(r);
          evidenceKept += 1;
          continue;
        }
        dropped += 1;
      }
      // One marker per attempt per process. It is itself an evidence type, so a
      // later reseed counts it and the ceiling engages one row earlier — a
      // one-row drift, deliberately not worth a second counter.
      if (dropped > 0 && evidenceMeter.noticeOnce(attemptId)) {
        kept.push({ id: id("iev"), attemptId, type: "evidence_capped", detail: `stored-evidence ceiling ${cap} reached`, photoUrl: null, at: new Date() });
      }
      evidenceMeter.add(attemptId, evidenceKept);
      toInsert = kept;
    }
  }
  if (toInsert.length === 0) return 0;
  // Chunked insert — SQLite/libSQL caps bound variables per statement.
  for (let i = 0; i < toInsert.length; i += 50) {
    await db.insert(schema.integrityEvents).values(toInsert.slice(i, i + 50));
  }
  return toInsert.length;
}

/**
 * Build the per-student option-order translator for one exam.
 *
 * `clientToken` is the scheme token the client reports (it came from the bundle it
 * rendered). When it is missing or from an older build, the translator is inert
 * and every index is passed through unchanged — that client is looking at the
 * ORIGINAL option order, so its indices are already original.
 *
 * Only loads the question rows when translation is actually active, so the
 * autosave path (called on every single answer) costs nothing extra for clients
 * that don't need it.
 */
export async function answerTranslator(examId: string, studentId: string, clientToken: unknown) {
  if (!tokenIsCurrent(clientToken)) return optionTranslator(studentId, examId, [], false);
  const { questions } = await getExamQuestionSet(examId);
  return optionTranslator(studentId, examId, questions, true);
}

/** Find a student in a tenant by roll number, ignoring case and padding. */
export async function findStudentByRoll(tid: string, roll: string) {
  const [row] = await db
    .select({ id: schema.students.id, rollNo: schema.students.rollNo, name: schema.students.name })
    .from(schema.students)
    .where(and(eq(schema.students.tenantId, tid), dsql`upper(trim(${schema.students.rollNo})) = ${roll}`))
    .limit(1);
  return row ?? null;
}

/**
 * Live Monitor payload, built once per tenant and shared between callers.
 *
 * Extracted from the route handler so the result can be cached and so concurrent
 * invigilators coalesce onto a single build. See getMonitorSnapshot below.
 */
export async function buildMonitorSnapshot(tid: string) {
  const now = Date.now();
  // An exam is effectively live when its DB status is "live", OR when it is
  // still "scheduled" but its start time has already passed (students can start
  // it at that point). This mirrors the "LIVE / In progress" badge on the
  // Schedule Assessment list, which is derived the same way. Without this, a
  // scheduled exam whose start time passed would show as live on the list but
  // never appear in the Live Monitor.
  const startMs = (e: { startAt: Date | number | string | null }) => {
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
  // An exam is OVER once its window (endAt + any admin extra time + total hold
  // time) has fully elapsed. A currently-held exam is paused, not over. Over
  // exams must drop off the Live Monitor entirely — there is nothing live.
  const isOver = (e: { endAt: number | string | Date | null; extraMin?: number | null; holdMs?: number | null; heldAt?: number | string | Date | null }) => {
    if (e.heldAt) return false;
    if (e.endAt == null) return false;
    const end = e.endAt instanceof Date ? e.endAt.getTime() : typeof e.endAt === "number" ? e.endAt : new Date(e.endAt).getTime();
    if (Number.isNaN(end)) return false;
    const extra = (e.extraMin ?? 0) * 60_000 + (e.holdMs ?? 0);
    return now > end + extra;
  };
  const liveExams = [...dbLive, ...startedScheduled].filter((e) => !isOver(e));

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

  // Students and classes for the tenant, served from the shared directory cache
  // (see TenantDirectory above) so a 5s monitor poll does not re-read ~1200 rows:
  //   * `studentById` resolves an attempt's student name/roll. It must include
  //     disabled students because someone can be disabled mid-term while their
  //     attempt still exists. Resolving from this map instead of querying per
  //     attempt turns ~1200 round trips into one.
  //   * `allStudents` (enabled only) is the assignable cohort, used to work out
  //     who has not started yet.
  const studentIdx = await directory.studentIndex(tid);
  const studentById = studentIdx.byId;
  const allStudents = studentIdx.enabled;
  // Resolve a student's classId to a readable section code (e.g. "CSE-C").
  const classCodeById = (await directory.classIndex(tid)).codeById;
  const sectionOf = (classId: string | null) => (classId ? classCodeById.get(classId) ?? "" : "");
  const liveRosters = await loadRosters(liveExams.map((e) => e.id));
  const assignedStudents = (e: { id: string; classId: string | null; sectionIds: string[] | null }) =>
    allStudents.filter((stu) => isEligible(e, stu, liveRosters.get(e.id)));

  const out = await Promise.all(
    liveExams.map(async (ex) => {
      // Only the columns this view uses. A full attempt row carries the 300-char
      // user agent and more; at 1,100 students on a 5s poll that was ~0.5 MB read
      // from the database per build for nothing.
      const atts = await db
        .select({
          id: schema.attempts.id,
          studentId: schema.attempts.studentId,
          status: schema.attempts.status,
          lastSeenAt: schema.attempts.lastSeenAt,
          startedAt: schema.attempts.startedAt,
          submittedAt: schema.attempts.submittedAt,
          score: schema.attempts.score,
        })
        .from(schema.attempts)
        .where(eq(schema.attempts.examId, ex.id));
      // Everyone who has engaged with the exam (in progress or already submitted/graded).
      const engaged = atts.filter((a) => a.status !== "not_started");
      // Proctoring evidence per attempt: violation count + newest snapshot key.
      //
      // PERFORMANCE — this is what used to hang the Live Monitor, twice over.
      // First it SELECTed every integrity_events row for every engaged attempt and
      // aggregated in JS: 27,153 rows (~1.7 MB of photo keys) per 5s poll on "Elite
      // Assessment - 1", doubled with two exams live, so a poll outlasted the poll
      // interval and the page froze. That became two grouped statements, which was
      // far better but still TOUCHED every event row of every engaged attempt on
      // every build - a cost that grows with exam duration x watch time.
      //
      // Now the aggregate is carried forward and only rows inserted since the last
      // build are read, off the `rowid` watermark. Evidence is monotonic, so that is
      // exact; see lib/integrity-rollup.ts for why the watermark lives in the
      // database rather than in a counter here, and what deletes do to it.
      const evAgg = await integrityRollup.load(db, ex.id, NON_VIOLATION_TYPES, now);
      const enriched = await Promise.all(
        engaged.map(async (a) => {
          const stu = studentById.get(a.studentId);
          const status = a.status === "in_progress" ? "in_progress" : "finished";
          // Online = a heartbeat within the last 40s (heartbeat interval is ~15s).
          // Heartbeats are coalesced and written every 5s, so the freshest ping for
          // this attempt may not be in the row we just read — overlay whatever is
          // still pending in this process, which makes the dot MORE accurate than
          // the database (zero staleness) rather than less.
          const pendingSeen = heartbeats.peekSeen(a.id);
          const lastSeenMs = Math.max(
            a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0,
            pendingSeen ?? 0,
          );
          const online = a.status === "in_progress" && lastSeenMs > 0 && now - lastSeenMs < 40_000;
          const agg = evAgg.get(a.id);
          // `snapshot` is kept in the payload for compatibility but no longer
          // signed: the Live Monitor page never displays it (the drawer loads
          // evidence from the reports endpoint), and signing a fresh URL for every
          // student's newest frame cost ~0.35 ms of CPU each — on the single
          // thread that also answers students — plus ~460 bytes per row.
          const snapshot: string | null = null;
          return {
            attemptId: a.id,
            examId: ex.id,
            student: stu?.name ?? "—",
            rollNo: stu?.rollNo ?? "",
            section: sectionOf(stu?.classId ?? null),
            status,
            online,
            lastSeenAt: lastSeenMs > 0 ? new Date(lastSeenMs) : a.lastSeenAt,
            startedAt: a.startedAt,
            submittedAt: a.submittedAt,
            score: a.status === "graded" ? a.score : null,
            graded: a.status === "graded",
            snapshot,
            violations: agg?.violations ?? 0,
          };
        }),
      );
      // Assigned students who have not started. If the exam window has closed
      // (now > endAt) they never showed up → "absent"; otherwise they can still
      // begin → "not_started".
      const endMs = ex.endAt ? new Date(ex.endAt).getTime() : null;
      const windowClosed = endMs !== null && !Number.isNaN(endMs) && now > endMs;
      const engagedStudentIds = new Set(engaged.map((a) => a.studentId));
      const notStarted = assignedStudents(ex)
        .filter((stu) => !engagedStudentIds.has(stu.id))
        .map((stu) => ({
          attemptId: `ns-${stu.id}`,
          examId: ex.id,
          student: stu.name ?? "—",
          rollNo: stu.rollNo ?? "",
          section: sectionOf(stu.classId ?? null),
          status: (windowClosed ? "absent" : "not_started") as "absent" | "not_started",
          online: false,
          lastSeenAt: null as string | null,
          startedAt: null as string | null,
          submittedAt: null as string | null,
          snapshot: null as string | null,
          violations: 0,
        }));
      const absentCount = windowClosed ? notStarted.length : 0;
      return {
        examId: ex.id,
        title: ex.title,
        held: !!ex.heldAt,
        heldAt: ex.heldAt,
        extraMin: ex.extraMin ?? 0,
        active: engaged.filter((a) => a.status === "in_progress").length,
        online: enriched.filter((s) => s.online).length,
        submitted: engaged.filter((a) => a.status !== "in_progress").length,
        notStarted: windowClosed ? 0 : notStarted.length,
        absent: absentCount,
        students: [...enriched, ...notStarted],
      };
    }),
  );
  return { live: out, nextScheduled };
}

/** How long a built snapshot may be reused. Well under the 5s client poll. */
export const MONITOR_CACHE_MS = 3000;
export type MonitorSnapshot = Awaited<ReturnType<typeof buildMonitorSnapshot>>;
export const monitorCache = new Map<string, { at: number; data: MonitorSnapshot }>();
export const monitorInFlight = new Map<string, Promise<MonitorSnapshot>>();

export async function getMonitorSnapshot(tid: string): Promise<MonitorSnapshot> {
  const cached = monitorCache.get(tid);
  if (cached && Date.now() - cached.at < MONITOR_CACHE_MS) return cached.data;

  // A build is already running for this tenant: join it instead of starting a
  // second identical one. Without this, five open monitor tabs meant five
  // concurrent full scans of attempts + integrity_events every 5 seconds.
  const running = monitorInFlight.get(tid);
  if (running) return running;

  // Time every real build. This is the freeze early-warning: the incident was a
  // build that grew past the 5s poll interval until polls stacked. The watchdog
  // logs it and flags the payload as soon as builds cross half the interval, so
  // it is visible on the invigilator's own screen during the exam.
  const startedAt = Date.now();
  const task = buildMonitorSnapshot(tid)
    .then((data) => {
      const rows = data.live.reduce((n, ex) => n + ex.students.length, 0);
      recordMonitorBuild(Date.now() - startedAt, rows);
      monitorCache.set(tid, { at: Date.now(), data });
      return data;
    })
    .finally(() => {
      monitorInFlight.delete(tid);
    });
  monitorInFlight.set(tid, task);
  return task;
}

/**
 * Which college owns a record, for the cross-college check (lib/staff-policy.ts
 * `inCollege`). `undefined` = no such record. Several edit/delete endpoints used to
 * look a record up by id alone, so staff of one college could change another
 * college's exams, students, sections or questions just by knowing an id.
 */
export async function tenantOf(kind: "exam" | "student" | "class" | "category" | "question", id: string): Promise<string | undefined> {
  const t =
    kind === "exam" ? schema.exams
    : kind === "student" ? schema.students
    : kind === "class" ? schema.classes
    : kind === "category" ? schema.categories
    : schema.questions;
  const [row] = await db.select({ tenantId: t.tenantId }).from(t).where(eq(t.id, id)).limit(1);
  return row?.tenantId;
}
/** 404 (not 403) for another college's record, so ids cannot be probed for existence. */
export const NOT_FOUND = { message: "Not found" } as const;

export const bulkStudentPasswords = createBulkStudentPasswords({
  db,
  secret: () => process.env.BETTER_AUTH_SECRET ?? "",
  invalidate: (tenantId) => {
    directory.invalidateStudents(tenantId);
    studentLoginThrottle.clear();
  },
});

/**
 * Which database lane a request runs on (see database/lanes.ts). The exam client's
 * own calls, student login and public self-registration ride the student lane;
 * everything else is the staff console. Background work (grading, sweeps, the
 * heartbeat flusher) runs outside any request and lands on the background lane.
 */
export const STUDENT_LANE_PATH = /^\/api\/(student\/|students\/verify-login$|register\/)/;

/** Browser origins allowed to call the API (see lib/http-guard.ts). */
export const ALLOWED_ORIGINS = allowedOrigins(process.env);
