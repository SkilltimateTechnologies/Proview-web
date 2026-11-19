import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "./schema";
import { createLaneRouter, deadlineFetch, envInt, freshLaneStats, type DbLane, type LaneStats } from "./lanes";

export { runInLane, currentLane, type DbLane } from "./lanes";

// Fail fast with a clear message instead of the cryptic libsql
// "URL_INVALID: The URL '' is not in a valid format" crash at import time.
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Configure it (and DATABASE_AUTH_TOKEN) in your " +
      "environment / Railway service variables before starting the server.",
  );
}

// Bun's global fetch handles gzip streaming correctly; the bundled node-fetch
// used by @libsql/client under Vite/Node throws ERR_STREAM_PREMATURE_CLOSE on
// larger gzipped pipeline responses. Force the platform fetch — now with a
// deadline on every request (see lanes.ts for why that matters).
const DATABASE_URL: string = process.env.DATABASE_URL;

/** Abort any single database request after this long. 0 disables (not recommended). */
const STATEMENT_TIMEOUT_MS = envInt("DB_STATEMENT_TIMEOUT_MS", 15_000, true);
/**
 * Statements each lane may run at once against a REMOTE database. The library
 * default was 20 for the whole process; these are per lane. Tunable per deploy.
 */
const LANE_CONCURRENCY: Record<DbLane, number> = {
  student: envInt("DB_CONCURRENCY_STUDENT", 48),
  admin: envInt("DB_CONCURRENCY_ADMIN", 16),
  background: envInt("DB_CONCURRENCY_BACKGROUND", 8),
};
/** Used when lanes are off (DB_LANES=off) or the database is a local file. */
const SINGLE_CONCURRENCY = envInt("DB_CONCURRENCY", 64);

const isLocalFile = /^file:/i.test(DATABASE_URL) || DATABASE_URL === ":memory:";
const lanesOn = !isLocalFile && (process.env.DB_LANES ?? "on").toLowerCase() !== "off";
const timedFetch = deadlineFetch(STATEMENT_TIMEOUT_MS);

function makeClient(concurrency: number) {
  return createClient({
    url: DATABASE_URL,
    authToken: process.env.DATABASE_AUTH_TOKEN,
    concurrency,
    fetch: timedFetch,
  });
}

export const laneStats: Record<DbLane, LaneStats> = {
  student: freshLaneStats(),
  admin: freshLaneStats(),
  background: freshLaneStats(),
};

const client = lanesOn
  ? createLaneRouter(
      {
        student: makeClient(LANE_CONCURRENCY.student),
        admin: makeClient(LANE_CONCURRENCY.admin),
        background: makeClient(LANE_CONCURRENCY.background),
      },
      laneStats,
    )
  : (() => {
      const single = makeClient(SINGLE_CONCURRENCY);
      // One client, so every lane name maps to it; stats still split by lane.
      return createLaneRouter({ student: single, admin: single, background: single }, laneStats);
    })();

/** What the connection layer is configured as — reported on /api/health. */
export const dbConfig = {
  lanes: lanesOn,
  statementTimeoutMs: STATEMENT_TIMEOUT_MS,
  concurrency: lanesOn ? LANE_CONCURRENCY : { single: isLocalFile ? null : SINGLE_CONCURRENCY },
};

/**
 * LOAD TESTING ONLY — off unless DB_FAKE_LATENCY_MS is set, and never set in prod.
 *
 * Production talks to Turso over HTTP (~13ms per statement, measured). A load test
 * against a local SQLite file pays microseconds per statement, which deletes the
 * single dominant cost in production: a 300-student run looked perfectly healthy
 * locally while the real exam slowed down. This makes a local file behave like a
 * remote database so a round-trip-bound slowdown can be reproduced without
 * pointing load at the real database.
 *
 * Only `execute` and `batch` are delayed — the two methods drizzle sends
 * statements through. With the variable unset this is an exact no-op: the same
 * client object is handed to drizzle, unwrapped.
 */
const fakeLatencyMs = Number(process.env.DB_FAKE_LATENCY_MS ?? 0);
const dbClient = fakeLatencyMs > 0
  ? new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        const fn = value as (...a: unknown[]) => unknown;
        if (prop !== "execute" && prop !== "batch") return fn.bind(target);
        return async (...args: unknown[]) => {
          await new Promise((resolve) => setTimeout(resolve, fakeLatencyMs));
          return fn.apply(target, args);
        };
      },
    })
  : client;
if (fakeLatencyMs > 0) {
  console.warn(`[db] SIMULATED LATENCY: +${fakeLatencyMs}ms per statement (load testing only)`);
}

/**
 * Statements this process has sent to the database, since boot.
 *
 * The exam pages failing at ~1000 concurrent students was a round-trip problem:
 * the database is remote (Turso over HTTP), so "how many statements does this
 * endpoint run" is the number that decides whether the app survives the load.
 * Counting them is one increment per query and makes that number observable in
 * `/api/health` instead of something we have to guess at.
 */
let queryCount = 0;
export const dbStats = {
  get queries() {
    return queryCount;
  },
  get lanes() {
    return laneStats;
  },
};

export const db = drizzle(dbClient, {
  schema,
  logger: {
    logQuery() {
      queryCount += 1;
    },
  },
});
