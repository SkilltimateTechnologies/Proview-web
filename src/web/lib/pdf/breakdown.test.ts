import { expect, test } from "bun:test";
import { breakdown, type ReportRow } from "./theme";

const row = (o: Partial<ReportRow>): ReportRow => ({ attemptId: Math.random().toString(36), studentId: "s", name: "n", rollNo: "r", email: null, section: "CSE-A", branch: "CSE", score: null, status: "graded", submittedAt: null, ...o });

const rows: ReportRow[] = [
  row({ section: "CSE-A", score: 80 }),
  row({ section: "CSE-A", score: 20 }),
  row({ section: "CSE-A", absent: true, status: "absent" }),
  row({ section: "CSE-B", absent: true, status: "absent" }),
  row({ section: "ELITE", branch: "CSM", homeSection: "CSM-C", score: 50 }),
  row({ section: "CSM-C", branch: "CSM", status: "submitted", score: null }), // still grading
  row({ section: "", branch: "", absent: true, status: "absent" }),
];

test("by branch: attendance and results per department", () => {
  const b = breakdown(rows, "branch");
  expect(b.map((g) => g.key)).toEqual(["CSE", "CSM", "Unassigned"]);
  const cse = b[0];
  expect([cse.total, cse.appeared, cse.absent, cse.attendancePct]).toEqual([4, 2, 2, 50]);
  expect([cse.scored, cse.average, cse.highest, cse.pass, cse.fail]).toEqual([2, 50, 80, 1, 1]);
  expect(cse.sections).toEqual(["CSE-A", "CSE-B"]);
  const csm = b[1]; // the ELITE student counts under CSM
  expect([csm.total, csm.appeared, csm.absent, csm.scored, csm.pass]).toEqual([2, 2, 0, 1, 1]);
  expect(csm.sections).toEqual(["CSM-C", "ELITE"]);
});

test("by section: a section with nobody present has no average", () => {
  const s = breakdown(rows, "section");
  expect(s.map((g) => g.key)).toEqual(["CSE-A", "CSE-B", "CSM-C", "ELITE", "Unassigned"]);
  const b = s[1];
  expect([b.total, b.appeared, b.absent, b.attendancePct, b.average, b.highest]).toEqual([1, 0, 1, 0, null, null]);
});

test("totals across groups add up to the whole roster", () => {
  for (const by of ["branch", "section"] as const) {
    const g = breakdown(rows, by);
    expect(g.reduce((a, x) => a + x.total, 0)).toBe(rows.length);
    expect(g.reduce((a, x) => a + x.absent, 0)).toBe(rows.filter((r) => r.absent).length);
  }
});
