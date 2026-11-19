/**
 * Slows down password guessing on student login.
 *
 * WHY: `/students/verify-login` had no limit at all, so a roll number's password
 * could be guessed as fast as the server could check hashes (~15 a second per
 * process). Roll numbers are predictable and many students keep `Welcome@123`.
 *
 * The limit is per ACCOUNT IDENTIFIER, never per IP address: an exam hall puts
 * hundreds of students behind one college IP, and a per-IP limit would lock the
 * whole hall out at the start bell. Only FAILED attempts count, and a success
 * clears the slate, so a student who mistypes twice and then logs in is never
 * affected. Per process and in memory: with two replicas an attacker gets twice
 * the budget, which is still a ~10,000x slowdown over no limit.
 */
export const MAX_FAILURES = Number(process.env.LOGIN_MAX_FAILURES) || 10;
export const WINDOW_MS = Number(process.env.LOGIN_FAILURE_WINDOW_MS) || 15 * 60_000;
const MAX_TRACKED = 50_000;

type Entry = { failures: number; firstAt: number };

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly maxFailures = MAX_FAILURES,
    private readonly windowMs = WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private key(identifier: string): string {
    return identifier.trim().toUpperCase();
  }

  /** Milliseconds until this identifier may try again, or 0 if it may try now. */
  retryAfterMs(identifier: string): number {
    const e = this.entries.get(this.key(identifier));
    if (!e) return 0;
    const age = this.now() - e.firstAt;
    if (age >= this.windowMs) {
      this.entries.delete(this.key(identifier));
      return 0;
    }
    return e.failures >= this.maxFailures ? this.windowMs - age : 0;
  }

  recordFailure(identifier: string): void {
    const k = this.key(identifier);
    const t = this.now();
    const e = this.entries.get(k);
    if (!e || t - e.firstAt >= this.windowMs) {
      if (this.entries.size >= MAX_TRACKED) this.prune(t);
      this.entries.set(k, { failures: 1, firstAt: t });
      return;
    }
    e.failures += 1;
  }

  recordSuccess(identifier: string): void {
    this.entries.delete(this.key(identifier));
  }

  /**
   * Forget every lock. Called when staff reset student passwords: the lock-out
   * message sends the student to the invigilator for exactly that, so a reset
   * must let them straight back in.
   */
  clear(): void {
    this.entries.clear();
  }

  private prune(t: number): void {
    for (const [k, e] of this.entries) if (t - e.firstAt >= this.windowMs) this.entries.delete(k);
    if (this.entries.size >= MAX_TRACKED) this.entries.clear();
  }
}

export const studentLoginThrottle = new LoginThrottle();
