/**
 * Self-monitoring for the exam server.
 *
 * WHY THIS EXISTS INSTEAD OF A NIGHTLY CRON
 * -----------------------------------------
 * The two incidents this guards against are both *exam-time* failures:
 *
 *   1. The Live Monitor froze because a 5s poll took longer than 5s, so polls
 *      stacked. That is only observable while an exam is running under load.
 *   2. Duplicate/corrupt rows are now blocked at write time by unique indexes,
 *      so there is nothing for a scheduled scan to discover after the fact.
 *
 * A nightly job would report a mid-exam freeze fifteen hours late, to nobody who
 * was watching. So the server checks itself at the two moments that actually
 * matter: on every monitor build (is it still fast enough?) and when an exam
 * finishes grading (did that exam produce clean data?). Both surface through
 * `/api/health` and `/api/admin/invariants`, which already exist.
 *
 * Everything here is best-effort and MUST NEVER THROW into a request path or
 * background sweep. A broken watchdog must not break an exam.
 */
import { db } from "../database";
import { sql } from "drizzle-orm";

/* -------------------------------------------------------------------------- */
/* Live Monitor latency                                                        */
/* -------------------------------------------------------------------------- */

/** Client poll interval in monitor.tsx. Keep in sync if that changes. */
export const MONITOR_POLL_MS = 5000;
/**
 * A build slower than this is a warning: at half the poll interval there is
 * still headroom, but the trend that caused the freeze has started.
 */
export const MONITOR_BUDGET_MS = MONITOR_POLL_MS / 2;
/** Consecutive over-budget builds before we call the monitor degraded. */
const DEGRADED_STREAK = 3;

export type MonitorTiming = {
  /** Duration of the last full (uncached) snapshot build, ms. */
  lastBuildMs: number | null;
  /** Slowest build seen since boot, ms. */
  worstBuildMs: number | null;
  /** Total uncached builds since boot. */
  builds: number;
  /** Builds that exceeded MONITOR_BUDGET_MS. */
  overBudget: number;
  /** Current run of consecutive over-budget builds. */
  streak: number;
  /** True once `streak` reaches DEGRADED_STREAK — the monitor is at risk. */
  degraded: boolean;
  /** ISO time of the last over-budget build, if any. */
  lastSlowAt: string | null;
  /** Rows in the last built payload — context for how heavy the build was. */
  lastRows: number | null;
};

const timing: MonitorTiming = {
  lastBuildMs: null,
  worstBuildMs: null,
  builds: 0,
  overBudget: 0,
  streak: 0,
  degraded: false,
  lastSlowAt: null,
  lastRows: null,
};

/**
 * Record one uncached monitor build. Called by getMonitorSnapshot.
 *
 * Cache hits and coalesced callers are deliberately NOT recorded — they cost
 * nothing, and counting them would dilute the average and hide a slow build.
 */
export function recordMonitorBuild(ms: number, rows: number): void {
  try {
    timing.builds += 1;
    timing.lastBuildMs = Math.round(ms);
    timing.lastRows = rows;
    if (timing.worstBuildMs === null || ms > timing.worstBuildMs) timing.worstBuildMs = Math.round(ms);

    if (ms > MONITOR_BUDGET_MS) {
      timing.overBudget += 1;
      timing.streak += 1;
      timing.lastSlowAt = new Date().toISOString();
      // Logged every time: Railway logs are the record of when it started.
      console.warn(
        `[watchdog] /api/monitor build took ${Math.round(ms)}ms ` +
          `(budget ${MONITOR_BUDGET_MS}ms, poll ${MONITOR_POLL_MS}ms, ${rows} student rows) ` +
          `— streak ${timing.streak}`,
      );
      if (timing.streak >= DEGRADED_STREAK && !timing.degraded) {
        timing.degraded = true;
        console.error(
          `[watchdog] LIVE MONITOR DEGRADED: ${DEGRADED_STREAK} consecutive builds over budget. ` +
            `Invigilator pages may start to lag. Worst ${timing.worstBuildMs}ms.`,
        );
      }
    } else {
      // One healthy build clears the streak; recovery should be immediate so a
      // single slow build during a burst does not latch the banner on forever.
      timing.streak = 0;
      timing.degraded = false;
    }
  } catch {
    // A watchdog must never break the thing it watches.
  }
}

export function monitorTiming(): MonitorTiming {
  return { ...timing };
}

/* -------------------------------------------------------------------------- */
/* Per-exam data self-check, run when an exam finishes grading                  */
/* -------------------------------------------------------------------------- */

export type ExamCheck = {
  examId: string;
  checkedAt: string;
  ok: boolean;
  attempts: number;
  /** Same (attempt, question) stored twice — the 103/100 bug. */
  duplicateAnswerGroups: number;
  /** score outside 0..100. */
  impossibleScores: number;
  /** Attempt total that disagrees with the paper's max marks. */
  denominatorMismatches: number;
  /** Graded attempts with no stored answers at all (start-retry loop). */
  attemptsWithNoAnswers: number;
  problems: string[];
};

/** Last check per exam, newest first. Bounded so it cannot grow forever. */
const examChecks: ExamCheck[] = [];
const EXAM_CHECK_HISTORY = 20;

/**
 * Verify one exam's data right after its last attempt is graded.
 *
 * Scoped to a single exam so it is cheap enough to run inline (a handful of
 * indexed aggregates), unlike a full-table audit. This is the check that would
 * have caught 23K91A04H1's 103/100 within seconds of that exam finishing,
 * instead of after the college reported it.
 */
export async function checkExamData(examId: string): Promise<ExamCheck | null> {
  try {
    const one = async (q: ReturnType<typeof sql>) => Number((await db.all<{ n: number }>(q))[0]?.n ?? 0);

    const attempts = await one(sql`SELECT COUNT(*) AS n FROM attempts WHERE exam_id = ${examId}`);
    const duplicateAnswerGroups = await one(sql`
      SELECT COUNT(*) AS n FROM (
        SELECT 1 FROM answers ans
        JOIN attempts a ON a.id = ans.attempt_id
        WHERE a.exam_id = ${examId}
        GROUP BY ans.attempt_id, ans.question_id
        HAVING COUNT(*) > 1
      )
    `);
    const impossibleScores = await one(sql`
      SELECT COUNT(*) AS n FROM attempts
      WHERE exam_id = ${examId} AND score IS NOT NULL AND (score < 0 OR score > 100)
    `);
    // The paper's max marks, from exam_questions (falling back to the question's
    // own points), vs what each graded attempt's answer rows add up to.
    const denominatorMismatches = await one(sql`
      SELECT COUNT(*) AS n FROM (
        SELECT ans.attempt_id
        FROM answers ans
        JOIN attempts a ON a.id = ans.attempt_id
        WHERE a.exam_id = ${examId} AND a.status = 'graded'
        GROUP BY ans.attempt_id
        HAVING COALESCE(SUM(ans.max_score), 0) <> (
          SELECT COALESCE(SUM(COALESCE(eq.points, q.points, 1)), 0)
          FROM exam_questions eq
          LEFT JOIN questions q ON q.id = eq.question_id
          WHERE eq.exam_id = ${examId}
        )
      )
    `);
    const attemptsWithNoAnswers = await one(sql`
      SELECT COUNT(*) AS n FROM attempts a
      WHERE a.exam_id = ${examId} AND a.status = 'graded'
        AND NOT EXISTS (SELECT 1 FROM answers ans WHERE ans.attempt_id = a.id)
    `);

    const problems: string[] = [];
    if (duplicateAnswerGroups > 0)
      problems.push(`${duplicateAnswerGroups} duplicate (attempt, question) answer group(s) — scores may be inflated`);
    if (impossibleScores > 0) problems.push(`${impossibleScores} attempt(s) scored outside 0..100`);
    if (denominatorMismatches > 0)
      problems.push(`${denominatorMismatches} attempt(s) whose marks total disagrees with the paper`);
    if (attemptsWithNoAnswers > 0)
      problems.push(`${attemptsWithNoAnswers} graded attempt(s) with no stored answers (possible start-retry loop)`);

    const result: ExamCheck = {
      examId,
      checkedAt: new Date().toISOString(),
      ok: problems.length === 0,
      attempts,
      duplicateAnswerGroups,
      impossibleScores,
      denominatorMismatches,
      attemptsWithNoAnswers,
      problems,
    };

    examChecks.unshift(result);
    if (examChecks.length > EXAM_CHECK_HISTORY) examChecks.length = EXAM_CHECK_HISTORY;

    if (result.ok) {
      console.log(`[watchdog] exam ${examId} finished: ${attempts} attempt(s), data clean.`);
    } else {
      console.error(`[watchdog] EXAM ${examId} FINISHED WITH PROBLEMS: ${problems.join("; ")}`);
    }
    return result;
  } catch (err) {
    console.error(`[watchdog] exam data check failed for ${examId}:`, err);
    return null;
  }
}

export function recentExamChecks(): ExamCheck[] {
  return examChecks.map((c) => ({ ...c }));
}

/** Exams whose most recent check found a problem — surfaced to admins. */
export function failingExamChecks(): ExamCheck[] {
  const seen = new Set<string>();
  const out: ExamCheck[] = [];
  for (const c of examChecks) {
    if (seen.has(c.examId)) continue; // only the newest check per exam counts
    seen.add(c.examId);
    if (!c.ok) out.push({ ...c });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Trigger: has this exam just finished grading?                               */
/* -------------------------------------------------------------------------- */

/** Exams already checked this process, so we check once per exam, not per attempt. */
const checkedExams = new Set<string>();

/**
 * Called after an attempt reaches a terminal state. When that attempt was the
 * last one outstanding for its exam, the exam is done — run the scoped check.
 *
 * Deliberately fire-and-forget and swallowing everything: grading must not fail
 * because a check failed.
 */
export async function maybeCheckExamAfterGrading(examId: string): Promise<void> {
  try {
    if (checkedExams.has(examId)) return;
    // An exam with no attempts at all cannot have "just finished" — and a bogus
    // id would otherwise sail through the pending-count check below (0 pending)
    // and record a meaningless "clean" result. Require something to check.
    const total = Number(
      (await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM attempts WHERE exam_id = ${examId}`))[0]?.n ?? 0,
    );
    if (total === 0) return;
    const pending = Number(
      (
        await db.all<{ n: number }>(sql`
          SELECT COUNT(*) AS n FROM attempts
          WHERE exam_id = ${examId} AND status NOT IN ('graded', 'not_started')
        `)
      )[0]?.n ?? 0,
    );
    if (pending > 0) return; // still grading — not finished yet
    checkedExams.add(examId);
    await checkExamData(examId);
  } catch (err) {
    console.error(`[watchdog] post-grading check failed for exam ${examId}:`, err);
  }
}
