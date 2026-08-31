/**
 * Per-tenant capacity quotas — a ceiling one college cannot cross, so it cannot
 * take the platform down for every other college.
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything shipped in this program so far made the same work cheaper. None of it
 * put an upper bound on the work. A single tenant scheduling a 5,000-student exam
 * at 10am, or a client bug that captures a webcam frame every 200ms instead of
 * every 27s, still consumes the whole shared database budget and every other
 * tenant's exam degrades with it. Cheaper is not the same as bounded.
 *
 * Two ceilings, because they are the two things that actually scale with a
 * tenant's behaviour rather than with the platform's:
 *
 *   maxConcurrentAttempts   how many attempts one tenant may have IN PROGRESS at
 *                           once. Bounds the live read/write load.
 *   maxEvidencePerAttempt   how many non-violation proctoring rows (periodic
 *                           frames and device-fault records) may be STORED per
 *                           attempt. Bounds the table that is kept forever.
 *
 * THE DEFAULT IS "NOTHING CHANGES"
 * --------------------------------
 * This is the rule the whole design bends around: every tenant defaults to
 * inherit-global, and the global default is unlimited. Until somebody
 * deliberately types a number this module changes **zero decisions**, and its
 * entire cost is ONE `count(*)` over the (tiny) tenants table per minute per
 * process — the check for "has anyone set an override?". Per request, on the
 * unconfigured platform, it is zero queries: the callers skip every check when
 * the resolved limit is null, and the resolver never reads a tenant row when
 * there is neither a global default nor any override on record.
 *
 * That one-per-minute count is the honest price of noticing a quota that another
 * process wrote. An in-process flag would be free and would silently ignore every
 * quota set by a different replica, which is worse.
 *
 * RESOLUTION ORDER
 * ----------------
 *   tenant value (non-null, > 0)  ->  global default (non-null, > 0)  ->  unlimited
 *
 * ZERO AND NEGATIVE MEAN UNLIMITED, NOT "BLOCK EVERYTHING".
 * A quota of 0 would refuse every student in the college the moment an exam
 * started, and the likeliest way to arrive at 0 is not intent — it is an empty
 * form field coerced through Number(""), a cleared input, or a JSON null that
 * became 0 somewhere. The cost of reading 0 as "unlimited" is a quota that
 * silently does nothing; the cost of reading it as "block" is a cancelled exam
 * for a whole college. There is already a deliberate, obvious way to stop a
 * tenant: `tenants.enabled = false`.
 *
 * WHAT THE CEILINGS DO NOT DO
 * ---------------------------
 *  - The concurrency gate NEVER touches a student who is already writing. It is
 *    checked only where a NEW live attempt is admitted; resume, reload, autosave,
 *    heartbeat and submit are never gated. A quota that could throw a student out
 *    of a paper they are halfway through would be worse than the overload it
 *    prevents.
 *  - The evidence cap NEVER drops a violation. It trims periodic frames and
 *    device-fault rows only. Evidence volume is a load problem; misconduct is a
 *    record, and the two must not be traded against each other (§34's rule).
 *
 * Every class here takes `db` as a parameter and never imports the app singleton,
 * so tests drive the real SQL against in-memory libSQL.
 */
import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/libsql";
import * as schema from "../database/schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** A resolved ceiling. `null` means unlimited — never 0. */
export type QuotaLimits = {
  maxConcurrentAttempts: number | null;
  maxEvidencePerAttempt: number | null;
};

/** What every tenant gets until somebody sets a number. */
export const UNLIMITED_QUOTA: QuotaLimits = Object.freeze({
  maxConcurrentAttempts: null,
  maxEvidencePerAttempt: null,
});

/** Raw (possibly null / junk) limit pair, as stored on a tenant or on settings. */
export type QuotaSource = {
  maxConcurrentAttempts?: number | null;
  maxEvidencePerAttempt?: number | null;
};

/**
 * tenant -> global -> unlimited, with 0, negatives and non-finite values all
 * treated as "not set". Pure, and the oracle the tests compare against.
 */
export function resolveLimit(tenantVal: unknown, globalVal: unknown): number | null {
  for (const raw of [tenantVal, globalVal]) {
    if (raw === null || raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    const floored = Math.floor(n);
    if (floored > 0) return floored;
    // 0 or negative: deliberately ignored, see the header. Fall through to the
    // next level rather than returning "block everything".
  }
  return null;
}

/** Resolve both ceilings for one tenant against the global defaults. */
export function resolveQuota(tenant: QuotaSource | null | undefined, globals: QuotaSource | null | undefined): QuotaLimits {
  const limits: QuotaLimits = {
    maxConcurrentAttempts: resolveLimit(tenant?.maxConcurrentAttempts, globals?.maxConcurrentAttempts),
    maxEvidencePerAttempt: resolveLimit(tenant?.maxEvidencePerAttempt, globals?.maxEvidencePerAttempt),
  };
  return limits;
}

/** True when no ceiling of any kind applies — the caller can skip everything. */
export function quotaIsUnlimited(q: QuotaLimits): boolean {
  return q.maxConcurrentAttempts === null && q.maxEvidencePerAttempt === null;
}

/** How long a tenant's own quota row is trusted. Quotas change by hand, rarely. */
export const QUOTA_TTL_MS = 60_000;

/**
 * The tenant's two numbers, cached.
 *
 * `load` is handed the already-cached global settings row by the caller (the API
 * keeps that in its own TTL cache), so the only thing this can cost is one narrow
 * two-column read of the tenant row, at most once a minute per tenant — and not
 * even that when no global default is set and therefore nothing can be inherited.
 */
export class TenantQuotaCache {
  private entries = new Map<string, { limits: QuotaLimits; expiresAtMs: number }>();

  async load(db: Db, tenantId: string, globals: QuotaSource | null | undefined, nowMs = Date.now()): Promise<QuotaLimits> {
    if (!tenantId) return UNLIMITED_QUOTA;
    const globalLimits = resolveQuota(null, globals);
    const cached = this.entries.get(tenantId);
    if (cached && cached.expiresAtMs > nowMs) return cached.limits;

    // FAST PATH: with no global default AND no tenant override anywhere on
    // record, nothing can be inherited and nothing can be overridden, so the
    // answer is unlimited without reading the tenant row at all. The
    // "anywhere on record" half is a cached count, so this costs one small
    // query a minute for the whole process rather than one per tenant read.
    let row: QuotaSource | null = null;
    if (!quotaIsUnlimited(globalLimits) || (await this.overridesExist(db, nowMs))) {
      const [r] = await db
        .select({
          maxConcurrentAttempts: schema.tenants.maxConcurrentAttempts,
          maxEvidencePerAttempt: schema.tenants.maxEvidencePerAttempt,
        })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, tenantId))
        .limit(1);
      row = r ?? null;
    }
    const limits = resolveQuota(row, globals);
    this.entries.set(tenantId, { limits, expiresAtMs: nowMs + QUOTA_TTL_MS });
    if (this.entries.size > 5_000) this.prune(nowMs);
    return limits;
  }

  /**
   * "Does any tenant have a quota override at all?"
   *
   * Cached for QUOTA_TTL_MS. The count is over `tenants`, which has one row per
   * college — it is the cheapest question in the schema, and asking it is what
   * lets a quota set by ANOTHER process (or set before a restart) take effect.
   * Errors resolve to `true`: on a database that cannot answer, do the extra
   * tenant read rather than silently ignoring every configured ceiling.
   */
  private overrides: { exist: boolean; expiresAtMs: number } | null = null;
  async overridesExist(db: Db, nowMs = Date.now()): Promise<boolean> {
    if (this.overrides && this.overrides.expiresAtMs > nowMs) return this.overrides.exist;
    let exist = true;
    try {
      const [row] = await db
        .select({ n: dsql<number>`count(*)` })
        .from(schema.tenants)
        .where(
          dsql`(${schema.tenants.maxConcurrentAttempts} is not null and ${schema.tenants.maxConcurrentAttempts} > 0)
               or (${schema.tenants.maxEvidencePerAttempt} is not null and ${schema.tenants.maxEvidencePerAttempt} > 0)`,
        );
      exist = Number(row?.n ?? 0) > 0;
    } catch {
      exist = true;
    }
    this.overrides = { exist, expiresAtMs: nowMs + QUOTA_TTL_MS };
    return exist;
  }

  /** Called by the admin write path so a new override applies immediately. */
  markTenantOverridesExist(nowMs = Date.now()): void {
    this.overrides = { exist: true, expiresAtMs: nowMs + QUOTA_TTL_MS };
  }

  invalidate(tenantId: string): void {
    this.entries.delete(tenantId);
  }
  invalidateAll(): void {
    this.entries.clear();
    this.overrides = null;
  }
  size(): number {
    return this.entries.size;
  }
  private prune(nowMs: number): void {
    for (const [k, v] of this.entries) if (v.expiresAtMs <= nowMs) this.entries.delete(k);
  }
}

export const tenantQuotas = new TenantQuotaCache();

/**
 * How long a live-attempt count is trusted. Short, because it is checked during a
 * start burst — the moment when the number moves fastest.
 */
export const CONCURRENCY_TTL_MS = 5_000;

export type GateResult = { allowed: boolean; live: number; limit: number };

/**
 * "Does this tenant already have too many students writing?"
 *
 * The count is a JOIN-and-COUNT over in-progress attempts, which is far too
 * expensive to run on every /start during a 1,000-student burst. So it is cached
 * for CONCURRENCY_TTL_MS and every attempt admitted in between is added locally.
 * That makes the gate EXACT on the way up inside a window (the local increments
 * are the admissions) and only approximate on the way down (submits inside the
 * window are not noticed until the count is re-read), which is the safe direction:
 * it can briefly under-admit, never over-admit.
 *
 * Stated plainly because it matters: this is a per-process gate. Two API
 * processes each hold their own count, so the effective ceiling is per process
 * and a two-replica deploy could admit up to 2x the number for one TTL window.
 * That is acceptable for a capacity ceiling whose job is to stop a runaway
 * order-of-magnitude, and it is NOT acceptable for anything that must be exact —
 * which is why nothing about correctness or eligibility is decided here.
 */
export class ConcurrencyGate {
  private counts = new Map<string, { live: number; expiresAtMs: number }>();

  async check(db: Db, tenantId: string, limit: number, nowMs = Date.now()): Promise<GateResult> {
    const live = await this.liveCount(db, tenantId, nowMs);
    return { allowed: live < limit, live, limit };
  }

  /** Count one admitted attempt against the cached total, without a re-read. */
  note(tenantId: string, nowMs = Date.now()): void {
    const cached = this.counts.get(tenantId);
    if (cached && cached.expiresAtMs > nowMs) cached.live += 1;
  }

  private async liveCount(db: Db, tenantId: string, nowMs: number): Promise<number> {
    const cached = this.counts.get(tenantId);
    if (cached && cached.expiresAtMs > nowMs) return cached.live;
    const [row] = await db
      .select({ n: dsql<number>`count(*)` })
      .from(schema.attempts)
      .innerJoin(schema.exams, eq(schema.attempts.examId, schema.exams.id))
      .where(and(eq(schema.exams.tenantId, tenantId), eq(schema.attempts.status, "in_progress")));
    const live = Number(row?.n ?? 0);
    this.counts.set(tenantId, { live, expiresAtMs: nowMs + CONCURRENCY_TTL_MS });
    return live;
  }

  invalidate(tenantId: string): void {
    this.counts.delete(tenantId);
  }
  invalidateAll(): void {
    this.counts.clear();
  }
  peek(tenantId: string): number | null {
    return this.counts.get(tenantId)?.live ?? null;
  }
}

export const concurrencyGate = new ConcurrencyGate();

/** Idle attempts are dropped from the evidence ledger after this long. */
export const EVIDENCE_IDLE_MS = 30 * 60_000;
/** Hard ceiling on tracked attempts, so a long-running process stays bounded. */
export const EVIDENCE_MAX_ENTRIES = 20_000;

/**
 * How many more evidence rows one attempt may store.
 *
 * Seeded with a single indexed COUNT the first time an attempt writes evidence in
 * this process, then maintained in memory as rows are inserted — evidence only
 * ever grows, so a carried count is exact for the lifetime of the attempt (the
 * same monotonicity argument as the §37 rollup, and the same reason it is safe).
 *
 * Deletes make the carried count too HIGH, which means the cap engages early and
 * stores less evidence than allowed. That is the harmless direction, and
 * `invalidateAll()` on the admin delete paths clears it anyway.
 */
export class EvidenceMeter {
  private entries = new Map<string, { stored: number; noticed: boolean; touchedAtMs: number }>();

  /**
   * Rows still allowed for this attempt. `Infinity` when uncapped, so the caller
   * can compare without special-casing.
   */
  async room(db: Db, attemptId: string, cap: number | null, evidenceTypes: Iterable<string>, nowMs = Date.now()): Promise<number> {
    if (cap === null) return Number.POSITIVE_INFINITY;
    if (!attemptId) return Number.POSITIVE_INFINITY;
    const entry = await this.entry(db, attemptId, evidenceTypes, nowMs);
    return Math.max(0, cap - entry.stored);
  }

  /** Record rows actually inserted. */
  add(attemptId: string, n: number, nowMs = Date.now()): void {
    if (n <= 0) return;
    const entry = this.entries.get(attemptId);
    if (!entry) return; // never seeded => uncapped tenant, nothing to track
    entry.stored += n;
    entry.touchedAtMs = nowMs;
  }

  /**
   * True exactly once per attempt per process — used to write a single
   * `evidence_capped` marker so the record shows WHY the frames stop, instead of
   * the silence that §34 was written to eliminate.
   */
  noticeOnce(attemptId: string): boolean {
    const entry = this.entries.get(attemptId);
    if (!entry || entry.noticed) return false;
    entry.noticed = true;
    return true;
  }

  private async entry(db: Db, attemptId: string, evidenceTypes: Iterable<string>, nowMs: number) {
    const existing = this.entries.get(attemptId);
    if (existing) {
      existing.touchedAtMs = nowMs;
      return existing;
    }
    const types = [...evidenceTypes];
    const [row] = types.length
      ? await db
          .select({ n: dsql<number>`count(*)` })
          .from(schema.integrityEvents)
          .where(and(eq(schema.integrityEvents.attemptId, attemptId), inArray(schema.integrityEvents.type, types)))
      : [{ n: 0 }];
    const entry = { stored: Number(row?.n ?? 0), noticed: false, touchedAtMs: nowMs };
    this.entries.set(attemptId, entry);
    if (this.entries.size > EVIDENCE_MAX_ENTRIES) this.prune(nowMs);
    return entry;
  }

  invalidate(attemptId: string): void {
    this.entries.delete(attemptId);
  }
  invalidateAll(): void {
    this.entries.clear();
  }
  size(): number {
    return this.entries.size;
  }
  private prune(nowMs: number): void {
    for (const [k, v] of this.entries) if (nowMs - v.touchedAtMs > EVIDENCE_IDLE_MS) this.entries.delete(k);
    if (this.entries.size > EVIDENCE_MAX_ENTRIES) {
      // Still over: drop the oldest-touched half rather than growing without bound.
      const byAge = [...this.entries.entries()].sort((a, b) => a[1].touchedAtMs - b[1].touchedAtMs);
      for (const [k] of byAge.slice(0, Math.floor(byAge.length / 2))) this.entries.delete(k);
    }
  }
}

export const evidenceMeter = new EvidenceMeter();

/** attempt -> tenant is immutable, so this can be cached for a long time. */
export const ATTEMPT_TENANT_TTL_MS = 5 * 60_000;

/**
 * Which tenant owns an attempt, for the evidence cap on the student write path.
 *
 * `attempts.exam_id` and `exams.tenant_id` are both write-once, so this mapping
 * cannot change for a given attempt — the same immutability argument that makes
 * `attempt-owner.ts` safe. Misses are not cached, for the same reason as there.
 */
export class AttemptTenantCache {
  private entries = new Map<string, { tenantId: string; expiresAtMs: number }>();

  async load(db: Db, attemptId: string, nowMs = Date.now()): Promise<string | null> {
    if (!attemptId) return null;
    const cached = this.entries.get(attemptId);
    if (cached && cached.expiresAtMs > nowMs) return cached.tenantId;
    const [row] = await db
      .select({ tenantId: schema.exams.tenantId })
      .from(schema.attempts)
      .innerJoin(schema.exams, eq(schema.attempts.examId, schema.exams.id))
      .where(eq(schema.attempts.id, attemptId))
      .limit(1);
    const tenantId = row?.tenantId ?? null;
    if (!tenantId) return null;
    this.entries.set(attemptId, { tenantId, expiresAtMs: nowMs + ATTEMPT_TENANT_TTL_MS });
    if (this.entries.size > 20_000) this.prune(nowMs);
    return tenantId;
  }

  invalidateAll(): void {
    this.entries.clear();
  }
  size(): number {
    return this.entries.size;
  }
  private prune(nowMs: number): void {
    for (const [k, v] of this.entries) if (v.expiresAtMs <= nowMs) this.entries.delete(k);
  }
}

export const attemptTenants = new AttemptTenantCache();
