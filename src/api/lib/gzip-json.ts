/**
 * gzip for large JSON responses, using Bun.gzipSync.
 *
 * WHY NOT hono/compress: it relies on the web `CompressionStream`, which Bun only
 * gained in 1.3. Production (Railway/Nixpacks) runs an older Bun where it does not
 * exist, so hono/compress threw on EVERY JSON response — every API call, both
 * logins included, returned 500 "Internal Server Error" (2026-11-19). Bun.gzipSync
 * exists in every Bun release, and this middleware never throws: any failure
 * leaves the original response untouched.
 *
 * Scope is deliberately narrow: GET only, application/json only, at least
 * `minBytes`, only when the client accepts gzip, never on an already-encoded
 * response. Auth (sign-in/sign-out) and every write are POSTs, so they are never
 * touched. The point is the large admin reads — the Live Monitor (~294 KB per 5s
 * poll per tab, ~22 KB gzipped) and the student list (~281 KB).
 */
import type { MiddlewareHandler } from "hono";

export const GZIP_MIN_BYTES = 1024;

export function gzipJson(
  opts: { minBytes?: number; gzip?: (bytes: Uint8Array) => Uint8Array } = {},
): MiddlewareHandler {
  const minBytes = opts.minBytes ?? GZIP_MIN_BYTES;
  const gzip = opts.gzip ?? ((bytes: Uint8Array) => Bun.gzipSync(bytes as Uint8Array<ArrayBuffer>));
  return async (c, next) => {
    await next();
    try {
      if (c.req.method !== "GET") return;
      if (!/\bgzip\b/i.test(c.req.header("accept-encoding") ?? "")) return;
      const res = c.res;
      if (!res.body || res.headers.has("content-encoding")) return;
      if (!/^application\/json/i.test(res.headers.get("content-type") ?? "")) return;
      // Read the body ONCE and always install a fresh response afterwards. No
      // res.clone(): on Bun 1.1/1.2 reading a clone left the ORIGINAL body empty,
      // which shipped 200s with no content (caught on Bun 1.2.0 before release).
      const raw = new Uint8Array(await res.arrayBuffer());
      let body: Uint8Array = raw;
      let packed: Uint8Array | null = null;
      if (raw.byteLength >= minBytes) {
        try {
          const out = gzip(raw);
          if (out.byteLength > 0 && out.byteLength < raw.byteLength) packed = out;
        } catch (e) {
          console.error("[gzip-json] skipped:", e instanceof Error ? e.message : String(e));
        }
      }
      if (packed) body = packed;
      c.res = new Response(body as unknown as BodyInit, { status: res.status, statusText: res.statusText, headers: res.headers });
      // Hono copies the previous response's headers onto the new one when c.res is
      // replaced, so set length/encoding AFTER the assignment.
      c.res.headers.set("Content-Length", String(body.byteLength));
      if (packed) {
        c.res.headers.set("Content-Encoding", "gzip");
        c.res.headers.append("Vary", "Accept-Encoding");
      }
    } catch (e) {
      // Compression is an optimisation: never let it fail a request.
      console.error("[gzip-json] skipped:", e instanceof Error ? e.message : String(e));
    }
  };
}
