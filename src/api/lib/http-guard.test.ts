import { describe, expect, test } from "bun:test";
import { allowedOrigins, bodyLimitFor, BODY_LIMITS, isAllowedOrigin, safeEqual, storedFileHeaders, UPLOAD_TYPES } from "./http-guard";

describe("allowedOrigins", () => {
  test("production: our own site plus configured origins only", () => {
    const o = allowedOrigins({ NODE_ENV: "production", WEBSITE_URL: "https://proview.skilltimate.com/", RAILWAY_PUBLIC_DOMAIN: "proview-web.up.railway.app", ALLOWED_ORIGINS: "https://a.example, https://b.example/x" });
    expect(o).toContain("https://proview.skilltimate.com");
    expect(o).toContain("https://proview-web.up.railway.app");
    expect(o).toContain("https://a.example");
    expect(o).toContain("https://b.example");
    expect(o.some((x) => x.includes("localhost"))).toBe(false);
  });

  test("development also allows the local dev servers", () => {
    expect(allowedOrigins({})).toContain("http://localhost:3100");
  });

  test("the live domain is always allowed, even with WEBSITE_URL unset or stale", () => {
    expect(allowedOrigins({ NODE_ENV: "production", WEBSITE_URL: "https://old.runable.site" })).toContain("https://proview.skilltimate.com");
  });

  test("a malformed entry is skipped instead of crashing boot", () => {
    expect(() => allowedOrigins({ ALLOWED_ORIGINS: "http://[bad" })).not.toThrow();
  });

  test("isAllowedOrigin", () => {
    const o = ["https://proview.skilltimate.com"];
    expect(isAllowedOrigin("https://proview.skilltimate.com", o)).toBe(true);
    expect(isAllowedOrigin("https://evil.example", o)).toBe(false);
    expect(isAllowedOrigin(null, o)).toBe(false);
  });
});

describe("bodyLimitFor", () => {
  test("bulk imports get the most room", () => {
    expect(bodyLimitFor("/api/students/bulk")).toBe(BODY_LIMITS.bulk);
    expect(bodyLimitFor("/api/questions/bulk")).toBe(BODY_LIMITS.bulk);
  });
  test("exam client and public routes are tighter", () => {
    expect(bodyLimitFor("/api/student/attempts/a1/submit")).toBe(BODY_LIMITS.student);
    expect(bodyLimitFor("/api/students/verify-login")).toBe(BODY_LIMITS.student);
    expect(bodyLimitFor("/api/register/tkr")).toBe(BODY_LIMITS.student);
  });
  test("everything else is a staff write", () => {
    expect(bodyLimitFor("/api/questions")).toBe(BODY_LIMITS.staff);
    expect(bodyLimitFor("/api/students")).toBe(BODY_LIMITS.staff);
  });
  test("the ceiling sits above every route limit", () => {
    expect(BODY_LIMITS.ceiling).toBeGreaterThan(BODY_LIMITS.bulk);
  });
});

describe("stored files", () => {
  test("images show inline in a sandbox", () => {
    const h = storedFileHeaders("image/jpeg");
    expect(h["Content-Type"]).toBe("image/jpeg");
    expect(h["Content-Disposition"]).toBeUndefined();
    expect(h["Content-Security-Policy"]).toContain("sandbox");
  });
  test("HTML and SVG never render as a page on our origin", () => {
    for (const t of ["text/html", "image/svg+xml", "application/xhtml+xml", "", null]) {
      const h = storedFileHeaders(t);
      expect(h["Content-Type"]).toBe("application/octet-stream");
      expect(h["Content-Disposition"]).toBe("attachment");
    }
  });
  test("PDFs open inline", () => {
    expect(storedFileHeaders("application/pdf; charset=binary")["Content-Type"]).toBe("application/pdf");
  });
  test("every response forbids type sniffing", () => {
    expect(storedFileHeaders("image/png")["X-Content-Type-Options"]).toBe("nosniff");
  });
  test("upload allow-list has no scriptable types", () => {
    expect(UPLOAD_TYPES.has("text/html")).toBe(false);
    expect(UPLOAD_TYPES.has("image/svg+xml")).toBe(false);
  });
});

test("safeEqual", () => {
  expect(safeEqual("abc", "abc")).toBe(true);
  expect(safeEqual("abc", "abd")).toBe(false);
  expect(safeEqual("abc", "abcd")).toBe(false);
});
