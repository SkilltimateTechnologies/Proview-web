/** Platform settings and the manual AI re-grade. Split out of index.ts; behaviour unchanged. */
import { Hono } from "hono";
import { eq, and, sql as dsql } from "drizzle-orm";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { db } from "../database";
import * as schema from "../database/schema";
import { requireAuth, requireSuperAdmin, requirePermission } from "../middleware/auth";
import { normaliseConfigKeys, sebMonitor } from "../lib/seb";
import { gradeSubjective } from "../lib/ai";
import { tenantQuotas } from "../lib/tenant-quota";
import { type Vars, GLOBAL_SETTINGS, getGlobalSettings, invalidateGlobalSettings } from "../core";

export const settingsRoutes = new Hono<{ Variables: Vars }>()
  // =================== SETTINGS ===================
  .post("/change-password", requireAuth, async (c) => {
    const user = c.get("user")!;
    const b = await c.req.json();
    const currentPassword = String(b.currentPassword ?? "");
    const newPassword = String(b.newPassword ?? "");
    if (newPassword.length < 8) return c.json({ message: "New password must be at least 8 characters" }, 400);
    const [acc] = await db.select().from(schema.account).where(and(eq(schema.account.userId, user.id), eq(schema.account.providerId, "credential")));
    if (!acc || !acc.password) return c.json({ message: "No credential account" }, 404);
    const valid = await verifyPassword({ hash: acc.password, password: currentPassword });
    if (!valid) return c.json({ message: "Current password is incorrect" }, 400);
    await db.update(schema.account).set({ password: await hashPassword(newPassword), updatedAt: new Date() }).where(eq(schema.account.id, acc.id));
    return c.json({ ok: true }, 200);
  })

  .get("/settings", requireAuth, requireSuperAdmin, async (c) => {
    const s = await getGlobalSettings();
    // mask keys
    const mask = (v: string | null) => (v ? `${v.slice(0, 4)}••••${v.slice(-3)}` : null);
    return c.json(
      {
        settings: {
          ...s,
          judge0Key: mask(s.judge0Key),
          claudeKey: mask(s.claudeKey),
          geminiKey: mask(s.geminiKey),
          openaiKey: mask(s.openaiKey),
          proctoring: { ...schema.DEFAULT_PROCTORING, ...(s.proctoring ?? {}) },
          // Last Safe Exam Browser request this server saw, for the lab test.
          seb: sebMonitor.status(),
        },
      },
      200,
    );
  })
  .patch("/settings", requireAuth, requireSuperAdmin, async (c) => {
    const b = await c.req.json();
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["aiProvider", "judge0Limit", "aiLimit"]) if (b[k] !== undefined) patch[k] = b[k];
    // Platform-global quota defaults (lib/tenant-quota.ts). A cleared field, a
    // null, a 0 or junk all store NULL = unlimited: a ceiling of zero would
    // refuse every student on the platform, and the likeliest source of a 0 is an
    // empty input box rather than intent.
    for (const k of ["maxConcurrentAttempts", "maxEvidencePerAttempt"]) {
      if (b[k] === undefined) continue;
      const n = Math.floor(Number(b[k]));
      patch[k] = b[k] === null || b[k] === "" || !Number.isFinite(n) || n <= 0 ? null : n;
    }
    // only overwrite keys if a non-masked value is provided
    for (const k of ["judge0Key", "claudeKey", "geminiKey", "openaiKey"]) {
      if (b[k] !== undefined && b[k] !== null && !String(b[k]).includes("••")) patch[k] = b[k];
    }
    if (b.proctoring !== undefined) {
      const cur = await getGlobalSettings();
      const next = { ...schema.DEFAULT_PROCTORING, ...(cur.proctoring ?? {}), ...b.proctoring };
      next.sebConfigKeys = normaliseConfigKeys(next.sebConfigKeys);
      // Whole minutes, 0 (off) to 600. Junk or an empty box keeps the default.
      const m = Math.floor(Number(next.minSubmitMinutes));
      next.minSubmitMinutes = Number.isFinite(m) && m >= 0 ? Math.min(m, 600) : schema.DEFAULT_PROCTORING.minSubmitMinutes;
      next.requireSeb = next.requireSeb === true;
      patch.proctoring = next;
    }
    await getGlobalSettings(); // ensure row exists
    const [s] = await db.update(schema.settings).set(patch).where(eq(schema.settings.id, GLOBAL_SETTINGS)).returning();
    invalidateGlobalSettings();
    // A changed default must apply now, not after the quota cache TTL.
    tenantQuotas.invalidateAll();
    return c.json({ ok: true, aiProvider: s.aiProvider }, 200);
  })

  // =================== AI EVALUATION (manual re-grade demo) ===================
  .post("/ai/grade", requireAuth, requirePermission("questionBank"), async (c) => {
    const b = await c.req.json();
    // Settings are a single global row keyed by id — there is no per-tenant
    // settings row (an earlier per-tenant lookup here referenced a column that
    // does not exist and 500'd this endpoint on every call).
    const s = await getGlobalSettings();
    const provider: string | null = s?.aiProvider ?? null;
    await db.update(schema.settings).set({ aiUsed: dsql`${schema.settings.aiUsed} + 1` }).where(eq(schema.settings.id, GLOBAL_SETTINGS));
    const res = await gradeSubjective({
      question: b.question,
      rubric: b.rubric,
      studentAnswer: b.studentAnswer,
      maxPoints: b.maxPoints ?? 10,
      isCode: b.isCode,
      language: b.language,
      provider,
    });
    return c.json(res, 200);
  });
