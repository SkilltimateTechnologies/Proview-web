/**
 * The 2-minute lock served when a candidate's camera is COVERED.
 *
 * Distinct from a denied permission (see camera-failure.ts). Here the camera is
 * running perfectly and still delivering frames — something is physically over
 * the lens, so the candidate is simply not visible. No track-level signal can
 * see that; it is caught by measuring the picture (see analyzeFrame).
 *
 * THE RULES, and why each one is the way it is:
 *
 *  * A lock runs for a STRICT two minutes. There is no dismiss button. The old
 *    behaviour let a candidate wait 60s and click "my room is just dim" to walk
 *    straight past the check, which made the whole detector optional.
 *
 *  * Uncovering the lens early does NOT end the lock. The lock IS the penalty,
 *    so covering the camera can never be cheaper than leaving it alone. If
 *    early release were allowed, the optimal cheat would be: cover, do the
 *    thing, uncover, resume immediately.
 *
 *  * Still covered when the two minutes expire? Another two minutes. Repeat for
 *    as long as the lens stays covered.
 *
 *  * Because it is a pure timer, a candidate in a genuinely unlit room always
 *    gets back into the exam — they lose two minutes, they are not locked out
 *    of their paper. That is the deliberate trade: this detector CANNOT tell a
 *    taped lens from a dark room (both are flat, dark frames), so the failure
 *    mode has to be survivable for the honest student. The exam timer keeps
 *    running throughout, which is what makes the penalty real.
 *
 * Kept DOM-free so the state machine is unit-testable without a browser; the
 * component owns the timers and the overlay.
 */

/** How long one lock period lasts. */
export const OBSTRUCTION_LOCK_MS = 120_000;

export type ObstructionLock = {
  /** Absolute wall-clock ms when the CURRENT period ends. */
  until: number;
  /** How many periods have been served, including the one running now. */
  periods: number;
  /** Why the first period was triggered — shown to the reviewer, not the student. */
  reason: string;
};

/** Begin the first lock period for a fresh obstruction. */
export function startLock(now: number, reason: string, lockMs: number = OBSTRUCTION_LOCK_MS): ObstructionLock {
  return { until: now + lockMs, periods: 1, reason };
}

/** Is this lock still running at `now`?
 *
 *  A null lock is not locked. Expiry is exclusive: at exactly `until` the period
 *  is over, so a lock can never survive its own deadline by a millisecond and
 *  strand the candidate. */
export function isLocked(lock: ObstructionLock | null, now: number): boolean {
  if (!lock) return false;
  return now < lock.until;
}

/** Milliseconds left in the current period — never negative, so the countdown
 *  cannot render as "-0:03" if a timer tick lands late (a backgrounded tab, a
 *  slow machine under exam load). */
export function lockRemainingMs(lock: ObstructionLock | null, now: number): number {
  if (!lock) return 0;
  return Math.max(0, lock.until - now);
}

/**
 * Decide what happens the moment a period expires.
 *
 * Called ONLY at/after expiry. `stillCovered` must be the freshest verdict
 * available: it decides between releasing the candidate and serving another
 * period, and getting it wrong in either direction is a real harm — a false
 * `true` keeps an honest candidate locked, a false `false` hands a cheater a
 * clear exam with the lens still taped.
 *
 * Returns the lock to hold next (null = release) and whether a new period was
 * started, so the caller can record exactly one re-lock event per extension.
 */
export function nextLockState(
  lock: ObstructionLock | null,
  now: number,
  stillCovered: boolean,
  lockMs: number = OBSTRUCTION_LOCK_MS,
): { lock: ObstructionLock | null; relocked: boolean } {
  // Nothing to decide.
  if (!lock) return { lock: null, relocked: false };
  // Called early — the period has not run out, so nothing changes. Guarding here
  // rather than trusting the caller means a stray tick can never cut a lock
  // short, which is the one bug that would quietly restore the old escape hatch.
  if (now < lock.until) return { lock, relocked: false };
  if (!stillCovered) return { lock: null, relocked: false };
  // Extend from NOW, not from `until`: if the tab was backgrounded and we come
  // back five minutes late, the candidate owes two minutes from this moment, not
  // a period that silently already elapsed.
  return { lock: { until: now + lockMs, periods: lock.periods + 1, reason: lock.reason }, relocked: true };
}

/** Human countdown for the overlay: M:SS. */
export function formatLockClock(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
