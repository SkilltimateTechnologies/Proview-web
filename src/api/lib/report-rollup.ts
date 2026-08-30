/**
 * Per-exam attempt statistics for the reports list, in ONE query instead of one
 * per exam.
 *
 * WHY
 * ---
 * `GET /reports` renders a card per conducted exam: attempts, finished, in
 * progress, absent, passed, failed, average. It computed those by pulling **every
 * attempt row of every exam** and counting in JavaScript:
 *
 *     rows.map(async (e) => db.select().from(attempts).where(eq(examId, e.id)))
 *
 * That is a textbook N+1 — one remote round trip per exam — and each trip shipped
 * whole rows. At 11 exams and 2,520 stored attempts, opening the reports page
 * transferred every attempt ever taken, with all 18 columns, to produce 7 integers
 * per exam. The cost grows with **exam history**, so it gets worse every week
 * forever, and it is paid by an admin page that several people refresh.
 *
 * SQLite counts far better than we do. This module issues one grouped aggregate
 * over `attempts` for all exam ids at once — conditional `SUM(CASE …)` columns,
 * riding `attempts_exam_idx` — and returns 7 numbers per exam. Bytes on the wire
 * drop from "every attempt row" to one small row per exam, and the round trips
 * drop from N to 1.
 *
 * WHAT MUST NOT DRIFT
 * -------------------
 * The definitions are subtle and were derived from the old JS, not invented here:
 *
 *  - `finished` counts `submitted` OR `graded` — an attempt is finished when the
 *    student is done, whether or not the grader has been.
 *  - `graded`/`passed`/`failed` key off **`score IS NOT NULL`, not `status`**. A
 *    terminally-failed grading run flips status to `graded` while leaving the score
 *    null (see grade-queue.ts), and those attempts must not count as passed or
 *    failed, or the pass rate silently shifts.
 *  - `passed` is `score >= 40`, `failed` is `score < 40`, so `passed + failed ==
 *    graded` exactly. In SQL, `NULL >= 40` is NULL and falls to the ELSE branch,
 *    which is what keeps the ungraded out of both.
 *  - `avg` is the mean over **graded** attempts only, and 0 when there are none —
 *    never a division by zero and never diluted by ungraded rows.
 *
 * `absent` is deliberately NOT here: it needs the exam's roster and deadline, not
 * the attempt table.
 *
 * `rollupFromAttempts` is the old JavaScript computation, kept as a pure function
 * so the tests can assert the SQL agrees with it row for row. It is the oracle,
 * not a fallback.
 *
 * Takes the database as a parameter (never the app's `db` singleton) so tests run
 * the real SQL against in-memory libSQL.
 */
import { inArray, sql as dsql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/libsql";
import * as schema from "../database/schema";

/** Any Drizzle libSQL handle over our schema — the app singleton or a test one. */
export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Pass threshold, as a percentage. Mirrors the client's PASS_MARK. */
export const PASS_MARK = 40;

/** Exam ids per statement, to stay under SQLite's bound-variable cap. */
export const ROLLUP_CHUNK = 200;

export type AttemptRollup = {
	/** Every attempt row for the exam, whatever its status. */
	attempts: number;
	/** status = submitted | graded. */
	finished: number;
	/** status = in_progress. */
	inProgress: number;
	/** score IS NOT NULL — see WHAT MUST NOT DRIFT. */
	graded: number;
	/** score >= PASS_MARK. */
	passed: number;
	/** score IS NOT NULL AND score < PASS_MARK. */
	failed: number;
	/** Sum of non-null scores, for the average. */
	scoreSum: number;
};

/** An exam nobody has attempted. Every field zero, so the card renders empty. */
export const EMPTY_ROLLUP: AttemptRollup = Object.freeze({
	attempts: 0,
	finished: 0,
	inProgress: 0,
	graded: 0,
	passed: 0,
	failed: 0,
	scoreSum: 0,
});

/** Mean score over graded attempts, one decimal place. 0 when nothing is graded. */
export function rollupAvg(r: AttemptRollup): number {
	if (!r.graded) return 0;
	return Math.round((r.scoreSum / r.graded) * 10) / 10;
}

/**
 * The pre-SQL computation, preserved exactly. Used by the tests as the oracle the
 * aggregate must match; not on the request path.
 */
export function rollupFromAttempts(
	rows: { status: string; score: number | null }[],
): AttemptRollup {
	const graded = rows.filter((a) => a.score != null);
	return {
		attempts: rows.length,
		finished: rows.filter((a) => a.status === "submitted" || a.status === "graded").length,
		inProgress: rows.filter((a) => a.status === "in_progress").length,
		graded: graded.length,
		passed: graded.filter((a) => (a.score ?? 0) >= PASS_MARK).length,
		failed: graded.filter((a) => (a.score ?? 0) < PASS_MARK).length,
		scoreSum: graded.reduce((s, a) => s + (a.score ?? 0), 0),
	};
}

/**
 * One grouped aggregate for every exam id given. Exams with no attempts are simply
 * absent from the map — callers fall back to `EMPTY_ROLLUP` rather than this
 * inventing rows for them.
 */
export async function loadAttemptRollups(
	db: Db,
	examIds: string[],
): Promise<Map<string, AttemptRollup>> {
	const out = new Map<string, AttemptRollup>();
	if (!examIds.length) return out;
	// De-duplicated: a repeated id would double every count for that exam.
	const ids = [...new Set(examIds)];
	const score = schema.attempts.score;
	const status = schema.attempts.status;
	for (let i = 0; i < ids.length; i += ROLLUP_CHUNK) {
		const rows = await db
			.select({
				examId: schema.attempts.examId,
				attempts: dsql<number>`count(*)`,
				finished: dsql<number>`sum(case when ${status} in ('submitted', 'graded') then 1 else 0 end)`,
				inProgress: dsql<number>`sum(case when ${status} = 'in_progress' then 1 else 0 end)`,
				graded: dsql<number>`sum(case when ${score} is not null then 1 else 0 end)`,
				// NULL >= 40 is NULL in SQL, so ungraded attempts fall to ELSE and are
				// counted as neither passed nor failed. That is the intended behaviour.
				passed: dsql<number>`sum(case when ${score} >= ${PASS_MARK} then 1 else 0 end)`,
				failed: dsql<number>`sum(case when ${score} is not null and ${score} < ${PASS_MARK} then 1 else 0 end)`,
				scoreSum: dsql<number>`coalesce(sum(${score}), 0)`,
			})
			.from(schema.attempts)
			.where(inArray(schema.attempts.examId, ids.slice(i, i + ROLLUP_CHUNK)))
			.groupBy(schema.attempts.examId);
		for (const r of rows) {
			out.set(r.examId, {
				attempts: Number(r.attempts ?? 0),
				finished: Number(r.finished ?? 0),
				inProgress: Number(r.inProgress ?? 0),
				graded: Number(r.graded ?? 0),
				passed: Number(r.passed ?? 0),
				failed: Number(r.failed ?? 0),
				scoreSum: Number(r.scoreSum ?? 0),
			});
		}
	}
	return out;
}
