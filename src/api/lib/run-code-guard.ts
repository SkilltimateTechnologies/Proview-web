/**
 * Limits on the student "Run code" button (POST /student/run-code).
 *
 * Every run is a paid Judge0 execution from one shared quota. The route used to
 * accept any signed-in student at any time, with code and input of any size and
 * no cap on how often, so one student (or a script with a student's token) could
 * use up the quota and break "Run code" for every exam in progress.
 *
 * Now: the student must have an exam in progress, code and input are capped, one
 * run at a time per student, and at most RUNS_PER_WINDOW runs per window. Limits
 * live in this process (one Railway service), like the login throttle.
 */
export const MAX_SOURCE_CHARS = Number(process.env.RUN_CODE_MAX_SOURCE_CHARS) || 64_000;
export const MAX_STDIN_CHARS = Number(process.env.RUN_CODE_MAX_STDIN_CHARS) || 64_000;
export const RUNS_PER_WINDOW = Number(process.env.RUN_CODE_RUNS_PER_WINDOW) || 30;
export const WINDOW_MS = Number(process.env.RUN_CODE_WINDOW_MS) || 5 * 60_000;

export type RunDecision = { ok: true } | { ok: false; status: 400 | 413 | 429; message: string };

export function checkRunSize(source: string, stdin: string): RunDecision {
  if (source.length > MAX_SOURCE_CHARS) return { ok: false, status: 413, message: `Your code is too long to run (limit ${Math.round(MAX_SOURCE_CHARS / 1000)}k characters).` };
  if (stdin.length > MAX_STDIN_CHARS) return { ok: false, status: 413, message: `The custom input is too long (limit ${Math.round(MAX_STDIN_CHARS / 1000)}k characters).` };
  return { ok: true };
}

export class RunLimiter {
  private readonly running = new Set<string>();
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly perWindow = RUNS_PER_WINDOW,
    private readonly windowMs = WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reserve a run for this student, or say why not. Call `finish` when the run ends. */
  start(studentId: string): RunDecision {
    if (this.running.has(studentId)) {
      return { ok: false, status: 429, message: "Your previous run is still going. Wait for its result, then run again." };
    }
    const t = this.now();
    const times = (this.recent.get(studentId) ?? []).filter((x) => t - x < this.windowMs);
    if (times.length >= this.perWindow) {
      const waitSec = Math.max(1, Math.ceil((times[0] + this.windowMs - t) / 1000));
      this.recent.set(studentId, times);
      return { ok: false, status: 429, message: `You have run your code ${this.perWindow} times in the last few minutes. Try again in ${waitSec} s.` };
    }
    times.push(t);
    this.recent.set(studentId, times);
    this.running.add(studentId);
    if (this.recent.size > 20_000) this.prune(t);
    return { ok: true };
  }

  finish(studentId: string): void {
    this.running.delete(studentId);
  }

  private prune(t: number): void {
    for (const [k, v] of this.recent) {
      if (!v.length || t - v[v.length - 1] >= this.windowMs) this.recent.delete(k);
    }
  }
}

export const runLimiter = new RunLimiter();
