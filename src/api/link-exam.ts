// One-off: link the 6 seed questions to the live "Aptitude Mock" exam and reset
// STU-21CS102's attempt so the desktop student flow can be tested end-to-end.
import { db } from "./database";
import * as schema from "./database/schema";
import { eq, and } from "drizzle-orm";
import { id } from "./lib/util";

const TID = "ten_990d34e8674e4cf8";

const [exam] = await db.select().from(schema.exams).where(and(eq(schema.exams.tenantId, TID), eq(schema.exams.title, "Aptitude Mock"))).limit(1);
if (!exam) throw new Error("Aptitude Mock exam not found");

const qs = await db.select().from(schema.questions).where(eq(schema.questions.tenantId, TID));
console.log("questions:", qs.length, "exam:", exam.id);

const existing = await db.select().from(schema.examQuestions).where(eq(schema.examQuestions.examId, exam.id));
if (existing.length === 0) {
  let order = 0;
  let total = 0;
  for (const q of qs) {
    await db.insert(schema.examQuestions).values({ id: id("eq"), examId: exam.id, questionId: q.id, order: order++, points: q.points ?? 1 });
    total += q.points ?? 1;
  }
  await db.update(schema.exams).set({ totalPoints: total }).where(eq(schema.exams.id, exam.id));
  console.log("linked", qs.length, "questions, totalPoints", total);
} else {
  console.log("already linked:", existing.length);
}

// Reset our test student's attempt on this exam to not_started (delete it).
const [stu] = await db.select().from(schema.students).where(eq(schema.students.rollNo, "STU-21CS102")).limit(1);
if (stu) {
  const del = await db.delete(schema.attempts).where(and(eq(schema.attempts.examId, exam.id), eq(schema.attempts.studentId, stu.id))).returning();
  console.log("cleared attempts for STU-21CS102:", del.length);
}
console.log("done. examId =", exam.id);
