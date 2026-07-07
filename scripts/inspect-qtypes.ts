import { db } from "../src/api/database/index";
import { exams, examQuestions, questions } from "../src/api/database/schema";
import { eq, inArray } from "drizzle-orm";

const drafts = await db.select().from(exams);
for (const e of drafts) {
  const eqs = await db.select().from(examQuestions).where(eq(examQuestions.examId, e.id));
  const qids = eqs.map((q) => q.questionId);
  const qs = qids.length ? await db.select().from(questions).where(inArray(questions.id, qids)) : [];
  const byType: Record<string, number> = {};
  for (const q of qs) byType[q.type] = (byType[q.type] || 0) + 1;
  console.log(`"${e.title}" [${e.status}] — ${qs.length} qs ${JSON.stringify(byType)}`);
}
process.exit(0);
