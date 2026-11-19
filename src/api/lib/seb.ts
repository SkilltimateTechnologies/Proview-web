/**
 * Optional "Require Safe Exam Browser" check for the exam API.
 *
 * The server never checked that an exam was taken in the Proview SEB client: a
 * student could open the student address in ordinary Chrome and sit the exam
 * there. Safe Exam Browser proves itself on every request with the header
 *
 *   X-SafeExamBrowser-ConfigKeyHash = SHA-256( full request URL + Config Key )
 *
 * where the Config Key is a 64-character hex value derived from the .seb file
 * (shown in SEB's Config Tool, Exam tab). An ordinary browser does not know the
 * key, so it cannot produce the hash for each URL.
 *
 * Off by default. Turn it on in Settings only after a lab test: with the keys
 * entered and the switch still off, the Settings page shows whether the last SEB
 * request matched. Several keys are allowed so a new .seb can be rolled out while
 * old installs still work.
 */
import { createHash } from "node:crypto";

export const SEB_REQUIRED_CODE = "seb_required";
export const SEB_REQUIRED_MESSAGE = "This exam must be taken in the Proview secure exam browser. Open the Proview Exam app on this computer and sign in there.";

const HEX64 = /^[0-9a-f]{64}$/;

/** Keep valid Config Keys only: 64 hex characters, lower-cased, de-duplicated, at most 10. */
export function normaliseConfigKeys(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,;]+/) : [];
  const out: string[] = [];
  for (const p of parts) {
    const k = String(p ?? "").trim().toLowerCase();
    if (HEX64.test(k) && !out.includes(k)) out.push(k);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * The URLs SEB may have hashed. Behind Cloudflare and Railway the server sees
 * plain http and possibly an internal host, so the public address is rebuilt
 * from the forwarded headers and from WEBSITE_URL as well.
 */
export function candidateUrls(requestUrl: string, headers: { get(name: string): string | null }, websiteUrl?: string): string[] {
  const out = new Set<string>();
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    return [];
  }
  const pathAndQuery = u.pathname + u.search;
  out.add(u.origin + pathAndQuery);
  const host = (headers.get("x-forwarded-host") || headers.get("host") || "").split(",")[0].trim();
  if (host) out.add(`https://${host}${pathAndQuery}`);
  if (websiteUrl) {
    try {
      out.add(new URL(websiteUrl).origin + pathAndQuery);
    } catch {
      /* ignore */
    }
  }
  return [...out];
}

export function configKeyHash(url: string, key: string): string {
  return createHash("sha256").update(url + key).digest("hex");
}

export type SebCheck = { seb: boolean; matched: boolean };

/** Does this request come from SEB with one of our configs? */
export function checkSeb(opts: { requestUrl: string; headers: { get(name: string): string | null }; keys: string[]; websiteUrl?: string }): SebCheck {
  const sent = (opts.headers.get("x-safeexambrowser-configkeyhash") || "").trim().toLowerCase();
  const ua = opts.headers.get("user-agent") || "";
  const seb = !!sent || /\bSEB\//.test(ua);
  if (!sent || !opts.keys.length) return { seb, matched: false };
  for (const url of candidateUrls(opts.requestUrl, opts.headers, opts.websiteUrl)) {
    for (const key of opts.keys) {
      if (configKeyHash(url, key) === sent) return { seb: true, matched: true };
    }
  }
  return { seb, matched: false };
}

/** Which requests the switch protects: the exam client's API and student sign-in. */
export function isSebProtectedPath(path: string): boolean {
  if (path === "/api/student/seb-check") return false;
  return /^\/api\/student\//.test(path) || path === "/api/students/verify-login";
}

/** What Settings shows: the most recent SEB request this server saw and whether it matched. */
export class SebMonitor {
  private last: { at: number; matched: boolean; userAgent: string } | null = null;
  constructor(private readonly now: () => number = Date.now) {}
  record(check: SebCheck, userAgent: string | null): void {
    if (!check.seb) return;
    this.last = { at: this.now(), matched: check.matched, userAgent: String(userAgent ?? "").slice(0, 200) };
  }
  status(): { lastSeenAt: string | null; lastMatched: boolean | null; lastUserAgent: string | null } {
    return this.last
      ? { lastSeenAt: new Date(this.last.at).toISOString(), lastMatched: this.last.matched, lastUserAgent: this.last.userAgent }
      : { lastSeenAt: null, lastMatched: null, lastUserAgent: null };
  }
}

export const sebMonitor = new SebMonitor();
