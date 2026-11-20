import { expect, test } from "bun:test";
import { branchFromCode, labelRow, type ClassLike } from "./report-labels";

const cls: ClassLike[] = [
  { id: "c1", code: "CSE-A", branch: "CSE" },
  { id: "c2", code: "CSM-C", branch: "CSM" },
  { id: "c3", code: "ELITE", branch: "ELITE" },
  { id: "c4", code: "CIVIL", branch: "CIVIL" },
];
const byId = new Map(cls.map((c) => [c.id, c]));
const byCode = new Map(cls.map((c) => [c.code, c]));

test("a normal student: branch of their section, no home section", () => {
  expect(labelRow("CSE-A", { classId: "c1" }, byId, byCode)).toEqual({ branch: "CSE", homeSection: null });
});

test("an ELITE student is counted under their home branch, with the home section shown", () => {
  expect(labelRow("ELITE", { classId: "c3", originalClassId: "c2" }, byId, byCode)).toEqual({ branch: "CSM", homeSection: "CSM-C" });
});

test("the section frozen on the attempt wins over the student's current section", () => {
  // Sat the exam in CSE-A, moved to CSM-C later: still reported under CSE.
  expect(labelRow("CSE-A", { classId: "c2" }, byId, byCode).branch).toBe("CSE");
});

test("a section code with no class row falls back to its prefix", () => {
  expect(labelRow("ECE-B", { classId: null }, byId, byCode)).toEqual({ branch: "ECE", homeSection: null });
  expect(branchFromCode("it a")).toBe("IT");
  expect(branchFromCode("")).toBe("");
});

test("a student with no section at all gets an empty branch", () => {
  expect(labelRow("", undefined, byId, byCode)).toEqual({ branch: "", homeSection: null });
});
