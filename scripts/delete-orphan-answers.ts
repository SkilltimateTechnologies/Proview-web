/**
 * Delete `answers` rows whose attempt no longer exists.
 *
 * These accumulate when an exam (and its attempts) is deleted without cascading
 * to answers. They are unreachable by the app — no attempt points at them, so no
 * report, score or export can ever read them — but they keep the table large and
 * make every future orphan audit noisier.
 *
 * Dry run by default. Writes a full backup of every row it deletes before
 * deleting anything, so the operation is reversible.
 *
 *   bun scripts/delete-orphan-answers.ts            # report only
 *   bun scripts/delete-orphan-answers.ts --apply    # back up, then delete
 */
import { db } from "../src/api/database";
import { sql } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");

type OrphanRow = {
  id: string;
  attemptId: string;
  questionId: string | null;
  response: string | null;
  score: number | null;
  maxScore: number | null;
  aiNotes: string | null;
  autoGraded: number | null;
};

async function loadOrphans(): Promise<OrphanRow[]> {
  return db.all<OrphanRow>(sql`
    SELECT ans.id            AS id,
           ans.attempt_id    AS attemptId,
           ans.question_id   AS questionId,
           ans.response      AS response,
           ans.score         AS score,
           ans.max_score     AS maxScore,
           ans.ai_notes      AS aiNotes,
           ans.auto_graded   AS autoGraded
    FROM answers ans
    LEFT JOIN attempts a ON a.id = ans.attempt_id
    WHERE a.id IS NULL
  `);
}

const hasContent = (r: OrphanRow) =>
  (r.response !== null && String(r.response).trim() !== "") || r.score !== null;

const orphans = await loadOrphans();

if (!orphans.length) {
  console.log("No orphaned answer rows. Nothing to do.");
  process.exit(0);
}

const withContent = orphans.filter(hasContent);
const byAttempt = new Map<string, number>();
for (const r of orphans) byAttempt.set(r.attemptId, (byAttempt.get(r.attemptId) ?? 0) + 1);

console.log(`Orphaned answer rows: ${orphans.length}`);
console.log(`  across ${byAttempt.size} deleted attempt(s)`);
console.log(`  ${withContent.length} row(s) carry content or a score:`);
for (const r of withContent) {
  const preview = String(r.response ?? "").replace(/\s+/g, " ").slice(0, 60);
  console.log(`    ${r.id}  attempt=${r.attemptId}  score=${r.score}  response="${preview}"`);
}

// Safety: confirm not one of these attempt ids exists. If any does, the JOIN
// above is wrong and we must not delete anything.
const ids = [...byAttempt.keys()];
let stillLive = 0;
for (let i = 0; i < ids.length; i += 100) {
  const chunk = ids.slice(i, i + 100);
  const found = await db.all<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM attempts WHERE id IN (${sql.join(chunk.map((v) => sql`${v}`), sql`, `)})
  `);
  stillLive += Number(found[0]?.n ?? 0);
}
if (stillLive > 0) {
  console.error(`REFUSING: ${stillLive} of those attempt ids still exist. Orphan query is wrong.`);
  process.exit(1);
}
console.log(`Safety check: 0 of ${ids.length} referenced attempts exist. All rows are genuinely unreachable.`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing deleted. Re-run with --apply to back up and delete.");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `orphan-answers-delete-backup-${stamp}.json`;
await Bun.write(backupPath, JSON.stringify({ deletedAt: new Date().toISOString(), rows: orphans }, null, 2));
console.log(`\nBackup written: ${backupPath} (${orphans.length} rows)`);

let deleted = 0;
const rowIds = orphans.map((r) => r.id);
for (let i = 0; i < rowIds.length; i += 100) {
  const chunk = rowIds.slice(i, i + 100);
  await db.run(sql`DELETE FROM answers WHERE id IN (${sql.join(chunk.map((v) => sql`${v}`), sql`, `)})`);
  deleted += chunk.length;
}
console.log(`Deleted ${deleted} orphaned answer row(s).`);

const remaining = await loadOrphans();
if (remaining.length) {
  console.error(`VERIFICATION FAILED: ${remaining.length} orphan row(s) still present.`);
  process.exit(1);
}
console.log("Verification passed: 0 orphaned answer rows remain.");
