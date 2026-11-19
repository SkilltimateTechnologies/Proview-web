/**
 * Grade a coding answer by running it against the question's test cases.
 *
 * Coding answers used to be graded only by an AI reading the code, with
 * instructions written for simple classroom exercises: accept hard-coded values,
 * ignore edge cases, never mind speed. For CodeVita-style problems that meant a
 * program that printed the sample answer, or a brute force far too slow for the
 * stated limits, could score full marks.
 *
 * A coding question that carries `meta.tests` (a list of { input, expected }) is
 * now graded the way the real contest grades it: the student's program runs on
 * each input through Judge0 with the question's time limit, and the score is the
 * share of tests whose output matches. Questions without tests keep AI grading.
 *
 * The tests never reach the student: the exam paper ships only `language` and
 * `starter` from a coding question's meta.
 */
import { createHash } from "node:crypto";

export type CodeTest = { input: string; expected: string };

export type TestRun = {
  /** false = the runner itself failed (network, quota, timeout waiting); NOT a verdict on the code. */
  ok: boolean;
  stdout: string;
  stderr: string;
  compileOutput: string;
  status: string;
  message?: string;
};

export type RunJob = {
  source: string;
  languageId: number;
  stdin: string;
  cpuTimeLimit: number;
  wallTimeLimit: number;
  memoryLimitKb: number;
};

/** Most tests one question may carry (each costs a Judge0 run per student). */
export const MAX_TESTS = 20;
/** Largest input or expected output per test, in characters. */
export const MAX_TEST_CHARS = 200_000;
export const DEFAULT_TIME_LIMIT_SEC = 2;
const MEMORY_LIMIT_KB = 256_000;

/** The usable tests on a question's meta, or [] when it has none (AI grading then applies). */
export function testsOf(meta: unknown): CodeTest[] {
  const raw = (meta as { tests?: unknown } | null | undefined)?.tests;
  if (!Array.isArray(raw)) return [];
  const out: CodeTest[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const input = (t as { input?: unknown }).input;
    const expected = (t as { expected?: unknown }).expected;
    if (typeof input !== "string" || typeof expected !== "string") continue;
    if (!expected.trim()) continue; // a test with no expected output can never be judged
    if (input.length > MAX_TEST_CHARS || expected.length > MAX_TEST_CHARS) continue;
    out.push({ input, expected });
    if (out.length >= MAX_TESTS) break;
  }
  return out;
}

export function timeLimitOf(meta: unknown): number {
  const v = Number((meta as { timeLimitSec?: unknown } | null | undefined)?.timeLimitSec);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 10) : DEFAULT_TIME_LIMIT_SEC;
}

/**
 * Output comparison, as contest judges do it: line endings normalised, trailing
 * spaces on each line and trailing blank lines ignored. Everything else (order,
 * spacing inside a line, case) must match.
 */
export function normaliseOutput(s: string): string {
  const lines = String(s ?? "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

export function outputsMatch(actual: string, expected: string): boolean {
  return normaliseOutput(actual) === normaliseOutput(expected);
}

export type Verdict = "passed" | "wrong" | "time" | "runtime" | "compile" | "memory" | "other";

export function verdictOf(run: TestRun, expected: string): Verdict {
  const st = run.status.toLowerCase();
  if (st.includes("time limit")) return "time";
  if (st.includes("compil")) return "compile";
  if (st.includes("memory")) return "memory";
  if (st.includes("runtime") || st.includes("nzec") || st.includes("sigsegv") || st.includes("signal")) return "runtime";
  if (st.includes("internal") || st.includes("exec format")) return "other";
  return outputsMatch(run.stdout, expected) ? "passed" : "wrong";
}

const VERDICT_LABEL: Record<Exclude<Verdict, "passed">, string> = {
  wrong: "wrong answer",
  time: "time limit exceeded",
  runtime: "runtime error",
  compile: "did not compile",
  memory: "memory limit exceeded",
  other: "could not run",
};

/** Cache key part: identical tests + limits give identical verdicts. */
export function testsFingerprint(tests: CodeTest[], timeLimitSec: number): string {
  const h = createHash("sha256");
  h.update(String(timeLimitSec));
  for (const t of tests) {
    h.update("\u0000");
    h.update(t.input);
    h.update("\u0001");
    h.update(t.expected);
  }
  return `tests:${h.digest("hex")}`;
}

export class RunnerUnavailable extends Error {}

/**
 * Run every test and score the answer. Throws RunnerUnavailable when Judge0 could
 * not give a verdict for some test, so the grade queue leaves the answer
 * ungraded and retries later instead of marking a student down for our outage.
 */
export async function gradeWithTests(opts: {
  source: string;
  languageId: number;
  tests: CodeTest[];
  timeLimitSec: number;
  maxPoints: number;
  run: (job: RunJob) => Promise<TestRun>;
}): Promise<{ score: number; notes: string; passed: number; total: number }> {
  const { source, languageId, tests, timeLimitSec, maxPoints, run } = opts;
  const total = tests.length;
  if (!total) throw new Error("gradeWithTests called without tests");

  const runs = await Promise.all(
    tests.map((t) =>
      run({
        source,
        languageId,
        stdin: t.input,
        cpuTimeLimit: timeLimitSec,
        // Wall time covers process start-up and a busy runner; CPU time is the real limit.
        wallTimeLimit: Math.max(timeLimitSec * 3, timeLimitSec + 3),
        memoryLimitKb: MEMORY_LIMIT_KB,
      }),
    ),
  );
  const failedRunner = runs.find((r) => !r.ok);
  if (failedRunner) throw new RunnerUnavailable(failedRunner.message || "code runner unavailable");

  const verdicts = runs.map((r, i) => verdictOf(r, tests[i].expected));
  const passed = verdicts.filter((v) => v === "passed").length;
  const score = Math.round((maxPoints * passed * 100) / total) / 100;

  let notes = `Passed ${passed} of ${total} test case${total === 1 ? "" : "s"}.`;
  if (passed < total) {
    const failures = verdicts
      .map((v, i) => (v === "passed" ? null : `test ${i + 1}: ${VERDICT_LABEL[v]}`))
      .filter(Boolean)
      .slice(0, 6);
    const more = total - passed - failures.length;
    notes += ` Failed ${failures.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
    if (verdicts.includes("time")) notes += ` Time limit is ${timeLimitSec} s per test.`;
    const compile = runs.find((_r, i) => verdicts[i] === "compile" || verdicts[i] === "runtime");
    const detail = (compile?.compileOutput || compile?.stderr || "").trim().split("\n").slice(-2).join(" ").slice(0, 200);
    if (detail) notes += ` Error: ${detail}`;
  }
  return { score, notes, passed, total };
}
