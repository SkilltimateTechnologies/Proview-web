import { describe, expect, it } from "bun:test";
import { closesAtMs, examEffStatus, isConcluded, isReportable, isStarted, toMs, type StatusExam } from "./exam-status";

const NOW = Date.UTC(2026, 7, 27, 18, 0, 0); // 2026-08-27T18:00:00Z
const MIN = 60_000;

/** An exam conducted this morning that nobody ever pressed "finish" on. */
const lapsed: StatusExam = {
  status: "scheduled",
  startAt: new Date(NOW - 4 * 60 * MIN),
  endAt: new Date(NOW - 2 * 60 * MIN),
  extraMin: 5,
  holdMs: 0,
  heldAt: null,
};

describe("toMs", () => {
  it("accepts Date, epoch ms and ISO string alike", () => {
    expect(toMs(new Date(NOW))).toBe(NOW);
    expect(toMs(NOW)).toBe(NOW);
    expect(toMs("2026-08-27T18:00:00.000Z")).toBe(NOW);
  });

  it("returns null for null, undefined and ungarbled garbage", () => {
    expect(toMs(null)).toBeNull();
    expect(toMs(undefined)).toBeNull();
    expect(toMs("not a date")).toBeNull();
  });
});

describe("isStarted", () => {
  it("is true at and after the start instant", () => {
    expect(isStarted({ startAt: new Date(NOW) }, NOW)).toBe(true);
    expect(isStarted({ startAt: new Date(NOW - MIN) }, NOW)).toBe(true);
  });

  it("is false before the start and for an unscheduled exam", () => {
    expect(isStarted({ startAt: new Date(NOW + MIN) }, NOW)).toBe(false);
    expect(isStarted({ startAt: null }, NOW)).toBe(false);
  });
});

describe("closesAtMs", () => {
  it("adds admin extra time and accumulated hold to endAt", () => {
    expect(closesAtMs({ ...lapsed, extraMin: 5, holdMs: 30_000 })).toBe(NOW - 2 * 60 * MIN + 5 * MIN + 30_000);
  });

  it("is null when the exam has no end", () => {
    expect(closesAtMs({ ...lapsed, endAt: null })).toBeNull();
  });
});

describe("examEffStatus", () => {
  it("returns draft and finished untouched — they are terminal admin states", () => {
    expect(examEffStatus({ ...lapsed, status: "draft" }, NOW)).toBe("draft");
    expect(examEffStatus({ ...lapsed, status: "finished" }, NOW)).toBe("finished");
  });

  it("reports a lapsed scheduled exam as ended, not scheduled — the bug this fixes", () => {
    expect(lapsed.status).toBe("scheduled");
    expect(examEffStatus(lapsed, NOW)).toBe("ended");
  });

  it("reports a started, still-open exam as live even when the column says scheduled", () => {
    const running: StatusExam = { ...lapsed, startAt: new Date(NOW - 10 * MIN), endAt: new Date(NOW + 50 * MIN) };
    expect(examEffStatus(running, NOW)).toBe("live");
  });

  it("keeps a future exam scheduled", () => {
    const future: StatusExam = { ...lapsed, startAt: new Date(NOW + 60 * MIN), endAt: new Date(NOW + 120 * MIN) };
    expect(examEffStatus(future, NOW)).toBe("scheduled");
  });

  it("does not end an exam while it is still inside its extra time", () => {
    const justOver: StatusExam = { ...lapsed, endAt: new Date(NOW - 2 * MIN), extraMin: 5 };
    expect(examEffStatus(justOver, NOW)).toBe("live");
  });

  it("never auto-ends a held exam — the admin must resume or finish it", () => {
    expect(examEffStatus({ ...lapsed, heldAt: new Date(NOW - 30 * MIN) }, NOW)).toBe("live");
  });

  it("leaves an open-ended live exam live", () => {
    expect(examEffStatus({ ...lapsed, status: "live", endAt: null }, NOW)).toBe("live");
  });
});

describe("isConcluded — the TPO report gate", () => {
  it("admits a lapsed exam that was never formally finished", () => {
    expect(isConcluded(lapsed, NOW)).toBe(true);
  });

  it("admits a formally finished exam", () => {
    expect(isConcluded({ ...lapsed, status: "finished" }, NOW)).toBe(true);
  });

  it("rejects live, future and draft exams", () => {
    expect(isConcluded({ ...lapsed, endAt: new Date(NOW + 50 * MIN) }, NOW)).toBe(false);
    expect(isConcluded({ ...lapsed, startAt: new Date(NOW + 60 * MIN), endAt: new Date(NOW + 120 * MIN) }, NOW)).toBe(false);
    expect(isConcluded({ ...lapsed, status: "draft" }, NOW)).toBe(false);
  });
});

describe("isReportable — the Reports list filter", () => {
  it("includes concluded and live exams", () => {
    expect(isReportable(lapsed, NOW)).toBe(true);
    expect(isReportable({ ...lapsed, status: "finished" }, NOW)).toBe(true);
    expect(isReportable({ ...lapsed, endAt: new Date(NOW + 50 * MIN) }, NOW)).toBe(true);
  });

  it("excludes drafts and exams scheduled in the future — they have no results yet", () => {
    expect(isReportable({ ...lapsed, status: "draft" }, NOW)).toBe(false);
    expect(isReportable({ ...lapsed, startAt: new Date(NOW + 60 * MIN), endAt: new Date(NOW + 120 * MIN) }, NOW)).toBe(false);
  });
});
