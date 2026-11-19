/** Public self-registration (no auth). Split out of index.ts; behaviour unchanged. */
import { Hono } from "hono";
import { eq, and, inArray, sql as dsql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { db } from "../database";
import * as schema from "../database/schema";
import { id } from "../lib/util";
import { normalizeRoll, rollNoProblem, isDuplicateRollError } from "../lib/students";
import { matchesCohort, ensureOptInOnlyLoaded } from "../lib/roster";
import { type Vars, directory, resolveRegisterTenant, findStudentByRoll } from "../core";

export const registrationRoutes = new Hono<{ Variables: Vars }>()
  // =================== PUBLIC SELF-REGISTRATION (no auth) ===================
  // Meta for the public registration page: tenant name + section dropdown list.
  // The URL uses the college short code (e.g. /register/tkr), resolved below.
  .get("/register/:code/meta", async (c) => {
    const t = await resolveRegisterTenant(c.req.param("code"));
    if (!t) return c.json({ message: "Invalid registration link" }, 404);
    const rows = await db
      .select({ id: schema.classes.id, code: schema.classes.code })
      .from(schema.classes)
      .where(eq(schema.classes.tenantId, t.id));
    rows.sort((a, b) => a.code.localeCompare(b.code));
    return c.json({ tenant: { id: t.id, name: t.name, code: t.shortName }, sections: rows }, 200);
  })
  // Check whether a student already exists for this tenant — by roll number OR name.
  .get("/register/:code/check", async (c) => {
    const raw = String(c.req.query("q") ?? c.req.query("rollNo") ?? "").trim();
    if (!raw) return c.json({ message: "Enter a roll number or name" }, 400);
    const t = await resolveRegisterTenant(c.req.param("code"));
    if (!t) return c.json({ message: "Invalid registration link" }, 404);
    const tid = t.id;

    const roll = raw.replace(/\s+/g, "").toUpperCase();
    const nameQ = raw.replace(/\s+/g, " ");
    // A query containing a digit is treated as a roll number; otherwise a name.
    const looksLikeRoll = /\d/.test(raw);

    // PUBLIC endpoint (no login). It used to answer any partial name with up to six
    // full names and roll numbers, so anyone holding the registration link could
    // list the whole college a few letters at a time. Now: a roll number must match
    // exactly; a name must match the WHOLE name (case and spacing ignored); and
    // the answer carries only the first name, plus the roll number only when the
    // asker already typed it.
    const rollKey = normalizeRoll(raw);
    const nameKey = nameQ.toLowerCase();
    const [hit] = await db
      .select({ name: schema.students.name, rollNo: schema.students.rollNo })
      .from(schema.students)
      .where(
        and(
          eq(schema.students.tenantId, tid),
          looksLikeRoll
            ? dsql`upper(trim(${schema.students.rollNo})) = ${rollKey}`
            : dsql`lower(trim(${schema.students.name})) = ${nameKey}`,
        ),
      )
      .limit(1);
    const firstName = hit ? (String(hit.name ?? "").trim().split(/\s+/)[0] ?? "") : null;

    return c.json(
      {
        query: raw,
        looksLikeRoll,
        exists: !!hit,
        name: firstName || null,
        rollNo: looksLikeRoll ? roll : "",
      },
      200,
    );
  })
  // Register a new student (only if the roll number is not already present).
  .post("/register/:code", async (c) => {
    const rt = await resolveRegisterTenant(c.req.param("code"));
    if (!rt) return c.json({ message: "Invalid registration link" }, 404);
    const tid = rt.id;
    const b = await c.req.json();

    const roll = normalizeRoll(b.rollNo);
    const name = String(b.name ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
    const email = String(b.email ?? "").trim().toLowerCase();
    const phone = String(b.phone ?? "").trim();
    const gender = String(b.gender ?? "").trim().toLowerCase();
    const classId = b.classId ? String(b.classId) : null;

    const rollBad = rollNoProblem(roll);
    if (rollBad) return c.json({ message: rollBad }, 400);
    if (!name) return c.json({ message: "Name is required" }, 400);
    if (!classId) return c.json({ message: "Please select your section" }, 400);
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return c.json({ message: "A valid email is required" }, 400);
    if (!/^\d{10}$/.test(phone.replace(/\D/g, "").slice(-10))) return c.json({ message: "A valid phone number is required" }, 400);
    if (gender !== "male" && gender !== "female") return c.json({ message: "Please select gender" }, 400);

    // Section must belong to this tenant.
    const [cls] = await db
      .select({ id: schema.classes.id })
      .from(schema.classes)
      .where(and(eq(schema.classes.id, classId), eq(schema.classes.tenantId, tid)));
    if (!cls) return c.json({ message: "Invalid section" }, 400);

    // Block duplicates by roll number, ignoring case and padding of what is ALREADY
    // stored — an exact match here missed rows saved before normalisation existed.
    const dupRoll = await findStudentByRoll(tid, roll);
    if (dupRoll) return c.json({ message: "This roll number is already registered", exists: true }, 409);

    // Block duplicate email within the tenant.
    const [dupEmail] = await db
      .select({ id: schema.students.id })
      .from(schema.students)
      .where(and(eq(schema.students.tenantId, tid), eq(schema.students.email, email)));
    if (dupEmail) return c.json({ message: "This email is already registered" }, 409);

    const newStuId = id("stu");
    try {
      await db.insert(schema.students).values({
        id: newStuId,
        tenantId: tid,
        classId,
        rollNo: roll,
        name,
        email,
        phone: phone.replace(/\D/g, "").slice(-10),
        gender,
        password: await hashPassword("Welcome@123"),
      });
    } catch (e) {
      // The check above and this insert are two separate statements, so two students
      // submitting the same roll at the same moment both pass the check. The unique
      // index is the real guarantee; translate its error into the same 409 rather
      // than a 500, so the second one just sees "already registered".
      if (isDuplicateRollError(e)) return c.json({ message: "This roll number is already registered", exists: true }, 409);
      throw e;
    }
    // A new student changes the assignable cohort every admin screen reads.
    directory.invalidateStudents(tid);

    // Late-registrant enrolment: a student who registers after exams were set up
    // must still land in the exam meant for their branch. Cohort matching already
    // makes them eligible for section-targeted exams, but we ALSO write an explicit
    // roster "add" so they're concretely enrolled — visible in the assigned count
    // and robust even if the exam uses explicit "students" assignment. Scoped to
    // exams that are running or scheduled and that target this student's section.
    try {
      const activeExams = await db
        .select()
        .from(schema.exams)
        .where(and(eq(schema.exams.tenantId, tid), inArray(schema.exams.status, ["scheduled", "live"])));
      // Make sure opt-in-only cohorts (ELITE) are known before cohort matching, so a
      // student registering into ELITE is not auto-enrolled into regular exams.
      await ensureOptInOnlyLoaded();
      const stu = { id: newStuId, classId };
      const toEnroll = activeExams.filter((e) => {
        const secIds = (e.sectionIds as string[] | null) ?? null;
        // Cohort-mode exam that targets this student's section (or all sections).
        if (e.assignMode !== "students" && matchesCohort({ classId: e.classId, sectionIds: secIds, assignMode: e.assignMode }, stu)) return true;
        // Explicit "students"-mode exam that still carries this section in its scope.
        if (e.assignMode === "students" && Array.isArray(secIds) && classId && secIds.includes(classId)) return true;
        return false;
      });
      if (toEnroll.length) {
        await db
          .insert(schema.examRoster)
          .values(toEnroll.map((e) => ({ id: id("rost"), examId: e.id, studentId: newStuId, mode: "add" as const, createdBy: null })));
      }
    } catch (e) {
      console.error("[register] auto-enrol failed for", roll, e);
    }

    return c.json({ ok: true, name, rollNo: roll }, 201);
  });
