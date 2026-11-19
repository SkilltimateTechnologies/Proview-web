/**
 * API entry: app-wide middleware (body limit, database lane, SEB check, CORS,
 * gzip, auth) and the route modules, mounted in their original order. Hono runs
 * handlers in registration order, so this order is behaviour.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { newRequestId, reportError } from "./lib/observe";
import { cors } from "hono/cors";
import { gzipJson } from "./lib/gzip-json";
import { auth } from "./auth";
import { runInLane } from "./database";
import * as schema from "./database/schema";
import { authCache, authMiddleware } from "./middleware/auth";
import { checkSeb, isSebProtectedPath, normaliseConfigKeys, sebMonitor, SEB_REQUIRED_CODE, SEB_REQUIRED_MESSAGE } from "./lib/seb";
import { bodyLimitFor, isAllowedOrigin } from "./lib/http-guard";
import { type Vars, getGlobalSettings, invalidateStudentExamLists, STUDENT_LANE_PATH, ALLOWED_ORIGINS } from "./core";
import { systemRoutes } from "./routes/system";
import { registrationRoutes } from "./routes/registration";
import { staffRoutes } from "./routes/staff";
import { studentsRoutes } from "./routes/students";
import { studentClientRoutes } from "./routes/student-client";
import { questionBankRoutes } from "./routes/question-bank";
import { examsRoutes } from "./routes/exams";
import { insightsRoutes } from "./routes/insights";
import { settingsRoutes } from "./routes/settings";

const app = new Hono<{ Variables: Vars }>()
  // Every response carries X-Request-Id; server errors quote it, so a student's
  // screenshot of an error leads straight to the log line.
  .use(async (c, next) => {
    const rid = (c.req.header("x-request-id") || "").slice(0, 40) || newRequestId();
    c.set("requestId", rid);
    await next();
    try {
      c.header("X-Request-Id", rid);
    } catch {
      /* a response with read-only headers keeps its own */
    }
  })
  // Refuse an oversized body before anything reads it. Bun's own ceiling
  // (server.ts) covers requests that send no Content-Length.
  .use(async (c, next) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > 0 && len > bodyLimitFor(c.req.path)) {
      return c.json({ message: "This request is too large." }, 413);
    }
    return next();
  })
  .use((c, next) => runInLane(STUDENT_LANE_PATH.test(c.req.path) ? "student" : "admin", next))
  // Optional "Require Safe Exam Browser" (Settings → Proctoring, lib/seb.ts). Off
  // by default; with no Config Keys entered it never refuses anyone, so it cannot
  // lock every student out by accident.
  .use(async (c, next) => {
    if (!isSebProtectedPath(c.req.path)) return next();
    const gs = await getGlobalSettings();
    const pc = { ...schema.DEFAULT_PROCTORING, ...(gs.proctoring ?? {}) };
    const keys = normaliseConfigKeys(pc.sebConfigKeys);
    const check = checkSeb({ requestUrl: c.req.url, headers: c.req.raw.headers, keys, websiteUrl: process.env.WEBSITE_URL });
    sebMonitor.record(check, c.req.header("user-agent") ?? null);
    if (pc.requireSeb && keys.length && !check.matched) {
      return c.json({ ok: false, code: SEB_REQUIRED_CODE, message: SEB_REQUIRED_MESSAGE }, 403);
    }
    return next();
  })
  // Only our own site may make credentialed cross-origin calls. This used to echo
  // back ANY origin with credentials allowed.
  .use(cors({ origin: (origin) => (isAllowedOrigin(origin, ALLOWED_ORIGINS) ? origin : null), credentials: true, exposeHeaders: ["set-auth-token"] }))
  // gzip large JSON reads (GET only). NOT hono/compress: it needs the web
  // CompressionStream, which production's older Bun lacks — it 500'd every API
  // call. See lib/gzip-json.ts.
  .use(gzipJson())
  .on(["GET", "POST"], "/api/auth/*", (c) => {
    // A sign-out must not stay honoured by the identity cache for its TTL.
    if (/sign-out|revoke/.test(c.req.path)) authCache.invalidate();
    return auth.handler(c.req.raw);
  })
  .basePath("api")
  .use("*", authMiddleware)
  // Any write to an exam, its roster or a registration can change what a student's
  // dashboard should show; drop the short exam-list cache after every such write
  // (see getStudentExamListBase). One rule here instead of a call in each handler,
  // so a future roster endpoint cannot forget it.
  .use("*", async (c, next) => {
    await next();
    if (c.req.method !== "GET" && /^\/api\/(exams|reports\/[^/]+\/roster|register\/)/.test(c.req.path)) {
      invalidateStudentExamLists();
    }
  })
  .route("/", systemRoutes)
  .route("/", registrationRoutes)
  .route("/", staffRoutes)
  .route("/", studentsRoutes)
  .route("/", studentClientRoutes)
  .route("/", questionBankRoutes)
  .route("/", examsRoutes)
  .route("/", insightsRoutes)
  .route("/", settingsRoutes);

// One handler for every unexpected error in any route: a structured log line,
// Sentry and the alert webhook when configured (lib/observe.ts), and a clean
// message with the request id instead of a raw 500.
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  const rid = c.get("requestId");
  const p = c.get("profile");
  reportError(err, { source: "server", requestId: rid, method: c.req.method, path: c.req.path, userId: p?.userId ?? null, role: p?.role ?? null });
  return c.json({ message: `Something went wrong on the server. Please try again. (ref ${rid ?? "-"})`, requestId: rid }, 500);
});

export type AppType = typeof app;
export default app;
