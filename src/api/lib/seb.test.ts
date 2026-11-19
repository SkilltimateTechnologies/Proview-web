import { describe, expect, test } from "bun:test";
import { candidateUrls, checkSeb, configKeyHash, isSebProtectedPath, normaliseConfigKeys, SebMonitor } from "./seb";

const KEY = "a".repeat(64);
const KEY2 = "0123456789abcdef".repeat(4);
const hdrs = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe("normaliseConfigKeys", () => {
  test("accepts a pasted list, keeps only 64-hex keys", () => {
    expect(normaliseConfigKeys(`${KEY.toUpperCase()}\n not-a-key, ${KEY2};${KEY}`)).toEqual([KEY, KEY2]);
    expect(normaliseConfigKeys([KEY, "short"])).toEqual([KEY]);
    expect(normaliseConfigKeys(undefined)).toEqual([]);
  });
});

describe("candidateUrls", () => {
  test("rebuilds the public https address behind a proxy", () => {
    const urls = candidateUrls("http://10.0.0.5:8080/api/student/exams?x=1", hdrs({ host: "proview.skilltimate.com" }), "https://proview.skilltimate.com");
    expect(urls).toContain("https://proview.skilltimate.com/api/student/exams?x=1");
    expect(urls).toContain("http://10.0.0.5:8080/api/student/exams?x=1");
  });
  test("prefers x-forwarded-host when present", () => {
    expect(candidateUrls("http://internal/api/student/a", hdrs({ host: "internal", "x-forwarded-host": "proview.skilltimate.com" }))).toContain("https://proview.skilltimate.com/api/student/a");
  });
});

describe("checkSeb", () => {
  const url = "https://proview.skilltimate.com/api/students/verify-login";
  test("a correct hash for the request URL matches", () => {
    const h = hdrs({ "x-safeexambrowser-configkeyhash": configKeyHash(url, KEY2), "user-agent": "Mozilla/5.0 SEB/3.10.1" });
    expect(checkSeb({ requestUrl: url, headers: h, keys: [KEY, KEY2] })).toEqual({ seb: true, matched: true });
  });
  test("a hash made for another URL does not match (no replay across URLs)", () => {
    const h = hdrs({ "x-safeexambrowser-configkeyhash": configKeyHash("https://proview.skilltimate.com/api/student/exams", KEY) });
    expect(checkSeb({ requestUrl: url, headers: h, keys: [KEY] }).matched).toBe(false);
  });
  test("an ordinary browser is not SEB", () => {
    expect(checkSeb({ requestUrl: url, headers: hdrs({ "user-agent": "Mozilla/5.0 Chrome/140" }), keys: [KEY] })).toEqual({ seb: false, matched: false });
  });
  test("SEB with an unknown config is seen but does not match", () => {
    const h = hdrs({ "x-safeexambrowser-configkeyhash": configKeyHash(url, KEY2), "user-agent": "SEB/3.10.1" });
    expect(checkSeb({ requestUrl: url, headers: h, keys: [KEY] })).toEqual({ seb: true, matched: false });
  });
});

test("protected paths: exam client API and student sign-in only", () => {
  expect(isSebProtectedPath("/api/student/attempts/a/answers")).toBe(true);
  expect(isSebProtectedPath("/api/students/verify-login")).toBe(true);
  expect(isSebProtectedPath("/api/student/seb-check")).toBe(false);
  expect(isSebProtectedPath("/api/students")).toBe(false);
  expect(isSebProtectedPath("/api/exams")).toBe(false);
  expect(isSebProtectedPath("/api/register/tkr")).toBe(false);
});

test("SebMonitor remembers the last SEB request only", () => {
  const m = new SebMonitor(() => 0);
  m.record({ seb: false, matched: false }, "Chrome");
  expect(m.status().lastSeenAt).toBeNull();
  m.record({ seb: true, matched: true }, "SEB/3.10.1");
  expect(m.status()).toMatchObject({ lastMatched: true, lastUserAgent: "SEB/3.10.1" });
});
