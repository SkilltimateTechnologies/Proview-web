import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "./schema";

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
// larger gzipped pipeline responses. Force the platform fetch.
const client = createClient({
  url: process.env.DATABASE_URL,
  authToken: process.env.DATABASE_AUTH_TOKEN,
  fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
    // libsql may hand us a Request-like object; normalize to url + init so the
    // platform fetch can parse it (avoids "Failed to parse URL from [object Request]").
    if (input && typeof input === "object" && "url" in input && typeof (input as Request).url === "string") {
      const r = input as Request;
      return fetch(r.url, {
        method: r.method,
        headers: r.headers,
        body: (r as unknown as { body?: BodyInit }).body ?? init?.body,
        ...init,
      });
    }
    return fetch(input as RequestInfo | URL, init);
  }) as unknown as typeof fetch,
});

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
};

export const db = drizzle(dbClient, {
  schema,
  logger: {
    logQuery() {
      queryCount += 1;
    },
  },
});
