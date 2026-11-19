/** Question bank: categories and questions. Split out of index.ts; behaviour unchanged. */
import { Hono } from "hono";
import { eq, and, or, desc, sql as dsql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { requireAuth, requirePermission } from "../middleware/auth";
import { listMeta } from "../lib/question-meta";
import { id } from "../lib/util";
import { generateQuestions } from "../lib/ai";
import { inCollege } from "../lib/staff-policy";
import { type Vars, examQuestionsCache, GLOBAL_SETTINGS, getGlobalSettings, examPaperCache, tenantOf, NOT_FOUND } from "../core";

export const questionBankRoutes = new Hono<{ Variables: Vars }>()
  // =================== QUESTIONS ===================
  // =================== CATEGORIES ===================
  .get("/categories", requireAuth, requirePermission("questionBank"), async (c) => {
    const p = c.get("profile")!;
    const tid = p.role === "super_admin" && c.req.query("tenantId") ? c.req.query("tenantId")! : p.tenantId;
    if (!tid) return c.json({ categories: [] }, 200);
    const rows = await db.select().from(schema.categories).where(eq(schema.categories.tenantId, tid)).orderBy(desc(schema.categories.createdAt));
    const counts = await db
      .select({ categoryId: schema.questions.categoryId, n: dsql<number>`count(*)` })
      .from(schema.questions)
      .where(eq(schema.questions.tenantId, tid))
      .groupBy(schema.questions.categoryId);
    const cmap = new Map(counts.map((x) => [x.categoryId, x.n]));
    return c.json({ categories: rows.map((r) => ({ ...r, questionCount: cmap.get(r.id) ?? 0 })) }, 200);
  })
  .post("/categories", requireAuth, requirePermission("questionBank"), async (c) => {
    const p = c.get("profile")!;
    const b = await c.req.json();
    const tid = p.role === "super_admin" ? (b.tenantId ?? p.tenantId) : p.tenantId;
    if (!tid) return c.json({ message: "No tenant" }, 400);
    const [row] = await db
      .insert(schema.categories)
      .values({ id: id("cat"), tenantId: tid, name: b.name, description: b.description ?? null, color: b.color ?? "#1e3a5f" })
      .returning();
    return c.json({ category: row }, 201);
  })
  .patch("/categories/:id", requireAuth, requirePermission("questionBank"), async (c) => {
    if (!inCollege(c.get("profile"), await tenantOf("category", c.req.param("id")))) return c.json(NOT_FOUND, 404);
    const b = await c.req.json();
    const [row] = await db
      .update(schema.categories)
      .set({ name: b.name, description: b.description ?? null, color: b.color ?? "#1e3a5f" })
      .where(eq(schema.categories.id, c.req.param("id")))
      .returning();
    return c.json({ category: row }, 200);
  })
  .delete("/categories/:id", requireAuth, requirePermission("questionBank"), async (c) => {
    const cid = c.req.param("id");
    if (!inCollege(c.get("profile"), await tenantOf("category", cid))) return c.json(NOT_FOUND, 404);
    // Detach questions from this category (keep the questions).
    await db.update(schema.questions).set({ categoryId: null }).where(eq(schema.questions.categoryId, cid));
    await db.delete(schema.categories).where(eq(schema.categories.id, cid));
    return c.json({ ok: true }, 200);
  })

  .get("/questions", requireAuth, requirePermission("questionBank"), async (c) => {
    const p = c.get("profile")!;
    const tid = p.role === "super_admin" && c.req.query("tenantId") ? c.req.query("tenantId")! : p.tenantId;
    if (!tid) return c.json({ questions: [] }, 200);
    const catFilter = c.req.query("categoryId");
    // Visible = own tenant's questions OR any global question from other colleges.
    const visibility = or(eq(schema.questions.tenantId, tid), eq(schema.questions.isGlobal, true));
    const where = catFilter
      ? and(visibility, eq(schema.questions.categoryId, catFilter))
      : visibility;
    const rows = await db
      .select({ q: schema.questions, catName: schema.categories.name, ownerName: schema.tenants.name })
      .from(schema.questions)
      .leftJoin(schema.categories, eq(schema.categories.id, schema.questions.categoryId))
      .leftJoin(schema.tenants, eq(schema.tenants.id, schema.questions.tenantId))
      .where(where)
      .orderBy(desc(schema.questions.createdAt));
    const questions = rows.map((r) => ({
      ...r.q,
      // Lists carry a summary of meta only: rubrics, reference solutions and test
      // cases can be tens of KB per question, and the exam builder loads every
      // question visible to the college. The editor fetches the full question
      // (GET /questions/:id) when it opens.
      meta: listMeta(r.q.meta),
      categoryName: r.catName ?? null,
      ownedByOther: r.q.tenantId !== tid,
      ownerName: r.q.tenantId !== tid ? r.ownerName ?? null : null,
    }));
    return c.json({ questions }, 200);
  })
  // One question with its full meta (rubric, solution, test cases), for the editor.
  .get("/questions/:id", requireAuth, requirePermission("questionBank"), async (c) => {
    const p = c.get("profile")!;
    const [q] = await db.select().from(schema.questions).where(eq(schema.questions.id, c.req.param("id"))).limit(1);
    // Same visibility as the list: own college's questions plus global ones.
    if (!q || (p.role !== "super_admin" && q.tenantId !== p.tenantId && !q.isGlobal)) return c.json(NOT_FOUND, 404);
    return c.json({ question: { ...q, ownedByOther: q.tenantId !== p.tenantId } }, 200);
  })
  .post("/questions", requireAuth, requirePermission("questionBank"), async (c) => {
    const p = c.get("profile")!;
    const b = await c.req.json();
    const tid = p.tenantId!;
    const [row] = await db
      .insert(schema.questions)
      .values({
        id: id("q"),
        tenantId: tid,
        categoryId: b.categoryId ?? null,
        isGlobal: b.isGlobal ?? true,
        type: b.type,
        prompt: b.prompt,
        options: b.options ?? null,
        correct: b.correct ?? null,
        meta: b.meta ?? null,
        points: b.points ?? 1,
        difficulty: b.difficulty ?? "medium",
        topic: b.topic ?? null,
        aiGenerated: !!b.aiGenerated,
        createdBy: p.userId,
      })
      .returning();
    return c.json({ question: row }, 201);
  })
  .patch("/questions/:id", requireAuth, requirePermission("questionBank"), async (c) => {
    if (!inCollege(c.get("profile"), await tenantOf("question", c.req.param("id")))) return c.json(NOT_FOUND, 404);
    const b = await c.req.json();
    // A list copy of meta (see listMeta) lacks the rubric, solution and tests;
    // saving it back would erase them. The editor always loads the full question.
    if (b.meta && typeof b.meta === "object" && ("testCount" in b.meta || "hasRubric" in b.meta)) {
      return c.json({ message: "This copy of the question is incomplete. Reload the page and edit again." }, 409);
    }
    const patch: Record<string, unknown> = {};
    for (const k of ["type", "prompt", "options", "correct", "meta", "points", "difficulty", "topic", "isGlobal", "categoryId"]) {
      if (k in b) patch[k] = b[k];
    }
    const [row] = await db
      .update(schema.questions)
      .set(patch)
      .where(eq(schema.questions.id, c.req.param("id")))
      .returning();
    // Option-order translation is derived from the option list, so a cached copy of
    // this question must not outlive the edit. Cheap: exams are few.
    examQuestionsCache.clear();
    examPaperCache.clear();
    return c.json({ question: row }, 200);
  })
  .delete("/questions/:id", requireAuth, requirePermission("questionBank"), async (c) => {
    if (!inCollege(c.get("profile"), await tenantOf("question", c.req.param("id")))) return c.json(NOT_FOUND, 404);
    await db.delete(schema.questions).where(eq(schema.questions.id, c.req.param("id")));
    examQuestionsCache.clear();
    examPaperCache.clear();
    return c.json({ ok: true }, 200);
  })
  // AI question generation (preview, not saved)
  .post("/questions/generate", requireAuth, requirePermission("questionBank"), async (c) => {
    const b = await c.req.json();
    const gs = await getGlobalSettings();
    const items = await generateQuestions({
      topic: b.topic,
      type: b.type,
      count: Math.min(Number(b.count) || 5, 15),
      difficulty: b.difficulty || "medium",
      provider: gs.aiProvider,
    });
    // track AI usage
    await db.update(schema.settings).set({ aiUsed: dsql`${schema.settings.aiUsed} + 1` }).where(eq(schema.settings.id, GLOBAL_SETTINGS));
    return c.json({ questions: items }, 200);
  })
  .post("/questions/bulk", requireAuth, requirePermission("questionBank"), async (c) => {
    const p = c.get("profile")!;
    const b = await c.req.json(); // { questions: [...] }
    const tid = p.tenantId!;
    const values = (b.questions as Array<Record<string, unknown>>).map((q) => ({
      id: id("q"),
      tenantId: tid,
      categoryId: (q.categoryId as string) ?? null,
      type: String(q.type),
      prompt: String(q.prompt),
      options: (q.options as string[]) ?? null,
      correct: q.correct ?? null,
      meta: (q.meta as Record<string, unknown>) ?? null,
      points: Number(q.points) || 1,
      difficulty: String(q.difficulty ?? "medium"),
      topic: (q.topic as string) ?? null,
      aiGenerated: true,
      createdBy: p.userId,
    }));
    if (values.length) await db.insert(schema.questions).values(values);
    return c.json({ inserted: values.length }, 201);
  });
