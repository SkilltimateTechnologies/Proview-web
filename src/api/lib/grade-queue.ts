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
import { and, eq, inArray, notInArray, sql as dsql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { gradeSubjective } from "./ai";
import {
  MAX_GRADE_TRIES,
  backfillGradeJobs,
  backoffMs,
  claimGradeJobs,
  closeStaleGradeJobs,
  completeGradeJob,
  completeGradeJobByAttempt,
  countGradeJobs,
  enqueueGradeJob,
  failGradeJob,
} from "./grade-jobs";
import { autoGrade, effectiveEndMs, id } from "./util";
import { maybeCheckExamAfterGrading } from "./watchdog";

// Global cap on in-flight AI grading calls. A whole class submitting at the
// deadline funnels ~20 subjective answers per student through this semaphore, so
// too low a value turns into hours of backlog: at 3 slots and ~5s per call we
// measured 38 answers/min, i.e. ~4h for a 454-student batch. Tunable per
// deployment in case the provider starts rate-limiting.
const MAX_CONCURRENT = Number(process.env.GRADE_CONCURRENCY) || 12;
let active = 0;
const waiters: Array<() => void> = [];

/** Bounded retries per attempt before we give up and flag for manual review. */
const MAX_GRADE_RETRIES = MAX_GRADE_TRIES;
/**
 * attemptId -> consecutive failed grading passes.
 *
 * FALLBACK ONLY. The durable queue (lib/grade-jobs.ts) keeps the counter in the
 * `grade_jobs` row, which is the whole point: this Map resets to zero on every
 * deploy, so before the queue existed an answer the AI could never grade was
 * retried forever and billed forever. It survives here purely for the degraded
 * path below, where at least a bounded in-process retry is better than none.
 */
const retryCounts = new Map<string, number>();

/**
 * Whether the durable `grade_jobs` queue is usable on the connected database.
 *
 * FAIL SOFT, DELIBERATELY. A missing or unreachable queue table must never stop
 * papers being graded — that would be a worse bug than the one the queue fixes.
 * The first failure flips this to false, logs once, and every path falls back to
 * the in-memory schedule that shipped before this table existed.
 */
let jobsAvailable = false;
let jobsWarned = false;

export function gradeQueueMode(): "durable" | "in-memory" {
  return jobsAvailable ? "durable" : "in-memory";
}

function markJobsUnavailable(e: unknown) {
  jobsAvailable = false;
  if (jobsWarned) return;
  jobsWarned = true;
  console.error(
    "[grade-queue] durable grade_jobs queue unavailable — falling back to the " +
      "in-memory schedule (retry state will not survive a restart):",
    e instanceof Error ? e.message : String(e),
  );
}

/**
 * Persist "this attempt needs grading". One statement, fail-soft: on the submit
 * path a queue write must never be the thing that fails a student's submit.
 */
async function recordGradeJob(attemptId: string, examId: string, delayMs = 0): Promise<boolean> {
  if (!jobsAvailable) return false;
  try {
    await enqueueGradeJob(db, { attemptId, examId, delayMs });
    return true;
  } catch (e) {
    markJobsUnavailable(e);
    return false;
  }
}

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

/**
 * Attempts being graded by THIS process right now.
 *
 * Still needed with the durable queue, for a different reason than before: the
 * submit path starts grading immediately (so a normal submit is graded in seconds,
 * not on the next worker tick) while the job row is also claimable. This set is
 * what stops the same process from grading one attempt down two paths at once —
 * cross-process exclusivity is the job table's atomic claim, not this.
 */
const inFlight = new Set<string>();

function tryEnterInFlight(attemptId: string): boolean {
  if (inFlight.has(attemptId)) return false;
  inFlight.add(attemptId);
  return true;
}

/**
 * Start grading an attempt now, off the request path. Fire-and-forget and safe to
 * call repeatedly — de-duped per attempt while in flight.
 *
 * With the durable queue available this runs ONE pass and then stops: retries,
 * backoff and the eventual give-up belong to the job row, so scheduling them here
 * too would double every retry and double the AI bill. Without the queue it falls
 * back to the original in-memory retry chain.
 */
export function queueAttemptGrading(attemptId: string, provider?: string | null) {
  if (!tryEnterInFlight(attemptId)) return;
  const pass = jobsAvailable
    ? async () => {
        const res = await gradeAttemptOnce(attemptId, provider);
        // Nothing left to grade: close the job so the worker does not redo work
        // that is already finished. Failure here is harmless — the worker would
        // claim the job, find nothing pending and complete it itself.
        if (res.done) await completeGradeJobByAttempt(db, attemptId).catch(() => {});
      }
    : () => gradeAttempt(attemptId, provider);
  pass()
    .catch((e) => console.error(`[grade-queue] attempt ${attemptId} failed:`, e))
    .finally(() => inFlight.delete(attemptId));
}

/**
 * Grade one attempt's outstanding subjective/coding answers ONCE, then reconcile
 * the attempt's status. The pure unit of work: no retry scheduling, no give-up.
 *
 * Both drivers call this — the durable worker (which owns retries through the job
 * row) and the in-memory fallback below. Keeping the scheduling out of here is
 * what makes the two paths agree on grading behaviour.
 *
 * `done: true` means the queue has nothing left to do for this attempt: either
 * every answer is graded, or the attempt was reopened / no longer exists.
 */
export async function gradeAttemptOnce(
  attemptId: string,
  providerArg?: string | null,
): Promise<{ done: boolean; ungraded: number }> {
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
  const stillUngraded = finalAnswers.filter((a) => a.score == null && hasContent(a.response)).length;
  const { scorePct, deduped } = scoreFromAnswers(finalAnswers);
  if (deduped > 0) {
    console.error(
      `[grade-queue] INVARIANT VIOLATION: attempt ${attemptId} has ${deduped} duplicate answer row(s); ` +
        `scored on the deduped set. answers_attempt_question_uq is missing or was bypassed.`,
    );
  }

  const [att] = await db.select().from(schema.attempts).where(eq(schema.attempts.id, attemptId)).limit(1);
  // Never regress a re-opened / in-progress attempt. Nothing left for the queue
  // to do about it either, so this counts as done.
  if (!att || (att.status !== "submitted" && att.status !== "graded")) return { done: true, ungraded: 0 };

  if (!stillUngraded) {
    // Fully graded — flip to graded and clear the fallback retry bookkeeping.
    retryCounts.delete(attemptId);
    await db.update(schema.attempts).set({ status: "graded", score: scorePct }).where(eq(schema.attempts.id, attemptId));
    // If that was the exam's last outstanding attempt, the exam is finished:
    // self-check its data now, while the people who ran it are still around,
    // instead of waiting for the college to report a wrong mark. Fire-and-forget
    // and never awaited into the grading result — a check must not fail grading.
    void maybeCheckExamAfterGrading(att.examId);
    return { done: true, ungraded: 0 };
  }

  // Some subjective answers are still ungraded (AI errored / rate-limited). Persist
  // the partial score so the report is not stuck at the pre-grading number while
  // retries run, and let the caller decide when to retry and when to give up.
  await db.update(schema.attempts).set({ score: scorePct }).where(eq(schema.attempts.id, attemptId));
  return { done: false, ungraded: stillUngraded };
}

/**
 * Terminal path: stop trying to grade an attempt.
 *
 * Student-visible behaviour is deliberately UNCHANGED from before the durable
 * queue: answers we could never grade are written 0 with a manual-review note and
 * the attempt flips to "graded", so clients stop polling and a student still gets
 * a result. What is new is that the `grade_jobs` row survives as `failed` with the
 * error on it, so these students are findable instead of living in a log line.
 */
export async function giveUpOnAttempt(attemptId: string, tries: number): Promise<void> {
  const finalAnswers = await db.select().from(schema.answers).where(eq(schema.answers.attemptId, attemptId));
  const [att] = await db.select().from(schema.attempts).where(eq(schema.attempts.id, attemptId)).limit(1);
  if (!att || (att.status !== "submitted" && att.status !== "graded")) return;
  const ungraded = finalAnswers.filter((a) => a.score == null && hasContent(a.response));
  for (const a of ungraded) {
    await db.update(schema.answers)
      .set({ score: 0, autoGraded: true, aiNotes: "Auto-grading failed after retries; needs manual review." })
      .where(eq(schema.answers.id, a.id));
  }
  const { scorePct } = scoreFromAnswers(
    finalAnswers.map((a) => (a.score == null && hasContent(a.response) ? { ...a, score: 0 } : a)),
  );
  console.error(`[grade-queue] attempt ${attemptId}: gave up grading ${ungraded.length} answer(s) after ${tries} tries; marking graded (manual review needed).`);
  await db.update(schema.attempts).set({ status: "graded", score: scorePct }).where(eq(schema.attempts.id, attemptId));
  void maybeCheckExamAfterGrading(att.examId);
}

/**
 * FALLBACK scheduler, used only when the durable queue is unavailable: grade,
 * and on failure retry in-process with backoff up to the cap, then give up.
 *
 * This is the pre-queue behaviour, kept verbatim on purpose. Its weakness is the
 * reason `grade_jobs` exists — `retryCounts` and the `setTimeout` both die with
 * the process, so a deploy resets the counter and the retries start over.
 */
export async function gradeAttempt(attemptId: string, providerArg?: string | null) {
  const provider = providerArg !== undefined ? providerArg : await getProvider();
  const res = await gradeAttemptOnce(attemptId, provider);
  if (res.done) {
    retryCounts.delete(attemptId);
    return;
  }
  const tries = (retryCounts.get(attemptId) ?? 0) + 1;
  if (tries < MAX_GRADE_RETRIES) {
    retryCounts.set(attemptId, tries);
    setTimeout(() => queueAttemptGrading(attemptId, provider), backoffMs(tries));
    return;
  }
  retryCounts.delete(attemptId);
  await giveUpOnAttempt(attemptId, tries);
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
  //
  // ONE statement for the whole paper, not one per question. This used to be a
  // `for (const r of rows) await db.insert(...)` loop, which is invisible on a
  // local SQLite file and brutal on Turso over HTTP: every iteration is its own
  // remote round trip, so a 15-question paper spent 15 sequential latencies
  // inside submit. Measured at a 13ms/statement simulation, submit was ~21
  // statements / 334ms p50 while autosave (already batched, below) was ~4/62ms.
  // `excluded` is the row we tried to insert, applied row by row by SQLite, so
  // each row still lands its own response/score/maxScore/aiNotes/autoGraded —
  // identical values to the loop, in a single trip.
  //
  // Deduped by questionId first: SQLite refuses to apply ON CONFLICT twice to
  // the same row within one statement. `eqs` is one row per exam question and the
  // unique index makes twins impossible, so this is defence in depth, matching
  // the autosave path. Chunked because libSQL caps bound variables per statement.
  const writeRows = [...new Map(rows.map((r) => [r.questionId, r])).values()];
  for (let i = 0; i < writeRows.length; i += 50) {
    await db.insert(schema.answers).values(writeRows.slice(i, i + 50)).onConflictDoUpdate({
      target: [schema.answers.attemptId, schema.answers.questionId],
      set: {
        response: dsql`excluded.response`,
        score: dsql`excluded.score`,
        maxScore: dsql`excluded.max_score`,
        aiNotes: dsql`excluded.ai_notes`,
        autoGraded: dsql`excluded.auto_graded`,
      },
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

  if (hasPending) {
    // Persist the work FIRST, then start grading it immediately.
    //
    // The row is the durable half: if this process dies mid-grade, or a deploy
    // lands two seconds later, another worker picks the attempt up with its retry
    // count intact instead of the schedule evaporating. Costs submit exactly one
    // extra statement (7 -> 8) and is fail-soft, so a queue problem can never turn
    // into a failed submit for a student.
    await recordGradeJob(aid, attempt.examId);
    queueAttemptGrading(aid, provider);
  }
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

/**
 * Start the recurring auto-submit sweep (runs immediately, then on an interval).
 *
 * This used to also run `sweepPendingGrading` on the same 60s tick. It no longer
 * does: that sweep is a scan of `attempts` plus one answers query per submitted
 * attempt, so during the submit burst it was firing 300+ queries a minute against
 * the exact table students were still writing to. The durable queue makes the
 * recovery sweep a reconcile rather than the scheduler, so it moved to its own,
 * much slower timer (see startGradingReconcileSweep).
 */
export function startAutoSubmitSweep(intervalMs = 60_000) {
  if (autoSubmitTimer) return;
  const tick = () => {
    void sweepAutoSubmit();
  };
  tick();
  autoSubmitTimer = setInterval(tick, intervalMs);
}

// ---------------------------------------------------------------------------
// Durable grading worker
// ---------------------------------------------------------------------------

/**
 * Identifies this process in `grade_jobs.claimed_by`. Diagnostic only — the claim
 * is made atomic by the UPDATE, not by this id.
 */
const WORKER_ID = `${process.env.RAILWAY_REPLICA_ID ?? process.env.HOSTNAME ?? "local"}:${process.pid}:${id("w")}`;

/**
 * Jobs claimed per tick. Matches MAX_CONCURRENT so a tick claims roughly what the
 * AI concurrency limiter can actually work through, instead of holding leases on
 * work it will not start for minutes.
 */
const WORKER_BATCH = Number(process.env.GRADE_WORKER_BATCH) || MAX_CONCURRENT;

let gradeWorkerTimer: ReturnType<typeof setInterval> | null = null;
let workerBusy = false;

/**
 * One pass of the durable worker: claim due jobs, grade them, record the outcome.
 *
 * Exported for the tests. Never throws — a worker that dies on an unexpected error
 * stops grading for the whole deployment.
 */
export async function gradeWorkerTick(): Promise<{ claimed: number; done: number; failed: number }> {
  const result = { claimed: 0, done: 0, failed: 0 };
  // Never let two ticks overlap: a slow AI provider would otherwise stack ticks
  // until every claim lease expires and the work is re-claimed underneath us.
  if (workerBusy || !jobsAvailable) return result;
  workerBusy = true;
  try {
    const jobs = await claimGradeJobs(db, { workerId: WORKER_ID, limit: WORKER_BATCH });
    result.claimed = jobs.length;
    if (!jobs.length) return result;
    const provider = await getProvider();
    await Promise.all(
      jobs.map(async (job) => {
        // The submit path may already be grading this attempt in this process.
        // Hand the job back (unclaimed, tries untouched) instead of grading the
        // same paper twice and paying for it twice.
        if (!tryEnterInFlight(job.attemptId)) {
          await enqueueGradeJob(db, { attemptId: job.attemptId, examId: job.examId, delayMs: 30_000 }).catch(() => {});
          return;
        }
        try {
          const res = await gradeAttemptOnce(job.attemptId, provider);
          if (res.done) {
            await completeGradeJob(db, job.id);
            result.done++;
            return;
          }
          const outcome = await failGradeJob(db, {
            jobId: job.id,
            tries: job.tries,
            error: `${res.ungraded} answer(s) still ungraded after a full pass`,
          });
          result.failed++;
          if (outcome.terminal) await giveUpOnAttempt(job.attemptId, outcome.tries);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[grade-queue] job ${job.id} (attempt ${job.attemptId}) failed:`, msg);
          try {
            const outcome = await failGradeJob(db, { jobId: job.id, tries: job.tries, error: msg });
            result.failed++;
            if (outcome.terminal) await giveUpOnAttempt(job.attemptId, outcome.tries);
          } catch (e2) {
            markJobsUnavailable(e2);
          }
        } finally {
          inFlight.delete(job.attemptId);
        }
      }),
    );
    if (result.done || result.failed) {
      console.log(`[grade-queue] worker: claimed ${result.claimed}, graded ${result.done}, retry/failed ${result.failed}`);
    }
    return result;
  } catch (e) {
    markJobsUnavailable(e);
    return result;
  } finally {
    workerBusy = false;
  }
}

/** Start the durable grading worker (runs immediately, then on an interval). */
export function startGradeWorker(intervalMs = 5_000) {
  if (gradeWorkerTimer) return;
  const tick = () => void gradeWorkerTick();
  tick();
  gradeWorkerTimer = setInterval(tick, intervalMs);
}

let reconcileTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the slow reconcile sweep. 10 minutes, not 60 seconds: with the durable
 * queue this is a safety net for work the queue never heard about (rows written
 * before the table existed, or while it was unavailable), not the scheduler.
 */
export function startGradingReconcileSweep(intervalMs = 10 * 60_000) {
  if (reconcileTimer) return;
  const tick = () => void sweepPendingGrading();
  tick();
  reconcileTimer = setInterval(tick, intervalMs);
}

/**
 * Bring the grading queue up: probe the table, adopt orphaned work, start the
 * worker and the reconcile sweep.
 *
 * The probe is the fail-soft gate. If `grade_jobs` is not there (invariants could
 * not create it, or we are pointed at an old database), `jobsAvailable` stays false
 * and every path uses the in-memory schedule that shipped before this table —
 * degraded, but grading still happens.
 */
export async function startGradeQueue(opts: { workerIntervalMs?: number; reconcileIntervalMs?: number } = {}) {
  try {
    await countGradeJobs(db);
    jobsAvailable = true;
  } catch (e) {
    markJobsUnavailable(e);
  }

  if (jobsAvailable) {
    try {
      // Attempts left `submitted` before this table existed have no job row, so
      // nothing would ever claim them. One bounded pass adopts them; the rest are
      // picked up by the reconcile sweep.
      const adopted = await backfillGradeJobs(db);
      if (adopted) console.log(`[grade-queue] adopted ${adopted} pre-existing submitted attempt(s) into the durable queue`);
    } catch (e) {
      console.error("[grade-queue] backfill failed (continuing):", e instanceof Error ? e.message : String(e));
    }
    startGradeWorker(opts.workerIntervalMs ?? 5_000);
  }

  console.log(`[grade-queue] scheduling mode: ${gradeQueueMode()}`);
  startGradingReconcileSweep(opts.reconcileIntervalMs ?? 10 * 60_000);
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
/** Attempts examined per reconcile pass. Bounded so this is fixed, cheap work. */
const RECONCILE_ATTEMPT_LIMIT = Number(process.env.GRADE_RECONCILE_LIMIT) || 200;
/** Lost-flip repairs per pass. Each one reads that attempt's answers, so cap it. */
const RECONCILE_REPAIR_LIMIT = 50;

export async function sweepPendingGrading() {
  try {
    // BOUNDED, and no longer one query per attempt.
    //
    // This used to be `select * from attempts where status = 'submitted'` — and
    // `attempts` carries no index on `status`, so that is a full table scan — plus
    // one `select * from answers where attempt_id = ?` for every row returned. At
    // 300 just-submitted attempts that was a scan and ~300 queries every 60
    // seconds, competing with students who were still submitting. Now: one capped
    // read, then ONE grouped count for the whole batch.
    const subs = await db
      .select({ id: schema.attempts.id, examId: schema.attempts.examId })
      .from(schema.attempts)
      .where(eq(schema.attempts.status, "submitted"))
      .limit(RECONCILE_ATTEMPT_LIMIT);
    if (!subs.length) {
      if (jobsAvailable) await closeStaleGradeJobs(db).catch(() => {});
      return;
    }

    const ungradedByAttempt = new Map<string, number>();
    const ids = subs.map((a) => a.id);
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      // `trim(response) NOT IN ('', 'null', '""')` is the SQL approximation of
      // hasContent(): the column is JSON text, so an empty answer is stored as one
      // of those three spellings. It only has to be a PRE-FILTER — gradeAttemptOnce
      // re-checks precisely in JS, and an attempt wrongly included here just gets
      // reconciled to "graded", which is what it needed anyway.
      const rows = await db.all<{ attempt_id: string; ungraded: number }>(
        dsql`SELECT attempt_id,
                    SUM(CASE WHEN score IS NULL AND response IS NOT NULL
                             AND trim(response) NOT IN ('', 'null', '""') THEN 1 ELSE 0 END) AS ungraded
               FROM answers
              WHERE attempt_id IN (${dsql.join(chunk.map((c) => dsql`${c}`), dsql`, `)})
              GROUP BY attempt_id`,
      );
      for (const r of rows) ungradedByAttempt.set(r.attempt_id, Number(r.ungraded ?? 0));
    }

    const provider = jobsAvailable ? null : await getProvider();
    let queued = 0;
    let reconciled = 0;
    let skipped = 0;
    for (const a of subs) {
      if ((ungradedByAttempt.get(a.id) ?? 0) > 0) {
        // Still has ungraded content. With the durable queue this is just "make
        // sure a job row exists" — the worker owns the retry schedule. Without it,
        // fall back to grading in-process as before.
        if (jobsAvailable) await recordGradeJob(a.id, a.examId);
        else queueAttemptGrading(a.id, provider);
        queued++;
        continue;
      }
      // Nothing left to grade but the attempt is still "submitted" — the final flip
      // was lost. Recompute the score and flip to "graded" directly.
      if (reconciled >= RECONCILE_REPAIR_LIMIT) {
        skipped++;
        continue;
      }
      const ans = await db.select().from(schema.answers).where(eq(schema.answers.attemptId, a.id));
      const { scorePct, deduped } = scoreFromAnswers(ans);
      if (deduped > 0) {
        console.error(
          `[grade-queue] INVARIANT VIOLATION: attempt ${a.id} has ${deduped} duplicate answer row(s) during reconcile; scored on the deduped set.`,
        );
      }
      await db.update(schema.attempts).set({ status: "graded", score: scorePct }).where(eq(schema.attempts.id, a.id));
      if (jobsAvailable) await completeGradeJobByAttempt(db, a.id).catch(() => {});
      void maybeCheckExamAfterGrading(a.examId);
      reconciled++;
    }
    if (jobsAvailable) await closeStaleGradeJobs(db).catch(() => {});
    if (queued || reconciled || skipped) {
      console.log(
        `[grade-queue] recovery sweep: queued ${queued}, reconciled-to-graded ${reconciled}` +
          (skipped ? `, deferred ${skipped} to the next pass` : ""),
      );
    }
  } catch (e) {
    console.error("[grade-queue] recovery sweep failed:", e);
  }
}
