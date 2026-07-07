import { createClient } from "@libsql/client";

const client = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

// libsql/SQLite has no "ADD COLUMN IF NOT EXISTS" — run each and ignore
// "duplicate column name" errors so the script is idempotent.
const stmts = [
  `ALTER TABLE exams ADD COLUMN held_at integer`,
  `ALTER TABLE exams ADD COLUMN hold_ms integer NOT NULL DEFAULT 0`,
  `ALTER TABLE exams ADD COLUMN extra_min integer NOT NULL DEFAULT 0`,
  `ALTER TABLE attempts ADD COLUMN last_seen_at integer`,
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
console.log("Migration complete.");
process.exit(0);
