/**
 * Database "lanes": separate connection pools for student traffic, the admin
 * console and background work, plus a hard deadline on every statement.
 *
 * WHY THIS EXISTS
 * ---------------
 * `@libsql/client` runs at most `concurrency` statements at once (default 20) per
 * client, queues everything else with NO upper bound, and puts NO deadline on any
 * statement. The whole app used ONE client, so:
 *
 *  1. Every request in the process shared one 20-slot pipe. When 1,100 students hit
 *     the same instant (the start bell, the timer reaching zero) the queue grew to
 *     thousands of statements and every request waited behind it — including the
 *     invigilator's Live Monitor and every admin page. That is "the admin account
 *     also hangs when students write the exam".
 *  2. A request the database never answered held its slot until the OS gave up on
 *     the socket. Measured on a stand-in database: 20 unanswered requests froze
 *     every database-backed endpoint for ~5 minutes while /api/health stayed green.
 *
 * What this module does:
 *  - Each lane gets its OWN client (and so its own slot limit and queue). A student
 *    surge can no longer starve the admin console, and AI grading or the sweeps can
 *    never starve students.
 *  - Every HTTP request to the database is aborted after `statementTimeoutMs`. A stuck
 *    request now costs a few seconds, not minutes. A timed-out write may or may not
 *    have been applied — exactly as before when the hang finally broke — and every
 *    write path the exam uses is an idempotent upsert or guarded update, so the
 *    client's retry converges on the same row.
 *  - The lane is chosen from the request's async context (AsyncLocalStorage), so no
 *    call site changes: `db` is still the one import everywhere.
 *
 * Kill switch: DB_LANES=off restores a single client (with the deadline still on).
 * Local `file:` databases always use a single client: SQLite file locking does not
 * want three writers, and the concurrency limit does not apply to them anyway.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type DbLane = "student" | "admin" | "background";
export const DB_LANES: readonly DbLane[] = ["student", "admin", "background"];

const laneStore = new AsyncLocalStorage<DbLane>();

/** Run `fn` (and everything it awaits or schedules) on a database lane. */
export function runInLane<T>(lane: DbLane, fn: () => T): T {
  return laneStore.run(lane, fn);
}

/** The lane of the current async context. Work started outside any request is background. */
export function currentLane(): DbLane {
  return laneStore.getStore() ?? "background";
}

/** Positive integer from the environment, else the default. 0 is allowed only when `allowZero`. */
export function envInt(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !allowZero)) return fallback;
  return n;
}

/** Live counters per lane, exposed on /api/health so the next slowdown explains itself. */
export type LaneStats = {
  /** Statements started and not yet finished (running + waiting for a slot). */
  pending: number;
  /** Highest `pending` seen since boot. */
  peakPending: number;
  /** Statements that failed because they hit the deadline. */
  timeouts: number;
  /** Slowest statement in the last minute, in ms (queue wait included). */
  slowestRecentMs: number;
};

export function freshLaneStats(): LaneStats {
  return { pending: 0, peakPending: 0, timeouts: 0, slowestRecentMs: 0 };
}

/** Minimal surface of a libSQL client that the router needs to know about. */
type AnyClient = object;

const TRACKED_METHODS = new Set(["execute", "batch", "executeMultiple"]);

function isTimeoutError(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    const err = cur as { name?: string; message?: string; cause?: unknown };
    if (err.name === "TimeoutError" || /timed out|TimeoutError/i.test(String(err.message ?? ""))) return true;
    cur = err.cause;
  }
  return false;
}

/**
 * A client-shaped object that forwards every call to the client of the current
 * lane, counting what each lane has in flight. `pick` is injectable for tests.
 */
export function createLaneRouter<C extends AnyClient>(
  clients: Record<DbLane, C>,
  stats: Record<DbLane, LaneStats>,
  pick: () => DbLane = currentLane,
  now: () => number = Date.now,
): C {
  const windowStart: Record<DbLane, number> = { student: now(), admin: now(), background: now() };
  return new Proxy(clients.background, {
    get(_target, prop) {
      const lane = pick();
      const client = clients[lane];
      const value = Reflect.get(client, prop, client);
      if (typeof value !== "function") return value;
      if (typeof prop !== "string" || !TRACKED_METHODS.has(prop)) return (value as Function).bind(client);
      return async (...args: unknown[]) => {
        const s = stats[lane];
        s.pending += 1;
        if (s.pending > s.peakPending) s.peakPending = s.pending;
        const started = now();
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(client, args);
        } catch (e) {
          if (isTimeoutError(e)) s.timeouts += 1;
          throw e;
        } finally {
          s.pending -= 1;
          const took = now() - started;
          if (started - windowStart[lane] > 60_000) {
            windowStart[lane] = started;
            s.slowestRecentMs = 0;
          }
          if (took > s.slowestRecentMs) s.slowestRecentMs = took;
        }
      };
    },
  }) as C;
}

/**
 * Abort when either signal aborts. AbortSignal.any is missing from older Bun
 * releases (production runs an older Bun than development), so fall back to a
 * hand-rolled combination there.
 */
function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const native = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === "function") return native([a, b]);
  const ctl = new AbortController();
  for (const s of [a, b]) {
    if (s.aborted) {
      ctl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

/**
 * Wrap a fetch so every request carries a deadline. Also normalises a Request-like
 * input to url + init, which the previous inline wrapper did for libsql's sake.
 * `timeoutMs` 0 disables the deadline.
 */
export function deadlineFetch(timeoutMs: number, baseFetch: typeof fetch = fetch): typeof fetch {
  const withDeadline = (init?: RequestInit): RequestInit | undefined => {
    if (!(timeoutMs > 0)) return init;
    // A plain timer rather than AbortSignal.timeout: identical behaviour, and it
    // also fires under the test runner of the older Bun production runs. The timer
    // is unref'd so it never holds the process open; firing after the request has
    // finished is a no-op.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new DOMException("The operation timed out.", "TimeoutError")), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    const timeout = ctl.signal;
    return { ...init, signal: init?.signal ? anySignal(init.signal, timeout) : timeout };
  };
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    if (input && typeof input === "object" && "url" in input && typeof (input as Request).url === "string") {
      const r = input as Request;
      return baseFetch(
        r.url,
        withDeadline({
          method: r.method,
          headers: r.headers,
          body: (r as unknown as { body?: BodyInit }).body ?? init?.body,
          ...init,
        }),
      );
    }
    return baseFetch(input as RequestInfo | URL, withDeadline(init));
  }) as typeof fetch;
}
