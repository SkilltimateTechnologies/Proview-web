/**
 * Regression tests for the duplicate-student incident.
 *
 * Each case here maps to a real row that had to be merged out of production:
 * a pasted college email, a case variant, a padded variant, and a lost insert
 * race that surfaced as a 500 instead of a clean 409.
 */
import { describe, expect, test } from "bun:test";
import { normalizeRoll, rollNoProblem, isDuplicateRollError } from "./students";

describe("normalizeRoll", () => {
  test("collapses the three spellings that created three students", () => {
    const canonical = "23K91A0491";
    expect(normalizeRoll("23k91a0491")).toBe(canonical);
    expect(normalizeRoll(" 23K91A0491 ")).toBe(canonical);
    expect(normalizeRoll("23K91A0491")).toBe(canonical);
    expect(normalizeRoll("23K91A 0491")).toBe(canonical);
  });

  test("survives non-string input without throwing", () => {
    expect(normalizeRoll(null)).toBe("");
    expect(normalizeRoll(undefined)).toBe("");
    expect(normalizeRoll(12345)).toBe("12345");
  });

  test("is idempotent — normalising twice changes nothing", () => {
    const once = normalizeRoll("  24k95a0503 ");
    expect(normalizeRoll(once)).toBe(once);
  });
});

describe("rollNoProblem", () => {
  test("rejects a pasted college email (the real duplicate source)", () => {
    expect(rollNoProblem(normalizeRoll("23K91A0491@TKRCET.COM"))).toMatch(/email/i);
    expect(rollNoProblem(normalizeRoll("24k95a0503@tkrcet.com"))).toMatch(/email/i);
  });

  test("rejects empty, too short and too long values", () => {
    expect(rollNoProblem("")).toMatch(/required/i);
    expect(rollNoProblem("A1")).toMatch(/short/i);
    expect(rollNoProblem("A".repeat(21))).toMatch(/long/i);
  });

  test("rejects punctuation that means the field was mis-filled", () => {
    expect(rollNoProblem("23K91A0491,")).toBeTruthy();
    expect(rollNoProblem("23K91A0491/2")).toBeTruthy();
  });

  test("accepts real roll numbers, including hyphenated ones", () => {
    expect(rollNoProblem("23K91A0491")).toBeNull();
    expect(rollNoProblem("24K95A0503")).toBeNull();
    expect(rollNoProblem("CSE-1234")).toBeNull();
  });
});

describe("isDuplicateRollError", () => {
  test("recognises the SQLite unique-index violation", () => {
    expect(isDuplicateRollError(new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: index 'students_tenant_roll_uq'"))).toBe(true);
  });

  test("sees through drizzle's wrapper, whose own message hides the constraint", () => {
    // This is the exact shape that made 5 of 6 concurrent creates return 500.
    const cause = new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: index 'students_tenant_roll_uq'");
    const wrapped = new Error('Failed query: insert into "students" ("id", "tenant_id") values (?, ?)', { cause });
    expect(isDuplicateRollError(wrapped)).toBe(true);
  });

  test("matches a plain-column unique violation on students too", () => {
    const cause = new Error("UNIQUE constraint failed: students.tenant_id, students.roll_no");
    expect(isDuplicateRollError(new Error("Failed query", { cause }))).toBe(true);
  });

  test("does not swallow unrelated errors", () => {
    expect(isDuplicateRollError(new Error("SQLITE_BUSY: database is locked"))).toBe(false);
    expect(isDuplicateRollError(new Error("UNIQUE constraint failed: index 'answers_attempt_question_uq'"))).toBe(false);
    expect(isDuplicateRollError("something went wrong")).toBe(false);
    expect(isDuplicateRollError(null)).toBe(false);
  });

  test("terminates on a self-referencing cause chain", () => {
    const e = new Error("boom") as Error & { cause?: unknown };
    e.cause = e;
    expect(isDuplicateRollError(e)).toBe(false);
  });
});
