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

/** fetch with exponential backoff on 429 / 5xx (respects Retry-After). */
async function fetchWithBackoff(url: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        if (attempt === MAX_RETRIES) return res;
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
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
class Judge0Queue {
  private waiters: Waiter[] = [];
  private draining = false;
  private inFlight = 0; // batches currently submitting/polling
  private tokens = THROTTLE_RPS; // token bucket
  private lastRefill = Date.now();

  /** Enqueue one run and resolve when Judge0 returns (or on timeout). */
  run(job: Judge0Job, cfgProvider: () => Judge0Config | null): Promise<Judge0Result> {
    return new Promise<Judge0Result>((resolve) => {
      const waiter: Waiter = { job, enqueuedAt: Date.now(), resolve };
      this.waiters.push(waiter);
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

  private timedOut(w: Waiter) {
    return Date.now() - w.enqueuedAt >= MAX_WAIT_MS;
  }

  private failWaiter(w: Waiter, message: string, httpStatus = 502) {
    w.resolve({ ok: false, stdout: "", stderr: "", compileOutput: "", status: "Error", time: null, memory: null, message, httpStatus });
  }

  private drain(cfgProvider: () => Judge0Config | null) {
    if (this.draining) return;
    this.draining = true;
    void this.dispatchLoop(cfgProvider).finally(() => {
      this.draining = false;
      // a late arrival (or a freed in-flight slot) may need another pass
      if (this.waiters.length > 0) this.drain(cfgProvider);
    });
  }

  /**
   * Dispatch batches CONCURRENTLY (up to MAX_INFLIGHT_BATCHES in flight at once).
   * Each batch's outbound submission rate is still smoothed by the token bucket,
   * but polling a slow batch no longer blocks the next batch from starting — so a
   * burst of clicks actually drains instead of piling up until MAX_WAIT_MS.
   */
  private async dispatchLoop(cfgProvider: () => Judge0Config | null) {
    while (this.waiters.length > 0) {
      // hold off until an in-flight slot frees up
      if (this.inFlight >= MAX_INFLIGHT_BATCHES) { await sleep(20); continue; }

      // small collect window so bursts group into a full batch
      if (this.waiters.length < BATCH_SIZE) await sleep(BATCH_WINDOW_MS);

      // drop anyone who already waited too long
      const now = Date.now();
      this.waiters = this.waiters.filter((w) => {
        if (now - w.enqueuedAt >= MAX_WAIT_MS) {
          this.failWaiter(w, "Server is busy — please press Run again in a moment.", 503);
          return false;
        }
        return true;
      });
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

  private async processBatch(batch: Waiter[], cfg: Judge0Config) {
    // 1 token per submission in the batch (the batch POST executes N runs).
    await this.takeTokens(batch.length);

    try {
      const submissions = batch.map((w) => ({
        source_code: enc(w.job.source),
        language_id: w.job.languageId,
        stdin: enc(w.job.stdin),
      }));

      const createRes = await fetchWithBackoff(
        `${cfg.baseUrl}/submissions/batch?base64_encoded=true`,
        { method: "POST", headers: cfg.headers, body: JSON.stringify({ submissions }) },
      );

      if (!createRes.ok) {
        const t = await createRes.text().catch(() => "");
        for (const w of batch) this.failWaiter(w, `Runner error (${createRes.status}). Try again in a moment.`, 502);
        void t;
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
          this.failWaiter(w, "Code execution timed out. Try again.", 504);
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
      for (const w of batch) this.failWaiter(w, "Couldn't reach the code runner. Check your connection and try again.", 502);
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
      const res = await fetchWithBackoff(url, { headers: cfg.headers });
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
    return { queued: this.waiters.length, inFlight: this.inFlight, draining: this.draining, tokens: Math.floor(this.tokens) };
  }
}

export const judge0Queue = new Judge0Queue();
