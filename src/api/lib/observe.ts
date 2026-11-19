/**
 * Error tracking and alerts.
 *
 * Errors used to surface only as scattered console.log lines, so a broken route
 * was usually reported by a college before anyone here saw it. Now:
 *
 * - Every server error is logged as ONE structured JSON line (level, request id,
 *   method, path, user, stack), so Railway's log search finds it by request id.
 * - Browser errors from the exam screen and the admin console arrive through
 *   POST /api/client-errors and are logged the same way.
 * - SENTRY_DSN (optional): errors are also sent to Sentry over its plain HTTP
 *   envelope API (no SDK, nothing that needs a newer Bun).
 * - ALERT_WEBHOOK_URL (optional): a Slack / Discord / Google Chat incoming
 *   webhook gets a short message, at most once per distinct error every 10
 *   minutes and at most 20 messages an hour, so an outage cannot flood it.
 *
 * Nothing here may throw into a request: reporting is best-effort.
 */
import { createHash, randomUUID } from "node:crypto";

export type ErrorContext = {
  source: "server" | "browser" | "process";
  requestId?: string;
  method?: string;
  path?: string;
  userId?: string | null;
  role?: string | null;
  url?: string;
  userAgent?: string;
  extra?: Record<string, unknown>;
};

const env = (k: string) => (typeof process !== "undefined" ? process.env[k] : undefined);

/** Short id for a request, echoed in the X-Request-Id header and in error messages. */
export function newRequestId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export function logJson(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

/** Same error (type + message + first stack frame) → same fingerprint, ignoring ids and numbers. */
export function fingerprint(name: string, message: string, stack?: string): string {
  const firstFrame = (stack || "").split("\n").find((l) => /^\s*at\s/.test(l))?.trim() ?? "";
  const norm = `${name}|${message}|${firstFrame}`.replace(/[0-9a-f]{8,}/gi, "#").replace(/\d+/g, "#");
  return createHash("sha1").update(norm).digest("hex").slice(0, 12);
}

// ---- Sentry (optional) -------------------------------------------------------

export type SentryTarget = { url: string; auth: string; dsn: string };

/** https://<key>@<host>/<project> → envelope endpoint + auth header, or null. */
export function parseSentryDsn(dsn: string | undefined): SentryTarget | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const key = u.username;
    const project = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!key || !project) return null;
    return {
      url: `${u.protocol}//${u.host}/api/${project}/envelope/`,
      auth: `Sentry sentry_version=7, sentry_key=${key}, sentry_client=proview/1.0`,
      dsn,
    };
  } catch {
    return null;
  }
}

export function sentryEnvelope(err: { name: string; message: string; stack?: string }, ctx: ErrorContext, target: SentryTarget): string {
  const eventId = randomUUID().replace(/-/g, "");
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: ctx.source === "browser" ? "javascript" : "node",
    level: "error",
    environment: env("RAILWAY_ENVIRONMENT_NAME") || env("NODE_ENV") || "production",
    release: env("RAILWAY_GIT_COMMIT_SHA")?.slice(0, 12),
    server_name: "proview-web",
    exception: { values: [{ type: err.name, value: err.message, stacktrace: err.stack ? { frames: [] } : undefined }] },
    tags: { source: ctx.source, path: ctx.path, method: ctx.method, role: ctx.role ?? undefined, request_id: ctx.requestId },
    extra: { stack: err.stack?.slice(0, 4000), url: ctx.url, userAgent: ctx.userAgent, ...ctx.extra },
    user: ctx.userId ? { id: ctx.userId } : undefined,
  };
  return [JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: target.dsn }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");
}

// ---- Alert webhook (optional) -------------------------------------------------

/** Decides which alerts are sent: one per key per window, and a global hourly cap. */
export class AlertGate {
  private readonly lastByKey = new Map<string, number>();
  private sentTimes: number[] = [];
  constructor(
    private readonly perKeyMs = 10 * 60_000,
    private readonly perHour = 20,
    private readonly now: () => number = Date.now,
  ) {}
  allow(key: string): boolean {
    const t = this.now();
    const last = this.lastByKey.get(key);
    if (last != null && t - last < this.perKeyMs) return false;
    this.sentTimes = this.sentTimes.filter((x) => t - x < 3_600_000);
    if (this.sentTimes.length >= this.perHour) return false;
    this.lastByKey.set(key, t);
    this.sentTimes.push(t);
    if (this.lastByKey.size > 5000) this.lastByKey.clear();
    return true;
  }
}

const alertGate = new AlertGate();

/** Slack, Discord and Google Chat all accept one of these two keys. */
export function webhookBody(text: string): string {
  return JSON.stringify({ text, content: text.slice(0, 1900) });
}

async function postWebhook(text: string): Promise<void> {
  const url = env("ALERT_WEBHOOK_URL");
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: webhookBody(text), signal: AbortSignal.timeout?.(5000) });
  } catch {
    /* best-effort */
  }
}

/** Operational alert (health degraded, invariants failed…), rate-limited per key. */
export function alertOps(key: string, text: string): void {
  logJson("warn", "alert", { key, text });
  if (!alertGate.allow(`ops:${key}`)) return;
  void postWebhook(`⚠️ Proview: ${text}`);
}

// ---- The one entry point ------------------------------------------------------

export function reportError(raw: unknown, ctx: ErrorContext): string {
  const err = raw instanceof Error ? raw : new Error(typeof raw === "string" ? raw : JSON.stringify(raw)?.slice(0, 500) ?? "unknown error");
  const fp = fingerprint(err.name, err.message, err.stack);
  try {
    logJson("error", err.message, {
      source: ctx.source, fingerprint: fp, requestId: ctx.requestId, method: ctx.method, path: ctx.path,
      userId: ctx.userId ?? undefined, role: ctx.role ?? undefined, url: ctx.url, userAgent: ctx.userAgent,
      name: err.name, stack: err.stack?.split("\n").slice(0, 12).join("\n"), ...ctx.extra,
    });
    const target = parseSentryDsn(env("SENTRY_DSN"));
    if (target) {
      void fetch(target.url, { method: "POST", headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": target.auth }, body: sentryEnvelope(err, ctx, target), signal: AbortSignal.timeout?.(5000) }).catch(() => {});
    }
    if (alertGate.allow(`err:${fp}`)) {
      const where = ctx.source === "browser" ? `browser ${ctx.url ?? ""}` : `${ctx.method ?? ""} ${ctx.path ?? ""}`;
      void postWebhook(`🔴 Proview error (${ctx.source}) ${where.trim()}\n${err.name}: ${err.message.slice(0, 300)}${ctx.requestId ? `\nrequest ${ctx.requestId}` : ""}`);
    }
  } catch {
    /* never throw from the reporter */
  }
  return fp;
}

// ---- Browser reports -----------------------------------------------------------

export type ClientErrorReport = { message?: unknown; name?: unknown; stack?: unknown; url?: unknown; kind?: unknown };

/** Accept at most this many browser reports a minute across all users (a broken release must not flood logs). */
export class RateWindow {
  private times: number[] = [];
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}
  take(): boolean {
    const t = this.now();
    this.times = this.times.filter((x) => t - x < this.windowMs);
    if (this.times.length >= this.max) return false;
    this.times.push(t);
    return true;
  }
}

export function normaliseClientReport(b: ClientErrorReport): { name: string; message: string; stack?: string; url?: string; kind: string } | null {
  const message = String(b?.message ?? "").slice(0, 500).trim();
  if (!message) return null;
  return {
    name: String(b?.name ?? "Error").slice(0, 80),
    message,
    stack: b?.stack ? String(b.stack).slice(0, 4000) : undefined,
    url: b?.url ? String(b.url).slice(0, 300) : undefined,
    kind: String(b?.kind ?? "error").slice(0, 30),
  };
}
