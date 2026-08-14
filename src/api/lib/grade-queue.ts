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
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { gradeSubjective } from "./ai";
import { autoGrade, effectiveEndMs, id } from "./util";

// Global cap on in-flight AI grading calls. A whole class submitting at the
// deadline funnels ~20 subjective answers per student through this semaphore, so
// too low a value turns into hours of backlog: at 3 slots and ~5s per call we
// measured 38 answers/min, i.e. ~4h for a 454-student batch. Tunable per
// deployment in case the provider starts rate-limiting.
const MAX_CONCURRENT = Number(process.env.GRADE_CONCURRENCY) || 12;
let active = 0;
const waiters: Array<() => void> = [];

/** Bounded retries per attempt before we give up and flag for manual review. */
const MAX_GRADE_RETRIES = 3;
/** attemptId -> consecutive failed grading passes. In-memory: resets on deploy. */
const retryCounts = new Map<string, number>();

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

type AnswerRow = typeof schema.answers.$inferSelect;

/**
 * Collapse answer rows to at most ONE row per question.
 *
 * `answers_attempt_question_uq` makes duplicates impossible at the database
 * level, and that index is asserted on every boot (see database/invariants.ts).
 * This is the second line of defence: scoring must not be able to produce an
 * impossible number even if a duplicate somehow exists — an index dropped by
 * hand, a restored pre-fix backup, a future writer that bypasses the upsert.
 *
 * A student seeing 103/100 is the failure everyone notices, so the arithmetic
 * itself is made incapable of it. Keeper rule matches the one used for the
 * production dedupe: real content > has a score > has a max_score > higher
 * score > lowest id. `max_score` matters because duplicate twins were
 * asymmetric — one row carried the points, the twin was null — and ignoring it
 * shrinks the denominator instead of restoring it.
 */
export function dedupeAnswerRows<T extends Pick<AnswerRow, "id" | "questionId" | "response" | "score" | "maxScore">>(
  rows: T[],
): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const cur = best.get(r.questionId);
    if (!cur) {
      best.set(r.questionId, r);
      continue;
    }
    if (rank(r) > rank(cur)) best.set(r.questionId, r);
  }
  return [...best.values()];

  function rank(r: T): number {
    // Ordered lexicographically by weight, highest wins. Negated id keeps the
    // lowest id as the final tiebreak (ids are unique so this never ties).
    return (
      (hasContent(r.response) ? 1e12 : 0) +
      (r.score != null ? 1e9 : 0) +
      (r.maxScore != null ? 1e6 : 0) +
      (r.score ?? 0) * 1e3 +
      -hashId(r.id)
    );
  }
  function hashId(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000;
    return h / 1000;
  }
}

/**
 * The single place an attempt's percentage score is derived from answer rows.
 * Deduped (see above) and clamped to 0..100 so no arithmetic path can emit an
 * out-of-range score. `expectedMax` (the paper's total_points) is preferred as
 * the denominator when supplied, since it cannot be distorted by row-level data
 * at all.
 */
export function scoreFromAnswers(
  rows: Pick<AnswerRow, "id" | "questionId" | "response" | "score" | "maxScore">[],
  expectedMax?: number | null,
): { scorePct: number; earned: number; max: number; deduped: number } {
  const unique = dedupeAnswerRows(rows);
  const earned = unique.reduce((s, a) => s + (a.score ?? 0), 0);
  const rowMax = unique.reduce((s, a) => s + (a.maxScore ?? 0), 0);
  const max = expectedMax && expectedMax > 0 ? expectedMax : rowMax;
  const raw = max > 0 ? (earned / max) * 100 : 0;
  const scorePct = Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
  return { scorePct, earned, max, deduped: rows.length - unique.length };
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
  const { scorePct, deduped } = scoreFromAnswers(finalAnswers);
  if (deduped > 0) {
    console.error(
      `[grade-queue] INVARIANT VIOLATION: attempt ${attemptId} has ${deduped} duplicate answer row(s); ` +
        `scored on the deduped set. answers_attempt_question_uq is missing or was bypassed.`,
    );
  }

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

  // Read any previously-saved answers BEFORE wiping. Per-answer autosave writes
  // the student's work to this table as they go, so the server copy is the
  // source of truth. A reopen/resume can trigger a re-submit whose client
  // payload is empty or partial (local answers weren't reloaded) — blindly
  // replacing would ERASE real work. We merge instead: the client response wins
  // only when it has content, otherwise we fall back to what was already saved.
  const prior = await db.select().from(schema.answers).where(eq(schema.answers.attemptId, aid));
  const priorRespByQ = new Map(prior.map((p) => [p.questionId, p.response]));

  // NOTE: this used to DELETE every answer row here and re-insert the merged set.
  // That was a data-loss window, not just an idempotency trick: if two finalize
  // calls overlapped (student submit racing the auto-submit sweep, or a double
  // submit), the second one read `prior` AFTER the first had deleted it, saw an
  // empty map, and wrote blank rows over real work. One student ended up with 23
  // real answers sitting beside blank twins and scored 0. We now upsert every row
  // instead, so the student's work is never unreachable for even an instant.

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
    const clientResp = given?.response ?? null;
    const priorResp = priorRespByQ.get(eq2.questionId) ?? null;
    // Merge: keep the client's answer when it actually has content, else
    // preserve the previously-saved answer so a blank/partial re-submit after a
    // reopen never destroys autosaved work.
    const response = hasContent(clientResp) ? clientResp : priorResp;
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
  // Upsert on (attempt_id, question_id) so a concurrent finalize converges on the
  // same row instead of creating a second one. autoGrade is deterministic and the
  // merged `response` prefers content, so whichever call lands last writes the
  // same values.
  for (const r of rows) {
    await db.insert(schema.answers).values(r).onConflictDoUpdate({
      target: [schema.answers.attemptId, schema.answers.questionId],
      set: { response: r.response, score: r.score, maxScore: r.maxScore, aiNotes: r.aiNotes, autoGraded: r.autoGraded },
    });
  }
  // Drop stray rows for questions that are no longer part of the paper (the old
  // blanket delete used to cover this). Targeted, so live answers are untouched.
  if (qids.length) {
    await db.delete(schema.answers).where(and(eq(schema.answers.attemptId, aid), notInArray(schema.answers.questionId, qids)));
  }

  // `earned`/`max` are accumulated over the PAPER (eqs), not over answer rows, so
  // a duplicate row cannot distort them. Clamped anyway — no code path should be
  // able to emit a score outside 0..100.
  const scorePct = max > 0 ? Math.max(0, Math.min(100, Math.round((earned / max) * 1000) / 10)) : 0;
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
        const { scorePct, deduped } = scoreFromAnswers(ans);
        if (deduped > 0) {
          console.error(
            `[grade-queue] INVARIANT VIOLATION: attempt ${a.id} has ${deduped} duplicate answer row(s) during reconcile; scored on the deduped set.`,
          );
        }
        await db.update(schema.attempts).set({ status: "graded", score: scorePct }).where(eq(schema.attempts.id, a.id));
        reconciled++;
      }
    }
    if (queued || reconciled) console.log(`[grade-queue] recovery sweep: re-queued ${queued}, reconciled-to-graded ${reconciled}`);
  } catch (e) {
    console.error("[grade-queue] recovery sweep failed:", e);
  }
}
