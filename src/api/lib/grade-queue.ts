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

async function gradeAttempt(attemptId: string, providerArg?: string | null) {
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
