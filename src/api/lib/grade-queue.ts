/**
 * Background AI grading queue.
 *
 * On submit we persist answers and grade the objective questions (mcq / multi /
 * truefalse / fillblank) instantly, mark the attempt "submitted" and return fast.
 * Subjective + coding answers are graded here, off the request path, through a
 * globally bounded concurrency limiter so a whole class auto-submitting at the
 * deadline can never stall a student's submit or hammer the AI provider into
 * rate limits. When every subjective answer of an attempt is graded, the score
 * is recomputed and the attempt flips to "graded".
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { gradeSubjective } from "./ai";
import { autoGrade, effectiveEndMs, id } from "./util";

const MAX_CONCURRENT = 3;
let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  return new Promise((resolve) => {
    const tryRun = () => {
      if (active < MAX_CONCURRENT) {
        active++;
        resolve();
      } else {
        waiters.push(tryRun);
      }
    };
    tryRun();
  });
}

function release() {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next();
}

async function throttle<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

async function getProvider(): Promise<string | null> {
  try {
    const [s] = await db.select().from(schema.settings).where(eq(schema.settings.id, "global")).limit(1);
    return s?.aiProvider ?? null;
  } catch {
    return null;
  }
}

function hasContent(response: unknown): boolean {
  return response != null && String(typeof response === "string" ? response : JSON.stringify(response)).trim() !== "";
}

const inFlight = new Set<string>();

/**
 * Queue an attempt for background subjective grading. Fire-and-forget: safe to
 * call multiple times, de-duped per attempt while in flight.
 */
export function queueAttemptGrading(attemptId: string, provider?: string | null) {
  if (inFlight.has(attemptId)) return;
  inFlight.add(attemptId);
  gradeAttempt(attemptId, provider)
    .catch((e) => console.error(`[grade-queue] attempt ${attemptId} failed:`, e))
    .finally(() => inFlight.delete(attemptId));
}

export async function gradeAttempt(attemptId: string, providerArg?: string | null) {
  const provider = providerArg !== undefined ? providerArg : await getProvider();
  const answers = await db.select().from(schema.answers).where(eq(schema.answers.attemptId, attemptId));
  const pending = answers.filter((a) => !a.autoGraded && a.score == null && hasContent(a.response));

  if (pending.length) {
    const qids = [...new Set(pending.map((a) => a.questionId))];
    const qs = qids.length ? await db.select().from(schema.questions).where(inArray(schema.questions.id, qids)) : [];
    const qById = new Map(qs.map((q) => [q.id, q]));

    await Promise.all(
      pending.map((a) =>
        throttle(async () => {
          const q = qById.get(a.questionId);
          if (!q) return;
          const maxScore = a.maxScore ?? q.points ?? 1;
          try {
            const meta = (q.meta ?? {}) as Record<string, unknown>;
            const res = await gradeSubjective({
              question: q.prompt,
              rubric: (meta.rubric as string) || (meta.solution as string) || undefined,
              studentAnswer: String(typeof a.response === "string" ? a.response : JSON.stringify(a.response)),
              maxPoints: maxScore,
              isCode: q.type === "coding",
              language: meta.language as string | undefined,
              provider,
            });
            await db.update(schema.answers).set({ score: res.score, aiNotes: res.notes, autoGraded: true }).where(eq(schema.answers.id, a.id));
          } catch (e) {
            console.error(`[grade-queue] grade answer ${a.id} failed:`, e);
            // leave ungraded; a later sweep can retry.
          }
        }),
      ),
    );
  }

  // Recompute the total from the latest answer rows and flip to "graded" only
  // when nothing subjective is left ungraded.
  const finalAnswers = await db.select().from(schema.answers).where(eq(schema.answers.attemptId, attemptId));
  const stillUngraded = finalAnswers.some((a) => a.score == null && hasContent(a.response));
  const earned = finalAnswers.reduce((s, a) => s + (a.score ?? 0), 0);
  const max = finalAnswers.reduce((s, a) => s + (a.maxScore ?? 0), 0);
  const scorePct = max > 0 ? Math.round((earned / max) * 1000) / 10 : 0;

  const [att] = await db.select().from(schema.attempts).where(eq(schema.attempts.id, attemptId)).limit(1);
  // Never regress a re-opened / in-progress attempt.
  if (att && (att.status === "submitted" || att.status === "graded")) {
    await db.update(schema.attempts).set({ status: stillUngraded ? "submitted" : "graded", score: scorePct }).where(eq(schema.attempts.id, attemptId));
  }
}

/**
 * Persist answers for an attempt and grade it. Objective questions
 * (mcq / multi / truefalse / fillblank) are graded inline; subjective + coding
 * answers with content are deferred to the background queue. This is the single
 * shared grading path used by BOTH the student submit endpoint and the
 * server-side auto-submit sweep, so a force-submit grades identically to a
 * normal submit. Idempotent: wipes prior answers before reinserting.
 *
 * `respArr` is the client-supplied answers. For the auto-submit sweep it is `[]`
 * (a disconnected student never synced answers to the server, so unanswered
 * questions score 0) — the point is to move an abandoned attempt out of
 * `in_progress` and into grading, not to fabricate answers.
 */
export async function finalizeAttempt(
  attempt: typeof schema.attempts.$inferSelect,
  respArr: { questionId: string; response: unknown }[],
  provider: string | null,
): Promise<{ score: number; status: "submitted" | "graded" }> {
  const aid = attempt.id;
  const eqs = await db.select().from(schema.examQuestions).where(eq(schema.examQuestions.examId, attempt.examId)).orderBy(schema.examQuestions.order);
  const qids = eqs.map((q) => q.questionId);
  const qs = qids.length ? await db.select().from(schema.questions).where(inArray(schema.questions.id, qids)) : [];
  const qById = new Map(qs.map((q) => [q.id, q]));
  const pointsById = new Map(eqs.map((e) => [e.questionId, e.points]));

  // Wipe any prior answers for idempotency, then insert fresh.
  await db.delete(schema.answers).where(eq(schema.answers.attemptId, aid));

  let earned = 0;
  let max = 0;
  let hasPending = false;
  const rows: (typeof schema.answers.$inferInsert)[] = [];
  for (const eq2 of eqs) {
    const q = qById.get(eq2.questionId);
    if (!q) continue;
    const maxScore = pointsById.get(eq2.questionId) ?? q.points ?? 1;
    max += maxScore;
    const given = respArr.find((r) => r.questionId === eq2.questionId);
    const response = given?.response ?? null;
    let score: number | null = null;
    let autoGraded = false;

    const auto = autoGrade(q.type, q.correct, response, maxScore);
    if (auto !== null) {
      score = auto;
      autoGraded = true;
    } else if (response != null && String(response).trim() !== "") {
      // Subjective / coding with content: defer to background grading.
      score = null;
      autoGraded = false;
      hasPending = true;
    } else {
      score = 0; // blank answer
      autoGraded = true;
    }
    if (score != null) earned += score;
    rows.push({
      id: id("ans"),
      attemptId: aid,
      questionId: eq2.questionId,
      response,
      score,
      maxScore,
      aiNotes: null,
      autoGraded,
    });
  }
  if (rows.length) await db.insert(schema.answers).values(rows);

  const scorePct = max > 0 ? Math.round((earned / max) * 1000) / 10 : 0;
  const status: "submitted" | "graded" = hasPending ? "submitted" : "graded";
  await db.update(schema.attempts).set({
    status,
    score: scorePct,
    submittedAt: new Date(),
  }).where(eq(schema.attempts.id, aid));

  if (hasPending) queueAttemptGrading(aid, provider);
  return { score: scorePct, status };
}

// Grace window after an attempt's effective deadline before the server
// force-submits it. Gives an online client's own auto-submit, and an offline
// client reconnecting to sync buffered answers, time to land first — so we only
// force-submit attempts that are genuinely abandoned (browser closed / lost
// connection through the cutoff and never returned).
const AUTOSUBMIT_GRACE_MS = 3 * 60_000;
let autoSubmitTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Find `in_progress` attempts whose effective deadline (+ grace) has passed and
 * force-submit them server-side through the shared grading path, so a student
 * who closed their browser or lost connection at the cutoff still gets submitted
 * and graded instead of staying stuck `in_progress` forever.
 */
export async function sweepAutoSubmit() {
  try {
    const now = Date.now();
    const inProg = await db.select().from(schema.attempts).where(eq(schema.attempts.status, "in_progress"));
    if (!inProg.length) return;
    const examIds = [...new Set(inProg.map((a) => a.examId))];
    const exams = examIds.length ? await db.select().from(schema.exams).where(inArray(schema.exams.id, examIds)) : [];
    const examById = new Map(exams.map((e) => [e.id, e]));
    const provider = await getProvider();
    let done = 0;
    for (const a of inProg) {
      const exam = examById.get(a.examId);
      if (!exam) continue;
      if (exam.status === "draft") continue;   // never touch unpublished exams
      if (exam.heldAt) continue;               // exam paused/held for everyone — don't force-submit
      const endMs = effectiveEndMs(exam, a, now);
      if (endMs + AUTOSUBMIT_GRACE_MS >= now) continue; // still within window + grace
      try {
        await finalizeAttempt(a, [], provider);
        done++;
      } catch (e) {
        console.error(`[auto-submit] attempt ${a.id} failed:`, e);
      }
    }
    if (done) console.log(`[auto-submit] force-submitted ${done} expired in-progress attempt(s)`);
  } catch (e) {
    console.error("[auto-submit] sweep failed:", e);
  }
}

/** Start the recurring auto-submit sweep (runs immediately, then on an interval). */
export function startAutoSubmitSweep(intervalMs = 60_000) {
  if (autoSubmitTimer) return;
  void sweepAutoSubmit();
  autoSubmitTimer = setInterval(() => void sweepAutoSubmit(), intervalMs);
}

/**
 * Startup recovery: re-enqueue any "submitted" attempts that still have
 * ungraded subjective answers (e.g. server restarted mid-grading, or the AI
 * provider was rate-limited during a burst). Idempotent.
 */
export async function sweepPendingGrading() {
  try {
    const subs = await db.select().from(schema.attempts).where(eq(schema.attempts.status, "submitted"));
    if (!subs.length) return;
    const provider = await getProvider();
    let queued = 0;
    for (const a of subs) {
      const ans = await db.select().from(schema.answers).where(eq(schema.answers.attemptId, a.id));
      if (ans.some((x) => x.score == null && hasContent(x.response))) {
        queueAttemptGrading(a.id, provider);
        queued++;
      }
    }
    if (queued) console.log(`[grade-queue] startup sweep re-queued ${queued} attempt(s) for grading`);
  } catch (e) {
    console.error("[grade-queue] startup sweep failed:", e);
  }
}
