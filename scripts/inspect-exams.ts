import { db } from "../src/api/database/index";
import { exams, attempts, examQuestions } from "../src/api/database/schema";
import { eq } from "drizzle-orm";

const now = Date.now();
const fmt = (ms: number | null | undefined) =>
  ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "—";

const allExams = await db.select().from(exams);
console.log(`\n=== EXAMS (${allExams.length}) — now=${fmt(now)} ===`);
for (const e of allExams) {
  const start = (e as any).startAt as number | null;
  const end = (e as any).endAt as number | null;
  const extra = ((e as any).extraMin as number) || 0;
  const hold = ((e as any).holdMs as number) || 0;
  const held = (e as any).heldAt as number | null;
  const over = !held && end != null && now > end + extra * 60000 + hold;
  const qs = await db.select().from(examQuestions).where(eq(examQuestions.examId, e.id));
  const att = await db.select().from(attempts).where(eq(attempts.examId, e.id));
  const byStatus: Record<string, number> = {};
  for (const a of att) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  console.log(
    `\n[${e.status}]${over ? " (OVER)" : ""} "${e.title}" id=${e.id}` +
      `\n   start=${fmt(start)} dur=${(e as any).durationMin}m end=${fmt(end)} extra=${extra} hold=${hold} held=${fmt(held)}` +
      `\n   questions=${qs.length} attempts=${att.length} ${JSON.stringify(byStatus)}`,
  );
}
process.exit(0);
