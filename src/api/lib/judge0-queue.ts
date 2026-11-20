// =============================================================================
// Judge0 run-code queue — server-side throttle + batch + poll + backoff.
//
// Every student "Run code" request enqueues here instead of hitting RapidAPI
// directly. A single global queue smooths bursts (e.g. 50 clicks/sec) into a
// steady stream that stays under RapidAPI's per-second limits, groups runs into
// batches of <=20 to cut HTTP calls + cost, polls each batch together, and
// retries transient failures with exponential backoff. Students see a normal
// synchronous result — they just wait in line (bounded by MAX_WAIT_MS).
//
// Tunables: 50 submissions/s throttle, 6 batches in flight concurrently, 45s
// max wait, 300ms batch window. All overridable via JUDGE0_* env vars.
// =============================================================================

export type Judge0Result = {
  ok: boolean;
  stdout: string;
  stderr: string;
  compileOutput: string;
  status: string;
  time: string | null;
  memory: number | null;
  message?: string;
  httpStatus?: number; // for the route to pick a sensible response code
};

export type Judge0Job = {
  source: string;
  languageId: number;
  stdin: string;
  /** Optional Judge0 limits (seconds / KB). Omitted = the runner's defaults. */
  cpuTimeLimit?: number;
  wallTimeLimit?: number;
  memoryLimitKb?: number;
  /**
   * "background" (test-case grading after an exam) only uses spare capacity: it
   * is dispatched when no student run is waiting, with at most
   * MAX_BG_INFLIGHT_BATCHES in flight, so grading one college's exam never slows
   * "Run code" for students writing another exam. Default: interactive.
   */
  priority?: "interactive" | "background";
};

type Waiter = {
  job: Judge0Job;
  enqueuedAt: number;
  resolve: (r: Judge0Result) => void;
};

// ---- Config -----------------------------------------------------------------
const THROTTLE_RPS = Number(process.env.JUDGE0_THROTTLE_RPS || 50); // outbound submissions/sec
const MAX_WAIT_MS = Number(process.env.JUDGE0_MAX_WAIT_MS || 45_000); // per-job give-up
const BATCH_WINDOW_MS = Number(process.env.JUDGE0_BATCH_WINDOW_MS || 300); // collect window
const BATCH_SIZE = Math.min(Number(process.env.JUDGE0_BATCH_SIZE || 20), 20); // RapidAPI cap = 20
// How many batches may be submitted + polling AT THE SAME TIME. The old queue
// processed one batch to completion before starting the next, so throughput
// collapsed to ~BATCH_SIZE / poll-latency (a few runs/sec) under exam load.
// Running batches concurrently (still bounded by the token bucket for outbound
// rate) lets the queue actually drain a burst.
const MAX_INFLIGHT_BATCHES = Math.max(1, Number(process.env.JUDGE0_MAX_INFLIGHT || 6));
const POLL_INTERVAL_MS = 700;
const POLL_MAX_TRIES = 25;
const MAX_RETRIES = 4; // backoff attempts on 429 / 5xx
// Every call to Judge0 gets its own timeout, and a Retry-After is never honoured
// beyond a few seconds. On 19 Nov 2026 the RapidAPI key ran out of quota during a
// live exam; its 429s and a call that never answered held batches open, the queue
// stopped dispatching, and every "Run code" hung until the edge cut it with a bare
// 502. Nothing in here may wait without a bound.
const FETCH_TIMEOUT_MS = Number(process.env.JUDGE0_FETCH_TIMEOUT_MS || 15_000);
const MAX_RETRY_AFTER_MS = 5_000;
// A student's request always gets an answer within this, whatever Judge0 does.
// Below Cloudflare's 100 s origin timeout.
const HARD_DEADLINE_MS = Number(process.env.JUDGE0_HARD_DEADLINE_MS || 75_000);
const MAX_BG_INFLIGHT_BATCHES = Math.max(1, Number(process.env.JUDGE0_MAX_BG_INFLIGHT || 2));
// Background jobs wait behind students; they give up much later than a student run.
const BG_MAX_WAIT_MS = Number(process.env.JUDGE0_BG_MAX_WAIT_MS || 15 * 60_000);

// ---- base64 helpers ---------------------------------------------------------
const enc = (s: string) => Buffer.from(s, "utf8").toString("base64");
const dec = (s: string | null | undefined) => (s ? Buffer.from(s, "base64").toString("utf8") : "");

type J0Sub = {
  stdout?: string | null; stderr?: string | null; compile_output?: string | null; message?: string | null;
  status?: { id?: number; description?: string }; time?: string | null; memory?: number | null; token?: string;
};

export type Judge0Config = {
  baseUrl: string;
  headers: Record<string, string>;
  isRapidApi: boolean;
};

/** Resolve endpoint + auth headers from settings/env. Returns null if unconfigured. */
export function resolveJudge0Config(key: string | null): Judge0Config | null {
  const baseUrl = (process.env.JUDGE0_URL || "https://judge0-ce.p.rapidapi.com").replace(/\/+$/, "");
  const rapidHost = baseUrl.match(/^https?:\/\/([^/]+)/i)?.[1] || "judge0-ce.p.rapidapi.com";
  const isRapidApi = /rapidapi\.com/i.test(baseUrl);
  if (isRapidApi && !key) return null;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (isRapidApi) {
    headers["X-RapidAPI-Key"] = key!;
    headers["X-RapidAPI-Host"] = rapidHost;
  } else if (key) {
    headers["X-Auth-Token"] = key;
  }
  return { baseUrl, headers, isRapidApi };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A 429 that waiting will not fix: the plan's daily/monthly quota is used up. */
export function isQuotaExhausted(status: number, body: string): boolean {
  return status === 429 && /quota|upgrade your plan/i.test(body);
}

/** What a student is told when Judge0 refuses the call outright. */
export function runnerRefusalMessage(status: number, body: string): string {
  if (isQuotaExhausted(status, body)) return "The code runner's usage limit has been reached. Please tell your invigilator. Your code is saved and will still be graded.";
  if (status === 401 || status === 403) return "The code runner is not set up correctly (key rejected). Please tell your invigilator. Your code is saved and will still be graded.";
  if (status === 429) return "The code runner is busy. Wait a few seconds and press Run again.";
  return `Runner error (${status}). Try again in a moment.`;
}

/**
 * fetch with a per-call timeout and exponential backoff on 429 / 5xx. Retry-After
 * is honoured only up to MAX_RETRY_AFTER_MS, and a quota-exhausted 429 is
 * returned at once: retrying it cannot succeed.
 */
async function fetchWithBackoff(url: string, init: RequestInit, fetchTimeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // An ordinary timer, always cleared, rather than AbortSignal.timeout(): that
      // one's timer does not keep the process awake, and on Railway's build
      // machine it never fired, so a hung call was never aborted.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), fetchTimeoutMs);
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: ctl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt === MAX_RETRIES) return res;
        if (res.status === 429 && isQuotaExhausted(429, await res.clone().text().catch(() => ""))) return res;
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
          : Math.min(8000, 400 * 2 ** attempt) + Math.random() * 200; // jitter
        await sleep(wait);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt === MAX_RETRIES) throw e;
      await sleep(Math.min(8000, 400 * 2 ** attempt) + Math.random() * 200);
    }
  }
  throw lastErr ?? new Error("judge0 fetch failed");
}

// =============================================================================
// The singleton queue
// =============================================================================
/**
 * Timing limits of one queue. The shared queue uses the JUDGE0_* environment
 * values read at start-up; a test builds its own queue with short limits, because
 * every test file shares one process and the shared queue may already be loaded.
 */
export type Judge0QueueLimits = {
  maxWaitMs: number;
  batchWindowMs: number;
  fetchTimeoutMs: number;
  hardDeadlineMs: number;
  bgMaxWaitMs: number;
};

export const DEFAULT_LIMITS: Judge0QueueLimits = {
  maxWaitMs: MAX_WAIT_MS,
  batchWindowMs: BATCH_WINDOW_MS,
  fetchTimeoutMs: FETCH_TIMEOUT_MS,
  hardDeadlineMs: HARD_DEADLINE_MS,
  bgMaxWaitMs: BG_MAX_WAIT_MS,
};

export class Judge0Queue {
  private readonly lim: Judge0QueueLimits;
  constructor(limits: Partial<Judge0QueueLimits> = {}) {
    this.lim = { ...DEFAULT_LIMITS, ...limits };
  }

  private waiters: Waiter[] = [];
  private bgWaiters: Waiter[] = [];
  private draining = false;
  private inFlight = 0; // batches currently submitting/polling
  private bgInFlight = 0; // of which background batches
  private tokens = THROTTLE_RPS; // token bucket
  private lastRefill = Date.now();

  /** Enqueue one run and resolve when Judge0 returns (or on timeout). */
  run(job: Judge0Job, cfgProvider: () => Judge0Config | null): Promise<Judge0Result> {
    return new Promise<Judge0Result>((outerResolve) => {
      // Resolve exactly once: by Judge0, by the queue's own give-up, or by the
      // hard deadline below, whichever comes first.
      let done = false;
      const deadlineMs = job.priority === "background" ? this.lim.bgMaxWaitMs + this.lim.hardDeadlineMs : this.lim.hardDeadlineMs;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        outerResolve({ ok: false, stdout: "", stderr: "", compileOutput: "", status: "Error", time: null, memory: null, message: "Code execution timed out. Press Run again in a moment.", httpStatus: 503 });
      }, deadlineMs);
      // Not unref()'d: an unreferenced timer may never fire (it did not on
      // Railway's build machine). It is cleared as soon as the run is answered,
      // so it never keeps the process alive longer than the run itself.
      const resolve = (r: Judge0Result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        outerResolve(r);
      };
      const waiter: Waiter = { job, enqueuedAt: Date.now(), resolve };
      (job.priority === "background" ? this.bgWaiters : this.waiters).push(waiter);
      this.drain(cfgProvider);
    });
  }

  private refillTokens() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(THROTTLE_RPS, this.tokens + elapsed * THROTTLE_RPS);
    this.lastRefill = now;
  }

  /** Wait until the bucket has at least `n` tokens, then consume them. */
  private async takeTokens(n: number) {
    // n is <= THROTTLE_RPS by construction (batch <= 20, rps configurable).
    const need = Math.min(n, THROTTLE_RPS);
    for (;;) {
      this.refillTokens();
      if (this.tokens >= need) { this.tokens -= need; return; }
      const deficit = need - this.tokens;
      await sleep(Math.ceil((deficit / THROTTLE_RPS) * 1000));
    }
  }

  // Failures are 503, never 502/504: Cloudflare in front of the site can swap an
  // origin 502/504 for its own page, and the student then sees a bare
  // "Request failed (502)" instead of the message.
  private failWaiter(w: Waiter, message: string, httpStatus = 503) {
    w.resolve({ ok: false, stdout: "", stderr: "", compileOutput: "", status: "Error", time: null, memory: null, message, httpStatus });
  }

  private drain(cfgProvider: () => Judge0Config | null) {
    if (this.draining) return;
    this.draining = true;
    void this.dispatchLoop(cfgProvider).finally(() => {
      this.draining = false;
      // a late arrival (or a freed in-flight slot) may need another pass. Background
      // work only re-wakes the dispatcher when it could actually start a batch;
      // otherwise the batch that frees a slot re-wakes it (no busy loop).
      if (this.waiters.length > 0 || this.canStartBackground()) this.drain(cfgProvider);
    });
  }

  /**
   * Dispatch batches CONCURRENTLY (up to MAX_INFLIGHT_BATCHES in flight at once).
   * Each batch's outbound submission rate is still smoothed by the token bucket,
   * but polling a slow batch no longer blocks the next batch from starting — so a
   * burst of clicks actually drains instead of piling up until MAX_WAIT_MS.
   */
  private async dispatchLoop(cfgProvider: () => Judge0Config | null) {
    while (this.waiters.length > 0 || this.bgWaiters.length > 0) {
      // Give up on students who have waited too long BEFORE waiting for a slot:
      // with every slot held by a slow batch this loop only sleeps, and the old
      // order meant nobody was ever released.
      this.dropExpiredWaiters();
      if (this.waiters.length === 0 && this.bgWaiters.length === 0) break;
      // hold off until an in-flight slot frees up (background work just waits for
      // a finishing batch to re-wake the dispatcher)
      if (this.inFlight >= MAX_INFLIGHT_BATCHES) {
        if (this.waiters.length === 0) break;
        await sleep(20);
        continue;
      }

      // No student is waiting: let background work use spare capacity.
      if (this.waiters.length === 0) {
        if (this.dispatchBackground(cfgProvider)) continue;
        // Background slots full: the freed slot re-wakes the dispatcher.
        break;
      }

      // small collect window so bursts group into a full batch
      if (this.waiters.length < BATCH_SIZE) await sleep(this.lim.batchWindowMs);

      // drop anyone who already waited too long
      this.dropExpiredWaiters();
      if (this.waiters.length === 0) break;

      const cfg = cfgProvider();
      const batch = this.waiters.splice(0, BATCH_SIZE);
      if (!cfg) {
        for (const w of batch) this.failWaiter(w, "Code execution is not configured. Contact your administrator.", 503);
        continue;
      }

      // fire the batch without awaiting; a freed slot re-wakes the dispatcher
      this.inFlight++;
      void this.processBatch(batch, cfg).finally(() => {
        this.inFlight--;
        this.drain(cfgProvider);
      });
    }
  }

  private dropExpiredWaiters() {
    const now = Date.now();
    this.waiters = this.waiters.filter((w) => {
      if (now - w.enqueuedAt >= this.lim.maxWaitMs) {
        this.failWaiter(w, "Server is busy — please press Run again in a moment.", 503);
        return false;
      }
      return true;
    });
  }

  private canStartBackground(): boolean {
    return this.bgWaiters.length > 0 && this.bgInFlight < MAX_BG_INFLIGHT_BATCHES && this.inFlight < MAX_INFLIGHT_BATCHES;
  }

  /** Start one background batch if a background slot is free. Returns whether one was started. */
  private dispatchBackground(cfgProvider: () => Judge0Config | null): boolean {
    const now = Date.now();
    this.bgWaiters = this.bgWaiters.filter((w) => {
      if (now - w.enqueuedAt >= this.lim.bgMaxWaitMs) {
        this.failWaiter(w, "Code runner busy; grading will retry.", 503);
        return false;
      }
      return true;
    });
    if (this.bgWaiters.length === 0 || this.bgInFlight >= MAX_BG_INFLIGHT_BATCHES) return false;
    const cfg = cfgProvider();
    const batch = this.bgWaiters.splice(0, BATCH_SIZE);
    if (!cfg) {
      for (const w of batch) this.failWaiter(w, "Code execution is not configured.", 503);
      return true;
    }
    this.inFlight++;
    this.bgInFlight++;
    void this.processBatch(batch, cfg).finally(() => {
      this.inFlight--;
      this.bgInFlight--;
      this.drain(cfgProvider);
    });
    return true;
  }

  private async processBatch(batch: Waiter[], cfg: Judge0Config) {
    // 1 token per submission in the batch (the batch POST executes N runs).
    await this.takeTokens(batch.length);

    try {
      const submissions = batch.map((w) => ({
        source_code: enc(w.job.source),
        language_id: w.job.languageId,
        stdin: enc(w.job.stdin),
        ...(w.job.cpuTimeLimit ? { cpu_time_limit: w.job.cpuTimeLimit } : {}),
        ...(w.job.wallTimeLimit ? { wall_time_limit: w.job.wallTimeLimit } : {}),
        ...(w.job.memoryLimitKb ? { memory_limit: w.job.memoryLimitKb } : {}),
      }));

      const createRes = await fetchWithBackoff(
        `${cfg.baseUrl}/submissions/batch?base64_encoded=true`,
        { method: "POST", headers: cfg.headers, body: JSON.stringify({ submissions }) },
        this.lim.fetchTimeoutMs,
      );

      if (!createRes.ok) {
        const t = await createRes.text().catch(() => "");
        const refused = isQuotaExhausted(createRes.status, t) || createRes.status === 401 || createRes.status === 403;
        if (refused) console.error(`[judge0] refused ${createRes.status}: ${t.slice(0, 200)}`);
        for (const w of batch) this.failWaiter(w, runnerRefusalMessage(createRes.status, t), 503);
        return;
      }

      const created = (await createRes.json().catch(() => [])) as Array<{ token?: string }>;
      const tokens = batch.map((_, i) => created[i]?.token ?? null);

      // poll the whole batch together
      const results = await this.pollBatch(tokens, cfg);

      results.forEach((sub, i) => {
        const w = batch[i];
        if (!w) return;
        if (!sub) {
          this.failWaiter(w, "Code execution timed out. Try again.", 503);
          return;
        }
        w.resolve({
          ok: true,
          stdout: dec(sub.stdout),
          stderr: dec(sub.stderr),
          compileOutput: dec(sub.compile_output),
          status: sub.status?.description ?? "Done",
          time: sub.time ?? null,
          memory: sub.memory ?? null,
        });
      });
    } catch {
      console.error("[judge0] call failed or timed out");
      for (const w of batch) this.failWaiter(w, "Couldn't reach the code runner. Press Run again in a moment.", 503);
    }
  }

  /** Poll batch tokens until all are finished (status.id > 2) or tries run out. */
  private async pollBatch(tokens: Array<string | null>, cfg: Judge0Config): Promise<Array<J0Sub | null>> {
    const valid = tokens.filter((t): t is string => !!t);
    if (valid.length === 0) return tokens.map(() => null);

    const byToken = new Map<string, J0Sub>();
    for (let i = 0; i < POLL_MAX_TRIES; i++) {
      await sleep(POLL_INTERVAL_MS);
      const pending = valid.filter((t) => !byToken.has(t));
      if (pending.length === 0) break;

      const url = `${cfg.baseUrl}/submissions/batch?tokens=${pending.join(",")}&base64_encoded=true&fields=stdout,stderr,compile_output,status,time,memory,token`;
      const res = await fetchWithBackoff(url, { headers: cfg.headers }, this.lim.fetchTimeoutMs);
      if (!res.ok) continue;
      const body = (await res.json().catch(() => ({}))) as { submissions?: J0Sub[] };
      for (const sub of body.submissions ?? []) {
        if (sub?.token && (sub.status?.id ?? 0) > 2) byToken.set(sub.token, sub);
      }
    }

    return tokens.map((t) => (t ? byToken.get(t) ?? null : null));
  }

  /** For observability / admin health. */
  stats() {
    return { queued: this.waiters.length, queuedBackground: this.bgWaiters.length, inFlight: this.inFlight, inFlightBackground: this.bgInFlight, draining: this.draining, tokens: Math.floor(this.tokens) };
  }
}

export const judge0Queue = new Judge0Queue();
