/**
 * Server clock, as seen from this computer.
 *
 * Exam times (start, deadline, Submit unlock) are server times, but the exam
 * screen and the waiting room used to compare them with this PC's own clock. A
 * lab PC whose clock runs fast (a dead CMOS battery, a wrong time zone, never
 * synced) reached "time's up" early and auto-submitted: minutes early, or
 * seconds after starting when the clock was hours ahead, again after every
 * reopen. A slow clock unlocked Start late. Every server answer that carries
 * `serverNow` refreshes the offset; all exam-time maths uses serverNowMs().
 */
const KEY = "examly:clockOffsetMs";

let offsetMs = (() => {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
})();

/** Record the server's time from a response (ISO string or ms). Ignores junk. */
export function syncClock(serverNow: string | number | null | undefined): void {
  const t = serverNow == null ? NaN : new Date(serverNow).getTime();
  if (!Number.isFinite(t)) return;
  offsetMs = t - Date.now();
  try {
    localStorage.setItem(KEY, String(Math.round(offsetMs)));
  } catch {
    /* storage full or blocked: the in-memory offset still applies */
  }
}

/** Server time minus this PC's time, in ms. */
export function clockOffsetMs(): number {
  return offsetMs;
}

/** The server's current time, estimated from this PC. */
export function serverNowMs(): number {
  return Date.now() + offsetMs;
}
