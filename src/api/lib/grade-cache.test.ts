/**
 * Identical answers are graded once. Pin what must never happen: a failed or
 * unparseable grade copied to other students, or a grade reused across a
 * different question, rubric, maximum or answer.
 */
import { describe, expect, test } from "bun:test";
import { GradeCache, UNGRADED_NOTE, type GradeInput } from "./grade-cache";

const base: GradeInput = { provider: "anthropic", questionId: "q1", question: "Define a process.", rubric: "program in execution", maxPoints: 5, studentAnswer: "A program in execution." };

describe("GradeCache", () => {
  test("an identical answer reuses the first grade", async () => {
    const cache = new GradeCache(); let calls = 0;
    const call = async () => { calls++; return { score: 4, notes: "Good." }; };
    expect(await cache.grade(base, call)).toEqual({ score: 4, notes: "Good." });
    expect(await cache.grade({ ...base }, call)).toEqual({ score: 4, notes: "Good." });
    expect(calls).toBe(1);
  });

  test("anything that changes the grade changes the key", async () => {
    const cache = new GradeCache(); let calls = 0;
    const call = async () => { calls++; return { score: calls, notes: "n" }; };
    await cache.grade(base, call);
    for (const v of [{ studentAnswer: "A program in execution" }, { questionId: "q2" }, { rubric: "other" }, { maxPoints: 10 }, { provider: "google" }, { question: "Define a thread." }, { isCode: true }]) {
      await cache.grade({ ...base, ...v }, call);
    }
    expect(calls).toBe(8);
  });

  test("failures are never cached: errors and the unparseable fallback are retried", async () => {
    const cache = new GradeCache(); let calls = 0;
    await expect(cache.grade(base, async () => { calls++; throw new Error("provider down"); })).rejects.toThrow("provider down");
    expect(await cache.grade(base, async () => { calls++; return { score: 0, notes: UNGRADED_NOTE }; })).toEqual({ score: 0, notes: UNGRADED_NOTE });
    expect(await cache.grade(base, async () => { calls++; return { score: 3, notes: "ok" }; })).toEqual({ score: 3, notes: "ok" });
    expect(calls).toBe(3);
  });

  test("concurrent identical requests share one call", async () => {
    const cache = new GradeCache(); let calls = 0;
    const call = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return { score: 2, notes: "x" }; };
    const out = await Promise.all(Array.from({ length: 8 }, () => cache.grade(base, call)));
    expect(calls).toBe(1);
    expect(out.every((r) => r.score === 2)).toBe(true);
  });

  test("callers get copies, so one cannot alter another's grade", async () => {
    const cache = new GradeCache();
    const a = await cache.grade(base, async () => ({ score: 4, notes: "Good." }));
    a.score = 0;
    expect((await cache.grade(base, async () => ({ score: 9, notes: "no" }))).score).toBe(4);
  });
});
