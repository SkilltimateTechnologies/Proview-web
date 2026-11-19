/**
 * Browser error reporting (server side: api/lib/observe.ts, POST /api/client-errors).
 *
 * A crash on a student's screen used to be invisible unless the student called.
 * Uncaught errors, unhandled promise rejections and React render crashes (via
 * ErrorBoundary) are now sent to the server, which logs them and forwards them to
 * Sentry / the alert webhook when configured. Each distinct message is sent once
 * per page, at most 10 per page, and browser-extension noise is ignored.
 */
const sent = new Set<string>();
let count = 0;
const MAX_PER_PAGE = 10;

const IGNORE = [/ResizeObserver loop/i, /^Script error\.?$/i, /chrome-extension:|moz-extension:|safari-extension:/i];

export function reportClientError(err: unknown, kind = "error"): void {
  try {
    const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : (() => { try { return JSON.stringify(err); } catch { return String(err); } })());
    const message = String(e.message || "").slice(0, 500);
    if (!message) return;
    const stack = String(e.stack || "").slice(0, 4000);
    if (IGNORE.some((r) => r.test(message) || r.test(stack))) return;
    const key = `${e.name}|${message}`;
    if (sent.has(key) || count >= MAX_PER_PAGE) return;
    sent.add(key);
    count++;
    const body = JSON.stringify({ name: e.name, message, stack, url: location.href.slice(0, 300), kind });
    const ok = typeof navigator.sendBeacon === "function" && navigator.sendBeacon("/api/client-errors", new Blob([body], { type: "application/json" }));
    if (!ok) void fetch("/api/client-errors", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  } catch {
    /* reporting must never break the page */
  }
}

let installed = false;
export function installErrorReporting(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (ev) => reportClientError(ev.error ?? ev.message, "error"));
  window.addEventListener("unhandledrejection", (ev) => reportClientError(ev.reason, "unhandledrejection"));
}
