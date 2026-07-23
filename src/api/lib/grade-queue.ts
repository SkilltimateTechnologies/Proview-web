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

export function hasContent(response: unknown): boolean {
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
  if (!att || (att.status !== "submitted" && att.status !== "graded")) return;

  if (!stillUngraded) {
    // Fully graded — flip to graded and clear retry bookkeeping.
    retryCounts.delete(attemptId);
    await db.update(schema.attempts).set({ status: "graded", score: scorePct }).where(eq(schema.attempts.id, attemptId));
    return;
  }

  // Some subjective answers are still ungraded (AI errored / rate-limited).
  // Retry a bounded number of times with backoff instead of leaving the attempt
  // stuck "submitted" forever — which makes every client poll /status
  // indefinitely and the boot sweep re-queue it on every restart.
  const tries = (retryCounts.get(attemptId) ?? 0) + 1;
  if (tries < MAX_GRADE_RETRIES) {
    retryCounts.set(attemptId, tries);
    await db.update(schema.attempts).set({ score: scorePct }).where(eq(schema.attempts.id, attemptId));
    const delay = Math.min(120_000, 20_000 * tries);
    setTimeout(() => queueAttemptGrading(attemptId, provider), delay);
    return;
  }

  // Give up: mark the answers we could never grade as 0 (best-effort) with a
  // note for manual review, then flip the attempt to a terminal "graded" state
  // so clients stop polling and the boot sweep stops re-queueing it.
  retryCounts.delete(attemptId);
  const ungraded = finalAnswers.filter((a) => a.score == null && hasContent(a.response));
  for (const a of ungraded) {
    await db.update(schema.answers)
      .set({ score: 0, autoGraded: true, aiNotes: "Auto-grading failed after retries; needs manual review." })
      .where(eq(schema.answers.id, a.id));
  }
  console.error(`[grade-queue] attempt ${attemptId}: gave up grading ${ungraded.length} answer(s) after ${tries} tries; marking graded (manual review needed).`);
  await db.update(schema.attempts).set({ status: "graded", score: scorePct }).where(eq(schema.attempts.id, attemptId));
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
  const answeredCount = rows.filter((r) => hasContent(r.response)).length;
  await db.update(schema.attempts).set({
    status,
    score: scorePct,
    answeredCount,
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
        // A student who started but never submitted by the deadline lost the
        // connection through the cutoff. We DO NOT delete the attempt anymore —
        // that erased who actually participated. Instead we grade whatever they
        // synced (per-answer autosave keeps the server copy current) and flag the
        // attempt `disconnected` so the report shows a distinct "Disconnected ·
        // answered N/total" instead of a misleading blank "Absent".
        const ans = await db.select().from(schema.answers).where(eq(schema.answers.attemptId, a.id));
        const synced = ans
          .filter((x) => hasContent(x.response))
          .map((x) => ({ questionId: x.questionId, response: x.response }));
        await finalizeAttempt(a, synced, provider);
        await db.update(schema.attempts).set({ disconnected: true }).where(eq(schema.attempts.id, a.id));
        done++;
      } catch (e) {
        console.error(`[auto-submit] attempt ${a.id} failed:`, e);
      }
    }
    if (done) console.log(`[auto-submit] force-submitted ${done} disconnected attempt(s) on synced answers`);
  } catch (e) {
    console.error("[auto-submit] sweep failed:", e);
  }
}

/** Start the recurring auto-submit sweep (runs immediately, then on an interval). */
export function startAutoSubmitSweep(intervalMs = 60_000) {
  if (autoSubmitTimer) return;
  const tick = () => {
    void sweepAutoSubmit();
    // Also reconcile any attempts stuck at "submitted" (lost final flip, or
    // still-ungraded answers) on the same cadence — not just at boot — so live
    // batches self-heal as they finish instead of lingering until a restart.
    void sweepPendingGrading();
  };
  tick();
  autoSubmitTimer = setInterval(tick, intervalMs);
}

/**
 * Recovery sweep for "submitted" attempts that never reached "graded".
 * Two failure modes are handled:
 *  1. Still-ungraded subjective answers (restart mid-grading / provider
 *     rate-limited during a burst) → re-enqueue for grading.
 *  2. All answers ARE graded but the attempt's final status-flip write was lost
 *     (e.g. a transient Turso hiccup during the submit burst hit the flip but
 *     not the answer writes). The grading sweep would skip these forever since
 *     they have no ungraded answers — so reconcile them straight to "graded"
 *     here, recomputing the score from the answer rows. Idempotent.
 */
export async function sweepPendingGrading() {
  try {
    const subs = await db.select().from(schema.attempts).where(eq(schema.attempts.status, "submitted"));
    if (!subs.length) return;
    const provider = await getProvider();
    let queued = 0;
    let reconciled = 0;
    for (const a of subs) {
      const ans = await db.select().from(schema.answers).where(eq(schema.answers.attemptId, a.id));
      if (ans.some((x) => x.score == null && hasContent(x.response))) {
        // Still has ungraded content → (re)grade it.
        queueAttemptGrading(a.id, provider);
        queued++;
      } else {
        // Nothing left to grade but the attempt is still "submitted" — the final
        // flip was lost. Recompute the score and flip to "graded" directly.
        const earned = ans.reduce((s, x) => s + (x.score ?? 0), 0);
        const max = ans.reduce((s, x) => s + (x.maxScore ?? 0), 0);
        const scorePct = max > 0 ? Math.round((earned / max) * 1000) / 10 : 0;
        await db.update(schema.attempts).set({ status: "graded", score: scorePct }).where(eq(schema.attempts.id, a.id));
        reconciled++;
      }
    }
    if (queued || reconciled) console.log(`[grade-queue] recovery sweep: re-queued ${queued}, reconciled-to-graded ${reconciled}`);
  } catch (e) {
    console.error("[grade-queue] recovery sweep failed:", e);
  }
}
