import { describe, expect, test } from "bun:test";
import { checkRunSize, MAX_SOURCE_CHARS, MAX_STDIN_CHARS, RunLimiter } from "./run-code-guard";

describe("checkRunSize", () => {
  test("normal code and input pass", () => {
    expect(checkRunSize("print(1)", "5\n")).toEqual({ ok: true });
  });
  test("oversized code or input is refused", () => {
    expect(checkRunSize("x".repeat(MAX_SOURCE_CHARS + 1), "")).toMatchObject({ ok: false, status: 413 });
    expect(checkRunSize("x", "y".repeat(MAX_STDIN_CHARS + 1))).toMatchObject({ ok: false, status: 413 });
  });
});

describe("RunLimiter", () => {
  test("one run at a time per student", () => {
    const l = new RunLimiter(30, 60_000, () => 0);
    expect(l.start("s1").ok).toBe(true);
    expect(l.start("s1")).toMatchObject({ ok: false, status: 429 });
    expect(l.start("s2").ok).toBe(true); // other students unaffected
    l.finish("s1");
    expect(l.start("s1").ok).toBe(true);
  });

  test("caps runs per window and frees up as the window slides", () => {
    let t = 0;
    const l = new RunLimiter(3, 60_000, () => t);
    for (let i = 0; i < 3; i++) {
      expect(l.start("s").ok).toBe(true);
      l.finish("s");
      t += 1000;
    }
    const refused = l.start("s");
    expect(refused).toMatchObject({ ok: false, status: 429 });
    expect((refused as { message: string }).message).toContain("57 s");
    t = 60_001; // the first run has left the window
    expect(l.start("s").ok).toBe(true);
  });
});
