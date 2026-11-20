import { afterAll, beforeAll, expect, test } from "bun:test";

import { Judge0Queue, isQuotaExhausted, runnerRefusalMessage } from "./judge0-queue";

// Its own queue with short limits. NOT environment variables: bun runs every test
// file in one process, so when another file (scoring.test.ts loads grade-queue)
// imports the shared queue first, env values set here are read too late. That
// ordering differs between machines; it passed locally and failed on Railway.
const judge0Queue = new Judge0Queue({ fetchTimeoutMs: 400, maxWaitMs: 1500, hardDeadlineMs: 3000, batchWindowMs: 10 });

let mode: "hang" | "quota" | "ok" = "hang";
let calls = 0;
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      calls++;
      if (mode === "hang") return new Promise<Response>(() => {});
      if (mode === "quota") return Response.json({ message: "You have exceeded the DAILY quota for Submissions on your current plan, BASIC. Upgrade your plan at https://rapidapi.com" }, { status: 429, headers: { "retry-after": "40000" } });
      const u = new URL(req.url);
      if (req.method === "POST") return req.json().then((b: { submissions: unknown[] }) => Response.json(b.submissions.map((_, i) => ({ token: `t${i}` }))));
      const tokens = (u.searchParams.get("tokens") ?? "").split(",");
      return Response.json({ submissions: tokens.map((t) => ({ token: t, status: { id: 3, description: "Accepted" }, stdout: btoa("2\n") })) });
    },
  });
});
// Do not await: the "hang" handler never settles, and stop() would wait for it.
afterAll(() => { void server.stop(true); });

const cfg = () => ({ baseUrl: `http://127.0.0.1:${server.port}`, headers: { "Content-Type": "application/json" }, isRapidApi: false });
const job = { source: "print(1+1)", languageId: 71, stdin: "" };

test("a Judge0 that never answers cannot hang a run, nor jam the queue for later runs", async () => {
  mode = "hang";
  const t0 = Date.now();
  // More runs than 6 slots x 20 per batch would fit, all against a hung runner.
  const results = await Promise.all(Array.from({ length: 10 }, () => judge0Queue.run(job, cfg)));
  expect(Date.now() - t0).toBeLessThan(3500);
  for (const r of results) {
    expect(r.ok).toBe(false);
    expect(r.message).toBeTruthy();
  }
  // Runner back: the next run works (no slot left stuck).
  mode = "ok";
  await Bun.sleep(1500);
  const r = await judge0Queue.run(job, cfg);
  expect(r.ok).toBe(true);
  expect(r.stdout).toBe("2\n");
}, 20_000);

test("quota exhausted: answered at once with a clear message, Retry-After not honoured", async () => {
  mode = "quota";
  const before = calls;
  const t0 = Date.now();
  const r = await judge0Queue.run(job, cfg);
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(r.ok).toBe(false);
  expect(r.message).toContain("usage limit");
  expect(calls - before).toBe(1); // no pointless retries
});

test("refusal messages", () => {
  expect(isQuotaExhausted(429, "You have exceeded the MONTHLY quota")).toBe(true);
  expect(isQuotaExhausted(429, "Too many requests")).toBe(false);
  expect(runnerRefusalMessage(403, "You are not subscribed to this API.")).toContain("key rejected");
  expect(runnerRefusalMessage(429, "Too many requests")).toContain("busy");
  expect(runnerRefusalMessage(500, "")).toContain("500");
});
