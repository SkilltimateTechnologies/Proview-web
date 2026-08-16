import { describe, it, expect } from "bun:test";
import {
  OBSTRUCTION_LOCK_MS,
  startLock,
  isLocked,
  lockRemainingMs,
  nextLockState,
  formatLockClock,
} from "./obstruction-lock";

const T0 = 1_700_000_000_000;

describe("startLock", () => {
  it("runs for two minutes from now", () => {
    const l = startLock(T0, "covered");
    expect(l.until).toBe(T0 + 120_000);
    expect(OBSTRUCTION_LOCK_MS).toBe(120_000);
  });

  it("counts the first period", () => {
    expect(startLock(T0, "covered").periods).toBe(1);
  });

  it("keeps the reason for the reviewer", () => {
    expect(startLock(T0, "lens taped").reason).toBe("lens taped");
  });

  it("honours a custom duration (used by the tests and any future config)", () => {
    expect(startLock(T0, "x", 5_000).until).toBe(T0 + 5_000);
  });
});

describe("isLocked", () => {
  it("is locked for the whole period", () => {
    const l = startLock(T0, "covered");
    expect(isLocked(l, T0)).toBe(true);
    expect(isLocked(l, T0 + 1)).toBe(true);
    expect(isLocked(l, T0 + 119_999)).toBe(true);
  });

  it("is over exactly at the deadline, never a millisecond past it", () => {
    const l = startLock(T0, "covered");
    expect(isLocked(l, T0 + 120_000)).toBe(false);
    expect(isLocked(l, T0 + 120_001)).toBe(false);
  });

  it("a missing lock is not a lock", () => {
    expect(isLocked(null, T0)).toBe(false);
  });
});

describe("lockRemainingMs", () => {
  it("counts down through the period", () => {
    const l = startLock(T0, "covered");
    expect(lockRemainingMs(l, T0)).toBe(120_000);
    expect(lockRemainingMs(l, T0 + 30_000)).toBe(90_000);
  });

  it("never goes negative when a tick lands late", () => {
    const l = startLock(T0, "covered");
    expect(lockRemainingMs(l, T0 + 500_000)).toBe(0);
  });

  it("is zero with no lock", () => {
    expect(lockRemainingMs(null, T0)).toBe(0);
  });
});

describe("nextLockState — the candidate serves the full period", () => {
  it("UNCOVERING EARLY DOES NOT RELEASE — the lock is the penalty", () => {
    const l = startLock(T0, "covered");
    // Lens clear after 10 seconds; the exam must stay locked.
    const r = nextLockState(l, T0 + 10_000, false);
    expect(r.lock).toBe(l);
    expect(r.relocked).toBe(false);
    expect(isLocked(r.lock, T0 + 10_000)).toBe(true);
  });

  it("a stray tick one millisecond early cannot cut the lock short", () => {
    const l = startLock(T0, "covered");
    const r = nextLockState(l, T0 + 119_999, false);
    expect(r.lock).toBe(l);
    expect(isLocked(r.lock, T0 + 119_999)).toBe(true);
  });

  it("releases at expiry when the lens is clear", () => {
    const l = startLock(T0, "covered");
    const r = nextLockState(l, T0 + 120_000, false);
    expect(r.lock).toBeNull();
    expect(r.relocked).toBe(false);
  });

  it("serves another full period when still covered at expiry", () => {
    const l = startLock(T0, "covered");
    const r = nextLockState(l, T0 + 120_000, true);
    expect(r.relocked).toBe(true);
    expect(r.lock!.until).toBe(T0 + 240_000);
    expect(r.lock!.periods).toBe(2);
  });

  it("re-locks indefinitely while the lens stays covered", () => {
    let lock = startLock(T0, "covered");
    let now = T0;
    for (let i = 2; i <= 6; i++) {
      now = lock.until;
      const r = nextLockState(lock, now, true);
      expect(r.relocked).toBe(true);
      lock = r.lock!;
      expect(lock.periods).toBe(i);
    }
    // ...and still releases the moment it is finally clear at an expiry.
    const done = nextLockState(lock, lock.until, false);
    expect(done.lock).toBeNull();
  });

  it("extends from NOW, so a backgrounded tab cannot bank an elapsed period", () => {
    const l = startLock(T0, "covered");
    // Tab frozen; we only get the expiry tick five minutes late.
    const late = T0 + 420_000;
    const r = nextLockState(l, late, true);
    expect(r.lock!.until).toBe(late + 120_000);
  });

  it("carries the original reason into every extension", () => {
    const l = startLock(T0, "lens taped");
    const r = nextLockState(l, T0 + 120_000, true);
    expect(r.lock!.reason).toBe("lens taped");
  });

  it("does nothing without a lock", () => {
    const r = nextLockState(null, T0, true);
    expect(r.lock).toBeNull();
    expect(r.relocked).toBe(false);
  });

  it("reports a re-lock exactly once per extension, so events cannot double-count", () => {
    const l = startLock(T0, "covered");
    const first = nextLockState(l, T0 + 120_000, true);
    expect(first.relocked).toBe(true);
    // Same lock queried again mid-period: no second event.
    const again = nextLockState(first.lock, T0 + 130_000, true);
    expect(again.relocked).toBe(false);
  });
});

describe("formatLockClock", () => {
  it("renders M:SS", () => {
    expect(formatLockClock(120_000)).toBe("2:00");
    expect(formatLockClock(65_000)).toBe("1:05");
    expect(formatLockClock(9_000)).toBe("0:09");
  });

  it("rounds up so the countdown never shows 0:00 while still locked", () => {
    expect(formatLockClock(1)).toBe("0:01");
    expect(formatLockClock(999)).toBe("0:01");
  });

  it("shows 0:00 only at zero, and clamps negatives", () => {
    expect(formatLockClock(0)).toBe("0:00");
    expect(formatLockClock(-5_000)).toBe("0:00");
  });
});
