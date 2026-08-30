/**
 * Pins the deferred-grading release time.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Grading used to start the instant a student pressed submit: a 300-student bell
 * fired 300 AI passes and Judge0 calls out of the web process while everyone else
 * was still writing to the same database. `gradeReleaseDelayMs` moves that work
 * to after the exam closes.
 *
 * The whole deferral rests on this one pure function, and both of its failure
 * directions are bad in a way nobody would notice quickly:
 *
 *   - returns 0 when it should wait  -> the deferral silently does nothing
 *   - returns > 0 when it should not -> a paper that could be graded now waits,
 *     e.g. an open practice exam with no end time would never be graded at all
 *
 * So every "grade now" escape hatch is pinned here, plus each of the three things
 * that legitimately push the release time out (extra time, banked hold, a hold
 * that is still running).
 *
 * Pure arithmetic on a plain object — no database, no fixtures, no clock control.
 * `now` is injected, so nothing here is time-of-day flaky.
 */
import { describe, expect, test } from "bun:test";

// grade-queue.ts imports the app's db singleton, which throws at import time
// without DATABASE_URL. Nothing here touches the database — the function under
// test is pure — but the module graph still has to load.
process.env.DATABASE_URL ||= ":memory:";
const { gradeReleaseDelayMs, GRADE_RELEASE_LAG_MS } = await import("./grade-queue");

const NOW = Date.UTC(2026, 7, 30, 10, 0, 0); // 2026-08-30T10:00:00Z
const MIN = 60_000;

describe("gradeReleaseDelayMs — grade now (returns 0)", () => {
  test("no exam row at all", () => {
    // finalizeAttempt falls back to null when the exam read throws. Grading a
    // paper immediately is worse for load but far better than never grading it.
    expect(gradeReleaseDelayMs(null, NOW)).toBe(0);
    expect(gradeReleaseDelayMs(undefined, NOW)).toBe(0);
  });

  test("gradingMode 'immediate' is the per-exam opt-out", () => {
    expect(gradeReleaseDelayMs({ endAt: NOW + 60 * MIN, gradingMode: "immediate" }, NOW)).toBe(0);
  });

  test("gradingMode null/'after_close' both defer — null is the DB default", () => {
    // ensureRequiredColumns adds the column with ALTER TABLE ADD COLUMN, which
    // cannot be NOT NULL, so every pre-existing exam row reads back null. Null
    // MUST behave like after_close or the deferral would be off everywhere.
    expect(gradeReleaseDelayMs({ endAt: NOW + 60 * MIN, gradingMode: null }, NOW)).toBeGreaterThan(0);
    expect(gradeReleaseDelayMs({ endAt: NOW + 60 * MIN }, NOW)).toBeGreaterThan(0);
    expect(gradeReleaseDelayMs({ endAt: NOW + 60 * MIN, gradingMode: "after_close" }, NOW)).toBeGreaterThan(0);
  });

  test("no end time — an open practice paper, where 'after close' never arrives", () => {
    expect(gradeReleaseDelayMs({ endAt: null }, NOW)).toBe(0);
  });

  test("unparseable end time is not trusted into a wait", () => {
    expect(gradeReleaseDelayMs({ endAt: "not a date" }, NOW)).toBe(0);
  });

  test("window already closed — a late or auto-submitted paper grades straight away", () => {
    // Past the lag too, otherwise there is still time left to wait for.
    expect(gradeReleaseDelayMs({ endAt: NOW - GRADE_RELEASE_LAG_MS - MIN }, NOW)).toBe(0);
  });

  test("never returns a negative delay", () => {
    expect(gradeReleaseDelayMs({ endAt: NOW - 10 * 24 * 60 * MIN }, NOW)).toBe(0);
  });
});

describe("gradeReleaseDelayMs — deferral arithmetic", () => {
  test("future window: end - now + lag", () => {
    expect(gradeReleaseDelayMs({ endAt: NOW + 60 * MIN }, NOW)).toBe(60 * MIN + GRADE_RELEASE_LAG_MS);
  });

  test("extraMin (admin extra time) pushes the release out", () => {
    expect(gradeReleaseDelayMs({ endAt: NOW + 60 * MIN, extraMin: 15 }, NOW))
      .toBe(75 * MIN + GRADE_RELEASE_LAG_MS);
  });

  test("holdMs (hold time already banked) pushes the release out", () => {
    expect(gradeReleaseDelayMs({ endAt: NOW + 60 * MIN, holdMs: 5 * MIN }, NOW))
      .toBe(65 * MIN + GRADE_RELEASE_LAG_MS);
  });

  test("a hold that is STILL RUNNING extends by its elapsed time", () => {
    // heldAt set = the clock is paused right now, so the window cannot close
    // before the hold is lifted. 3 minutes into the hold = 3 more minutes.
    expect(gradeReleaseDelayMs({ endAt: NOW + 60 * MIN, heldAt: NOW - 3 * MIN }, NOW))
      .toBe(63 * MIN + GRADE_RELEASE_LAG_MS);
  });

  test("an unparseable heldAt is ignored rather than poisoning the arithmetic", () => {
    expect(gradeReleaseDelayMs({ endAt: NOW + 60 * MIN, heldAt: "nonsense" }, NOW))
      .toBe(60 * MIN + GRADE_RELEASE_LAG_MS);
  });

  test("extraMin + holdMs + live hold all stack", () => {
    expect(gradeReleaseDelayMs(
      { endAt: NOW + 60 * MIN, extraMin: 10, holdMs: 2 * MIN, heldAt: NOW - MIN },
      NOW,
    )).toBe(73 * MIN + GRADE_RELEASE_LAG_MS);
  });

  test("accepts Date, epoch ms and ISO string alike", () => {
    const end = NOW + 30 * MIN;
    const expected = 30 * MIN + GRADE_RELEASE_LAG_MS;
    expect(gradeReleaseDelayMs({ endAt: new Date(end) }, NOW)).toBe(expected);
    expect(gradeReleaseDelayMs({ endAt: end }, NOW)).toBe(expected);
    expect(gradeReleaseDelayMs({ endAt: new Date(end).toISOString() }, NOW)).toBe(expected);
  });

  test("the lag is a real, positive window for the auto-submit sweep", () => {
    // The 60s auto-submit sweep needs its grace window to force-submit students
    // who lost their connection through the cutoff; grading them in the same
    // batch as the on-time submitters keeps it to one batch instead of two.
    expect(GRADE_RELEASE_LAG_MS).toBeGreaterThanOrEqual(3 * MIN);
  });

  test("a 90-minute paper submitted 10 minutes in still waits for the bell", () => {
    // The realistic case: an early finisher. Their AI grading must not start
    // while 300 classmates are still autosaving.
    const delay = gradeReleaseDelayMs({ endAt: NOW + 80 * MIN }, NOW);
    expect(delay).toBe(80 * MIN + GRADE_RELEASE_LAG_MS);
    expect(delay).toBeGreaterThan(60 * MIN);
  });
});
