/**
 * Student login throttle. The failure that matters most is a false lock-out of an
 * honest student at the exam bell, so pin: only failures count, success resets,
 * the limit is per account (case-insensitive), and it lifts after the window.
 */
import { describe, expect, test } from "bun:test";
import { LoginThrottle } from "./login-throttle";

describe("LoginThrottle", () => {
  test("locks only after the limit of failures, for that account only", () => {
    let t = 0;
    const th = new LoginThrottle(3, 60_000, () => t);
    for (let i = 0; i < 2; i++) th.recordFailure("23K91A0501");
    expect(th.retryAfterMs("23K91A0501")).toBe(0);
    th.recordFailure("23k91a0501 ");
    expect(th.retryAfterMs("23K91A0501")).toBe(60_000);
    expect(th.retryAfterMs("23K91A0502")).toBe(0);
  });

  test("lifts when the window passes", () => {
    let t = 0;
    const th = new LoginThrottle(2, 60_000, () => t);
    th.recordFailure("A"); th.recordFailure("A");
    t = 59_999; expect(th.retryAfterMs("A")).toBe(1);
    t = 60_000; expect(th.retryAfterMs("A")).toBe(0);
    th.recordFailure("A");
    expect(th.retryAfterMs("A")).toBe(0);
  });

  test("a successful login clears earlier mistakes", () => {
    let t = 0;
    const th = new LoginThrottle(2, 60_000, () => t);
    th.recordFailure("A");
    th.recordSuccess("a");
    th.recordFailure("A");
    expect(th.retryAfterMs("A")).toBe(0);
  });

  test("clear() lifts every lock (staff password reset)", () => {
    let t = 0;
    const th = new LoginThrottle(1, 60_000, () => t);
    th.recordFailure("A");
    expect(th.retryAfterMs("A")).toBeGreaterThan(0);
    th.clear();
    expect(th.retryAfterMs("A")).toBe(0);
  });
});
