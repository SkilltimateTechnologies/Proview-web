/**
 * gzipJson replaced hono/compress after hono/compress 500'd every API call on
 * production's older Bun (no CompressionStream). These tests pin the contract:
 * only large JSON GETs are compressed, the bytes round-trip, headers survive, and
 * a compression failure never fails the request.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { gunzipSync } from "node:zlib";
import { gzipJson } from "./gzip-json";

const big = { rows: Array.from({ length: 400 }, (_, i) => ({ id: `att_${i}`, name: `Student ${i}`, status: "in_progress" })) };

function app(gzip?: (b: Uint8Array) => Uint8Array) {
  return new Hono()
    .use(gzipJson(gzip ? { gzip } : {}))
    .get("/big", (c) => { c.header("Set-Cookie", "a=1"); c.header("X-Keep", "yes"); return c.json(big, 200); })
    .get("/small", (c) => c.json({ ok: true }, 200))
    .get("/text", (c) => c.text("x".repeat(5000), 200))
    .post("/big", (c) => c.json(big, 200))
    .get("/err", (c) => c.json(big, 500));
}

describe("gzipJson", () => {
  test("compresses a large JSON GET and the body round-trips", async () => {
    const res = await app().request("/big", { headers: { "Accept-Encoding": "gzip, br" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("x-keep")).toBe("yes");
    expect(res.headers.get("set-cookie")).toBe("a=1");
    const packed = new Uint8Array(await res.arrayBuffer());
    expect(Number(res.headers.get("content-length"))).toBe(packed.byteLength);
    expect(JSON.parse(gunzipSync(packed).toString("utf8"))).toEqual(big);
  });

  test("keeps the status of an error response", async () => {
    const res = await app().request("/err", { headers: { "Accept-Encoding": "gzip" } });
    expect(res.status).toBe(500);
    expect(JSON.parse(gunzipSync(new Uint8Array(await res.arrayBuffer())).toString("utf8"))).toEqual(big);
  });

  test("leaves small, non-JSON, POST and no-gzip responses untouched", async () => {
    for (const [method, path, enc] of [["GET", "/small", "gzip"], ["GET", "/text", "gzip"], ["POST", "/big", "gzip"], ["GET", "/big", "br"], ["GET", "/big", ""]] as const) {
      const res = await app().request(path, { method, headers: enc ? { "Accept-Encoding": enc } : {} });
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.length).toBeGreaterThan(0);
    }
    const res = await app().request("/big", { headers: { "Accept-Encoding": "identity" } });
    expect(await res.json()).toEqual(big);
  });

  test("a compressor that throws never fails the request", async () => {
    const res = await app(() => { throw new Error("zlib blew up"); }).request("/big", { headers: { "Accept-Encoding": "gzip" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual(big);
  });

  test("does not depend on CompressionStream (absent on production's Bun)", async () => {
    const saved = (globalThis as { CompressionStream?: unknown }).CompressionStream;
    (globalThis as { CompressionStream?: unknown }).CompressionStream = undefined;
    try {
      const res = await app().request("/big", { headers: { "Accept-Encoding": "gzip" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe("gzip");
    } finally {
      (globalThis as { CompressionStream?: unknown }).CompressionStream = saved;
    }
  });
});
