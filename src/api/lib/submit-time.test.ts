import { expect, test } from "bun:test";
import { submitAvailableAtMs } from "./util";

const T0 = Date.UTC(2026, 10, 19, 14, 30);

test("Submit opens the minimum time after the student's own start", () => {
  expect(submitAvailableAtMs({ durationMin: 120 }, { startedAt: new Date(T0) }, 20, T0)).toBe(T0 + 20 * 60_000);
});

test("a late starter's minimum counts from their own start", () => {
  const late = T0 + 45 * 60_000;
  expect(submitAvailableAtMs({ durationMin: 120 }, { startedAt: late }, 20, late)).toBe(late + 20 * 60_000);
});

test("time paused for a network drop does not count as writing time", () => {
  expect(submitAvailableAtMs({ durationMin: 120 }, { startedAt: T0, pausedMs: 3 * 60_000 }, 20, T0)).toBe(T0 + 23 * 60_000);
});

test("capped at the exam length, so a short quiz is never unsubmittable", () => {
  expect(submitAvailableAtMs({ durationMin: 15 }, { startedAt: T0 }, 20, T0)).toBe(T0 + 15 * 60_000);
});

test("0 turns the minimum off", () => {
  expect(submitAvailableAtMs({ durationMin: 60 }, { startedAt: T0 }, 0, T0)).toBe(T0);
});
