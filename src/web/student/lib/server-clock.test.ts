import { beforeEach, expect, test } from "bun:test";

// localStorage stand-in for the test runner
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };

const clock = await import("./server-clock");

beforeEach(() => clock.syncClock(Date.now()));

test("a PC clock 82 minutes fast is corrected", () => {
  const serverNow = Date.now() - 82 * 60_000; // the PC thinks it is 82 min later than the server
  clock.syncClock(new Date(serverNow).toISOString());
  expect(Math.abs(clock.serverNowMs() - serverNow)).toBeLessThan(50);
  expect(Math.round(clock.clockOffsetMs() / 60_000)).toBe(-82);
});

test("a slow PC clock is corrected", () => {
  const serverNow = Date.now() + 15 * 60_000;
  clock.syncClock(serverNow);
  expect(Math.abs(clock.serverNowMs() - serverNow)).toBeLessThan(50);
});

test("junk is ignored, keeping the last good offset", () => {
  clock.syncClock(Date.now() + 60_000);
  const before = clock.clockOffsetMs();
  clock.syncClock(null);
  clock.syncClock("not a date");
  expect(clock.clockOffsetMs()).toBe(before);
});

test("the offset survives a page reload (saved in localStorage)", () => {
  clock.syncClock(Date.now() + 5 * 60_000);
  expect(Number(store.get("examly:clockOffsetMs"))).toBeGreaterThan(4 * 60_000);
});
