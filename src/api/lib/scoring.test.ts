/**
 * Regression tests for the score corruption that showed a student 103/100.
 *
 *   bun test
 *
 * These are pure functions — no database, no network — so they run in
 * milliseconds and gate every build (`bun run build` runs them).
 *
 * The bug: two `answers` rows existed for one question and the grader summed
 * every row, inflating numerator AND denominator. A related twin case blanked
 * real work. The database now forbids duplicates outright
 * (`answers_attempt_question_uq`, asserted at boot by database/invariants.ts);
 * these tests cover the second line of defence — that the arithmetic itself
 * cannot produce an impossible or duplicate-distorted score even if a duplicate
 * row somehow reaches it.
 */
import { describe, expect, test } from "bun:test";
import { dedupeAnswerRows, scoreFromAnswers } from "./grade-queue";

type Row = { id: string; questionId: string; response: unknown; score: number | null; maxScore: number | null };

/**
 * A 50-question / 55-point paper, deliberately scoring BELOW 100 so that the
 * clamp cannot mask a genuine difference between the clean and duplicated sets.
 * 41 of 48 one-pointers correct, plus a 6-point coding answer and a 1-point mcq.
 */
function paper(): { clean: Row[]; coding: Row; mcq: Row } {
  const base: Row[] = Array.from({ length: 48 }, (_, i) => ({
    id: `ans_${String(i).padStart(2, "0")}`,
    questionId: `q${i}`,
    response: "a",
    score: i < 41 ? 1 : 0,
    maxScore: 1,
  }));
  const coding: Row = { id: "ans_coding", questionId: "q_coding", response: "def f(): pass", score: 6, maxScore: 6 };
  const mcq: Row = { id: "ans_mcq", questionId: "q_mcq", response: "b", score: 1, maxScore: 1 };
  return { clean: [...base, coding, mcq], coding, mcq };
}

describe("dedupeAnswerRows", () => {
  test("collapses duplicate rows to one per question", () => {
    const { clean, coding, mcq } = paper();
    const withDupes = [...clean, { ...coding, id: "ans_coding_2" }, { ...mcq, id: "ans_mcq_2" }];
    expect(withDupes).toHaveLength(52);
    expect(dedupeAnswerRows(withDupes)).toHaveLength(50);
  });

  test("keeps the row with real content over a blank twin", () => {
    // The finalize data-loss case: a blank row written over real work.
    const rows: Row[] = [
      { id: "ans_blank", questionId: "q1", response: "", score: 0, maxScore: 5 },
      { id: "ans_real", questionId: "q1", response: "the student's actual essay", score: 4, maxScore: 5 },
    ];
    expect(dedupeAnswerRows(rows)[0]!.id).toBe("ans_real");
  });

  test("prefers the row carrying max_score when twins are asymmetric", () => {
    // Real duplicates were asymmetric: one row had the points, the twin was null.
    // Ignoring max_score here is what once turned 103 into 102.1 instead of 96.
    const rows: Row[] = [
      { id: "ans_null", questionId: "q1", response: "answer", score: null, maxScore: null },
      { id: "ans_full", questionId: "q1", response: "answer", score: 6, maxScore: 6 },
    ];
    const kept = dedupeAnswerRows(rows)[0]!;
    expect(kept.id).toBe("ans_full");
    expect(kept.maxScore).toBe(6);
  });

  test("is deterministic regardless of row order", () => {
    const rows: Row[] = [
      { id: "ans_b", questionId: "q1", response: "x", score: 2, maxScore: 5 },
      { id: "ans_a", questionId: "q1", response: "x", score: 2, maxScore: 5 },
    ];
    expect(dedupeAnswerRows(rows)[0]!.id).toBe(dedupeAnswerRows([...rows].reverse())[0]!.id);
  });

  test("leaves a clean answer set untouched", () => {
    const { clean } = paper();
    expect(dedupeAnswerRows(clean)).toHaveLength(clean.length);
  });
});

describe("scoreFromAnswers", () => {
  test("duplicate rows do not change the score (the 103/100 bug)", () => {
    const { clean, coding, mcq } = paper();
    const withDupes = [...clean, { ...coding, id: "ans_coding_2" }, { ...mcq, id: "ans_mcq_2" }];

    const good = scoreFromAnswers(clean);
    const bad = scoreFromAnswers(withDupes);

    expect(good.scorePct).toBeLessThan(100); // fixture sanity: equality below is meaningful
    expect(bad.scorePct).toBe(good.scorePct);
    expect(bad.deduped).toBe(2); // and the violation is surfaced for alerting

    // Without dedupe this set summed to 55/62 = 88.7 instead of 48/55 = 87.3.
    const naive = withDupes.reduce((s, a) => s + (a.score ?? 0), 0) / withDupes.reduce((s, a) => s + (a.maxScore ?? 0), 0) * 100;
    expect(Math.round(naive * 10) / 10).not.toBe(good.scorePct);
  });

  test("never returns a score above 100", () => {
    const rows: Row[] = [{ id: "a", questionId: "q1", response: "x", score: 9999, maxScore: 1 }];
    expect(scoreFromAnswers(rows).scorePct).toBe(100);
  });

  test("never returns a negative score", () => {
    const rows: Row[] = [{ id: "a", questionId: "q1", response: "x", score: -50, maxScore: 10 }];
    expect(scoreFromAnswers(rows).scorePct).toBe(0);
  });

  test("prefers the paper total as denominator when supplied", () => {
    const { clean, coding } = paper();
    const withDupes = [...clean, { ...coding, id: "ans_coding_2" }];
    expect(scoreFromAnswers(withDupes, 100).max).toBe(100);
  });

  test("handles an empty answer set without dividing by zero", () => {
    expect(scoreFromAnswers([]).scorePct).toBe(0);
  });

  test("reports zero dedupes for a clean set", () => {
    expect(scoreFromAnswers(paper().clean).deduped).toBe(0);
  });
});
