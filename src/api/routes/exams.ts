/** Exams: create, edit, hold, extra time, roster. Split out of index.ts; behaviour unchanged. */
import { Hono } from "hono";
import { eq, ne, and, desc, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { requireAuth, requirePermission } from "../middleware/auth";
import { id, effectiveEndMs } from "../lib/util";
import { isEligible, matchesCohort, loadRoster, ensureOptInOnlyLoaded } from "../lib/roster";
import { integrityRollup } from "../lib/integrity-rollup";
import { attemptOwners } from "../lib/attempt-owner";
import { evidenceMeter } from "../lib/tenant-quota";
import { inCollege } from "../lib/staff-policy";
import { type Vars, directory, invalidateExam, invalidateExamQuestions, tenantOf, NOT_FOUND } from "../core";

export const examsRoutes = new Hono<{ Variables: Vars }>()
  // =================== EXAMS ===================
  .get("/exams", requireAuth, requirePermission("exams"), async (c) => {
    const p = c.get("profile")!;
    const tid = p.role === "super_admin" && c.req.query("tenantId") ? c.req.query("tenantId")! : p.tenantId;
    if (!tid) return c.json({ exams: [] }, 200);
    const rows = await db.select().from(schema.exams).where(eq(schema.exams.tenantId, tid)).orderBy(desc(schema.exams.createdAt));
    // Newest assessment date first (startAt if scheduled, else createdAt).
    const dateVal = (e: (typeof rows)[number]) => {
      const d = e.startAt ?? e.createdAt;
      return d ? new Date(d as any).getTime() : 0;
    };
    rows.sort((a, b) => dateVal(b) - dateVal(a));
    return c.json({ exams: rows }, 200);
  })
  // Single exam with its selected question IDs (for the edit page).
  .get("/exams/:id", requireAuth, requirePermission("exams"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("id");
    const [row] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!row || (p.role !== "super_admin" && row.tenantId !== p.tenantId)) return c.json({ error: "not found" }, 404);
    const eqs = await db
      .select({ questionId: schema.examQuestions.questionId })
      .from(schema.examQuestions)
      .where(eq(schema.examQuestions.examId, eid))
      .orderBy(schema.examQuestions.order);
    // Explicitly-added students (used to hydrate the "specific students" picker).
    const adds = await db.select({ studentId: schema.examRoster.studentId }).from(schema.examRoster).where(and(eq(schema.examRoster.examId, eid), eq(schema.examRoster.mode, "add")));
    return c.json({ exam: row, questionIds: eqs.map((e) => e.questionId), studentIds: adds.map((a) => a.studentId) }, 200);
  })
  .post("/exams", requireAuth, requirePermission("exams"), async (c) => {
    const p = c.get("profile")!;
    const b = await c.req.json();
    const tid = p.tenantId!;
    const qids: string[] = b.questionIds ?? [];
    const qs = qids.length ? await db.select().from(schema.questions).where(inArray(schema.questions.id, qids)) : [];
    const total = qs.reduce((s, q) => s + q.points, 0);
    const assignMode = b.assignMode === "students" ? "students" : "cohort";
    const eid = id("ex");
    const [row] = await db
      .insert(schema.exams)
      .values({
        id: eid,
        tenantId: tid,
        title: b.title,
        classId: b.classId ?? null,
        sectionIds: assignMode === "students" ? null : (Array.isArray(b.sectionIds) && b.sectionIds.length ? b.sectionIds : null),
        assignMode,
        status: b.status ?? "scheduled",
        startAt: b.startAt ? new Date(b.startAt) : null,
        // The exam window closes at startAt + duration. After that the window is
        // closed and any student who never showed up is marked absent. (Offline
        // lost time is added back per-attempt beyond this cap at /start & /resume.)
        endAt: b.startAt ? new Date(new Date(b.startAt).getTime() + (b.durationMin ?? 60) * 60_000) : null,
        durationMin: b.durationMin ?? 60,
        totalPoints: total,
        createdBy: p.userId,
      })
      .returning();
    if (qids.length) {
      await db.insert(schema.examQuestions).values(
        qids.map((q, i) => ({ id: id("eq"), examId: eid, questionId: q, order: i, points: qs.find((x) => x.id === q)?.points ?? 1 })),
      );
    }
    // "students" mode: seed the roster add-list with the explicitly picked students.
    if (assignMode === "students" && Array.isArray(b.studentIds) && b.studentIds.length) {
      const ids = [...new Set(b.studentIds.map((s: unknown) => String(s)).filter(Boolean))] as string[];
      const valid = await db.select({ id: schema.students.id }).from(schema.students).where(and(eq(schema.students.tenantId, tid), inArray(schema.students.id, ids)));
      if (valid.length) {
        await db.insert(schema.examRoster).values(
          valid.map((s) => ({ id: id("rst"), examId: eid, studentId: s.id, mode: "add" as const, createdBy: p.userId ?? null })),
        );
      }
    }
    return c.json({ exam: row }, 201);
  })
  .patch("/exams/:id", requireAuth, requirePermission("exams"), async (c) => {
    const eid = c.req.param("id");
    if (!inCollege(c.get("profile"), await tenantOf("exam", eid))) return c.json(NOT_FOUND, 404);
    const b = await c.req.json();
    // GUARD, checked before ANY write. In "students" mode the save below reconciles
    // the roster to exactly `studentIds`, deleting the attempts, answers and
    // proctoring evidence of anyone left off the list. Saving the edit form on an
    // exam that has already been sat could therefore erase real results, with no
    // backup to restore from. Refuse unless the caller explicitly confirms
    // (`forceRemoveAttempts: true`); removing one student on purpose is still
    // possible through the roster "Remove" action, which is explicit by design.
    if (Array.isArray(b.studentIds) && b.forceRemoveAttempts !== true) {
      const [cur] = await db.select({ assignMode: schema.exams.assignMode }).from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
      const mode = b.assignMode !== undefined ? (b.assignMode === "students" ? "students" : "cohort") : cur?.assignMode;
      if (mode === "students") {
        const keep = new Set(b.studentIds.map((x: unknown) => String(x)));
        const adds = await db
          .select({ studentId: schema.examRoster.studentId })
          .from(schema.examRoster)
          .where(and(eq(schema.examRoster.examId, eid), eq(schema.examRoster.mode, "add")));
        const dropping = adds.map((r) => r.studentId).filter((id) => !keep.has(id));
        if (dropping.length) {
          const sat = await db
            .select({ studentId: schema.attempts.studentId })
            .from(schema.attempts)
            .where(and(eq(schema.attempts.examId, eid), inArray(schema.attempts.studentId, dropping), ne(schema.attempts.status, "not_started")));
          if (sat.length) {
            return c.json({
              message: `${sat.length} student${sat.length === 1 ? " has" : "s have"} already taken this exam and would lose their answers if removed from the list. Nothing was saved. Add them back, or remove them one at a time from the exam's roster if you really mean to delete their results.`,
              code: "would_delete_attempts",
              studentIds: sat.map((r) => r.studentId),
            }, 409);
          }
        }
      }
    }
    const patch: Record<string, unknown> = {};
    for (const k of ["title", "status", "durationMin"]) if (b[k] !== undefined) patch[k] = b[k];
    if (b.assignMode !== undefined) patch.assignMode = b.assignMode === "students" ? "students" : "cohort";
    if (b.sectionIds !== undefined) patch.sectionIds = Array.isArray(b.sectionIds) && b.sectionIds.length ? b.sectionIds : null;
    if (b.startAt !== undefined || b.durationMin !== undefined) {
      // Keep the exam window (endAt = startAt + duration) in sync whenever EITHER
      // the start time OR the duration changes. Editing only the duration must
      // still move the window, otherwise the deadline stays stale and students
      // can be cut off early / late. Fall back to the exam's stored values for
      // whichever field the request did not include.
      let startAtVal: Date | null | undefined;
      let durMin = b.durationMin;
      if (b.startAt !== undefined) {
        patch.startAt = b.startAt ? new Date(b.startAt) : null;
        startAtVal = patch.startAt as Date | null;
      }
      if (startAtVal === undefined || durMin === undefined) {
        const [ex] = await db
          .select({ startAt: schema.exams.startAt, durationMin: schema.exams.durationMin })
          .from(schema.exams)
          .where(eq(schema.exams.id, eid))
          .limit(1);
        if (startAtVal === undefined) startAtVal = ex?.startAt ?? null;
        if (durMin === undefined) durMin = ex?.durationMin ?? 60;
      }
      patch.endAt = startAtVal ? new Date(new Date(startAtVal).getTime() + durMin * 60_000) : null;
    } else if (b.endAt !== undefined) {
      patch.endAt = b.endAt ? new Date(b.endAt) : null;
    }
    // Optionally replace the exam's question set and recompute total points.
    if (Array.isArray(b.questionIds)) {
      const qids: string[] = b.questionIds;
      const qs = qids.length ? await db.select().from(schema.questions).where(inArray(schema.questions.id, qids)) : [];
      patch.totalPoints = qs.reduce((s, q) => s + q.points, 0);
      await db.delete(schema.examQuestions).where(eq(schema.examQuestions.examId, eid));
      if (qids.length) {
        await db.insert(schema.examQuestions).values(
          qids.map((q, i) => ({ id: id("eq"), examId: eid, questionId: q, order: i, points: qs.find((x) => x.id === q)?.points ?? 1 })),
        );
      }
    }
    // In "students" mode, the picked list IS the roster add-list. Reconcile the
    // exam's "add" overrides to exactly match the provided studentIds. Removing a
    // student also clears any attempt/answers/events so they aren't counted.
    //
    // CRITICAL: this reconcile is DESTRUCTIVE (it purges add-rows + their attempts
    // for anyone not in `studentIds`). It must ONLY run when the exam is actually
    // in "students" assign mode. A cohort exam edited from the admin panel sends
    // `studentIds: []` (the picker is hidden), and running the reconcile there
    // would silently wipe every additive roster override AND their live answers.
    // In cohort mode, roster add/remove is managed solely via the dedicated
    // /roster endpoints — a PATCH must never touch it.
    let effAssignMode: "students" | "cohort";
    if (b.assignMode !== undefined) {
      effAssignMode = b.assignMode === "students" ? "students" : "cohort";
    } else {
      const [exMode] = await db
        .select({ assignMode: schema.exams.assignMode })
        .from(schema.exams)
        .where(eq(schema.exams.id, eid))
        .limit(1);
      effAssignMode = exMode?.assignMode === "students" ? "students" : "cohort";
    }
    if (effAssignMode === "students" && Array.isArray(b.studentIds)) {
      const p = c.get("profile")!;
      const want = new Set(b.studentIds.map((s: unknown) => String(s)).filter(Boolean) as string[]);
      const existing = await db.select().from(schema.examRoster).where(and(eq(schema.examRoster.examId, eid), eq(schema.examRoster.mode, "add")));
      const have = new Set(existing.map((r) => r.studentId));
      // Drop add-rows no longer wanted (and purge their attempts).
      for (const r of existing) {
        if (!want.has(r.studentId)) {
          const atts = await db.select().from(schema.attempts).where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, r.studentId)));
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
          if (atts.length) await db.delete(schema.attempts).where(and(eq(schema.attempts.examId, eid), eq(schema.attempts.studentId, r.studentId)));
          await db.delete(schema.examRoster).where(eq(schema.examRoster.id, r.id));
        }
      }
      // Add new picks (validate they belong to the tenant).
      const toAdd = [...want].filter((sid) => !have.has(sid));
      if (toAdd.length) {
        const valid = await db.select({ id: schema.students.id }).from(schema.students).where(and(eq(schema.students.tenantId, p.tenantId!), inArray(schema.students.id, toAdd)));
        if (valid.length) {
          await db.insert(schema.examRoster).values(
            valid.map((s) => ({ id: id("rst"), examId: eid, studentId: s.id, mode: "add" as const, createdBy: p.userId ?? null })),
          );
        }
      }
    }
    const [row] = await db.update(schema.exams).set(patch).where(eq(schema.exams.id, eid)).returning();
    // Students read the exam row (and its question set) through short-lived caches;
    // drop them so an admin edit is visible on the next heartbeat, not one TTL later.
    invalidateExam(eid);
    invalidateExamQuestions(eid);
    return c.json({ exam: row }, 200);
  })

  // ---- Admin exam controls: global hold / resume / extra time (outage handling) ----
  // Hold the WHOLE exam (e.g. a venue-wide internet/power outage). Every running
  // student's timer freezes; the held duration is added back to the deadline on resume.
  .post("/exams/:id/hold", requireAuth, requirePermission("exams"), async (c) => {
    const eid = c.req.param("id");
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!ex || !inCollege(c.get("profile"), ex.tenantId)) return c.json({ message: "Not found" }, 404);
    if (!ex.heldAt) await db.update(schema.exams).set({ heldAt: new Date() }).where(eq(schema.exams.id, eid));
    invalidateExam(eid);
    return c.json({ ok: true, held: true }, 200);
  })
  // Resume a held exam: fold the elapsed hold into holdMs and clear heldAt so
  // deadlines shift forward by exactly the outage duration.
  .post("/exams/:id/unhold", requireAuth, requirePermission("exams"), async (c) => {
    const eid = c.req.param("id");
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!ex || !inCollege(c.get("profile"), ex.tenantId)) return c.json({ message: "Not found" }, 404);
    if (ex.heldAt) {
      const elapsed = Math.max(0, Date.now() - new Date(ex.heldAt).getTime());
      await db.update(schema.exams).set({ heldAt: null, holdMs: (ex.holdMs ?? 0) + elapsed }).where(eq(schema.exams.id, eid));
    }
    invalidateExam(eid);
    return c.json({ ok: true, held: false }, 200);
  })
  // Grant extra minutes to the whole exam (shifts every deadline forward).
  .post("/exams/:id/extra-time", requireAuth, requirePermission("exams"), async (c) => {
    const eid = c.req.param("id");
    if (!inCollege(c.get("profile"), await tenantOf("exam", eid))) return c.json(NOT_FOUND, 404);
    const b = await c.req.json().catch(() => ({}));
    let minutes = Number(b.minutes);
    if (!Number.isFinite(minutes)) minutes = 0;
    minutes = Math.round(minutes);
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!ex) return c.json({ message: "Not found" }, 404);
    const next = Math.max(0, (ex.extraMin ?? 0) + minutes);
    const [row] = await db.update(schema.exams).set({ extraMin: next }).where(eq(schema.exams.id, eid)).returning();
    invalidateExam(eid);
    return c.json({ ok: true, extraMin: row.extraMin }, 200);
  })

  // =================== SCHEDULE-ASSESSMENT ROSTER (add / remove students) ===================
  // Manage the per-assessment student roster from the Schedule Assessment screen.
  // Same override model as the reports roster, but gated by the "exams" permission
  // so it lives with assessment scheduling. Works regardless of exam status.

  // Current roster overrides for an exam: explicitly added + explicitly removed.
  .get("/exams/:examId/roster", requireAuth, requirePermission("exams"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("examId");
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!ex || ex.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
    const overrides = await db.select().from(schema.examRoster).where(eq(schema.examRoster.examId, eid));
    // Names and section codes come from the directory cache — this handler only
    // needs them to label rows, so two full-table reads per open were pure waste.
    const clmap = (await directory.classIndex(p.tenantId!)).byId;
    const smap = (await directory.studentIndex(p.tenantId!)).byId;
    const shape = (o: typeof overrides[number]) => {
      const s = smap.get(o.studentId);
      return { id: o.studentId, name: s?.name ?? "—", rollNo: s?.rollNo ?? "", email: s?.email ?? null, section: s?.classId ? clmap.get(s.classId)?.code ?? "" : "" };
    };
    const added = overrides.filter((o) => o.mode === "add").map(shape);
    const removed = overrides.filter((o) => o.mode === "remove").map(shape);
    return c.json({ added, removed }, 200);
  })

  // Students NOT currently eligible for the exam — the "Add student" picker.
  .get("/exams/:examId/roster/candidates", requireAuth, requirePermission("exams"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("examId");
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!ex || ex.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
    const roster = await loadRoster(eid);
    const allStudents = (await directory.studentIndex(p.tenantId!)).enabled;
    const clmap = (await directory.classIndex(p.tenantId!)).byId;
    const candidates = allStudents
      .filter((stu) => !isEligible(ex, stu, roster))
      .filter((stu) => !q || (stu.name ?? "").toLowerCase().includes(q) || (stu.rollNo ?? "").toLowerCase().includes(q) || (stu.email ?? "").toLowerCase().includes(q))
      .slice(0, 30)
      .map((stu) => ({ id: stu.id, name: stu.name ?? "—", rollNo: stu.rollNo ?? "", email: stu.email ?? null, section: stu.classId ? clmap.get(stu.classId)?.code ?? "" : "" }));
    return c.json({ candidates }, 200);
  })

  // Students CURRENTLY eligible for the exam — the "Remove student" picker.
  .get("/exams/:examId/roster/eligible", requireAuth, requirePermission("exams"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("examId");
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!ex || ex.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
    const roster = await loadRoster(eid);
    const allStudents = (await directory.studentIndex(p.tenantId!)).enabled;
    const clmap = (await directory.classIndex(p.tenantId!)).byId;
    const eligible = allStudents
      .filter((stu) => isEligible(ex, stu, roster))
      .filter((stu) => !q || (stu.name ?? "").toLowerCase().includes(q) || (stu.rollNo ?? "").toLowerCase().includes(q) || (stu.email ?? "").toLowerCase().includes(q))
      .slice(0, 30)
      .map((stu) => ({ id: stu.id, name: stu.name ?? "—", rollNo: stu.rollNo ?? "", email: stu.email ?? null, section: stu.classId ? clmap.get(stu.classId)?.code ?? "" : "" }));
    return c.json({ eligible }, 200);
  })

  // Add a student to the assessment (idempotent). Clears any prior override.
  .post("/exams/:examId/roster/add", requireAuth, requirePermission("exams"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("examId");
    const b = await c.req.json().catch(() => ({}));
    const studentId = String(b.studentId ?? "");
    if (!studentId) return c.json({ message: "studentId required" }, 400);
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!ex || ex.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
    const [stu] = await db.select().from(schema.students).where(eq(schema.students.id, studentId)).limit(1);
    if (!stu || stu.tenantId !== p.tenantId) return c.json({ message: "Student not found" }, 404);
    await db.delete(schema.examRoster).where(and(eq(schema.examRoster.examId, eid), eq(schema.examRoster.studentId, studentId)));
    await ensureOptInOnlyLoaded();
    if (!matchesCohort(ex, stu)) {
      await db.insert(schema.examRoster).values({ id: id("rst"), examId: eid, studentId, mode: "add", createdBy: p.userId ?? null });
    }
    return c.json({ ok: true }, 200);
  })

  // Remove a student from the assessment: records a "remove" override and deletes
  // any attempt/answers/events for this exam so they are not counted at all.
  .post("/exams/:examId/roster/remove", requireAuth, requirePermission("exams"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("examId");
    const b = await c.req.json().catch(() => ({}));
    const studentId = String(b.studentId ?? "");
    if (!studentId) return c.json({ message: "studentId required" }, 400);
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!ex || ex.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
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
    // Only need a "remove" override if the student would otherwise be a cohort match.
    const [stu] = await db.select().from(schema.students).where(eq(schema.students.id, studentId)).limit(1);
    await ensureOptInOnlyLoaded();
    if (stu && matchesCohort(ex, stu)) {
      await db.insert(schema.examRoster).values({ id: id("rst"), examId: eid, studentId, mode: "remove", createdBy: p.userId ?? null });
    }
    return c.json({ ok: true }, 200);
  })

  // Undo an override — restore a student to their default cohort eligibility.
  .post("/exams/:examId/roster/reset", requireAuth, requirePermission("exams"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("examId");
    const b = await c.req.json().catch(() => ({}));
    const studentId = String(b.studentId ?? "");
    if (!studentId) return c.json({ message: "studentId required" }, 400);
    const [ex] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!ex || ex.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
    await db.delete(schema.examRoster).where(and(eq(schema.examRoster.examId, eid), eq(schema.examRoster.studentId, studentId)));
    return c.json({ ok: true }, 200);
  })

  // Reopen a single accidentally-submitted attempt. Flips submitted/graded back
  // to in_progress WITHOUT wiping the student's work — their answers stay in the
  // DB and their timer resumes from the original startedAt (via effectiveEndMs).
  // Optional addMinutes grants extra time to THIS student only by bumping the
  // per-attempt pausedMs (does not affect anyone else in the exam).
  .post("/exams/:id/attempts/:attemptId/reopen", requireAuth, requirePermission("liveMonitor"), async (c) => {
    const p = c.get("profile")!;
    const eid = c.req.param("id");
    const aid = c.req.param("attemptId");
    const b = await c.req.json().catch(() => ({}));
    let addMinutes = Number(b.addMinutes);
    if (!Number.isFinite(addMinutes) || addMinutes < 0) addMinutes = 0;
    addMinutes = Math.round(addMinutes);

    const [exam] = await db.select().from(schema.exams).where(eq(schema.exams.id, eid)).limit(1);
    if (!exam || exam.tenantId !== p.tenantId) return c.json({ message: "Not found" }, 404);
    const [attempt] = await db.select().from(schema.attempts).where(eq(schema.attempts.id, aid)).limit(1);
    if (!attempt || attempt.examId !== eid) return c.json({ message: "Attempt not found" }, 404);
    if (attempt.status !== "submitted" && attempt.status !== "graded") {
      return c.json({ message: "Only a submitted or graded attempt can be reopened." }, 400);
    }

    const now = Date.now();
    const addMs = addMinutes * 60_000;

    // Shared exam-window end that everyone still writing is bound to:
    // endAt + admin extra time + accumulated hold + any currently-running hold.
    // This is independent of THIS attempt's (possibly skewed) startedAt, so a
    // reset student picks up exactly the time still left on the room's clock.
    let sharedEnd = 0;
    if (exam.endAt) {
      sharedEnd =
        new Date(exam.endAt).getTime() + (exam.extraMin ?? 0) * 60_000 + (exam.holdMs ?? 0);
      if (exam.heldAt) sharedEnd += Math.max(0, now - new Date(exam.heldAt).getTime());
    }

    // Deadline if we simply resumed this attempt's own timer.
    const naturalEnd = effectiveEndMs(exam, { startedAt: attempt.startedAt, pausedMs: attempt.pausedMs ?? 0 }, now);

    // Target deadline = the later of the shared window end and this attempt's
    // natural end, plus any admin-granted minutes for THIS student only. Using
    // the shared end means a student who submitted early (or whose start time is
    // skewed) resumes with the SAME leftover time as the rest of the room — e.g.
    // 30 min left on the window + 20 min admin extra = 50 min — never a fresh
    // full duration.
    let target = Math.max(sharedEnd, naturalEnd) + addMs;

    // Always guarantee a real writable cushion after a reopen. A tiny floor (e.g.
    // 1 min) caused a submit/reopen loop: the client's auto-submit-on-timeout
    // fires again within a heartbeat, the admin reopens, and round it goes. Give
    // at least MIN_WRITABLE_MS of usable time from now — the admin's added
    // minutes if larger, else this floor (or a fresh duration if the whole
    // window has already closed and no minutes were specified).
    const MIN_WRITABLE_MS = 10 * 60_000; // 10 min floor of usable time
    if (target - now < MIN_WRITABLE_MS) {
      const grantMin =
        addMinutes > 0 ? Math.max(addMinutes, 10) : (target - now <= 0 ? exam.durationMin : 10);
      target = now + grantMin * 60_000;
    }

    // Realise `target` via pausedMs (added AFTER the exam-window cap inside
    // effectiveEndMs), keeping startedAt untouched. pausedMs affects only this
    // attempt.
    const floorEnd = effectiveEndMs(exam, { startedAt: attempt.startedAt, pausedMs: 0 }, now);
    const newPaused = Math.max(0, target - floorEnd);

    await db
      .update(schema.attempts)
      .set({
        status: "in_progress",
        score: null,
        submittedAt: null,
        pausedMs: newPaused,
        lastPausedAt: null,
        lastSeenAt: new Date(),
      })
      .where(eq(schema.attempts.id, aid));

    const endAtMs = effectiveEndMs(exam, { startedAt: attempt.startedAt, pausedMs: newPaused }, now);
    return c.json({ ok: true, endAt: new Date(endAtMs), grantedUntil: new Date(endAtMs), addedMinutes: addMinutes }, 200);
  });
