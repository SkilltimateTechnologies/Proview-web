/** Health, session, uploads and the file proxy. Split out of index.ts; behaviour unchanged. */
import { Hono } from "hono";
import { normaliseClientReport, RateWindow, reportError } from "../lib/observe";

const clientErrorWindow = new RateWindow(120, 60_000);
import { eq, sql as dsql } from "drizzle-orm";
import { db, dbConfig, dbStats } from "../database";
import * as schema from "../database/schema";
import { INDEX_STATE, REQUIRED_COLUMNS, REQUIRED_PERF_INDEXES, REQUIRED_UNIQUE_INDEXES } from "../database/invariants";
import { requireAuth, requireSuperAdmin, requirePermission } from "../middleware/auth";
import { normaliseContentType, safeEqual, storedFileHeaders, UPLOAD_TYPES } from "../lib/http-guard";
import { id } from "../lib/util";
import { presignPut, getObject } from "../lib/s3";
import { monitorTiming, recentExamChecks, failingExamChecks, checkExamData, MONITOR_POLL_MS, MONITOR_BUDGET_MS } from "../lib/watchdog";
import { backups } from "../lib/backups-runtime";
import { bulkResetHandler } from "../routes/bulk-student-passwords";
import { type Vars, settingsCache, examCache, examQuestionsCache, directory, bulkStudentPasswords } from "../core";

export const systemRoutes = new Hono<{ Variables: Vars }>()
  // Browser errors from the exam screen and the admin console (lib/observe.ts).
  // Public on purpose: a crash can happen before or after sign-in. Capped at 120
  // reports a minute across everyone, and trimmed, so it cannot flood the logs.
  .post("/client-errors", async (c) => {
    if (!clientErrorWindow.take()) return c.body(null, 204);
    const b = await c.req.json().catch(() => null);
    const r = normaliseClientReport(b ?? {});
    if (!r) return c.body(null, 204);
    const err = Object.assign(new Error(r.message), { name: r.name, stack: r.stack });
    reportError(err, { source: "browser", url: r.url, userAgent: c.req.header("user-agent")?.slice(0, 200), requestId: c.get("requestId"), extra: { kind: r.kind } });
    return c.body(null, 204);
  })
  .all("/rpc/*", requireAuth, requirePermission("users"), async (c) => {
    const result = await bulkResetHandler.handle(c.req.raw, {
      prefix: "/api/rpc",
      context: { profile: c.get("profile"), service: bulkStudentPasswords },
    });
    return result.response ?? c.json({ message: "Not found" }, 404);
  })
  // Health doubles as the visibility surface for the database uniqueness
  // guarantees asserted at boot. If a required unique index could not be put in
  // place, duplicate rows can silently corrupt scores again — so that must be
  // observable from outside the process, not buried in a startup log. Returns
  // 503 in that state so uptime monitoring actually catches it.
  .get("/health", (c) => {
    const inv = INDEX_STATE;
    const monitor = monitorTiming();
    const badExams = failingExamChecks();
    // Anyone may ask whether the server is up; only a signed-in super admin (or a
    // caller holding HEALTH_TOKEN, for scripts) sees the internals: database
    // counters, runtime version, backup state, exam checks.
    const p = c.get("profile");
    const token = process.env.HEALTH_TOKEN;
    const sent = c.req.header("x-health-token");
    const detailed = (p?.role === "super_admin" && p.enabled) || (!!token && !!sent && safeEqual(sent, token));
    if (inv.checkedAt && !inv.ok) {
      return detailed
        ? c.json({ status: "degraded", invariants: inv, monitor, examChecks: badExams }, 503)
        : c.json({ status: "degraded" }, 503);
    }
    // A slow Live Monitor or an exam that finished with bad data is reported but
    // does NOT 503: the exam server is still serving students correctly and must
    // stay in the load balancer. It shows up as "warn" for whoever is looking.
    const warn = monitor.degraded || badExams.length > 0;
    if (!detailed) return c.json({ status: warn ? "warn" : "ok" }, 200);
    return c.json(
      {
        status: warn ? "warn" : "ok",
        invariants: { ok: inv.ok, checkedAt: inv.checkedAt },
        monitor,
        examChecks: badExams,
        // Statements sent to the remote database since boot, plus what the read
        // caches are holding. The scale incident was a round-trip problem, so this
        // is the number to watch during an exam: divide the delta by the requests
        // served and you have the cost per request.
        // Production (Railway/Nixpacks) runs an older Bun than development, which is
        // what broke logins on 2026-11-19. Reported so the version is never a guess.
        runtime: { bun: typeof Bun !== "undefined" ? Bun.version : null },
        // Advisory only: a failed or stale backup never turns health red (rule 3).
        backups: backups.status(),
        db: {
          queries: dbStats.queries,
          // Connection layer: per-lane statements in flight (running + queued),
          // the peak since boot, statements that hit the deadline, and the slowest
          // statement in the last minute. A lane whose `pending` keeps climbing is
          // the database falling behind; `timeouts` rising means it stopped answering.
          lanes: dbStats.lanes,
          config: dbConfig,
          cached: {
            settings: settingsCache.size,
            exams: examCache.size,
            examQuestions: examQuestionsCache.size,
            // Tenants whose student/class directory is warm. Admin pages used to
            // re-read the whole students table per request; these two counters are
            // how you tell the directory cache is actually being hit.
            directoryStudents: directory.stats().students,
            directoryClasses: directory.stats().classes,
          },
        },
      },
      200,
    );
  })

  // Full uniqueness/consistency audit of the live database. Admin-only, run on
  // demand or from a scheduled check: confirms the unique indexes exist AND that
  // no duplicate rows or impossible scores have appeared. Cheap enough to poll.
  .get("/admin/invariants", requireAuth, requireSuperAdmin, async (c) => {
    const indexes = await Promise.all(
      REQUIRED_UNIQUE_INDEXES.map(async (spec) => {
        // GROUP BY every column in the spec, not the first two. This used to be
        // `const [a, b] = spec.columns`, which assumed every unique index was a
        // two-column one; a single-column spec (grade_jobs_attempt_uq) made `b`
        // undefined, and `dsql.raw(undefined)` throws — 500ing this whole audit
        // endpoint. Same fix as countDuplicateGroups in invariants.ts.
        const groupBy = spec.columns.join(", ");
        const present = (await db.all<{ name: string }>(
          dsql`SELECT name FROM sqlite_master WHERE type='index' AND name=${spec.name}`,
        )).length > 0;
        const dupes = Number((await db.all<{ c: number }>(
          dsql`SELECT COUNT(*) AS c FROM (SELECT 1 FROM ${dsql.raw(spec.table)} GROUP BY ${dsql.raw(groupBy)} HAVING COUNT(*) > 1)`,
        ))[0]?.c ?? 0);
        return { index: spec.name, table: spec.table, columns: spec.columns, present, duplicateGroups: dupes, guards: spec.guards };
      }),
    );
    // Additive columns `schema.ts` depends on. A missing one is worse than a missing
    // index — every query on the table would fail — so it is reported alongside them.
    const columns = await Promise.all(
      REQUIRED_COLUMNS.map(async (spec) => {
        const present = Number((await db.all<{ c: number }>(
          dsql`SELECT COUNT(*) AS c FROM pragma_table_info(${spec.table}) WHERE name = ${spec.column}`,
        ))[0]?.c ?? 0) > 0;
        return { table: spec.table, column: spec.column, type: spec.type, present, guards: spec.guards };
      }),
    );
    // Performance indexes. Informational: a missing one makes the app slow, not
    // wrong, so it is reported but deliberately kept out of `ok`. It still has to be
    // verifiable from outside the process — nothing in the deploy path runs a
    // migration, so this is how we confirm a deploy actually created them.
    const perfIndexes = await Promise.all(
      REQUIRED_PERF_INDEXES.map(async (spec) => {
        const present = (await db.all<{ name: string }>(
          dsql`SELECT name FROM sqlite_master WHERE type='index' AND name=${spec.name}`,
        )).length > 0;
        return { index: spec.name, table: spec.table, columns: spec.columns, present, guards: spec.guards };
      }),
    );
    const impossible = Number((await db.all<{ c: number }>(
      dsql`SELECT COUNT(*) AS c FROM attempts WHERE score > 100 OR score < 0`,
    ))[0]?.c ?? 0);
    // A graded attempt whose answer max_score total differs from its paper total
    // is the signature of the duplicate bug (inflated) or of lost rows (deflated).
    const denomMismatch = Number((await db.all<{ c: number }>(
      dsql`SELECT COUNT(*) AS c FROM attempts a JOIN exams e ON e.id = a.exam_id
           WHERE a.status IN ('graded','submitted')
             AND (SELECT COALESCE(SUM(COALESCE(x.max_score,0)),0) FROM answers x WHERE x.attempt_id = a.id) <> e.total_points`,
    ))[0]?.c ?? 0);
    // HEURISTIC (informational, does not affect `ok`): the same person entered twice
    // under two different roll numbers. The unique index cannot catch this — the roll
    // numbers genuinely differ, usually by one mistyped character — so the only signal
    // is an identical name inside the same section. Surfaced so a TPO can review and
    // merge instead of finding out when a student appears twice in a report.
    const suspects = await db.all<{ classId: string; name: string; rolls: string; n: number }>(dsql`
      SELECT class_id AS classId, lower(trim(name)) AS name,
             group_concat(roll_no) AS rolls, COUNT(*) AS n
      FROM students
      GROUP BY tenant_id, class_id, lower(trim(name))
      HAVING COUNT(*) > 1
      ORDER BY n DESC
      LIMIT 50
    `);
    // Roll numbers that cannot be right — a pasted email is the usual culprit.
    const malformedRolls = await db.all<{ id: string; rollNo: string; name: string }>(dsql`
      SELECT id, roll_no AS rollNo, name FROM students
      WHERE roll_no LIKE '%@%'
         OR roll_no <> trim(roll_no)
         OR roll_no <> upper(roll_no)
      LIMIT 50
    `);
    const ok = indexes.every((i) => i.present && i.duplicateGroups === 0) && columns.every((c2) => c2.present) && impossible === 0 && denomMismatch === 0;
    return c.json({
      ok,
      bootCheck: INDEX_STATE,
      indexes,
      perfIndexes,
      columns,
      attemptsWithImpossibleScore: impossible,
      attemptsWithDenominatorMismatch: denomMismatch,
      duplicateStudentSuspects: suspects.map((s) => ({ ...s, n: Number(s.n) })),
      malformedRollNumbers: malformedRolls,
      // Runtime self-monitoring, so one page answers "is it healthy right now?"
      // as well as "is the stored data sound?".
      liveMonitor: { ...monitorTiming(), pollMs: MONITOR_POLL_MS, budgetMs: MONITOR_BUDGET_MS },
      examChecks: recentExamChecks(),
    }, ok ? 200 : 500);
  })

  // Re-run the per-exam data check on demand. The automatic run happens when an
  // exam finishes grading; this is for re-checking an older exam (e.g. after a
  // manual score edit) without waiting for anything.
  .post("/admin/exam-check/:examId", requireAuth, requireSuperAdmin, async (c) => {
    const examId = c.req.param("examId");
    const [exam] = await db.select().from(schema.exams).where(eq(schema.exams.id, examId)).limit(1);
    if (!exam) return c.json({ error: "Exam not found" }, 404);
    const result = await checkExamData(examId);
    if (!result) return c.json({ error: "Check failed; see server logs" }, 500);
    return c.json(result, 200);
  })

  // ---- TEMP diagnostic: verify DB connectivity + env presence ----
  // Super-admin only: it reports which secrets are set and the start of the
  // database URL, which must not be readable by anyone on the internet.
  .get("/__diag", requireAuth, requireSuperAdmin, async (c) => {
    const env = {
      DATABASE_URL: process.env.DATABASE_URL
        ? `${process.env.DATABASE_URL.slice(0, 14)}… (len ${process.env.DATABASE_URL.length})`
        : "MISSING",
      DATABASE_AUTH_TOKEN: process.env.DATABASE_AUTH_TOKEN
        ? `set (len ${process.env.DATABASE_AUTH_TOKEN.length})`
        : "MISSING",
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ? "set" : "MISSING",
      WEBSITE_URL: process.env.WEBSITE_URL ?? "MISSING",
    };
    try {
      const [u] = await db.select().from(schema.user).limit(1);
      return c.json({ db: "ok", userFound: !!u, env }, 200);
    } catch (e) {
      return c.json(
        { db: "error", error: e instanceof Error ? e.message : String(e), env },
        500,
      );
    }
  })

  // ---- current session context ----
  .get("/me", requireAuth, async (c) => {
    const user = c.get("user")!;
    const profile = c.get("profile")!;
    let tenant = null;
    if (profile.tenantId) {
      const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, profile.tenantId));
      tenant = t ?? null;
    }
    return c.json({ user, profile, tenant }, 200);
  })

  // ---- file upload presign (client -> tigris directly) ----
  .post("/upload/presign", requireAuth, async (c) => {
    const { name, contentType } = await c.req.json();
    // Uploads are served back from our own origin (/api/files), so only types that
    // cannot run script are accepted: images and PDFs.
    const type = normaliseContentType(contentType);
    if (!UPLOAD_TYPES.has(type)) return c.json({ message: "Only PNG, JPEG, WebP, GIF or PDF files can be uploaded." }, 400);
    const key = `uploads/${Date.now()}-${id()}-${String(name ?? "file").slice(0, 120).replace(/[^\w.-]/g, "_")}`;
    const url = await presignPut(key, type);
    // Tigris objects are not public-read (raw endpoint URL returns 403), so we
    // serve uploads through our own same-origin proxy route below.
    return c.json({ url, key, publicUrl: `/api/files/${key}` }, 200);
  })

  // ---- authenticated file proxy (streams object from S3) ----
  // Deliberately NOT public. Objects under `integrity/` are student webcam
  // photos, so an unauthenticated reader holding (or guessing) a key could pull
  // faces straight out of the bucket. Every read requires a signed-in staff
  // session; snapshot keys additionally require the `reports` permission and are
  // scoped to the caller's own college, so a TPO cannot read another college's
  // evidence by key alone.
  .get("/files/*", requireAuth, async (c) => {
    const key = c.req.path.replace(/^\/api\/files\//, "");
    if (!key) return c.text("Not found", 404);
    // Reject traversal / absolute keys before they reach storage.
    if (key.includes("..") || key.startsWith("/")) return c.text("Not found", 404);
    // Database backups contain every college's data and every password hash. They
    // are never served through the app, to anyone: restore from the bucket itself.
    if (key.startsWith("backups/")) return c.text("Not found", 404);

    if (key.startsWith("integrity/")) {
      const profile = c.get("profile");
      if (!profile) return c.json({ message: "Unauthorized" }, 401);
      const staff =
        profile.role === "super_admin" ||
        profile.role === "college_admin" ||
        (profile.role === "tpo" && profile.permissions?.reports === true);
      if (!staff) return c.json({ message: "Forbidden" }, 403);
      // Keys are written as `integrity/<attemptId>/<file>`; confirm the attempt
      // belongs to this college before streaming the frame.
      if (profile.role !== "super_admin") {
        const attemptId = key.split("/")[1] ?? "";
        if (!attemptId) return c.text("Not found", 404);
        const [own] = await db
          .select({ tenantId: schema.exams.tenantId })
          .from(schema.attempts)
          .innerJoin(schema.exams, eq(schema.attempts.examId, schema.exams.id))
          .where(eq(schema.attempts.id, attemptId))
          .limit(1);
        if (!own || own.tenantId !== profile.tenantId) return c.json({ message: "Forbidden" }, 403);
      }
    }

    try {
      const out = await getObject(key);
      if (!out.Body) return c.text("Not found", 404);
      const buf = await out.Body.transformToByteArray();
      // Cast: transformToByteArray gives Uint8Array<ArrayBufferLike>, Hono wants
      // an ArrayBuffer-backed view. Same bytes, no copy.
      return c.body(buf as unknown as Uint8Array<ArrayBuffer>, 200, {
        // Images and PDFs show inline; anything else downloads in a sandbox and can
        // never render as a page on our origin (lib/http-guard.ts).
        ...storedFileHeaders(out.ContentType),
        // `private`: the response is authorised per-session, so shared/proxy
        // caches must never hold a copy. Browser caching is still fine —
        // object keys are content-addressed and never rewritten.
        "Cache-Control": "private, max-age=31536000, immutable",
      });
    } catch {
      return c.text("Not found", 404);
    }
  });
