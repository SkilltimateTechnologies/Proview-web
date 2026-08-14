import { createClient } from "@libsql/client";

const client = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

// libsql/SQLite has no "ADD COLUMN IF NOT EXISTS" — run each and ignore
// "duplicate column name" errors so the script is idempotent.
const stmts = [
  // remembers the student's home section when they are moved into an
  // opt-in-only cohort (ELITE), so they can be restored later.
  `ALTER TABLE students ADD COLUMN original_class_id text`,
  // freezes the section label on each attempt so historic reports keep
  // showing the section the student sat the exam in.
  `ALTER TABLE attempts ADD COLUMN section_snapshot text`,
];

for (const sql of stmts) {
  try {
    await client.execute(sql);
    console.log("OK:", sql);
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (/duplicate column name/i.test(msg)) {
      console.log("SKIP (exists):", sql);
    } else {
      console.error("FAIL:", sql, "\n ", msg);
      process.exit(1);
    }
  }
}

// Backfill section_snapshot for every existing attempt from the student's
// CURRENT class. Must run before anyone is moved into ELITE.
const res = await client.execute(`
  UPDATE attempts
     SET section_snapshot = (
           SELECT c.code
             FROM students s
             JOIN classes c ON c.id = s.class_id
            WHERE s.id = attempts.student_id
         )
   WHERE section_snapshot IS NULL
`);
console.log("Backfilled section_snapshot rows:", res.rowsAffected);

const left = await client.execute(
  `SELECT count(*) AS n FROM attempts WHERE section_snapshot IS NULL`,
);
console.log("Attempts still without snapshot (no class linked):", left.rows[0]?.n);

console.log("Migration complete.");
process.exit(0);
