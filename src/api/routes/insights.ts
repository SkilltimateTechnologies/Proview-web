/** Live Monitor, dashboard, reports and per-report roster. Split out of index.ts; behaviour unchanged. */
import { labelRow } from "../lib/report-labels";
import { Hono } from "hono";
import { eq, ne, and, desc, inArray, sql as dsql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { requireAuth, requirePermission } from "../middleware/auth";
import { id } from "../lib/util";
import { presignGetCached } from "../lib/s3";
import { monitorTiming, MONITOR_POLL_MS, MONITOR_BUDGET_MS } from "../lib/watchdog";
import { isEligible, matchesCohort, loadRoster, loadRosters, ensureOptInOnlyLoaded } from "../lib/roster";
import { integrityRollup } from "../lib/integrity-rollup";
import { attemptOwners } from "../lib/attempt-owner";
import { evidenceMeter } from "../lib/tenant-quota";
import { EMPTY_ROLLUP, loadAttemptRollups, rollupAvg } from "../lib/report-rollup";
import { examEffStatus, isConcluded, isReportable, toMs, type StatusExam } from "../lib/exam-status";
import { type Vars, directory, getGlobalSettings, FRAME_EVENT_TYPES, isFrameEvent, getMonitorSnapshot } from "../core";

export const insightsRoutes = new Hono<{ Variables: Vars }>()
  // =================== LIVE MONITOR ===================
  .get("/monitor", requireAuth, requirePermission("liveMonitor"), async (c) => {
    const p = c.get("profile")!;
    const tid = p.tenantId;
    if (!tid) return c.json({ live: [], nextScheduled: null, health: null }, 200);

    // Every open Live Monitor tab polls this endpoint (every 15s), and during an exam
    // several invigilators watch at once. The payload is identical for everyone in
    // the tenant, so build it ONCE and share it: concurrent callers join the
    // in-flight promise, and callers within the cache window get the last result.
    // This is what stops N invigilators turning into N x the database load — the
    // single biggest reason the monitor seized up during a live exam.
    const snapshot = await getMonitorSnapshot(tid);
    // Ship the watchdog verdict with the payload so a slow monitor is visible to
    // the invigilator looking at the screen, not only in the server logs. This is
    // outside the cached snapshot because the timing changes per build.
    const t = monitorTiming();
    return c.json(
      {
        ...snapshot,
        health: {
          degraded: t.degraded,
          lastBuildMs: t.lastBuildMs,
          worstBuildMs: t.worstBuildMs,
          budgetMs: MONITOR_BUDGET_MS,
          pollMs: MONITOR_POLL_MS,
        },
      },
      200,
    );
  })


  // =================== DASHBOARD ===================
  .get("/dashboard", requireAuth, requirePermission("dashboard"), async (c) => {
    const p = c.get("profile")!;
    const tid = p.tenantId;
    if (!tid) return c.json({ stats: null, classAvg: [], trend: [], topStudents: [], classToppers: [] }, 200);

    // An exam counts toward results once it is either explicitly finished OR its
    // window has closed (deadline passed). Drafts never count. This mirrors the
    // effective-status logic used by the reports endpoint so the dashboard stays
    // consistent with what admins see under Reports.
    const nowMs = Date.now();
    // Optional period filter: from / to are YYYY-MM-DD (inclusive). Scopes every
    // finished-exam-derived stat to assessments conducted within the window.
    const fromQ = (c.req.query("from") ?? "").trim();
    const toQ = (c.req.query("to") ?? "").trim();
    const fromMs = fromQ ? new Date(`${fromQ}T00:00:00`).getTime() : null;
    const toMs = toQ ? new Date(`${toQ}T23:59:59.999`).getTime() : null;
    const conductedMs = (e: { endAt: any; startAt: any; createdAt: any }) => {
      const raw = e.endAt ?? e.startAt ?? e.createdAt;
      const t = raw ? new Date(raw).getTime() : NaN;
      return Number.isNaN(t) ? null : t;
    };
    const inPeriod = (e: { endAt: any; startAt: any; createdAt: any }) => {
      if (fromMs === null && toMs === null) return true;
      const t = conductedMs(e);
      if (t === null) return false;
      if (fromMs !== null && t < fromMs) return false;
      if (toMs !== null && t > toMs) return false;
      return true;
    };
    const allExams = await db.select().from(schema.exams).where(and(eq(schema.exams.tenantId, tid), ne(schema.exams.status, "draft"))).orderBy(schema.exams.createdAt);
    const finishedExams = allExams.filter((e) => {
      const isFinished = e.status === "finished" || (() => {
        const end = e.endAt ? new Date(e.endAt).getTime() : null;
        return end != null && !Number.isNaN(end) && nowMs > end;
      })();
      return isFinished && inPeriod(e);
    });
    const examIds = finishedExams.map((e) => e.id);
    // Only the three columns the dashboard uses. Full attempt rows (user agent,
    // timestamps, flags) for every attempt of every finished exam were read on each
    // load — 2,520 wide rows today, growing with every exam.
    const atts = examIds.length
      ? await db
          .select({ examId: schema.attempts.examId, studentId: schema.attempts.studentId, score: schema.attempts.score })
          .from(schema.attempts)
          .where(inArray(schema.attempts.examId, examIds))
      : [];
    const graded = atts.filter((a) => a.score != null);

    const avg = graded.length ? graded.reduce((s, a) => s + (a.score ?? 0), 0) / graded.length : 0;
    const passRate = graded.length ? (graded.filter((a) => (a.score ?? 0) >= 40).length / graded.length) * 100 : 0;

    // class-wise average. Students and classes come from the directory cache: the
    // dashboard only needs them to label and group scores, and re-reading 1,124
    // rows on every load was most of this endpoint's latency.
    const classIdx = await directory.classIndex(tid);
    const studentIdx = await directory.studentIndex(tid);
    const classes = classIdx.all;
    const students = studentIdx.all;
    const stuClass = new Map(students.map((s) => [s.id, s.classId]));
    const classScores = new Map<string, number[]>();
    for (const a of graded) {
      const cid = stuClass.get(a.studentId);
      if (!cid) continue;
      if (!classScores.has(cid)) classScores.set(cid, []);
      classScores.get(cid)!.push(a.score ?? 0);
    }
    const classAvg = classes
      .map((cl) => {
        const arr = classScores.get(cl.id) ?? [];
        if (!arr.length) return null;
        return { code: cl.code, avg: Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10 };
      })
      .filter((x): x is { code: string; avg: number } => x != null);

    // trend across finished exams (avg per exam)
    const trend = finishedExams.slice(-6).map((e) => {
      const ea = graded.filter((a) => a.examId === e.id);
      return { name: e.title.length > 8 ? e.title.slice(0, 8) : e.title, avg: ea.length ? Math.round((ea.reduce((s, a) => s + (a.score ?? 0), 0) / ea.length) * 10) / 10 : 0 };
    });

    // top students overall (avg score per student)
    const stuScores = new Map<string, number[]>();
    for (const a of graded) {
      if (!stuScores.has(a.studentId)) stuScores.set(a.studentId, []);
      stuScores.get(a.studentId)!.push(a.score ?? 0);
    }
    const smap = new Map(students.map((s) => [s.id, s]));
    const clmap = new Map(classes.map((cl) => [cl.id, cl]));
    const topStudents = [...stuScores.entries()]
      .map(([sid, arr]) => {
        const s = smap.get(sid);
        const cl = s?.classId ? clmap.get(s.classId) : null;
        return { name: s?.name ?? "—", rollNo: s?.rollNo ?? "", classCode: cl?.code ?? "—", avg: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 };
      })
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 8);

    // class toppers (only classes that actually have a graded student)
    const classToppers = classes
      .map((cl) => {
        const best = [...stuScores.entries()]
          .map(([sid, arr]) => ({ s: smap.get(sid), avg: arr.reduce((a, b) => a + b, 0) / arr.length }))
          .filter((x) => x.s?.classId === cl.id)
          .sort((a, b) => b.avg - a.avg)[0];
        if (!best?.s) return null;
        return { code: cl.code, name: best.s.name, score: Math.round(best.avg * 10) / 10 };
      })
      .filter((t): t is { code: string; name: string; score: number } => t != null);

    // settings for limit alert (platform-global)
    const s = await getGlobalSettings();
    const judge0Pct = s ? Math.round((s.judge0Used / Math.max(1, s.judge0Limit)) * 100) : 0;
    const aiPct = s ? Math.round((s.aiUsed / Math.max(1, s.aiLimit)) * 100) : 0;

    return c.json(
      {
        stats: {
          totalStudents: students.length,
          avg: Math.round(avg * 10) / 10,
          passRate: Math.round(passRate),
          completed: finishedExams.length,
        },
        classAvg,
        trend,
        topStudents,
        classToppers,
        limits: { judge0Pct, aiPct, judge0Used: s?.judge0Used ?? 0, judge0Limit: s?.judge0Limit ?? 0, aiUsed: s?.aiUsed ?? 0, aiLimit: s?.aiLimit ?? 0 },
      },
      200,
    );
  })

  // =================== REPORTS (finished only for TPO) ===================
  .get("/reports", requireAuth, requirePermission("reports"), async (c) => {
    const p = c.get("profile")!;
    const tid = p.tenantId;
    if (!tid) return c.json({ exams: [] }, 200);
    // Reports only cover CONDUCTED assessments — never drafts/scheduled-in-future.
    // TPO sees finished only; others see finished + live (in-progress). A scheduled
    // exam whose start time has passed is effectively live, so include it for
    // non-TPO roles too (mirrors the Live Monitor / Schedule list behaviour).
    const now = Date.now();
    const endMs = (e: { endAt: Date | number | string | null }) => toMs(e.endAt);
    // A scheduled exam whose start time has passed is effectively LIVE — until its
    // window (endAt + admin extra time + hold time) closes, after which it has ENDED.
    // Derivation lives in lib/exam-status so every caller agrees; see effStatus below.
    const effStatus = (e: StatusExam) => examEffStatus(e, now);
    const allExams = await db.select().from(schema.exams).where(eq(schema.exams.tenantId, tid)).orderBy(desc(schema.exams.createdAt));
    // Filter on DERIVED status, never the raw column. The raw column is admin intent
    // and never self-updates, so an exam conducted last month still reads "scheduled":
    // matching `status === "finished"` here hid every conducted exam from TPOs.
    const rows = allExams.filter((e) => (p.role === "tpo" ? isConcluded(e, now) : isReportable(e, now)));
    // All students in the tenant — used to size the "assigned" cohort per exam.
    // Directory cache: the list only counts eligibility, it never returns students.
    const allStudents = (await directory.studentIndex(tid)).enabled;
    const reportRosters = await loadRosters(rows.map((e) => e.id));
    const assignedFor = (e: { id: string; classId: string | null; sectionIds: string[] | null }) =>
      allStudents.filter((stu) => isEligible(e, stu, reportRosters.get(e.id))).length;
    // Per-exam counts in ONE grouped aggregate, not one query per exam.
    //
    // This used to be `rows.map(async (e) => select().from(attempts).where(examId))`
    // inside a Promise.all: a remote round trip per exam, each shipping every column
    // of every attempt row, to end up with seven integers per card. At 11 exams and
    // 2,520 stored attempts that meant transferring every attempt ever taken on every
    // open of the reports page — and because it scales with exam HISTORY rather than
    // with load, it got worse every week on its own. SQLite counts better than we do;
    // see lib/report-rollup.ts for the definitions (which are subtle: passed/failed
    // key off `score IS NOT NULL`, not status).
    const rollups = await loadAttemptRollups(db, rows.map((e) => e.id));
    const withStats = rows.map((e) => {
      const r = rollups.get(e.id) ?? EMPTY_ROLLUP;
      const assigned = assignedFor(e);
      // absent = assigned students who never finished nor are in progress, but ONLY
      // once the exam deadline has passed (before that they may still show up).
      const deadline = endMs(e);
      const deadlineOver = e.status === "finished" || (deadline !== null && now >= deadline);
      const absent = deadlineOver ? Math.max(0, assigned - r.finished - r.inProgress) : 0;
      // "wrote" retained for backward compat (== finished).
      return { ...e, status: effStatus(e), attempts: r.attempts, assigned, finished: r.finished, inProgress: r.inProgress, absent, wrote: r.finished, graded: r.graded, passed: r.passed, failed: r.failed, avg: rollupAvg(r) };
    });
    // Newest assessment date first (startAt if set, else createdAt).
    const dateVal = (e: (typeof withStats)[number]) => {
      const d = e.startAt ?? e.createdAt;
      return d ? new Date(d as any).getTime() : 0;
    };
    withStats.sort((a, b) => dateVal(b) - dateVal(a));
    return c.json({ exams: withStats }, 200);
  })
  .get("/reports/:examId", requireAuth, requirePermission("reports"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("examId");
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid));
    if (!ex || ex.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
    // Same rule as the /reports list: gate on DERIVED status, not the raw column, or a
    // TPO who can see a conducted exam in the list gets a 403 when opening it.
    if (p.role === "tpo" && !isConcluded(ex)) return c.json({ message: "Report not available until finished" }, 403);
    // Only the columns the report uses (the user-agent column alone is up to 300
    // characters per row).
    const atts = await db
      .select({
        id: schema.attempts.id,
        studentId: schema.attempts.studentId,
        sectionSnapshot: schema.attempts.sectionSnapshot,
        score: schema.attempts.score,
        status: schema.attempts.status,
        submittedAt: schema.attempts.submittedAt,
        disconnected: schema.attempts.disconnected,
        answeredCount: schema.attempts.answeredCount,
      })
      .from(schema.attempts)
      .where(eq(schema.attempts.examId, eid));
    // Total questions on the exam so the report can show "answered N/total" —
    // counted by the database instead of shipping every exam_questions row back.
    const [qCount] = await db
      .select({ n: dsql<number>`count(*)` })
      .from(schema.examQuestions)
      .where(eq(schema.examQuestions.examId, eid));
    const totalQuestions = Number(qCount?.n ?? 0);
    // Directory cache. This report used to read all 1,124 students and every class
    // on EVERY open, purely to label attempt rows with a name and a section code.
    const studentIdx = await directory.studentIndex(p.tenantId!);
    const smap = studentIdx.byId;
    const clmap = (await directory.classIndex(p.tenantId!)).byId;
    // Prefer the section frozen on the attempt (historical truth). Fall back to the
    // student's current section for older rows that predate the snapshot.
    const sectionOf = (sid: string) => {
      const cid = smap.get(sid)?.classId;
      return cid ? clmap.get(cid)?.code ?? "" : "";
    };
    const sectionOfAttempt = (a: { studentId: string; sectionSnapshot?: string | null }) =>
      a.sectionSnapshot && a.sectionSnapshot.trim() ? a.sectionSnapshot : sectionOf(a.studentId);
    // Branch + home section (lib/report-labels.ts) so staff can follow up by
    // department; ELITE students count under their home branch.
    const classByCode = new Map([...clmap.values()].map((cl) => [cl.code, cl]));
    const labels = (sid: string, section: string) => labelRow(section, smap.get(sid), clmap, classByCode);
    // How many webcam frames does each attempt actually have?
    //
    // WHY IT IS ON THE ROSTER. A student sat four exams whose camera never produced a
    // single frame. Nothing failed loudly: he started, submitted, scored 95, and the
    // only trace was an empty gallery on a review page nobody had a reason to open.
    // Surfacing the count here means "no proctoring evidence" is visible without
    // opening anyone, which is the difference between finding this in two months and
    // finding it the same day.
    //
    // ONE STATEMENT, NOT N+1. A naive count per row is ~200 round trips on a full
    // cohort. This is a single grouped aggregate over `integrity_events` restricted to
    // the frame types, chunked only to stay under SQLite's bound-variable cap, and it
    // rides `integrity_attempt_type_idx` (attempt_id, type).
    const frameCounts = new Map<string, number>();
    const failCounts = new Map<string, number>();
    const attIds = atts.map((a) => a.id);
    for (let i = 0; i < attIds.length; i += 200) {
      const slice = attIds.slice(i, i + 200);
      const agg = await db
        .select({ attemptId: schema.integrityEvents.attemptId, type: schema.integrityEvents.type, n: dsql<number>`count(*)` })
        .from(schema.integrityEvents)
        .where(and(
          inArray(schema.integrityEvents.attemptId, slice),
          inArray(schema.integrityEvents.type, [...FRAME_EVENT_TYPES, "snapshot_failed"]),
        ))
        .groupBy(schema.integrityEvents.attemptId, schema.integrityEvents.type);
      for (const row of agg) {
        const target = row.type === "snapshot_failed" ? failCounts : frameCounts;
        target.set(row.attemptId, (target.get(row.attemptId) ?? 0) + Number(row.n ?? 0));
      }
    }
    const attemptRows = atts
      .map((a) => ({ attemptId: a.id, studentId: a.studentId, name: smap.get(a.studentId)?.name ?? "—", rollNo: smap.get(a.studentId)?.rollNo ?? "", email: smap.get(a.studentId)?.email ?? null, section: sectionOfAttempt(a), ...labels(a.studentId, sectionOfAttempt(a)), score: a.score, status: a.status, submittedAt: a.submittedAt, absent: false, disconnected: !!a.disconnected, answeredCount: a.answeredCount ?? 0, frames: frameCounts.get(a.id) ?? 0, snapshotFailures: failCounts.get(a.id) ?? 0 }))
      .sort((x, y) => (y.score ?? -1) - (x.score ?? -1));
    // Assigned-but-absent students: enrolled in the exam's cohort yet no attempt row.
    // Only surface them once the exam window has closed (before that they may still
    // show up). Rendered as "A" (absent) rather than a misleading 0.
    const attemptedIds = new Set(atts.map((a) => a.studentId));
    const endAtMs = ex.endAt == null ? null : typeof ex.endAt === "number" ? ex.endAt : new Date(ex.endAt as any).getTime();
    const deadlineOver = ex.status === "finished" || (endAtMs !== null && !Number.isNaN(endAtMs) && Date.now() >= endAtMs);
    const exRoster = await loadRoster(eid);
    const absentRows = !deadlineOver
      ? []
      // `.all` (not `.enabled`) because the filter below drops disabled students
      // itself — keeping that explicit check preserves the previous behaviour.
      : studentIdx.all
          .filter((stu) => {
            if (stu.enabled === false) return false;
            if (attemptedIds.has(stu.id)) return false;
            return isEligible(ex, stu, exRoster);
          })
          .map((stu) => ({ attemptId: `absent-${stu.id}`, studentId: stu.id, name: stu.name ?? "—", rollNo: stu.rollNo ?? "", email: stu.email ?? null, section: sectionOf(stu.id), ...labels(stu.id, sectionOf(stu.id)), score: null, status: "absent", submittedAt: null, absent: true, disconnected: false, answeredCount: 0, frames: 0, snapshotFailures: 0 }))
          // Grouped by branch, then section, then roll number, so each department
          // finds its own absentees together.
          .sort((x, y) => x.branch.localeCompare(y.branch) || x.section.localeCompare(y.section) || x.rollNo.localeCompare(y.rollNo));
    // Attempts (scored, sorted high→low) first, absentees last.
    const rows = [...attemptRows, ...absentRows];
    // Whether snapshots are expected AT ALL right now. Proctoring is one global config
    // blob, so this is the only honest gate available: with webcam snapshots switched
    // off every attempt legitimately has zero frames, and the roster must not then
    // light up every student as a camera failure.
    const gsReport = await getGlobalSettings();
    const snapshotsExpected = { ...schema.DEFAULT_PROCTORING, ...(gsReport.proctoring ?? {}) }.webcamSnapshots !== false;
    return c.json({ exam: ex, results: rows, totalQuestions, snapshotsExpected }, 200);
  })
  .get("/reports/:examId/attempt/:attemptId", requireAuth, requirePermission("reports"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("examId");
    const aid = c.req.param("attemptId");
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid));
    if (!ex || ex.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
    const [att] = await db.select().from(schema.attempts).where(eq(schema.attempts.id, aid));
    if (!att || att.examId !== eid) return c.json({ message: "Not found" }, 404);
    const [stu] = await db.select().from(schema.students).where(eq(schema.students.id, att.studentId));
    const ans = await db.select().from(schema.answers).where(eq(schema.answers.attemptId, aid));
    const aMap = new Map(ans.map((a) => [a.questionId, a]));
    // Order questions by the exam's question order so the answer sheet reads top-to-bottom.
    const eqs = await db.select().from(schema.examQuestions).where(eq(schema.examQuestions.examId, eid)).orderBy(schema.examQuestions.order);
    const orderedQids = eqs.length ? eqs.map((e) => e.questionId) : ans.map((a) => a.questionId);
    const qs = orderedQids.length ? await db.select().from(schema.questions).where(inArray(schema.questions.id, orderedQids)) : [];
    const qmap = new Map(qs.map((q) => [q.id, q]));
    const answers = orderedQids.map((qid, i) => {
      const q = qmap.get(qid);
      const a = aMap.get(qid);
      const eqRow = eqs.find((e) => e.questionId === qid);
      return {
        id: a?.id ?? `q-${i}`,
        prompt: q?.prompt ?? "—",
        type: q?.type ?? "—",
        topic: q?.topic ?? null,
        options: q?.options ?? null,
        correct: q?.correct ?? null,
        explanation: (q?.meta as any)?.explanation ?? null,
        response: a?.response ?? null,
        score: a?.score ?? null,
        maxScore: a?.maxScore ?? eqRow?.points ?? q?.points ?? null,
        aiNotes: a?.aiNotes ?? null,
        autoGraded: a?.autoGraded ?? null,
      };
    });
    // Proctoring evidence: every recorded violation for this attempt, newest
    // first, with a short-lived signed URL for the webcam snapshot captured at
    // that moment (null when no snapshot was captured / storage was unavailable).
    const evRows = await db.select().from(schema.integrityEvents)
      .where(eq(schema.integrityEvents.attemptId, aid))
      .orderBy(desc(schema.integrityEvents.at));
    // Two separate streams for the reviewer: `integrity` is misconduct (what needs a
    // decision), `snapshots` is the routine timed camera trail (what proves the
    // student sat there alone). Mixing them buries the real flags in noise.
    const sign = async (ev: typeof evRows[number]) => {
      let photo: string | null = null;
      // Cached: the drawer re-polls every 10s while an attempt is live, and this
      // signs up to 900 URLs per open. The URL is valid 24h; the cache hands out
      // ones with at least 12h left.
      if (ev.photoUrl) { try { photo = await presignGetCached(ev.photoUrl); } catch { photo = null; } }
      // Same-origin proxy path for the same object. The presigned URL above is
      // fine for <img>, but a cross-origin fetch() to Tigris is blocked unless
      // the bucket carries a CORS policy — so bulk download (ZIP) reads through
      // our own /api/files/* route instead, which also never expires.
      const proxy = ev.photoUrl ? `/api/files/${ev.photoUrl}` : null;
      return { id: ev.id, type: ev.type, detail: ev.detail, at: ev.at, photo, proxy };
    };
    const integrity = await Promise.all(
      evRows.filter((ev) => !isFrameEvent(ev.type)).slice(0, 300).map(sign),
    );
    // Capped — at the ~27s cadence a 3h attempt is ~400 frames, so the cap has to
    // clear that or the tail of a long attempt silently disappears from review.
    const snapshots = (await Promise.all(
      evRows.filter((ev) => isFrameEvent(ev.type) && ev.photoUrl).slice(0, 600).map(sign),
    )).filter((s) => s.photo);
    return c.json({
      exam: { id: ex.id, title: ex.title },
      student: { name: stu?.name ?? "—", rollNo: stu?.rollNo ?? "", email: stu?.email ?? null },
      attempt: { score: att.score, status: att.status, submittedAt: att.submittedAt, startedAt: att.startedAt },
      answers,
      integrity,
      snapshots,
    }, 200);
  })

  // =================== ROSTER (per-exam add / remove / mark-absent) ===================
  // Search enabled students in the tenant who are NOT already eligible for the
  // exam — used by the "Add student to assessment" picker.
  .get("/reports/:examId/roster/candidates", requireAuth, requirePermission("reports"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("examId");
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid));
    if (!ex || ex.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
    const roster = await loadRoster(eid);
    const allStudents = (await directory.studentIndex(p.tenantId!)).enabled;
    const clmap = (await directory.classIndex(p.tenantId!)).byId;
    const candidates = allStudents
      // Not already eligible (so the picker only offers students you can add).
      .filter((stu) => !isEligible(ex, stu, roster))
      .filter((stu) => {
        if (!q) return true;
        return (stu.name ?? "").toLowerCase().includes(q) || (stu.rollNo ?? "").toLowerCase().includes(q) || (stu.email ?? "").toLowerCase().includes(q);
      })
      .slice(0, 30)
      .map((stu) => ({ id: stu.id, name: stu.name ?? "—", rollNo: stu.rollNo ?? "", email: stu.email ?? null, section: stu.classId ? clmap.get(stu.classId)?.code ?? "" : "" }));
    return c.json({ candidates }, 200);
  })

  // Add a student to an assessment (ad-hoc, outside their cohort). Idempotent:
  // clears any prior "remove" override and records an "add" override.
  .post("/reports/:examId/roster/add", requireAuth, requirePermission("reports"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("examId");
    const b = await c.req.json().catch(() => ({}));
    const studentId = String(b.studentId ?? "");
    if (!studentId) return c.json({ message: "studentId required" }, 400);
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid));
    if (!ex || ex.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
    const [stu] = await db.select().from(schema.students).where(eq(schema.students.id, studentId));
    if (!stu || stu.tenantId !== p.tenantId) return c.json({ message: "Student not found" }, 404);
    // Drop any existing override for this student, then add.
    await db.delete(schema.examRoster).where(and(eq(schema.examRoster.examId, eid), eq(schema.examRoster.studentId, studentId)));
    // Only need an explicit "add" row when the student isn't already a cohort match.
    await ensureOptInOnlyLoaded();
    if (!matchesCohort(ex, stu)) {
      await db.insert(schema.examRoster).values({ id: id("rst"), examId: eid, studentId, mode: "add", createdBy: p.userId ?? null });
    }
    return c.json({ ok: true }, 200);
  })

  // Remove a student from an assessment entirely: records a "remove" override
  // (so they drop off the roster/report) AND deletes any attempt + answers they
  // had for this exam, so they are not counted at all.
  .post("/reports/:examId/roster/remove", requireAuth, requirePermission("reports"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("examId");
    const b = await c.req.json().catch(() => ({}));
    const studentId = String(b.studentId ?? "");
    if (!studentId) return c.json({ message: "studentId required" }, 400);
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid));
    if (!ex || ex.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
    // Delete this student's attempt(s) + answers for the exam.
    const atts = await db.select().from(schema.attempts).where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, studentId)));
    for (const a of atts) {
      await db.delete(schema.answers).where(eq(schema.answers.attemptId, a.id));
      await db.delete(schema.integrityEvents).where(eq(schema.integrityEvents.attemptId, a.id));
    }
    // Deleting events can free the top rowid, and the monitor's evidence cache reads
    // forward from a rowid watermark - a reused rowid would land below it. Force a
    // full rebuild; see lib/integrity-rollup.ts.
    integrityRollup.invalidateAll();
    // The attempts themselves are gone, so the owner cache must not keep
    // authorizing their former owners; see lib/attempt-owner.ts.
    attemptOwners.invalidateAll();
    // Evidence rows are going with them, so the stored-evidence counters must
    // be dropped too or a re-sit starts life already at its ceiling.
    evidenceMeter.invalidateAll();
    if (atts.length) await db.delete(schema.attempts).where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, studentId)));
    // Record the remove override (clear any prior override first).
    await db.delete(schema.examRoster).where(and(eq(schema.examRoster.examId, eid), eq(schema.examRoster.studentId, studentId)));
    await db.insert(schema.examRoster).values({ id: id("rst"), examId: eid, studentId, mode: "remove", createdBy: p.userId ?? null });
    return c.json({ ok: true }, 200);
  })

  // Bulk-remove students from the assessment (checkbox selection on the report).
  .post("/reports/:examId/roster/bulk-remove", requireAuth, requirePermission("reports"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("examId");
    const b = await c.req.json().catch(() => ({}));
    const studentIds = Array.isArray(b.studentIds) ? b.studentIds.map((s: unknown) => String(s)).filter(Boolean) : [];
    if (!studentIds.length) return c.json({ message: "studentIds required" }, 400);
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid));
    if (!ex || ex.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
    let removed = 0;
    for (const studentId of studentIds) {
      const atts = await db.select().from(schema.attempts).where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, studentId)));
      for (const a of atts) {
        await db.delete(schema.answers).where(eq(schema.answers.attemptId, a.id));
        await db.delete(schema.integrityEvents).where(eq(schema.integrityEvents.attemptId, a.id));
      }
      // Deleting events can free the top rowid, and the monitor's evidence cache reads
      // forward from a rowid watermark - a reused rowid would land below it. Force a
      // full rebuild; see lib/integrity-rollup.ts.
      integrityRollup.invalidateAll();
      // The attempts themselves are gone, so the owner cache must not keep
      // authorizing their former owners; see lib/attempt-owner.ts.
      attemptOwners.invalidateAll();
      // Evidence rows are going with them, so the stored-evidence counters must
      // be dropped too or a re-sit starts life already at its ceiling.
      evidenceMeter.invalidateAll();
      if (atts.length) await db.delete(schema.attempts).where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, studentId)));
      await db.delete(schema.examRoster).where(and(eq(schema.examRoster.examId, eid), eq(schema.examRoster.studentId, studentId)));
      await db.insert(schema.examRoster).values({ id: id("rst"), examId: eid, studentId, mode: "remove", createdBy: p.userId ?? null });
      removed++;
    }
    return c.json({ ok: true, removed }, 200);
  })

  // Mark a student Absent: they STAY on the report (as "A") but are counted
  // absent. Ensures they are roster-eligible, then deletes any attempt so they
  // fall through to the auto-absent path (assigned + no attempt + deadline).
  .post("/reports/:examId/roster/mark-absent", requireAuth, requirePermission("reports"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("examId");
    const b = await c.req.json().catch(() => ({}));
    const studentId = String(b.studentId ?? "");
    if (!studentId) return c.json({ message: "studentId required" }, 400);
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid));
    if (!ex || ex.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
    const [stu] = await db.select().from(schema.students).where(eq(schema.students.id, studentId));
    if (!stu || stu.tenantId !== p.tenantId) return c.json({ message: "Student not found" }, 404);
    // Delete any attempt + answers so they read as absent (never attempted).
    const atts = await db.select().from(schema.attempts).where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, studentId)));
    for (const a of atts) {
      await db.delete(schema.answers).where(eq(schema.answers.attemptId, a.id));
      await db.delete(schema.integrityEvents).where(eq(schema.integrityEvents.attemptId, a.id));
    }
    // Deleting events can free the top rowid, and the monitor's evidence cache reads
    // forward from a rowid watermark - a reused rowid would land below it. Force a
    // full rebuild; see lib/integrity-rollup.ts.
    integrityRollup.invalidateAll();
    // The attempts themselves are gone, so the owner cache must not keep
    // authorizing their former owners; see lib/attempt-owner.ts.
    attemptOwners.invalidateAll();
    // Evidence rows are going with them, so the stored-evidence counters must
    // be dropped too or a re-sit starts life already at its ceiling.
    evidenceMeter.invalidateAll();
    if (atts.length) await db.delete(schema.attempts).where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, studentId)));
    // Guarantee roster eligibility: clear a stray "remove"; add an "add" override
    // only if the student isn't already a cohort match.
    await db.delete(schema.examRoster).where(and(eq(schema.examRoster.examId, eid), eq(schema.examRoster.studentId, studentId), eq(schema.examRoster.mode, "remove")));
    await ensureOptInOnlyLoaded();
    if (!matchesCohort(ex, stu)) {
      const existing = await db.select().from(schema.examRoster).where(and(eq(schema.examRoster.examId, eid), eq(schema.examRoster.studentId, studentId), eq(schema.examRoster.mode, "add")));
      if (!existing.length) await db.insert(schema.examRoster).values({ id: id("rst"), examId: eid, studentId, mode: "add", createdBy: p.userId ?? null });
    }
    return c.json({ ok: true }, 200);
  });
