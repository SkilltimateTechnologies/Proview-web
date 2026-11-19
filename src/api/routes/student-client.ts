/** The exam client's API: exam list, paper, start, autosave, heartbeat, submit, review, run code. Split out of index.ts; behaviour unchanged. */
import { Hono } from "hono";
import { eq, and, inArray, sql as dsql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { checkRunSize, runLimiter } from "../lib/run-code-guard";
import { checkSeb, normaliseConfigKeys, sebMonitor } from "../lib/seb";
import { id, effectiveEndMs, submitAvailableAtMs } from "../lib/util";
import { finalizeAttempt, hasContent } from "../lib/grade-queue";
import { presignPut } from "../lib/s3";
import { verifyStudentToken } from "../lib/student-token";
import { OPTION_ORDER_TOKEN, optionTranslator, tokenIsCurrent } from "../lib/option-order";
import { judge0Queue, resolveJudge0Config } from "../lib/judge0-queue";
import { isEligible, loadRoster, ensureOptInOnlyLoaded } from "../lib/roster";
import { heartbeats } from "../lib/heartbeat-queue";
import { attemptOwners } from "../lib/attempt-owner";
import { concurrencyGate, tenantQuotas } from "../lib/tenant-quota";
import { resultsUnlocked } from "../lib/exam-status";
import { type Vars, directory, examInProgressCache, hasExamInProgress, minSubmitMinutes, getGlobalSettings, getExamForPolling, getExamQuestionSet, getExamPaper, getStudentExamListBase, submitsInFlight, INTEGRITY_PREFIX, persistIntegrityEvents, answerTranslator } from "../core";

export const studentClientRoutes = new Hono<{ Variables: Vars }>()
  // =================== STUDENT (desktop client) ===================
  // All student routes authenticate via the "X-Student-Token" header (HMAC token
  // minted at /students/verify-login). No Better Auth session involved.

  // List exams visible to the logged-in student (their class/section), with
  // attempt state so the client can show scheduled vs finished.
  .get("/student/exams", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const [stu] = await db.select().from(schema.students).where(eq(schema.students.id, sid)).limit(1);
    if (!stu || !stu.enabled) return c.json({ message: "Unauthorized" }, 401);

    // Tenant-wide half (exams, roster overrides, question counts) from a 5s cache:
    // see getStudentExamListBase. Only the per-student reads below are live.
    const base = await getStudentExamListBase(stu.tenantId);
    // The cached list is shared; make sure the opt-in-only (ELITE) set is loaded
    // before eligibility, as loadRosters would have done on a cold path.
    await ensureOptInOnlyLoaded();

    // Only exams targeting the student's class (or all-class exams), matching
    // section if scoped, honouring any ad-hoc roster add/remove overrides.
    const visible = base.exams.filter((e) => isEligible(e, stu, base.rosters.get(e.id)));

    const exIds = visible.map((e) => e.id);
    const myAttempts = exIds.length
      ? await db.select().from(schema.attempts).where(and(inArray(schema.attempts.examId, exIds), eq(schema.attempts.studentId, sid)))
      : [];
    const aMap = new Map(myAttempts.map((a) => [a.examId, a]));
    const qMap = base.questionCounts;

    const now = Date.now();
    const exams = visible.map((e) => {
      const a = aMap.get(e.id);
      const startMs = e.startAt ? new Date(e.startAt).getTime() : null;
      const endMs = e.endAt ? new Date(e.endAt).getTime() : null;
      let phase: string;
      if (a && (a.status === "submitted" || a.status === "graded")) phase = "finished";
      else if (a && a.status === "in_progress") phase = "in_progress";
      // Exam window has closed and the student never submitted → Absent.
      else if (endMs && now > endMs) phase = "absent";
      // Only show the full-screen "live" gate when the exam is actually live:
      // either the admin flipped it to "live", or it's scheduled and its start
      // time has arrived. A scheduled exam with no start time (or a future
      // start) is still just upcoming — never auto-treated as live.
      else if (e.status === "live" || (startMs && now >= startMs)) phase = "available";
      else phase = "upcoming";
      // Results stay locked until the exam closes for everyone — admin finished it,
      // or the window INCLUDING extra time and holds has closed (lib/exam-status).
      // This stops early finishers leaking the answer key to students still writing.
      const resultsReady = resultsUnlocked(e, now);
      return {
        id: e.id,
        title: e.title,
        status: e.status,
        durationMin: e.durationMin,
        totalPoints: e.totalPoints,
        questionCount: qMap.get(e.id) ?? 0,
        startAt: e.startAt,
        endAt: e.endAt,
        phase,
        resultsReady,
        attempt: a ? { id: a.id, status: a.status, score: a.score, submittedAt: a.submittedAt } : null,
      };
    });
    // serverNow lets the waiting room count down on the server's clock, not the PC's.
    return c.json({ exams, serverNow: new Date(), student: { id: stu.id, name: stu.name, rollNo: stu.rollNo, email: stu.email } }, 200);
  })

  // Full exam bundle for offline download: all questions with options (no answers).
  .get("/student/exams/:id/bundle", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const [stu] = await db.select().from(schema.students).where(eq(schema.students.id, sid)).limit(1);
    if (!stu) return c.json({ message: "Unauthorized" }, 401);
    const eid = c.req.param("id");
    const [exam] = await db.select().from(schema.exams).where(and(eq(schema.exams.id, eid), eq(schema.exams.tenantId, stu.tenantId))).limit(1);
    if (!exam) return c.json({ message: "Not found" }, 404);

    // Cached per exam (see getExamPaper): identical for every student.
    const { eqs, qs } = await getExamPaper(eid);
    const qById = new Map(qs.map((q) => [q.id, q]));
    // Shuffle each question's OPTIONS for this student too. Question order alone
    // left the answer key identical for everyone, so a paper keyed "B" on 55% of
    // its questions rewarded anyone who just pressed B all the way down. The
    // permutation is display-only: answers.response keeps storing the ORIGINAL
    // index, so grading and every already-graded attempt are untouched.
    const optOrder = optionTranslator(stu.id, exam.id, qs, true);
    // Ship only what the client needs to render — never the correct answer.
    const questions = eqs.map((eq2) => {
      const q = qById.get(eq2.questionId);
      const meta = (q?.meta ?? {}) as Record<string, unknown>;
      const safeMeta: Record<string, unknown> = {};
      if (q?.type === "coding") {
        safeMeta.language = meta.language;
        safeMeta.starter = meta.starter;
      }
      return {
        id: eq2.questionId,
        order: eq2.order,
        points: eq2.points,
        type: q?.type ?? "short",
        prompt: q?.prompt ?? "",
        options: optOrder.display(eq2.questionId, (q?.options as string[] | null) ?? null),
        difficulty: q?.difficulty ?? "medium",
        topic: q?.topic ?? null,
        meta: safeMeta,
      };
    });
    // Randomise question order per student — same questions, different sequence.
    // Deterministic seed (student + exam) keeps the order stable across reloads/resume.
    let seed = 0;
    const seedStr = `${stu.id}:${exam.id}`;
    for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
    const shuffled = [...questions];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const gs = await getGlobalSettings();
    // The SEB Config Keys stay on the server: a student holding them could forge
    // the SEB header from an ordinary browser.
    const { sebConfigKeys: _sebKeys, ...proctoring } = { ...schema.DEFAULT_PROCTORING, ...(gs.proctoring ?? {}) };
    return c.json({
      exam: { id: exam.id, title: exam.title, durationMin: exam.durationMin, totalPoints: exam.totalPoints, startAt: exam.startAt, endAt: exam.endAt },
      questions: shuffled,
      proctoring,
      // Tells the server which rendering scheme this paper was built with. The
      // client caches the bundle offline and echoes this back on every write, so a
      // paper rendered by an older build (original option order) is still read
      // correctly instead of being un-permuted twice. Not a secret — it identifies
      // the scheme, never the permutation.
      optionOrder: OPTION_ORDER_TOKEN,
    }, 200);
  })

  // Start (or resume) an attempt. Returns a server-anchored absolute endAt so the
  // timer can't be cheated by clock changes or app restarts.
  .post("/student/attempts/:examId/start", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const eid = c.req.param("examId");
    const [exam] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!exam) return c.json({ message: "Not found" }, 404);
    // Only eligible students (cohort match or explicitly added, not removed) may start.
    const [startStu] = await db.select().from(schema.students).where(eq(schema.students.id, sid)).limit(1);
    if (!startStu || !startStu.enabled || !isEligible(exam, startStu, await loadRoster(eid))) {
      return c.json({ message: "Not eligible for this exam" }, 403);
    }
    // The scheme token of the bundle the client actually rendered. Parsed up front
    // because it gets STAMPED ONTO THE ATTEMPT: once the exam is over the bundle is
    // gone from the client, so the review endpoint has no other way to know whether
    // this student saw shuffled options or the original order. NULL on every attempt
    // that predates this feature, which is exactly what makes old reviews render
    // byte-for-byte as before.
    const startBody = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const startScheme = tokenIsCurrent(startBody?.optionOrder) ? OPTION_ORDER_TOKEN : null;
    // Which device/browser is this paper being sat on? Proctoring is a CLIENT
    // capability, so when a webcam or fullscreen check silently never worked, this
    // string is the only thing that can answer "what was it running on?". Stamped
    // once, diagnostic only, and truncated because a UA is attacker-controlled text.
    const startUA = (c.req.header("user-agent") ?? "").trim().slice(0, 300) || null;

    // Always resolve to the OLDEST attempt for this (exam, student) pair. A stable
    // deterministic pick means /start /status /heartbeat /resume all agree on the
    // same row even if a legacy duplicate still exists.
    let [attempt] = await db.select().from(schema.attempts)
      .where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, sid)))
      .orderBy(schema.attempts.createdAt, schema.attempts.id).limit(1);
    if (attempt && (attempt.status === "submitted" || attempt.status === "graded")) {
      return c.json({ message: "Already submitted" }, 409);
    }
    const now = Date.now();

    // ---- Per-tenant concurrency ceiling (lib/tenant-quota.ts) ----
    // Checked ONLY where a new live sitter is admitted: an attempt about to be
    // created, or a not_started roster row about to go in_progress. An attempt
    // that is already in_progress falls straight through, so a reload, a resume
    // or a flaky network retry can never be refused by a quota — ejecting a
    // student from a paper they are halfway through would be worse than the
    // overload the ceiling exists to prevent.
    // Costs nothing until somebody sets a number: the resolved limit is null by
    // default and the count is never taken.
    const admitsNewSitter = !attempt || attempt.status === "not_started";
    if (admitsNewSitter) {
      const quota = await tenantQuotas.load(db, exam.tenantId, await getGlobalSettings());
      if (quota.maxConcurrentAttempts !== null) {
        const gate = await concurrencyGate.check(db, exam.tenantId, quota.maxConcurrentAttempts);
        if (!gate.allowed) {
          return c.json(
            {
              message: "Your college has reached its limit of simultaneous exam attempts. Please wait a moment and press Start again.",
              code: "tenant_concurrency_quota",
              live: gate.live,
              limit: gate.limit,
            },
            429,
          );
        }
      }
    }

    if (!attempt) {
      const startedAt = new Date(now);
      // Freeze the student's section onto the attempt. Reports read this snapshot, so
      // a later section change (e.g. promotion into ELITE) never rewrites history.
      let sectionSnapshot: string | null = null;
      if (startStu.classId) {
        // From the tenant's cached section list (15s TTL, dropped on any section
        // edit) instead of one more query per student at the start bell.
        sectionSnapshot = (await directory.classIndex(startStu.tenantId)).codeById.get(startStu.classId) ?? null;
      }
      // RACE-SAFE CREATE. A student clicking Start twice, a flaky network retry, or
      // SEB reloading the page fires several /start calls at once. Select-then-insert
      // lets every one of them insert a row (they all see an empty SELECT), which is
      // what produced up to 44 duplicate rows for one student. The unique index on
      // (exam_id, student_id) now makes only the first insert win; the losers catch
      // the conflict and re-read the winning row, so all callers converge on one attempt.
      try {
        [attempt] = await db.insert(schema.attempts)
          .values({ id: id("att"), examId: eid, studentId: sid, status: "in_progress", startedAt, sectionSnapshot, optionOrder: startScheme, userAgent: startUA })
          .returning();
      } catch {
        [attempt] = await db.select().from(schema.attempts)
          .where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, sid)))
          .orderBy(schema.attempts.createdAt, schema.attempts.id).limit(1);
      }
      // Lost the race AND could not read the winner (should not happen) — fail loudly
      // rather than continue with an undefined attempt.
      if (!attempt) return c.json({ message: "Could not start attempt, please retry" }, 503);
      if (attempt.status === "submitted" || attempt.status === "graded") {
        return c.json({ message: "Already submitted" }, 409);
      }
    } else if (attempt.status === "not_started") {
      [attempt] = await db.update(schema.attempts).set({ status: "in_progress", startedAt: new Date(now), optionOrder: startScheme }).where(eq(schema.attempts.id, attempt.id)).returning();
    }
    // Count this sitter against the cached live total, so a start burst inside one
    // cache window is gated on admissions rather than on a stale count.
    if (admitsNewSitter) concurrencyGate.note(exam.tenantId);
    // Mark the student as seen (drives Live Monitor online/offline). Also record the
    // display scheme if it is not on the attempt yet — an attempt created by an older
    // build, or by a /start that raced this one, still needs the stamp so its review
    // renders in the order the student saw. Only ever written when the client reports
    // the current scheme, and never overwritten with null.
    const stampScheme = startScheme !== null && attempt.optionOrder !== startScheme;
    // Same one-write rule for the user-agent: only ever filled in when the row has
    // none (an attempt created by an older build, or the /start that lost the race),
    // never overwritten — the FIRST device that opened the paper is the useful fact.
    const stampUA = startUA !== null && !attempt.userAgent;
    const startSet: Record<string, unknown> = { lastSeenAt: new Date(now) };
    if (stampScheme) startSet.optionOrder = startScheme;
    if (stampUA) startSet.userAgent = startUA;
    await db.update(schema.attempts).set(startSet).where(eq(schema.attempts.id, attempt.id));
    if (stampScheme) attempt = { ...attempt, optionOrder: startScheme };
    if (stampUA) attempt = { ...attempt, userAgent: startUA };
    // Return the server-saved answers so a resume/reopen on a FRESH browser
    // (cleared cache, different machine, SEB kiosk that wipes local storage)
    // restores the student's prior work instead of showing a blank exam. The
    // client merges these under its own local answers (local wins per-question).
    const startSaved = await db.select().from(schema.answers).where(eq(schema.answers.attemptId, attempt.id));
    // Stored responses are ORIGINAL option indices; the client renders against the
    // shuffled bundle, so translate them into ITS display order. Only when the
    // client reports the current scheme token — a client on an older cached bundle
    // sees the original order and must get its answers back untranslated.
    const startTrans = await answerTranslator(attempt.examId, sid, startScheme);
    const startAnswers: Record<string, unknown> = {};
    for (const a of startSaved) if (a.response != null) startAnswers[a.questionId] = startTrans.toDisplay(a.questionId, a.response);
    // Absolute deadline includes admin extra-minutes + global hold time.
    const endAtMs = effectiveEndMs(exam, attempt, now);
    const submitAt = submitAvailableAtMs(exam, attempt, await minSubmitMinutes(), now);
    return c.json({ attemptId: attempt.id, startedAt: attempt.startedAt, endAt: new Date(endAtMs), submitAvailableAt: new Date(Math.min(submitAt, endAtMs)), serverNow: new Date(now), durationMin: exam.durationMin, pausedMs: attempt.pausedMs ?? 0, held: !!exam.heldAt, answers: startAnswers }, 200);
  })

  // Read-only status probe. Used by the client on mount to detect an in-progress
  // attempt after a page refresh WITHOUT mutating state (never transitions
  // not_started -> in_progress like /start does). Returns the server-anchored
  // endAt when the attempt is already running, so the timer stays un-cheatable.
  .get("/student/attempts/:examId/status", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const eid = c.req.param("examId");
    // Cached read: this is a poll, and the exam row is identical for every student.
    const exam = await getExamForPolling(eid);
    if (!exam) return c.json({ message: "Not found" }, 404);
    const [attempt] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, sid))).orderBy(schema.attempts.createdAt, schema.attempts.id).limit(1);
    const now = Date.now();
    if (!attempt) {
      return c.json({ status: "not_started", attemptId: null, startedAt: null, endAt: null, serverNow: new Date(now), held: false }, 200);
    }
    if (attempt.status === "in_progress") {
      // Refresh the seen timestamp (drives the Live Monitor online dot) and
      // return the live deadline. This is the only side effect here.
      await db.update(schema.attempts).set({ lastSeenAt: new Date(now) }).where(eq(schema.attempts.id, attempt.id));
      const endAtMs = effectiveEndMs(exam, attempt, now);
      // Include server-saved answers so a refresh/reopen resume on a fresh
      // browser restores prior work rather than a blank exam (client merges
      // these under its local answers).
      // Two columns, not the whole row: a coding answer's response is the big field
      // and the score/feedback columns are not used here.
      const stSaved = await db
        .select({ questionId: schema.answers.questionId, response: schema.answers.response })
        .from(schema.answers)
        .where(eq(schema.answers.attemptId, attempt.id));
      // Same translation as /start: stored indices are original, the client's screen
      // is in ITS shuffled display order. GET, so the scheme token arrives as a query
      // param rather than in a body.
      const stTrans = await answerTranslator(attempt.examId, sid, c.req.query("optionOrder"));
      const stAnswers: Record<string, unknown> = {};
      for (const a of stSaved) if (a.response != null) stAnswers[a.questionId] = stTrans.toDisplay(a.questionId, a.response);
      const submitAt = submitAvailableAtMs(exam, attempt, await minSubmitMinutes(), now);
      return c.json({ status: "in_progress", attemptId: attempt.id, startedAt: attempt.startedAt, endAt: new Date(endAtMs), submitAvailableAt: new Date(Math.min(submitAt, endAtMs)), serverNow: new Date(now), held: !!exam.heldAt, answers: stAnswers }, 200);
    }
    return c.json({ status: attempt.status, attemptId: attempt.id, startedAt: attempt.startedAt, endAt: null, serverNow: new Date(now), held: false, score: attempt.score }, 200);
  })

  // Resume a locked exam after an internet drop. The client reports how long it
  // was offline (offlineMs); we add that to pausedMs so the deadline shifts by the
  // same amount (timer effectively froze during the outage). Returns the new endAt.
  .post("/student/attempts/:examId/resume", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const eid = c.req.param("examId");
    const [exam] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!exam) return c.json({ message: "Not found" }, 404);
    const [attempt] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, sid))).orderBy(schema.attempts.createdAt, schema.attempts.id).limit(1);
    if (!attempt) return c.json({ message: "No attempt to resume" }, 404);
    if (attempt.status === "submitted" || attempt.status === "graded") return c.json({ message: "Already submitted" }, 409);
    const b = await c.req.json().catch(() => ({}));
    const now = Date.now();
    // Prefer server-measured pause (lastPausedAt) when present; fall back to the
    // client-reported offline duration. Clamp to the exam's total duration.
    let offlineMs = Number(b.offlineMs);
    if (!Number.isFinite(offlineMs) || offlineMs < 0) offlineMs = 0;
    if (attempt.lastPausedAt) {
      const serverGap = now - new Date(attempt.lastPausedAt).getTime();
      if (serverGap > offlineMs) offlineMs = serverGap;
    }
    offlineMs = Math.min(offlineMs, exam.durationMin * 60_000);
    const newPaused = (attempt.pausedMs ?? 0) + Math.round(offlineMs);
    await db.update(schema.attempts).set({ pausedMs: newPaused, lastPausedAt: null }).where(eq(schema.attempts.id, attempt.id));
    const startedMs = attempt.startedAt ? new Date(attempt.startedAt).getTime() : now;
    // Base = startedAt + duration capped by the window; add pausedMs on top so the
    // outage time extends the deadline beyond the window cap.
    let base = startedMs + exam.durationMin * 60_000;
    if (exam.endAt) base = Math.min(base, new Date(exam.endAt).getTime());
    const endAtMs = base + newPaused;
    return c.json({ attemptId: attempt.id, endAt: new Date(endAtMs), serverNow: new Date(now), pausedMs: newPaused }, 200);
  })

  // Mark that an exam was paused (internet lost). Records lastPausedAt so the
  // server can measure the true outage even if the client under-reports.
  .post("/student/attempts/:examId/pause", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const eid = c.req.param("examId");
    const [attempt] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, sid))).orderBy(schema.attempts.createdAt, schema.attempts.id).limit(1);
    if (!attempt) return c.json({ message: "No attempt" }, 404);
    if (attempt.status === "submitted" || attempt.status === "graded") return c.json({ ok: true }, 200);
    if (!attempt.lastPausedAt) {
      await db.update(schema.attempts).set({ lastPausedAt: new Date() }).where(eq(schema.attempts.id, attempt.id));
    }
    return c.json({ ok: true }, 200);
  })

  // Heartbeat: the running client pings this every ~15s. Records lastSeenAt (for
  // the Live Monitor online/offline dot) and returns the current hold state +
  // the up-to-date absolute deadline (so an admin hold/resume or extra-time grant
  // is picked up by every student without a page reload).
  //
  // This is the highest-volume endpoint during an exam (1000 students / 15s ≈ 67
  // requests a second) and it used to cost three remote round trips each time:
  // read the exam, read the attempt, write lastSeenAt. It now costs ONE, and that
  // one is a READ — the exam row comes from a 3s coalesced cache (every student is
  // reading the same row), the attempt read below doubles as the row that
  // effectiveEndMs needs, and lastSeenAt is handed to the coalescing queue instead
  // of being written here. The queue folds all 67/s into one batched UPDATE every
  // 5s (see lib/heartbeat-queue.ts for the staleness budget); presence is the one
  // thing cheap enough to lose a few seconds of, and writes are both the scarce
  // quota (25M/month vs 2.5B reads) and the serialized resource on Turso.
  // The attempt select matches at most one row because `attempts_exam_student_uq`
  // makes (exam_id, student_id) unique, and that index is asserted on every boot
  // and reported by /api/health.
  .post("/student/heartbeat/:examId", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const eid = c.req.param("examId");
    const exam = await getExamForPolling(eid);
    if (!exam) return c.json({ message: "Not found" }, 404);
    const now = Date.now();
    // Narrow on purpose: only what effectiveEndMs and the queue need. Coding
    // attempts carry no wide columns here, but there is no reason to ship any.
    const [attempt] = await db
      .select({
        id: schema.attempts.id,
        startedAt: schema.attempts.startedAt,
        pausedMs: schema.attempts.pausedMs,
      })
      .from(schema.attempts)
      .where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, sid)))
      .limit(1);
    if (!attempt) return c.json({ message: "No attempt" }, 404);
    heartbeats.markSeen(attempt.id, now);
    const endAtMs = effectiveEndMs(exam, attempt, now);
    return c.json({ held: !!exam.heldAt, endAt: new Date(endAtMs), serverNow: new Date(now) }, 200);
  })

  // Per-answer autosave. The running client calls this the moment a student
  // answers a question and navigates (plus a short debounce while typing), and
  // flushes any offline-buffered answers here on reconnect. Upserts each answer
  // WITHOUT grading — grading happens only at submit / auto-submit. Keeping every
  // answer server-side in real time means a mid-exam disconnect no longer loses
  // work, and `answeredCount` gives reports an accurate "answered N/total".
  .post("/student/attempts/:attemptId/answers", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const aid = c.req.param("attemptId");
    const [attempt] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.id, aid), eq(schema.attempts.studentId, sid))).limit(1);
    if (!attempt) return c.json({ message: "Not found" }, 404);
    // Once submitted/graded the answer set is frozen — ignore late autosaves.
    if (attempt.status === "submitted" || attempt.status === "graded") {
      return c.json({ ok: true, frozen: true, answeredCount: attempt.answeredCount }, 200);
    }

    const body = await c.req.json().catch(() => ({}));
    const incoming: { questionId: string; response: unknown }[] = Array.isArray(body.answers)
      ? body.answers
      : body.questionId ? [{ questionId: body.questionId, response: body.response }] : [];

    // Restrict to questions that actually belong to this exam (ignore stray ids).
    // Cached per exam: this list is frozen while the exam runs, and it used to be
    // re-read on every autosave — then read AGAIN inside answerTranslator.
    const { questionIds } = await getExamQuestionSet(attempt.examId);
    const validQ = new Set(questionIds);

    // The client sends the option index it DISPLAYED. Options are shuffled per
    // student, so convert back to the original index before storing — the grader and
    // every report read original indices.
    const saveTrans = await answerTranslator(attempt.examId, sid, body?.optionOrder);

    // Upsert against answers_attempt_question_uq. The old select-then-insert had
    // the same race as /start: two autosaves in flight for one question both saw
    // no existing row and both inserted, and the grader then counted both rows.
    // Only `response` is touched here — never clobber a score the grader wrote.
    // One statement for the whole batch instead of one per answer. A reconnect
    // flush can carry every question in the paper, and each upsert was its own
    // remote round trip. Deduped by questionId first (keeping the latest value):
    // SQLite refuses to apply ON CONFLICT twice to the same row in one statement.
    const byQuestion = new Map<string, unknown>();
    for (const a of incoming) {
      if (!a || !validQ.has(a.questionId)) continue;
      byQuestion.set(a.questionId, a.response == null ? null : saveTrans.toOriginal(a.questionId, a.response));
    }
    const answerRows = [...byQuestion].map(([questionId, stored]) => ({
      id: id("ans"),
      attemptId: aid,
      questionId,
      response: stored,
      score: null,
      maxScore: null,
      autoGraded: false,
    }));
    // Chunked because SQLite/libSQL caps bound variables per statement.
    for (let i = 0; i < answerRows.length; i += 50) {
      await db.insert(schema.answers)
        .values(answerRows.slice(i, i + 50))
        .onConflictDoUpdate({
          target: [schema.answers.attemptId, schema.answers.questionId],
          // `excluded` is the row we just tried to insert — the same value the
          // per-answer upsert used to write, applied row by row by SQLite.
          set: { response: dsql`excluded.response` },
        });
    }

    // Recompute answeredCount from rows that carry real content. Only the response
    // column is read: `hasContent` is the one thing that decides this, and pulling
    // whole rows meant shipping every coding answer back over the wire.
    const rows = await db
      .select({ response: schema.answers.response })
      .from(schema.answers)
      .where(eq(schema.answers.attemptId, aid));
    const answeredCount = rows.filter((r) => hasContent(r.response)).length;
    // Backstop for the review stamp: /start may have run on an older build, or the
    // attempt may have been created by the auto-submit sweep, and the review endpoint
    // has no bundle to consult after the exam. Written at most once (only when it
    // differs) and never cleared, so a client on a stale bundle cannot un-stamp an
    // attempt that is genuinely being sat in shuffled order.
    const saveScheme = saveTrans.active && attempt.optionOrder !== OPTION_ORDER_TOKEN ? OPTION_ORDER_TOKEN : null;
    await db.update(schema.attempts)
      .set(saveScheme ? { answeredCount, lastSeenAt: new Date(), optionOrder: saveScheme } : { answeredCount, lastSeenAt: new Date() })
      .where(eq(schema.attempts.id, aid));

    return c.json({ ok: true, answeredCount }, 200);
  })

  // ---- Proctoring: flush integrity events as they happen ----
  // The running client posts every violation here immediately (camera loss, tab
  // switch, fullscreen exit, extra monitor, blocked copy/paste…) so the evidence
  // survives a crash, a kill-the-app cheat attempt, or a never-submitted attempt.
  // Events are still resent at submit as a backstop; persistIntegrityEvents
  // dedupes on (type, at).
  .post("/student/attempts/:attemptId/events", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const aid = c.req.param("attemptId");
    // Authorization is ALL this route needs from the attempt - nothing below reads
    // a single column off it. Answered from memory, because attemptId -> studentId
    // is written once and never updated; see lib/attempt-owner.ts.
    if (!(await attemptOwners.authorize(db, aid, sid))) return c.json({ message: "Not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const saved = await persistIntegrityEvents(aid, body.events ?? body.integrityEvents);
    return c.json({ ok: true, saved }, 200);
  })

  // ---- Proctoring: presigned upload URL for a violation snapshot ----
  // The client grabs a JPEG frame from the live webcam at the moment of a
  // violation, PUTs it straight to object storage with this URL, then attaches
  // the returned key to the event. Keys are scoped to the attempt's own prefix.
  .post("/student/attempts/:attemptId/snapshot-url", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const aid = c.req.param("attemptId");
    // Authorization is ALL this route needs from the attempt - nothing below reads
    // a single column off it. Answered from memory, because attemptId -> studentId
    // is written once and never updated; see lib/attempt-owner.ts.
    if (!(await attemptOwners.authorize(db, aid, sid))) return c.json({ message: "Not found" }, 404);
    const key = `${INTEGRITY_PREFIX(aid)}${Date.now()}-${id()}.jpg`;
    try {
      const url = await presignPut(key, "image/jpeg");
      return c.json({ ok: true, url, key }, 200);
    } catch {
      // Storage misconfigured — never block the exam over a snapshot.
      return c.json({ ok: false, url: null, key: null }, 200);
    }
  })

  // Submit an attempt: persist answers, auto-grade objective questions
  // immediately, and AI-grade subjective/coding on submit.
  .post("/student/attempts/:attemptId/submit", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const aid = c.req.param("attemptId");
    // Submitting ends "Run code" for this student (see hasExamInProgress).
    examInProgressCache.invalidate(sid);
    const [attempt] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.id, aid), eq(schema.attempts.studentId, sid))).limit(1);
    if (!attempt) return c.json({ message: "Not found" }, 404);
    if (attempt.status === "submitted" || attempt.status === "graded") return c.json({ ok: true, alreadySubmitted: true }, 200);

    // Minimum writing time (Settings → Proctoring). A submit before it is refused
    // unless the exam's own time is (nearly) up: the timer's automatic submit at
    // the deadline, a late starter cut short by the exam window, and the server
    // sweep are never blocked. During an admin hold the guard stands aside too.
    if (attempt.status === "in_progress") {
      const nowMs = Date.now();
      const exam = await getExamForPolling(attempt.examId);
      if (exam) {
        const submitAt = submitAvailableAtMs(exam, attempt, await minSubmitMinutes(), nowMs);
        const endMs = effectiveEndMs(exam, attempt, nowMs);
        if (nowMs < submitAt && nowMs < endMs - 60_000 && !exam.heldAt) {
          const mins = Math.ceil((submitAt - nowMs) / 60_000);
          return c.json(
            { ok: false, code: "too_early", submitAvailableAt: new Date(submitAt), message: `You can submit after ${mins} more minute${mins === 1 ? "" : "s"}. Keep working on your answers.` },
            409,
          );
        }
      }
    }

    const body = await c.req.json().catch(() => ({}));
    const rawResp: { questionId: string; response: unknown }[] = Array.isArray(body.answers) ? body.answers : [];
    // Convert displayed option indices back to original indices before grading — the
    // same translation the autosave path applies, so a submit and an autosave of the
    // same click always store the identical value.
    const submitTrans = await answerTranslator(attempt.examId, sid, body?.optionOrder);
    const respArr = rawResp.map((a) => (
      a && typeof a.questionId === "string" && a.response != null
        ? { ...a, response: submitTrans.toOriginal(a.questionId, a.response) }
        : a
    ));

    // Last chance to stamp the display scheme on the attempt: after this the client
    // clears its bundle, so if it is not recorded now the review can never know the
    // student sat a shuffled paper. Write-once, never cleared (see autosave).
    if (submitTrans.active && attempt.optionOrder !== OPTION_ORDER_TOKEN) {
      try {
        await db.update(schema.attempts).set({ optionOrder: OPTION_ORDER_TOKEN }).where(eq(schema.attempts.id, aid));
      } catch { /* cosmetic for review only — never block a submit over it */ }
    }

    // Backstop for proctoring evidence: the client flushes violations live to
    // /events, but resends the whole list here in case a flush failed offline.
    // Deduped on (type, at) so nothing is stored twice. Never blocks the submit.
    try { await persistIntegrityEvents(aid, body.integrityEvents); } catch { /* evidence is best-effort */ }

    // Global AI provider for grading (single global settings row).
    let provider: string | null = null;
    try {
      const s = await getGlobalSettings();
      provider = s?.aiProvider ?? null;
    } catch { /* ignore */ }

    // Persist + grade through the shared path. Objective graded inline; subjective
    // + coding deferred to the background queue. The same path is reused by the
    // server-side auto-submit sweep for abandoned attempts.
    let run = submitsInFlight.get(aid);
    if (!run) {
      run = (async () => {
        const paper = await getExamPaper(attempt.examId);
        return finalizeAttempt(attempt, respArr, provider, undefined, paper);
      })().finally(() => submitsInFlight.delete(aid));
      submitsInFlight.set(aid, run);
    }
    const { score, status, gradeAt } = await run;

    // `gradeAt` is when the deferred grading batch becomes due (null = nothing to
    // wait for, i.e. graded already or grading now). The client uses it to decide
    // whether to keep polling for a score: with grading held until after the exam
    // closes, a fast poll would burn 40 reads per student and never see "graded".
    examInProgressCache.invalidate(sid);
    return c.json({ ok: true, attemptId: aid, score, status, gradeAt }, 200);
  })

  // Review a finished attempt: per-question response, score, correct answer + AI notes.
  .get("/student/attempts/:attemptId/review", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const aid = c.req.param("attemptId");
    const [attempt] = await db.select().from(schema.attempts).where(and(eq(schema.attempts.id, aid), eq(schema.attempts.studentId, sid))).limit(1);
    if (!attempt) return c.json({ message: "Not found" }, 404);
    const [exam] = await db.select().from(schema.exams).where(eq(schema.exams.id, attempt.examId)).limit(1);
    // Gate results until the exam closes for everyone, extra time and holds
    // included — prevents early finishers leaking the answer key (lib/exam-status).
    const resultsReady = !!exam && resultsUnlocked(exam);
    if (!resultsReady) return c.json({ message: "Results are locked until this exam closes. Please check back later." }, 403);
    const ans = await db.select().from(schema.answers).where(eq(schema.answers.attemptId, aid));
    const aMap = new Map(ans.map((a) => [a.questionId, a]));
    const eqs = await db.select().from(schema.examQuestions).where(eq(schema.examQuestions.examId, attempt.examId)).orderBy(schema.examQuestions.order);
    const qids = eqs.map((q) => q.questionId);
    const qs = qids.length ? await db.select().from(schema.questions).where(inArray(schema.questions.id, qids)) : [];
    const qById = new Map(qs.map((q) => [q.id, q]));

    // Show the review in the SAME option order the student sat the exam in,
    // otherwise "you chose B" contradicts the B they actually clicked. Options,
    // correct answer and response are all translated together, so the payload is
    // self-consistent; nothing stored changes.
    //
    // Gated on the scheme recorded ON THIS ATTEMPT, not on the current build. The
    // exam is over, so there is no bundle left to ask; every attempt sat before
    // shuffling existed has option_order = NULL and must render in the authored
    // order it was actually taken in. Translating those would show a student an
    // option list they never saw and move the tick onto a different line.
    const revTrans = optionTranslator(sid, attempt.examId, qs, tokenIsCurrent(attempt.optionOrder));

    const questions = eqs.map((eq2) => {
      const q = qById.get(eq2.questionId);
      const a = aMap.get(eq2.questionId);
      return {
        id: eq2.questionId,
        type: q?.type ?? "short",
        prompt: q?.prompt ?? "",
        options: revTrans.display(eq2.questionId, (q?.options as string[] | null) ?? null),
        correct: q?.correct != null ? revTrans.toDisplay(eq2.questionId, q.correct) : null,
        points: eq2.points,
        response: a?.response != null ? revTrans.toDisplay(eq2.questionId, a.response) : null,
        score: a?.score ?? null,
        maxScore: a?.maxScore ?? eq2.points,
        aiNotes: a?.aiNotes ?? null,
        explanation: (q?.meta as any)?.explanation ?? null,
      };
    });
    return c.json({
      attempt: { id: attempt.id, status: attempt.status, score: attempt.score, submittedAt: attempt.submittedAt },
      exam: exam ? { id: exam.id, title: exam.title, totalPoints: exam.totalPoints } : null,
      questions,
    }, 200);
  })

  // Run a student's code against Judge0 (RapidAPI) — lets them test before submit.
  // Returns stdout / stderr / compile output; never reveals hidden test cases.
  // Lab check for the SEB switch: open /api/student/seb-check inside the Proview
  // SEB client to see whether this server recognises it. Reveals no keys.
  .get("/student/seb-check", async (c) => {
    const gs = await getGlobalSettings();
    const pc = { ...schema.DEFAULT_PROCTORING, ...(gs.proctoring ?? {}) };
    const keys = normaliseConfigKeys(pc.sebConfigKeys);
    const check = checkSeb({ requestUrl: c.req.url, headers: c.req.raw.headers, keys, websiteUrl: process.env.WEBSITE_URL });
    sebMonitor.record(check, c.req.header("user-agent") ?? null);
    return c.json({ safeExamBrowser: check.seb, configRecognised: check.matched, required: !!pc.requireSeb && keys.length > 0, keysConfigured: keys.length }, 200);
  })
  .post("/student/run-code", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const b = await c.req.json().catch(() => ({}));
    const source = String(b.source ?? "");
    const language = String(b.language ?? "python").toLowerCase();
    const stdin = b.stdin != null ? String(b.stdin) : "";
    if (!source.trim()) return c.json({ ok: false, message: "Write some code before running." }, 400);
    const size = checkRunSize(source, stdin);
    if (!size.ok) return c.json({ ok: false, message: size.message }, size.status);
    // Runs are paid executions from one shared quota: only during an exam.
    if (!(await hasExamInProgress(sid))) {
      return c.json({ ok: false, message: "Code can only be run while you are writing an exam." }, 403);
    }

    // Judge0 CE language IDs (compatible across RapidAPI CE and self-hosted CE).
    const LANG: Record<string, number> = {
      python: 71, python3: 71, py: 71,
      javascript: 63, js: 63, node: 63,
      java: 62, c: 50, cpp: 54, "c++": 54, csharp: 51, "c#": 51,
      go: 60, ruby: 72, php: 68, typescript: 74, ts: 74, kotlin: 78, swift: 83, rust: 73,
    };
    const reqLangId = Number(b.languageId);
    const languageId = Number.isFinite(reqLangId) && reqLangId > 0 ? reqLangId : (LANG[language] ?? 71);

    // Resolve the RapidAPI key (settings first, then env). The config provider is
    // re-evaluated at drain time so a settings change takes effect without restart.
    let key: string | null = null;
    try { key = (await getGlobalSettings())?.judge0Key ?? null; } catch { /* ignore */ }
    if (!key) key = process.env.JUDGE0_KEY || null;
    if (!resolveJudge0Config(key)) {
      return c.json({ ok: false, message: "Code execution is not configured. Contact your administrator." }, 503);
    }

    // Enqueue on the global server-side queue. The queue throttles all students
    // together (<=10 req/s), batches runs (<=20) into single HTTP calls, polls
    // each batch, and retries transient failures with backoff. The student's
    // request stays synchronous — it just waits in line (bounded by MAX_WAIT_MS).
    // One run at a time per student, and a cap per few minutes (lib/run-code-guard.ts).
    const slot = runLimiter.start(sid);
    if (!slot.ok) return c.json({ ok: false, message: slot.message }, slot.status);
    let result;
    try {
      result = await judge0Queue.run(
        { source, languageId, stdin },
        () => resolveJudge0Config(key),
      );
    } finally {
      runLimiter.finish(sid);
    }

    if (!result.ok) {
      return c.json({ ok: false, message: result.message ?? "Couldn't run your code. Try again." }, (result.httpStatus ?? 502) as never);
    }

    // Best-effort usage counter.
    try { await db.update(schema.settings).set({ judge0Used: dsql`${schema.settings.judge0Used} + 1` }).where(eq(schema.settings.id, "global")); } catch { /* ignore */ }
    return c.json({
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
      compileOutput: result.compileOutput,
      status: result.status,
      time: result.time,
      memory: result.memory,
    }, 200);
  });
