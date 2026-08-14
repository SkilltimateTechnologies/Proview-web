/**
 * Merge duplicate student records.
 *
 * Duplicate students happened because there was no uniqueness guarantee on
 * (tenant, roll_no) and three separate write paths could each create a row:
 * a TPO adding a student by hand (no duplicate check at all), a CSV bulk import
 * (exact-string dedupe only), and public self-registration (exact-string dedupe,
 * and it happily accepted a pasted college EMAIL as the roll number).
 *
 * The code fixes stop new ones. This script repairs the existing rows, which
 * fall into two shapes:
 *
 *   MERGE  — two rows are the same person and BOTH have exam attempts. The
 *            attempts must be moved onto the keeper before the loser is deleted,
 *            or real exam results are destroyed. If both rows sat the SAME exam
 *            the move would violate attempts_exam_student_uq, so that case is
 *            reported and skipped rather than guessed at.
 *   DELETE  — a ghost row: same person, zero attempts, nothing to lose.
 *
 * Every action is explicit and listed below; nothing is inferred at runtime, so
 * this script cannot decide on its own to delete a student it misidentified.
 *
 * Usage:
 *   bun scripts/merge-duplicate-students.ts            # dry run, changes nothing
 *   bun scripts/merge-duplicate-students.ts --apply    # writes, after a backup
 */
import { createClient } from "@libsql/client";
import { writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const db = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });

/** Move every attempt from `fromRoll` onto `toRoll`, then delete `fromRoll`. */
type Merge = { kind: "merge"; from: string; to: string; why: string };
/** Delete `roll` outright. Asserted to have zero attempts before it is touched. */
type Ghost = { kind: "delete"; roll: string; why: string };
type Action = Merge | Ghost;

const ACTIONS: Action[] = [
  // ---- MERGES (loser has real attempts that must be preserved) ----
  {
    kind: "merge",
    from: "23K91A0491@TKRCET.COM",
    to: "23K91A0491",
    why: "Self-registered with the college email pasted into the roll field. Same roll, same person.",
  },
  {
    kind: "merge",
    from: "24K95A0503@TKRCET.COM",
    to: "24K95A0503",
    why: "Same as above. NOTE: 23K91A0539 (Boda Sandeep) is a DIFFERENT student who shares the name and is deliberately left alone.",
  },

  // ---- GHOSTS (zero attempts, roll number is a typo of the real one) ----
  { kind: "delete", roll: "23K91A0678", why: "Typo of 23K91A0578 (G.Sathwika, 3 attempts). Never attempted anything." },
  { kind: "delete", roll: "23K9A0568", why: "Typo of 23K91A0568 (Abhicharan Enukonda). Same phone. Never attempted anything." },
  { kind: "delete", roll: "23K91A049", why: "Truncated 23K91A0494 (Gurram Adhithya). Never attempted anything." },
  { kind: "delete", roll: "23K1A04A4", why: "Typo of 23K91A04A4 (K Ravikumar). Same phone. Never attempted anything." },
  { kind: "delete", roll: "23K91A66B56", why: "Typo of 23K91A66B6 (Mardhi Vijayendra Reddy). Never attempted anything." },
  { kind: "delete", roll: "23K9104L2", why: "Typo of 23K91A04L2 (Varshith Reddy). Same phone. Never attempted anything." },
  { kind: "delete", roll: "24K91A04L2", why: "Wrong-year variant of 23K91A04L2 (Varshith Reddy). Never attempted anything." },
  { kind: "delete", roll: "22K91A05A21", why: "Typo of 22K91A05A1 (Jala Manikanta Swamy). Same phone. Neither row has attempts; 05A1 is the valid roll format, so it is the keeper." },
];

type StudentRow = { id: string; roll_no: string; name: string; tenant_id: string; class_id: string | null };

async function studentByRoll(roll: string): Promise<StudentRow | null> {
  const r = await db.execute({ sql: "SELECT * FROM students WHERE roll_no = ?", args: [roll] });
  return (r.rows[0] as unknown as StudentRow) ?? null;
}

async function attemptsOf(studentId: string) {
  const r = await db.execute({
    sql: `SELECT a.id, a.exam_id, a.status, a.score, e.title
          FROM attempts a JOIN exams e ON e.id = a.exam_id
          WHERE a.student_id = ?`,
    args: [studentId],
  });
  return r.rows as unknown as { id: string; exam_id: string; status: string; score: number | null; title: string }[];
}

const plan: string[] = [];
const problems: string[] = [];
const backup: Record<string, unknown>[] = [];

for (const act of ACTIONS) {
  if (act.kind === "delete") {
    const stu = await studentByRoll(act.roll);
    if (!stu) { plan.push(`SKIP   delete ${act.roll} — no such student (already cleaned?)`); continue; }
    const atts = await attemptsOf(stu.id);
    if (atts.length > 0) {
      // Refuse: the assumption this action rests on is false.
      problems.push(`REFUSE delete ${act.roll} (${stu.name}) — it has ${atts.length} attempt(s); deleting would destroy exam results.`);
      continue;
    }
    plan.push(`DELETE ${act.roll} (${stu.name}) — 0 attempts. ${act.why}`);
    backup.push({ action: "delete", student: stu, attempts: [] });
    if (APPLY) {
      // Clear roster entries first so no exam still points at a student that is gone.
      await db.execute({ sql: "DELETE FROM exam_roster WHERE student_id = ?", args: [stu.id] });
      await db.execute({ sql: "DELETE FROM students WHERE id = ?", args: [stu.id] });
    }
    continue;
  }

  const loser = await studentByRoll(act.from);
  const keeper = await studentByRoll(act.to);
  if (!loser) { plan.push(`SKIP   merge ${act.from} — no such student (already merged?)`); continue; }
  if (!keeper) { problems.push(`REFUSE merge ${act.from} → ${act.to} — keeper ${act.to} does not exist.`); continue; }
  if (loser.id === keeper.id) { plan.push(`SKIP   merge ${act.from} → ${act.to} — same row.`); continue; }
  if (loser.tenant_id !== keeper.tenant_id) {
    problems.push(`REFUSE merge ${act.from} → ${act.to} — different tenants.`);
    continue;
  }

  const loserAtts = await attemptsOf(loser.id);
  const keeperAtts = await attemptsOf(keeper.id);
  const keeperExams = new Set(keeperAtts.map((a) => a.exam_id));
  // Both rows sitting the same exam cannot be merged automatically: moving the
  // attempt would break attempts_exam_student_uq, and picking which of the two
  // results is "the real one" is a human decision about a student's grade.
  const collide = loserAtts.filter((a) => keeperExams.has(a.exam_id));
  if (collide.length) {
    problems.push(
      `REFUSE merge ${act.from} → ${act.to} — both rows have an attempt on the same exam(s): ` +
        collide.map((a) => `${a.title} (loser ${a.score}, keeper ${keeperAtts.find((k) => k.exam_id === a.exam_id)?.score})`).join("; ") +
        `. Needs a human decision on which score stands.`,
    );
    continue;
  }

  plan.push(
    `MERGE  ${act.from} (${loser.name}) → ${act.to} (${keeper.name}): ` +
      `moving ${loserAtts.length} attempt(s) [${loserAtts.map((a) => `${a.title}=${a.score}`).join(", ") || "none"}], then deleting the duplicate row. ${act.why}`,
  );
  backup.push({ action: "merge", loser, keeper, movedAttempts: loserAtts });

  if (APPLY) {
    await db.execute({ sql: "UPDATE attempts SET student_id = ? WHERE student_id = ?", args: [keeper.id, loser.id] });
    // Roster rows are (exam, student) pairs; re-point them, ignoring any that would
    // duplicate a row the keeper already has.
    await db.execute({
      sql: `UPDATE OR IGNORE exam_roster SET student_id = ? WHERE student_id = ?`,
      args: [keeper.id, loser.id],
    });
    await db.execute({ sql: "DELETE FROM exam_roster WHERE student_id = ?", args: [loser.id] });
    await db.execute({ sql: "DELETE FROM students WHERE id = ?", args: [loser.id] });
  }
}

console.log(APPLY ? "=== APPLYING ===" : "=== DRY RUN (no changes) ===");
for (const line of plan) console.log("  " + line);
if (problems.length) {
  console.log("\n=== NEEDS ATTENTION ===");
  for (const line of problems) console.log("  " + line);
}

if (APPLY) {
  const file = `student-merge-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), backup }, null, 2));
  console.log(`\nBackup written: ${file}`);

  // Verify the outcome rather than assuming it.
  const dupes = await db.execute(
    `SELECT tenant_id, upper(trim(roll_no)) r, COUNT(*) n FROM students
     GROUP BY tenant_id, upper(trim(roll_no)) HAVING n > 1`,
  );
  const bad = await db.execute("SELECT roll_no FROM students WHERE roll_no LIKE '%@%' OR roll_no <> trim(roll_no) OR roll_no <> upper(roll_no)");
  const orphanAtt = await db.execute("SELECT COUNT(*) n FROM attempts a WHERE NOT EXISTS (SELECT 1 FROM students s WHERE s.id = a.student_id)");
  console.log(`\nPost-merge: duplicate roll groups=${dupes.rows.length}, malformed rolls=${bad.rows.length}, orphaned attempts=${(orphanAtt.rows[0] as any).n}`);
  if (dupes.rows.length || bad.rows.length || Number((orphanAtt.rows[0] as any).n) > 0) {
    console.error("Post-merge verification FAILED — inspect before deploying.");
    process.exit(1);
  }
  console.log("Post-merge verification passed.");
}
process.exit(problems.length ? 2 : 0);
