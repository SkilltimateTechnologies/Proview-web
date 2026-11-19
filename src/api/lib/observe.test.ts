import { describe, expect, test } from "bun:test";
import { AlertGate, fingerprint, normaliseClientReport, parseSentryDsn, RateWindow, sentryEnvelope, webhookBody } from "./observe";

describe("fingerprint", () => {
  test("the same error with different ids and numbers groups together", () => {
    const a = fingerprint("TypeError", "attempt att_9f8e7d6c5b4a missing at row 12", "Error\n    at finalize (grade.ts:10:5)");
    const b = fingerprint("TypeError", "attempt att_1a2b3c4d5e6f missing at row 99", "Error\n    at finalize (grade.ts:10:5)");
    expect(a).toBe(b);
  });
  test("different errors differ", () => {
    expect(fingerprint("TypeError", "x is undefined")).not.toBe(fingerprint("RangeError", "x is undefined"));
  });
});

describe("Sentry DSN", () => {
  test("parses into the envelope endpoint and auth header", () => {
    const t = parseSentryDsn("https://abc123@o42.ingest.sentry.io/4507")!;
    expect(t.url).toBe("https://o42.ingest.sentry.io/api/4507/envelope/");
    expect(t.auth).toContain("sentry_key=abc123");
  });
  test("missing or malformed DSN means Sentry is off", () => {
    expect(parseSentryDsn(undefined)).toBeNull();
    expect(parseSentryDsn("not a url")).toBeNull();
    expect(parseSentryDsn("https://o42.ingest.sentry.io/4507")).toBeNull();
  });
  test("envelope is three JSON lines with the error in the event", () => {
    const t = parseSentryDsn("https://k@h.example/1")!;
    const lines = sentryEnvelope({ name: "TypeError", message: "boom" }, { source: "server", path: "/api/x", method: "GET", requestId: "r1" }, t).split("\n");
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[1]).type).toBe("event");
    const ev = JSON.parse(lines[2]);
    expect(ev.exception.values[0]).toMatchObject({ type: "TypeError", value: "boom" });
    expect(ev.tags.request_id).toBe("r1");
  });
});

describe("AlertGate", () => {
  test("one alert per key per window, and an hourly cap", () => {
    let t = 0;
    const g = new AlertGate(10 * 60_000, 3, () => t);
    expect(g.allow("a")).toBe(true);
    expect(g.allow("a")).toBe(false);          // same error again within 10 min
    expect(g.allow("b")).toBe(true);
    expect(g.allow("c")).toBe(true);
    expect(g.allow("d")).toBe(false);          // hourly cap of 3 reached
    t = 11 * 60_000;
    expect(g.allow("a")).toBe(false);          // window passed but the hour cap still holds
    t = 61 * 60_000;
    expect(g.allow("a")).toBe(true);
  });
});

test("webhook body works for Slack/Google Chat (text) and Discord (content)", () => {
  const b = JSON.parse(webhookBody("hello"));
  expect(b.text).toBe("hello");
  expect(b.content).toBe("hello");
});

test("RateWindow caps browser reports per minute", () => {
  let t = 0;
  const w = new RateWindow(2, 60_000, () => t);
  expect(w.take()).toBe(true);
  expect(w.take()).toBe(true);
  expect(w.take()).toBe(false);
  t = 60_001;
  expect(w.take()).toBe(true);
});

test("browser reports are trimmed and empty ones dropped", () => {
  expect(normaliseClientReport({ message: "" })).toBeNull();
  const r = normaliseClientReport({ message: "x".repeat(900), stack: "s", url: "https://proview/px9k2m7/exam/1", kind: "unhandledrejection" })!;
  expect(r.message.length).toBe(500);
  expect(r.kind).toBe("unhandledrejection");
});
