/**
 * Small, pure request guards shared by the API and the Bun entry point.
 *
 * - allowedOrigins: which web origins may call the API from a browser. CORS and
 *   better-auth both used to accept ANY origin (they echoed back whatever the
 *   browser sent, with credentials allowed), which switches off their protection
 *   against requests forged by other websites.
 * - bodyLimitFor: the largest request body a route accepts. There was no limit at
 *   all below Bun's 128 MB default, so one oversized request could tie up memory
 *   and the database.
 * - upload types: staff uploads are served back from our own origin through
 *   /api/files, so an uploaded HTML or SVG file would run as Proview. Only images
 *   and PDFs are accepted, and anything else already in storage is served as a
 *   download inside a sandbox.
 */

const MB = 1024 * 1024;

/** Origins that may call the API from a browser. Requests without an Origin header (same-origin GETs, scripts, the SEB client's navigations) are unaffected. */
export function allowedOrigins(env: Record<string, string | undefined>): string[] {
  const out = new Set<string>(["https://proview.skilltimate.com"]);
  const add = (raw: string | undefined) => {
    if (!raw) return;
    for (const part of raw.split(",")) {
      const v = part.trim();
      if (!v) continue;
      try {
        out.add(new URL(v.includes("://") ? v : `https://${v}`).origin);
      } catch {
        /* ignore a malformed entry rather than refusing to boot */
      }
    }
  };
  add(env.WEBSITE_URL);
  add(env.RAILWAY_PUBLIC_DOMAIN);
  add(env.ALLOWED_ORIGINS);
  if (env.NODE_ENV !== "production") {
    for (const port of ["3000", "3100", "5173", "4173"]) {
      out.add(`http://localhost:${port}`);
      out.add(`http://127.0.0.1:${port}`);
    }
  }
  return [...out];
}

export function isAllowedOrigin(origin: string | null | undefined, allowed: readonly string[]): boolean {
  if (!origin) return false;
  return allowed.includes(origin.replace(/\/+$/, ""));
}

/** Largest accepted request body for a path, in bytes. */
export const BODY_LIMITS = {
  /** Bulk imports (students, questions): a few thousand rows of JSON. */
  bulk: 20 * MB,
  /** Staff console writes: questions with rubrics, exams with rosters, settings. */
  staff: 5 * MB,
  /** Exam client: answer saves, submit with every answer and integrity event. */
  student: 2 * MB,
  /** Hard ceiling enforced by Bun itself, for requests that send no Content-Length. */
  ceiling: 25 * MB,
} as const;

export function bodyLimitFor(path: string): number {
  if (/^\/api\/(students|questions)\/bulk$/.test(path)) return BODY_LIMITS.bulk;
  if (/^\/api\/(student\/|students\/verify-login$|register\/)/.test(path)) return BODY_LIMITS.student;
  return BODY_LIMITS.staff;
}

/** Content types staff may upload. Everything here is safe to show inline. */
export const UPLOAD_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"]);

export function normaliseContentType(raw: string | null | undefined): string {
  return String(raw ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * Response headers for a stored object served from our origin. Images and PDFs
 * show inline; any other type (an old upload, or something written by another
 * tool) downloads instead of rendering, so it can never run script as Proview.
 */
export function storedFileHeaders(contentType: string | null | undefined): Record<string, string> {
  const type = normaliseContentType(contentType);
  const headers: Record<string, string> = { "X-Content-Type-Options": "nosniff" };
  if (type.startsWith("image/") && type !== "image/svg+xml") {
    headers["Content-Type"] = type;
    headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
  } else if (type === "application/pdf") {
    headers["Content-Type"] = type;
  } else {
    headers["Content-Type"] = "application/octet-stream";
    headers["Content-Disposition"] = "attachment";
    headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
  }
  return headers;
}

/** Constant-time string comparison for secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
