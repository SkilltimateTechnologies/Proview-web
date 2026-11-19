import { expect, test } from "bun:test";
import { listMeta } from "./question-meta";

test("lists keep display fields and drop heavy ones", () => {
  const m = listMeta({ language: "python", languageId: 71, starter: "s", explanation: "e", rubric: "R".repeat(5000), solution: "S", tests: [{ input: "1", expected: "2" }, { input: "3", expected: "4" }], timeLimitSec: 2 });
  expect(m).toEqual({ language: "python", languageId: 71, starter: "s", explanation: "e", timeLimitSec: 2, testCount: 2, hasRubric: true });
});

test("empty or missing meta", () => {
  expect(listMeta(null)).toBeNull();
  expect(listMeta(undefined)).toBeNull();
  expect(listMeta({})).toEqual({});
  expect(listMeta({ rubric: "  " })).toEqual({});
});
