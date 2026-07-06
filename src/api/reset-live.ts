import { db } from "./database";
import * as schema from "./database/schema";
import { eq, and, inArray } from "drizzle-orm";

// Delete any attempts on LIVE exams so seed students see them as available again.
async function main() {
  const liveExams = await db.select().from(schema.exams).where(eq(schema.exams.status, "live"));
  if (!liveExams.length) { console.log("No live exams."); return; }
  const ids = liveExams.map((e) => e.id);
  console.log("Live exams:", liveExams.map((e) => e.title));
  const atts = await db.select().from(schema.attempts).where(inArray(schema.attempts.examId, ids));
  console.log(`Deleting ${atts.length} attempts on live exams…`);
  // delete answers first if a table exists
  for (const a of atts) {
    if (schema.answers) {
      await db.delete(schema.answers).where(eq(schema.answers.attemptId, a.id));
    }
  }
  if (atts.length) await db.delete(schema.attempts).where(inArray(schema.attempts.examId, ids));
  console.log("Done. Live exams are now fresh.");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
