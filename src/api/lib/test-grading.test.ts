import { describe, expect, test } from "bun:test";
import { gradeWithTests, normaliseOutput, outputsMatch, RunnerUnavailable, testsFingerprint, testsOf, timeLimitOf, verdictOf, type RunJob, type TestRun } from "./test-grading";

const ok = (stdout: string, status = "Accepted"): TestRun => ({ ok: true, stdout, stderr: "", compileOutput: "", status });

describe("testsOf", () => {
  test("keeps well-formed tests only", () => {
    const meta = { tests: [{ input: "1 2\n", expected: "3\n" }, { input: "x" }, { input: 5, expected: "1" }, { input: "", expected: "  " }, null] };
    expect(testsOf(meta)).toEqual([{ input: "1 2\n", expected: "3\n" }]);
  });
  test("no tests means AI grading", () => {
    expect(testsOf(null)).toEqual([]);
    expect(testsOf({})).toEqual([]);
    expect(testsOf({ tests: "nope" })).toEqual([]);
  });
  test("caps the number of tests", () => {
    const meta = { tests: Array.from({ length: 50 }, (_, i) => ({ input: String(i), expected: String(i) })) };
    expect(testsOf(meta).length).toBe(20);
  });
});

test("timeLimitOf defaults to 2 s and is capped", () => {
  expect(timeLimitOf({})).toBe(2);
  expect(timeLimitOf({ timeLimitSec: 3 })).toBe(3);
  expect(timeLimitOf({ timeLimitSec: 99 })).toBe(10);
  expect(timeLimitOf({ timeLimitSec: -1 })).toBe(2);
});

describe("output comparison", () => {
  test("ignores line-ending style, trailing spaces and trailing blank lines", () => {
    expect(outputsMatch("5 80\r\n", "5 80")).toBe(true);
    expect(outputsMatch("4  \n3\n\n\n", "4\n3\n")).toBe(true);
    expect(normaliseOutput("a \t\nb\n\n")).toBe("a\nb");
  });
  test("anything else must match exactly", () => {
    expect(outputsMatch("5  80", "5 80")).toBe(false);
    expect(outputsMatch("3\n4", "4\n3")).toBe(false);
    expect(outputsMatch("", "0")).toBe(false);
    expect(outputsMatch(" 1", "1")).toBe(false);
  });
});

describe("verdictOf", () => {
  test("maps Judge0 statuses", () => {
    expect(verdictOf(ok("3"), "3")).toBe("passed");
    expect(verdictOf(ok("4"), "3")).toBe("wrong");
    expect(verdictOf(ok("", "Time Limit Exceeded"), "3")).toBe("time");
    expect(verdictOf(ok("", "Runtime Error (NZEC)"), "3")).toBe("runtime");
    expect(verdictOf(ok("", "Compilation Error"), "3")).toBe("compile");
    expect(verdictOf(ok("", "Memory Limit Exceeded"), "3")).toBe("memory");
    expect(verdictOf(ok("", "Internal Error"), "3")).toBe("other");
  });
  test("a correct answer printed before a crash still fails", () => {
    expect(verdictOf(ok("3", "Runtime Error (NZEC)"), "3")).toBe("runtime");
  });
});

describe("gradeWithTests", () => {
  const tests = [
    { input: "1", expected: "2" },
    { input: "2", expected: "4" },
    { input: "3", expected: "6" },
    { input: "4", expected: "8" },
  ];
  test("score is the share of tests passed", async () => {
    const run = async (j: RunJob) => (j.stdin === "3" ? ok("", "Time Limit Exceeded") : j.stdin === "4" ? ok("9") : ok(String(Number(j.stdin) * 2)));
    const r = await gradeWithTests({ source: "x", languageId: 71, tests, timeLimitSec: 2, maxPoints: 30, run });
    expect(r.passed).toBe(2);
    expect(r.score).toBe(15);
    expect(r.notes).toContain("Passed 2 of 4");
    expect(r.notes).toContain("test 3: time limit exceeded");
    expect(r.notes).toContain("test 4: wrong answer");
    expect(r.notes).toContain("2 s per test");
  });
  test("full and zero marks", async () => {
    const all = await gradeWithTests({ source: "x", languageId: 71, tests, timeLimitSec: 2, maxPoints: 10, run: async (j) => ok(String(Number(j.stdin) * 2)) });
    expect(all.score).toBe(10);
    expect(all.notes).toBe("Passed 4 of 4 test cases.");
    const none = await gradeWithTests({ source: "x", languageId: 71, tests, timeLimitSec: 2, maxPoints: 10, run: async () => ({ ...ok("", "Compilation Error"), compileOutput: "SyntaxError: invalid syntax" }) });
    expect(none.score).toBe(0);
    expect(none.notes).toContain("SyntaxError");
  });
  test("thirds round to cents", async () => {
    const r = await gradeWithTests({ source: "x", languageId: 71, tests: tests.slice(0, 3), timeLimitSec: 2, maxPoints: 10, run: async (j) => ok(j.stdin === "1" ? "2" : "no") });
    expect(r.score).toBe(3.33);
  });
  test("passes the question's limits to the runner", async () => {
    const seen: RunJob[] = [];
    await gradeWithTests({ source: "src", languageId: 62, tests: tests.slice(0, 1), timeLimitSec: 3, maxPoints: 5, run: async (j) => { seen.push(j); return ok("2"); } });
    expect(seen[0]).toMatchObject({ source: "src", languageId: 62, stdin: "1", cpuTimeLimit: 3 });
    expect(seen[0].wallTimeLimit).toBeGreaterThan(3);
  });
  test("a runner outage throws instead of scoring the student 0", async () => {
    let threw: unknown = null;
    try {
      await gradeWithTests({ source: "x", languageId: 71, tests, timeLimitSec: 2, maxPoints: 10, run: async (j) => (j.stdin === "2" ? { ...ok(""), ok: false, message: "quota" } : ok("2")) });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(RunnerUnavailable);
  });
});

test("fingerprint changes with tests or time limit", () => {
  const a = [{ input: "1", expected: "2" }];
  expect(testsFingerprint(a, 2)).toBe(testsFingerprint([{ input: "1", expected: "2" }], 2));
  expect(testsFingerprint(a, 2)).not.toBe(testsFingerprint(a, 3));
  expect(testsFingerprint(a, 2)).not.toBe(testsFingerprint([{ input: "1", expected: "3" }], 2));
});
