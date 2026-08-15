import { describe, expect, test } from "bun:test";
import {
  OPTION_ORDER_TOKEN,
  displayToOriginalIndex,
  hasOrderDependentOptions,
  isPermutable,
  optionPermutation,
  optionTranslator,
  optionsForDisplay,
  originalToDisplayIndex,
  tokenIsCurrent,
} from "./option-order";
import { autoGrade } from "./util";

const OPTION_COUNTS = [2, 3, 4, 5, 6];

describe("optionPermutation", () => {
  test("is a real permutation — every index appears exactly once", () => {
    for (const n of OPTION_COUNTS) {
      for (let s = 0; s < 60; s++) {
        const perm = optionPermutation(`stu_${s}`, "ex_1", `q_${s}`, n);
        expect(perm.length).toBe(n);
        expect([...perm].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
      }
    }
  });

  test("is deterministic — the same student/exam/question always gets the same order", () => {
    const a = optionPermutation("stu_1", "ex_1", "q_1", 4);
    const b = optionPermutation("stu_1", "ex_1", "q_1", 4);
    expect(a).toEqual(b);
  });

  test("differs between students, and between questions for one student", () => {
    // Different students must not share a paper-wide order, otherwise copying a
    // neighbour's letters still works.
    const perStudent = new Set<string>();
    for (let s = 0; s < 40; s++) perStudent.add(JSON.stringify(optionPermutation(`stu_${s}`, "ex_1", "q_1", 4)));
    expect(perStudent.size).toBeGreaterThan(1);

    const perQuestion = new Set<string>();
    for (let q = 0; q < 40; q++) perQuestion.add(JSON.stringify(optionPermutation("stu_1", "ex_1", `q_${q}`, 4)));
    expect(perQuestion.size).toBeGreaterThan(1);
  });

  test("0 or 1 option is left alone", () => {
    expect(optionPermutation("s", "e", "q", 0)).toEqual([]);
    expect(optionPermutation("s", "e", "q", 1)).toEqual([0]);
  });

  test("nonsense counts never throw and never produce holes", () => {
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      const perm = optionPermutation("s", "e", "q", bad as number);
      expect(Array.isArray(perm)).toBe(true);
      expect(perm.every((v) => Number.isInteger(v))).toBe(true);
    }
  });

  test("no letter is worth more than chance across a cohort", () => {
    // The whole point of the change. General Set-1 keyed B on 55% of questions and
    // D on none; a guesser who always pressed B scored 55/100 and nobody could be
    // right with D. After shuffling, the correct DISPLAY position of a fixed key
    // must spread across all four slots.
    const key = 1; // original index of the correct option ("B")
    const slots = [0, 0, 0, 0];
    const students = 800;
    for (let s = 0; s < students; s++) {
      const perm = optionPermutation(`stu_${s}`, "ex_1", "q_fixed", 4);
      slots[originalToDisplayIndex(key, perm)]++;
    }
    for (const count of slots) {
      // Every slot lands near 25% — no dead letter, no jackpot letter.
      expect(count).toBeGreaterThan(students * 0.18);
      expect(count).toBeLessThan(students * 0.32);
    }
  });

  test("a whole paper's key is spread across letters for one student", () => {
    // 40 questions all keyed "B" (the pathological real case) must not stay "B".
    const slots = [0, 0, 0, 0];
    for (let q = 0; q < 40; q++) {
      const perm = optionPermutation("stu_x", "ex_general_set_1", `q_${q}`, 4);
      slots[originalToDisplayIndex(1, perm)]++;
    }
    expect(slots.filter((c) => c > 0).length).toBeGreaterThan(2);
    expect(Math.max(...slots)).toBeLessThan(40);
  });
});

describe("index round trip", () => {
  test("displayToOriginal is the exact inverse of originalToDisplay, for every option count", () => {
    for (const n of OPTION_COUNTS) {
      for (let s = 0; s < 30; s++) {
        const perm = optionPermutation(`stu_${s}`, "ex_1", `q_${s}`, n);
        for (let i = 0; i < n; i++) {
          expect(displayToOriginalIndex(originalToDisplayIndex(i, perm), perm)).toBe(i);
          expect(originalToDisplayIndex(displayToOriginalIndex(i, perm), perm)).toBe(i);
        }
      }
    }
  });

  test("the displayed option text matches the index we store", () => {
    // The real invariant: whatever text the student clicked must be the text the
    // original index points at.
    const options = ["alpha", "beta", "gamma", "delta"];
    for (let s = 0; s < 50; s++) {
      const perm = optionPermutation(`stu_${s}`, "ex_1", "q_1", options.length);
      const shown = optionsForDisplay(options, perm);
      for (let d = 0; d < shown.length; d++) {
        expect(options[displayToOriginalIndex(d, perm)]).toBe(shown[d]);
      }
    }
  });

  test("out-of-range indices pass through untouched instead of throwing", () => {
    const perm = optionPermutation("s", "e", "q", 4);
    for (const bad of [-1, 4, 99, 1.5, NaN]) {
      expect(displayToOriginalIndex(bad, perm)).toBe(bad);
      expect(originalToDisplayIndex(bad, perm)).toBe(bad);
    }
  });
});

describe("order-dependent options are left alone", () => {
  test("detects options that refer to position or to other options", () => {
    expect(hasOrderDependentOptions(["x", "y", "All of the above"])).toBe(true);
    expect(hasOrderDependentOptions(["x", "y", "none of the above"])).toBe(true);
    expect(hasOrderDependentOptions(["x", "y", "All of these"])).toBe(true);
    expect(hasOrderDependentOptions(["x", "y", "Both A and B"])).toBe(true);
    expect(hasOrderDependentOptions(["x", "y", "Options A and C"])).toBe(true);
    expect(hasOrderDependentOptions(["x", "y", "A and B are both correct"])).toBe(true);
  });

  test("does NOT match bitwise-operator answers from the live DSA bank", () => {
    // q_ce2e7ec9cff34e54 in production. "A & B" is the ANSWER, not a reference to
    // options A and B — shuffling it is correct and skipping it would be a bug.
    expect(hasOrderDependentOptions(["A | B", "A & B", "A - B", "A ^ B"])).toBe(false);
    expect(isPermutable("mcq", ["A | B", "A & B", "A - B", "A ^ B"])).toBe(true);
  });

  test("isPermutable gates on type and option count", () => {
    expect(isPermutable("mcq", ["a", "b", "c", "d"])).toBe(true);
    expect(isPermutable("multi", ["a", "b", "c"])).toBe(true);
    expect(isPermutable("fillblank", ["a", "b"])).toBe(true);
    // Booleans and free text are not index-valued.
    expect(isPermutable("truefalse", ["True", "False"])).toBe(false);
    expect(isPermutable("short", null)).toBe(false);
    expect(isPermutable("coding", null)).toBe(false);
    expect(isPermutable("essay", ["a", "b"])).toBe(false);
    // Nothing to shuffle.
    expect(isPermutable("mcq", ["only one"])).toBe(false);
    expect(isPermutable("mcq", [])).toBe(false);
    expect(isPermutable("mcq", null)).toBe(false);
    expect(isPermutable("mcq", "not an array")).toBe(false);
    expect(isPermutable(undefined, ["a", "b"])).toBe(false);
  });

  test("an order-dependent question keeps its authored order end to end", () => {
    const qs = [{ id: "q1", type: "mcq", options: ["x", "y", "All of the above"] }];
    const t = optionTranslator("stu_1", "ex_1", qs, true);
    expect(t.size).toBe(0);
    expect(t.display("q1", qs[0].options)).toEqual(["x", "y", "All of the above"]);
    expect(t.toOriginal("q1", 2)).toBe(2);
    expect(t.toDisplay("q1", 2)).toBe(2);
  });
});

describe("optionTranslator", () => {
  const questions = [
    { id: "q_mcq", type: "mcq", options: ["a", "b", "c", "d"] },
    { id: "q_multi", type: "multi", options: ["w", "x", "y", "z"] },
    { id: "q_tf", type: "truefalse", options: ["True", "False"] },
    { id: "q_short", type: "short", options: null },
    { id: "q_code", type: "coding", options: null },
  ];

  test("round trips every mcq answer a student could give", () => {
    for (let s = 0; s < 40; s++) {
      const t = optionTranslator(`stu_${s}`, "ex_1", questions, true);
      for (let d = 0; d < 4; d++) {
        expect(t.toDisplay("q_mcq", t.toOriginal("q_mcq", d))).toBe(d);
        expect(t.toDisplay("q_mcq", t.toOriginal("q_mcq", String(d)))).toBe(String(d));
      }
    }
  });

  test("stores the ORIGINAL index, so grading is unchanged", () => {
    // A student clicks the option whose text is "c" (original index 2). Whatever
    // slot it was shown in, the stored value must be 2 and autoGrade must award
    // full marks against the unchanged key.
    const options = ["a", "b", "c", "d"];
    const correct = 2;
    for (let s = 0; s < 60; s++) {
      const t = optionTranslator(`stu_${s}`, "ex_1", questions, true);
      const shown = t.display("q_mcq", options)!;
      const clicked = shown.indexOf("c");
      const stored = t.toOriginal("q_mcq", clicked);
      expect(stored).toBe(correct);
      expect(autoGrade("mcq", correct, stored, 5)).toBe(5);
    }
  });

  test("a wrong click still grades wrong", () => {
    const options = ["a", "b", "c", "d"];
    for (let s = 0; s < 60; s++) {
      const t = optionTranslator(`stu_${s}`, "ex_1", questions, true);
      const shown = t.display("q_mcq", options)!;
      const clicked = shown.indexOf("d");
      expect(autoGrade("mcq", 2, t.toOriginal("q_mcq", clicked), 5)).toBe(0);
    }
  });

  test("multi-select round trips as a canonical sorted set", () => {
    for (let s = 0; s < 30; s++) {
      const t = optionTranslator(`stu_${s}`, "ex_1", questions, true);
      const picked = [0, 2];
      const stored = t.toOriginal("q_multi", picked) as number[];
      expect(stored.length).toBe(2);
      expect([...stored].sort((a, b) => a - b)).toEqual(stored);
      expect(t.toDisplay("q_multi", stored)).toEqual(picked);
    }
  });

  test("non-index answers are never touched", () => {
    const t = optionTranslator("stu_1", "ex_1", questions, true);
    expect(t.toOriginal("q_tf", true)).toBe(true);
    expect(t.toOriginal("q_tf", false)).toBe(false);
    expect(t.toOriginal("q_short", "my written answer")).toBe("my written answer");
    expect(t.toOriginal("q_code", "def f():\n  return 1")).toBe("def f():\n  return 1");
    expect(t.toOriginal("q_mcq", null)).toBe(null);
    expect(t.toOriginal("q_mcq", undefined)).toBe(undefined);
    expect(t.toOriginal("q_mcq", "")).toBe("");
    expect(t.toOriginal("q_mcq", "not a number")).toBe("not a number");
    expect(t.toDisplay("q_mcq", null)).toBe(null);
  });

  test("an unknown question id is a pass-through, never a crash", () => {
    const t = optionTranslator("stu_1", "ex_1", questions, true);
    expect(t.toOriginal("q_not_in_exam", 3)).toBe(3);
    expect(t.toDisplay("q_not_in_exam", 3)).toBe(3);
    expect(t.display("q_not_in_exam", ["a", "b"])).toEqual(["a", "b"]);
    expect(t.permFor("q_not_in_exam")).toBe(null);
  });

  test("inactive translator is a complete no-op — protects clients on an old bundle", () => {
    const t = optionTranslator("stu_1", "ex_1", questions, false);
    expect(t.size).toBe(0);
    expect(t.display("q_mcq", ["a", "b", "c", "d"])).toEqual(["a", "b", "c", "d"]);
    for (let d = 0; d < 4; d++) {
      expect(t.toOriginal("q_mcq", d)).toBe(d);
      expect(t.toDisplay("q_mcq", d)).toBe(d);
    }
  });

  test("malformed question rows are skipped without throwing", () => {
    const t = optionTranslator("stu_1", "ex_1", [
      null as never,
      { id: 42 as never, type: "mcq", options: ["a", "b"] },
      { id: "ok", type: "mcq", options: ["a", "b", "c", "d"] },
    ], true);
    expect(t.size).toBe(1);
    expect(t.permFor("ok")).not.toBe(null);
  });
});

describe("scheme token", () => {
  test("only the exact current token activates translation", () => {
    expect(tokenIsCurrent(OPTION_ORDER_TOKEN)).toBe(true);
    for (const bad of [undefined, null, "", "v0", "V1", "v2", 1, true, {}]) {
      expect(tokenIsCurrent(bad)).toBe(false);
    }
  });
});
