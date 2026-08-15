/**
 * Tests for the monitor latency watchdog.
 *
 * These assert the ESCALATION LOGIC, which is the part that has to be right: a
 * single slow build must not cry wolf, a sustained run of them must raise the
 * flag, and one healthy build must clear it. The DB-touching parts of watchdog.ts
 * are exercised against a real database by scripts/verify-invariants.ts instead.
 */
import { test, expect, describe } from "bun:test";
import { recordMonitorBuild, monitorTiming, MONITOR_BUDGET_MS, MONITOR_POLL_MS } from "./watchdog";

const fast = () => recordMonitorBuild(10, 100);
const slow = () => recordMonitorBuild(MONITOR_BUDGET_MS + 500, 1200);
/** Return to a known-good state; the module holds process-wide counters. */
const reset = () => fast();

describe("monitor budget", () => {
  test("the budget leaves headroom inside the client poll interval", () => {
    // If the budget ever reached the poll interval, the warning would only fire
    // once polls were ALREADY stacking — i.e. once the freeze had started.
    expect(MONITOR_BUDGET_MS).toBeLessThan(MONITOR_POLL_MS);
  });
});

describe("recordMonitorBuild", () => {
  test("a fast build is healthy and not degraded", () => {
    fast();
    const t = monitorTiming();
    expect(t.lastBuildMs).toBe(10);
    expect(t.streak).toBe(0);
    expect(t.degraded).toBe(false);
  });

  test("one slow build warns but does NOT declare the monitor degraded", () => {
    reset();
    slow();
    const t = monitorTiming();
    expect(t.streak).toBe(1);
    expect(t.degraded).toBe(false); // a single spike is not a trend
  });

  test("three consecutive slow builds declare it degraded", () => {
    reset();
    slow();
    slow();
    slow();
    expect(monitorTiming().degraded).toBe(true);
  });

  test("a single healthy build clears the degraded flag", () => {
    reset();
    slow();
    slow();
    slow();
    expect(monitorTiming().degraded).toBe(true);
    fast();
    const t = monitorTiming();
    expect(t.degraded).toBe(false);
    expect(t.streak).toBe(0);
  });

  test("worst build is retained after recovery, so the spike is not forgotten", () => {
    reset();
    recordMonitorBuild(9999, 1200);
    fast();
    expect(monitorTiming().worstBuildMs).toBe(9999);
  });

  test("counters accumulate builds and over-budget builds separately", () => {
    const before = monitorTiming();
    fast();
    slow();
    fast();
    const after = monitorTiming();
    expect(after.builds).toBe(before.builds + 3);
    expect(after.overBudget).toBe(before.overBudget + 1);
  });

  test("an over-budget build records when it happened", () => {
    reset();
    slow();
    expect(monitorTiming().lastSlowAt).not.toBeNull();
  });

  test("monitorTiming returns a copy, so callers cannot corrupt the counters", () => {
    fast();
    const t = monitorTiming();
    t.degraded = true;
    t.builds = -1;
    expect(monitorTiming().degraded).toBe(false);
    expect(monitorTiming().builds).toBeGreaterThan(0);
  });

  test("never throws on nonsense input — a watchdog must not break the request path", () => {
    expect(() => recordMonitorBuild(Number.NaN, 0)).not.toThrow();
    expect(() => recordMonitorBuild(-1, -1)).not.toThrow();
    expect(() => recordMonitorBuild(Infinity, 0)).not.toThrow();
    reset();
  });
});
