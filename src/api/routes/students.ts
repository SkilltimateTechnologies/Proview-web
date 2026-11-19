/** Student records, bulk import and the Elite cohort. Split out of index.ts; behaviour unchanged. */
import { Hono } from "hono";
import { eq, and, or, desc, inArray, sql as dsql } from "drizzle-orm";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { db } from "../database";
import * as schema from "../database/schema";
import { requireAuth, requirePermission } from "../middleware/auth";
import { id } from "../lib/util";
import { signStudentToken, verifyStudentToken } from "../lib/student-token";
import { normalizeRoll, rollNoProblem, isDuplicateRollError } from "../lib/students";
import { invalidateOptInOnlyCache, isOptInOnlyCode } from "../lib/roster";
import { integrityRollup } from "../lib/integrity-rollup";
import { attemptOwners } from "../lib/attempt-owner";
import { evidenceMeter } from "../lib/tenant-quota";
import { inCollege } from "../lib/staff-policy";
import { studentLoginThrottle } from "../lib/login-throttle";
import { type Vars, directory, findStudentByRoll, tenantOf, NOT_FOUND } from "../core";

export const studentsRoutes = new Hono<{ Variables: Vars }>()
  // =================== STUDENTS ===================
  .get("/students", requireAuth, async (c) => {
    const p = c.get("profile")!;
    const tid = p.role === "super_admin" && c.req.query("tenantId") ? c.req.query("tenantId")! : p.tenantId;
    if (!tid) return c.json({ students: [] }, 200);
    // NOTE: never return the password hash to the client.
    const rows = await db
      .select({
        id: schema.students.id,
        tenantId: schema.students.tenantId,
        classId: schema.students.classId,
        originalClassId: schema.students.originalClassId,
        rollNo: schema.students.rollNo,
        name: schema.students.name,
        email: schema.students.email,
        enabled: schema.students.enabled,
        createdAt: schema.students.createdAt,
      })
      .from(schema.students)
      .where(eq(schema.students.tenantId, tid))
      .orderBy(desc(schema.students.createdAt));
    return c.json({ students: rows }, 200);
  })
  .post("/students", requireAuth, requirePermission("users"), async (c) => {
    const p = c.get("profile")!;
    const b = await c.req.json();
    const tid = p.role === "super_admin" ? (b.tenantId ?? p.tenantId) : p.tenantId;
    const plain = b.password && String(b.password).length >= 6 ? String(b.password) : "Welcome@123";

    // This endpoint used to insert whatever it was given, with NO duplicate check
    // of any kind — the main source of duplicate student records. Normalise, reject
    // obvious junk, and refuse a roll number the tenant already has.
    const roll = normalizeRoll(b.rollNo);
    const rollBad = rollNoProblem(roll);
    if (rollBad) return c.json({ message: rollBad }, 400);
    const name = String(b.name ?? "").trim().replace(/\s+/g, " ");
    if (!name) return c.json({ message: "Name is required" }, 400);
    if (!tid) return c.json({ message: "No tenant" }, 400);
    const clash = await findStudentByRoll(tid, roll);
    if (clash) {
      return c.json({ message: `Roll number ${roll} already exists (${clash.name})`, existingId: clash.id }, 409);
    }

    let row;
    try {
      [row] = await db
      .insert(schema.students)
      .values({
        id: id("stu"),
        tenantId: tid!,
        classId: b.classId ?? null,
        rollNo: roll,
        name,
        email: b.email ?? null,
        password: await hashPassword(plain),
      })
      .returning({
        id: schema.students.id,
        tenantId: schema.students.tenantId,
        classId: schema.students.classId,
        rollNo: schema.students.rollNo,
        name: schema.students.name,
        email: schema.students.email,
        enabled: schema.students.enabled,
        createdAt: schema.students.createdAt,
      });
    } catch (e) {
      // Same select-then-insert race as registration: the unique index has the
      // final say, so surface it as a clean 409.
      if (isDuplicateRollError(e)) return c.json({ message: `Roll number ${roll} already exists` }, 409);
      throw e;
    }
    directory.invalidateStudents(tid);
    return c.json({ student: row }, 201);
  })
  .post("/students/bulk", requireAuth, requirePermission("users"), async (c) => {
    const p = c.get("profile")!;
    const b = await c.req.json(); // { rows: [{name, rollNo, email, classCode}] }
    const tid = p.tenantId!;

    // Normalise a raw class value ("CSE - A", "cse-a", "CSE  A") to canonical "CSE-A".
    const normCode = (raw: string): string => {
      const cleaned = String(raw ?? "").trim().toUpperCase().replace(/\s+/g, " ");
      if (!cleaned) return "";
      // Split branch + section on hyphen or space; rejoin with a single hyphen.
      const m = cleaned.match(/^([A-Z]+)\s*-?\s*([A-Z0-9]*)$/);
      if (m) return m[2] ? `${m[1]}-${m[2]}` : m[1];
      return cleaned.replace(/\s*-\s*/g, "-").replace(/\s+/g, "-");
    };

    const classes = await db.select().from(schema.classes).where(eq(schema.classes.tenantId, tid));
    const codeMap = new Map(classes.map((cl) => [cl.code, cl.id]));

    // Existing roll numbers for this tenant — used to skip already-registered
    // students. Normalised with the SAME function the rows below go through, so a
    // stored "23k91a0491" and an imported " 23K91A0491 " are recognised as one.
    const existing = await db.select({ rollNo: schema.students.rollNo }).from(schema.students).where(eq(schema.students.tenantId, tid));
    const seenRolls = new Set(existing.map((e) => normalizeRoll(e.rollNo)));

    const clean = (b.rows as Array<Record<string, string>>)
      .map((r) => ({
        name: String(r.name ?? "").trim().replace(/\s+/g, " "),
        rollNo: normalizeRoll(r.rollNo),
        email: String(r.email ?? "").trim(),
        code: normCode(r.classCode ?? ""),
      }))
      .filter((r) => r.name && r.rollNo);

    // Hash the default password ONCE — hashing per row (scrypt) would hang the
    // request for large CSVs (hundreds of rows).
    const defaultHash = await hashPassword("Welcome@123");

    let inserted = 0, skipped = 0, createdSections = 0;
    // Rows the import refused to trust, returned to the caller so a TPO can see
    // WHY a row did not land instead of silently ending up with fewer students
    // than the file had. Previously every rejection was an anonymous "skipped".
    const rejected: { rollNo: string; name: string; reason: string }[] = [];
    const values: (typeof schema.students.$inferInsert)[] = [];
    for (const r of clean) {
      const key = r.rollNo;
      // Junk roll numbers (pasted emails, stray punctuation) used to be imported
      // verbatim and then never matched anything.
      const bad = rollNoProblem(key);
      if (bad) { skipped++; rejected.push({ rollNo: r.rollNo, name: r.name, reason: bad }); continue; }
      if (seenRolls.has(key)) { skipped++; rejected.push({ rollNo: r.rollNo, name: r.name, reason: "Already registered" }); continue; }
      seenRolls.add(key); // guard against duplicates within the same file

      // Auto-create the section if the class code is present but unknown.
      let classId: string | null = null;
      if (r.code) {
        classId = codeMap.get(r.code) ?? null;
        if (!classId) {
          const [branch, section] = r.code.includes("-") ? r.code.split("-") : [r.code, ""];
          const [row] = await db
            .insert(schema.classes)
            .values({ id: id("cls"), tenantId: tid, branch, section, code: r.code, batchStartYear: new Date().getFullYear() })
            .returning();
          classId = row.id;
          codeMap.set(r.code, row.id);
          createdSections++;
        }
      }

      values.push({
        id: id("stu"),
        tenantId: tid,
        classId,
        rollNo: r.rollNo,
        name: r.name,
        email: r.email || null,
        password: defaultHash,
      });
      inserted++;
    }
    // Insert in chunks to stay well under SQLite's variable limit. `onConflictDoNothing`
    // targets the roll-number unique index, so a concurrent import of the same file
    // (double-clicked upload) cannot create duplicates — the second one is a no-op
    // instead of a 500 that aborts the whole batch halfway through.
    for (let i = 0; i < values.length; i += 200) {
      await db.insert(schema.students).values(values.slice(i, i + 200)).onConflictDoNothing();
    }
    // An import can create sections as well as students — drop both for the tenant.
    directory.invalidate(tid);
    return c.json({ inserted, skipped, createdSections, rejected }, 201);
  })
  .patch("/students/:id", requireAuth, requirePermission("users"), async (c) => {
    const sid = c.req.param("id");
    if (!inCollege(c.get("profile"), await tenantOf("student", sid))) return c.json(NOT_FOUND, 404);
    const b = await c.req.json();
    const patch: Record<string, unknown> = {};
    for (const k of ["name", "rollNo", "email", "classId", "enabled"]) {
      if (k in b) patch[k] = b[k];
    }

    // Editing a roll number could previously produce a duplicate just as easily as
    // creating one — the edit form was in fact how the pasted-email roll numbers got
    // "fixed" into a second copy of an existing student. Normalise and check.
    const [before] = await db.select().from(schema.students).where(eq(schema.students.id, sid));
    if (!before) return c.json({ message: "Student not found" }, 404);
    if ("rollNo" in patch) {
      const roll = normalizeRoll(patch.rollNo);
      const bad = rollNoProblem(roll);
      if (bad) return c.json({ message: bad }, 400);
      if (roll !== normalizeRoll(before.rollNo)) {
        const clash = await findStudentByRoll(before.tenantId, roll);
        if (clash && clash.id !== sid) {
          return c.json({ message: `Roll number ${roll} already belongs to ${clash.name}`, existingId: clash.id }, 409);
        }
      }
      patch.rollNo = roll;
    }
    if ("name" in patch) {
      const name = String(patch.name ?? "").trim().replace(/\s+/g, " ");
      if (!name) return c.json({ message: "Name is required" }, 400);
      patch.name = name;
    }

    try {
      const [row] = await db.update(schema.students).set(patch).where(eq(schema.students.id, sid)).returning();
      // Name/roll/section/enabled all feed the cached index.
      directory.invalidateStudents(row?.tenantId);
      return c.json({ student: row }, 200);
    } catch (e) {
      if (isDuplicateRollError(e)) return c.json({ message: "Another student already has that roll number" }, 409);
      throw e;
    }
  })
  // ============ SPECIAL COHORTS (ELITE) ============
  // A special cohort is a section that is OPT-IN ONLY: students in it are skipped by
  // every regular-section assessment (including "All sections") and only receive
  // assessments that explicitly target the cohort. Moving a student in records their
  // previous section in originalClassId so the move is fully reversible.

  // Resolve (or create) the tenant's ELITE cohort section.
  .post("/cohorts/elite/ensure", requireAuth, requirePermission("users"), async (c) => {
    const p = c.get("profile")!;
    const tid = p.tenantId;
    if (!tid) return c.json({ message: "No tenant" }, 400);
    const rows = await db.select().from(schema.classes).where(eq(schema.classes.tenantId, tid));
    let elite = rows.find((cl) => isOptInOnlyCode(cl.code) || isOptInOnlyCode(cl.branch));
    if (!elite) {
      const year = new Date().getFullYear();
      [elite] = await db
        .insert(schema.classes)
        .values({ id: id("cls"), tenantId: tid, branch: "ELITE", batchStartYear: year, section: "", code: "ELITE" })
        .returning();
      invalidateOptInOnlyCache();
    }
    return c.json({ class: elite }, 200);
  })

  // Move students INTO the ELITE cohort (bulk, by studentId or rollNo).
  // Their current section is saved to originalClassId (only if not already saved, so
  // repeated moves never lose the true home section).
  .post("/cohorts/elite/add", requireAuth, requirePermission("users"), async (c) => {
    const p = c.get("profile")!;
    const tid = p.tenantId;
    if (!tid) return c.json({ message: "No tenant" }, 400);
    const b = await c.req.json();
    const ids: string[] = Array.isArray(b.studentIds) ? b.studentIds.map(String) : [];
    const rolls: string[] = Array.isArray(b.rollNos) ? b.rollNos.map((r: unknown) => String(r).trim().toUpperCase()) : [];

    const cls = await db.select().from(schema.classes).where(eq(schema.classes.tenantId, tid));
    let elite = cls.find((cl) => isOptInOnlyCode(cl.code) || isOptInOnlyCode(cl.branch));
    if (!elite) {
      const year = new Date().getFullYear();
      [elite] = await db
        .insert(schema.classes)
        .values({ id: id("cls"), tenantId: tid, branch: "ELITE", batchStartYear: year, section: "", code: "ELITE" })
        .returning();
      invalidateOptInOnlyCache();
    }

    const all = await db.select().from(schema.students).where(eq(schema.students.tenantId, tid));
    const byId = new Map(all.map((s) => [s.id, s]));
    const byRoll = new Map(all.map((s) => [s.rollNo.trim().toUpperCase(), s]));

    const moved: { id: string; rollNo: string; name: string; from: string }[] = [];
    const alreadyElite: string[] = [];
    const notFound: string[] = [];

    const targets = new Map<string, typeof all[number]>();
    for (const sidRaw of ids) {
      const s = byId.get(sidRaw);
      if (s) targets.set(s.id, s); else notFound.push(sidRaw);
    }
    for (const roll of rolls) {
      const s = byRoll.get(roll);
      if (s) targets.set(s.id, s); else notFound.push(roll);
    }

    const codeById = new Map(cls.map((cl) => [cl.id, cl.code]));
    for (const s of targets.values()) {
      if (s.classId === elite.id) { alreadyElite.push(s.rollNo); continue; }
      // Preserve the FIRST known home section; don't overwrite on re-moves.
      const keepOriginal = s.originalClassId ?? s.classId ?? null;
      await db.update(schema.students).set({ classId: elite.id, originalClassId: keepOriginal }).where(eq(schema.students.id, s.id));
      moved.push({ id: s.id, rollNo: s.rollNo, name: s.name, from: codeById.get(s.classId ?? "") ?? "(none)" });
    }
    directory.invalidateStudents(tid);
    return c.json({ ok: true, eliteClassId: elite.id, movedCount: moved.length, moved, alreadyElite, notFound }, 200);
  })

  // Remove students FROM the ELITE cohort, restoring their original section.
  .post("/cohorts/elite/remove", requireAuth, requirePermission("users"), async (c) => {
    const p = c.get("profile")!;
    const tid = p.tenantId;
    if (!tid) return c.json({ message: "No tenant" }, 400);
    const b = await c.req.json();
    const ids: string[] = Array.isArray(b.studentIds) ? b.studentIds.map(String) : [];
    // Optional explicit destination; otherwise fall back to originalClassId.
    const toClassId: string | null = b.classId ? String(b.classId) : null;

    const all = await db.select().from(schema.students).where(eq(schema.students.tenantId, tid));
    const byId = new Map(all.map((s) => [s.id, s]));
    const restored: { id: string; rollNo: string; to: string }[] = [];
    const noOriginal: string[] = [];

    const cls = await db.select().from(schema.classes).where(eq(schema.classes.tenantId, tid));
    const codeById = new Map(cls.map((cl) => [cl.id, cl.code]));

    for (const sidRaw of ids) {
      const s = byId.get(sidRaw);
      if (!s) continue;
      const dest = toClassId ?? s.originalClassId;
      if (!dest) { noOriginal.push(s.rollNo); continue; }
      await db.update(schema.students).set({ classId: dest, originalClassId: null }).where(eq(schema.students.id, s.id));
      restored.push({ id: s.id, rollNo: s.rollNo, to: codeById.get(dest) ?? dest });
    }
    directory.invalidateStudents(tid);
    return c.json({ ok: true, restoredCount: restored.length, restored, noOriginal }, 200);
  })

  // Current ELITE roster + each student's original section.
  .get("/cohorts/elite", requireAuth, async (c) => {
    const p = c.get("profile")!;
    const tid = p.tenantId;
    if (!tid) return c.json({ eliteClassId: null, students: [] }, 200);
    const cls = await db.select().from(schema.classes).where(eq(schema.classes.tenantId, tid));
    const elite = cls.find((cl) => isOptInOnlyCode(cl.code) || isOptInOnlyCode(cl.branch));
    if (!elite) return c.json({ eliteClassId: null, students: [] }, 200);
    const codeById = new Map(cls.map((cl) => [cl.id, cl.code]));
    const rows = await db.select().from(schema.students).where(and(eq(schema.students.tenantId, tid), eq(schema.students.classId, elite.id)));
    const out = rows
      .map((s) => ({ id: s.id, rollNo: s.rollNo, name: s.name, enabled: s.enabled, originalSection: s.originalClassId ? codeById.get(s.originalClassId) ?? "" : "" }))
      .sort((a, b) => a.rollNo.localeCompare(b.rollNo));
    return c.json({ eliteClassId: elite.id, students: out }, 200);
  })

  .post("/students/:id/reset-password", requireAuth, requirePermission("users"), async (c) => {
    const sid = c.req.param("id");
    if (!inCollege(c.get("profile"), await tenantOf("student", sid))) return c.json(NOT_FOUND, 404);
    const b = await c.req.json();
    const newPassword: string = b.password && String(b.password).length >= 6 ? String(b.password) : "Welcome@123";
    await db.update(schema.students).set({ password: await hashPassword(newPassword), mustChangePassword: true }).where(eq(schema.students.id, sid));
    studentLoginThrottle.clear();
    // Only a studentId is in scope, so clear every tenant. Rare enough to be free.
    directory.invalidateStudents();
    // Return the plaintext ONCE so the admin can hand it to the student; never stored/readable after.
    return c.json({ ok: true, password: newPassword }, 200);
  })
  // Permanently delete a student and everything attached to them (attempts,
  // answers, integrity events, roster overrides). Irreversible.
  .delete("/students/:id", requireAuth, requirePermission("users"), async (c) => {
    const sid = c.req.param("id");
    const me = c.get("profile")!;
    const [stu] = await db.select().from(schema.students).where(eq(schema.students.id, sid));
    if (!stu) return c.json({ message: "Student not found" }, 404);
    if (me.role !== "super_admin" && stu.tenantId !== me.tenantId) return c.json({ message: "Not allowed" }, 403);
    // Cascade: answers + integrity events hang off attempts, so clear those first.
    const atts = await db.select({ id: schema.attempts.id }).from(schema.attempts).where(eq(schema.attempts.studentId, sid));
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
    await db.delete(schema.attempts).where(eq(schema.attempts.studentId, sid));
    await db.delete(schema.examRoster).where(eq(schema.examRoster.studentId, sid));
    await db.delete(schema.students).where(eq(schema.students.id, sid));
    directory.invalidateStudents();
    return c.json({ ok: true }, 200);
  })
  // Student login verification for the Phase 2 desktop client. Public (no staff session).
  // Body: { identifier: rollNo|email, password }. Returns student (no hash) on success.
  .post("/students/verify-login", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const identifier = String(b.identifier ?? "").trim();
    const password = String(b.password ?? "");
    if (!identifier || !password) return c.json({ ok: false, message: "Enter your roll number / email and password." }, 400);
    // Password guessing is slowed per account (lib/login-throttle.ts) — never per IP,
    // because a whole exam hall shares one college IP.
    const waitMs = studentLoginThrottle.retryAfterMs(identifier);
    if (waitMs > 0) {
      const minutes = Math.ceil(waitMs / 60_000);
      return c.json({ ok: false, message: `Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or ask your invigilator to reset your password.` }, 429);
    }
    // Matched the way rolls and emails are STORED (upper-cased roll, any case of
    // email), so "23k91a0501" now logs in like "23K91A0501". Both lookups ride an
    // expression index (REQUIRED_PERF_INDEXES), where this used to scan every
    // student. Up to 5 candidates: two colleges may share a roll number, and the
    // password decides which account is meant instead of whichever row came first.
    const rollKey = normalizeRoll(identifier);
    const emailKey = identifier.toLowerCase();
    const candidates = await db
      .select()
      .from(schema.students)
      .where(
        or(
          inArray(dsql`upper(trim(${schema.students.rollNo}))`, [...new Set([rollKey, identifier.toUpperCase()])]),
          eq(dsql`lower(trim(${schema.students.email}))`, emailKey),
        ),
      )
      .limit(5);
    const enabled = candidates.filter((s) => s.enabled);
    if (!enabled.length) return c.json({ ok: false, message: "No account found for this roll number / email." }, 401);
    let stu: (typeof enabled)[number] | null = null;
    for (const candidate of enabled) {
      if (await verifyPassword({ hash: candidate.password, password })) {
        stu = candidate;
        break;
      }
    }
    if (!stu) {
      studentLoginThrottle.recordFailure(identifier);
      return c.json({ ok: false, message: "Incorrect password. Please try again." }, 401);
    }
    studentLoginThrottle.recordSuccess(identifier);
    const token = await signStudentToken(stu.id);
    const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, stu.tenantId)).limit(1);
    return c.json({
      ok: true,
      token,
      student: {
        id: stu.id,
        tenantId: stu.tenantId,
        classId: stu.classId,
        rollNo: stu.rollNo,
        name: stu.name,
        email: stu.email,
        collegeName: tenant?.name ?? "",
        collegeShort: tenant?.shortName ?? "",
        primaryColor: tenant?.primaryColor ?? "#1e3a5f",
        logoUrl: tenant?.logoUrl ?? null,
        mustChangePassword: !!stu.mustChangePassword,
      },
    }, 200);
  })

  // Student changes their own password (forced on first login, or from Profile).
  // Requires the current password. Clears the must-change flag on success.
  .post("/student/change-password", async (c) => {
    const sid = await verifyStudentToken(c.req.header("x-student-token"));
    if (!sid) return c.json({ message: "Unauthorized" }, 401);
    const [stu] = await db.select().from(schema.students).where(eq(schema.students.id, sid)).limit(1);
    if (!stu || !stu.enabled) return c.json({ message: "Unauthorized" }, 401);
    const b = await c.req.json().catch(() => ({}));
    const currentPassword = String(b.currentPassword ?? "");
    const newPassword = String(b.newPassword ?? "");
    if (newPassword.length < 6) return c.json({ ok: false, message: "New password must be at least 6 characters." }, 400);
    const valid = await verifyPassword({ hash: stu.password, password: currentPassword });
    if (!valid) return c.json({ ok: false, message: "Your current password is incorrect." }, 400);
    if (newPassword === currentPassword) return c.json({ ok: false, message: "Choose a password different from your current one." }, 400);
    await db.update(schema.students).set({ password: await hashPassword(newPassword), mustChangePassword: false }).where(eq(schema.students.id, sid));
    directory.invalidateStudents();
    return c.json({ ok: true }, 200);
  });
