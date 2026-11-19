/**
 * The lane router decides which connection pool a statement uses. If it routed
 * wrongly the whole point (students cannot starve the admin console, grading
 * cannot starve students) silently disappears, so pin it: routing by async
 * context, per-lane counters, and the per-request deadline.
 */
import { describe, expect, test } from "bun:test";
import { createLaneRouter, currentLane, deadlineFetch, envInt, freshLaneStats, runInLane, type DbLane } from "./lanes";

function fakeClient(name: string, delayMs = 0, fail?: Error) {
  return {
    name,
    calls: 0,
    async execute(sql: string) {
      this.calls += 1;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail) throw fail;
      return { from: name, sql };
    },
  };
}

function setup(delayMs = 0) {
  const clients = { student: fakeClient("student", delayMs), admin: fakeClient("admin", delayMs), background: fakeClient("background", delayMs) };
  const stats = { student: freshLaneStats(), admin: freshLaneStats(), background: freshLaneStats() };
  const router = createLaneRouter(clients, stats);
  return { clients, stats, router };
}

describe("lane routing", () => {
  test("outside any request the lane is background", async () => {
    const { router } = setup();
    expect(currentLane()).toBe("background");
    expect((await router.execute("x")).from).toBe("background");
  });

  test("runInLane routes to that lane's client, across awaits and timers", async () => {
    const { router } = setup();
    for (const lane of ["student", "admin", "background"] as DbLane[]) {
      const out = await runInLane(lane, async () => {
        await new Promise((r) => setTimeout(r, 5));
        await Promise.resolve();
        return router.execute("x");
      });
      expect(out.from).toBe(lane);
    }
  });

  test("a timer scheduled inside a lane keeps that lane (heartbeat flusher, grading)", async () => {
    const { router } = setup();
    const out = await new Promise<{ from: string }>((resolve) => {
      runInLane("student", () => {
        setTimeout(() => void router.execute("x").then(resolve), 5);
      });
    });
    expect(out.from).toBe("student");
  });

  test("concurrent requests on different lanes do not cross", async () => {
    const { router } = setup(10);
    const results = await Promise.all([
      ...Array.from({ length: 20 }, () => runInLane("student", () => router.execute("s"))),
      ...Array.from({ length: 5 }, () => runInLane("admin", () => router.execute("a"))),
    ]);
    expect(results.filter((r) => r.from === "student")).toHaveLength(20);
    expect(results.filter((r) => r.from === "admin")).toHaveLength(5);
  });

  test("counts pending per lane and peaks", async () => {
    const { router, stats } = setup(20);
    const work = Promise.all(Array.from({ length: 4 }, () => runInLane("admin", () => router.execute("a"))));
    await new Promise((r) => setTimeout(r, 5));
    expect(stats.admin.pending).toBe(4);
    expect(stats.student.pending).toBe(0);
    await work;
    expect(stats.admin.pending).toBe(0);
    expect(stats.admin.peakPending).toBe(4);
    expect(stats.admin.slowestRecentMs).toBeGreaterThanOrEqual(15);
  });

  test("a failing statement still releases pending and counts timeouts", async () => {
    const timeout = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    const clients = { student: fakeClient("s", 0, timeout), admin: fakeClient("a"), background: fakeClient("b") };
    const stats = { student: freshLaneStats(), admin: freshLaneStats(), background: freshLaneStats() };
    const router = createLaneRouter(clients, stats);
    await expect(runInLane("student", () => router.execute("x"))).rejects.toThrow("timed out");
    expect(stats.student.pending).toBe(0);
    expect(stats.student.timeouts).toBe(1);
  });

  test("non-method properties pass through to the lane client", () => {
    const { router } = setup();
    expect(runInLane("admin", () => (router as unknown as { name: string }).name)).toBe("admin");
  });
});

describe("deadlineFetch", () => {
  test("aborts a request that never answers", async () => {
    const hang: typeof fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const started = Date.now();
    await expect(deadlineFetch(50, hang)("http://db/")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("0 disables the deadline and passes init through", async () => {
    let seen: RequestInit | undefined;
    const spy: typeof fetch = (async (_: unknown, init?: RequestInit) => { seen = init; return new Response("ok"); }) as typeof fetch;
    await deadlineFetch(0, spy)("http://db/", { method: "POST", body: "x" });
    expect(seen?.signal).toBeUndefined();
    expect(seen?.method).toBe("POST");
  });

  test("normalises a Request-like input to url + init and keeps the body", async () => {
    let url = ""; let body: unknown;
    const spy: typeof fetch = (async (u: unknown, init?: RequestInit) => { url = String(u); body = init?.body; return new Response("ok"); }) as typeof fetch;
    const req = { url: "http://db/v2/pipeline", method: "POST", headers: new Headers(), body: "payload" };
    await deadlineFetch(1000, spy)(req as unknown as Request);
    expect(url).toBe("http://db/v2/pipeline");
    expect(body).toBe("payload");
  });
});

describe("envInt", () => {
  test("falls back on junk, negatives and (unless allowed) zero", () => {
    process.env.__LANE_T = "abc"; expect(envInt("__LANE_T", 7)).toBe(7);
    process.env.__LANE_T = "-3"; expect(envInt("__LANE_T", 7)).toBe(7);
    process.env.__LANE_T = "0"; expect(envInt("__LANE_T", 7)).toBe(7);
    expect(envInt("__LANE_T", 7, true)).toBe(0);
    process.env.__LANE_T = "40"; expect(envInt("__LANE_T", 7)).toBe(40);
    delete process.env.__LANE_T; expect(envInt("__LANE_T", 7)).toBe(7);
  });
});
