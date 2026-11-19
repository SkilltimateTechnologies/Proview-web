/**
 * Short-lived cache of "who is this staff request from?".
 *
 * WHY: every admin request (every Live Monitor poll, every page, every click) ran
 * `getSession` plus a `profiles` read — 3 database statements — before doing any
 * work. During an exam the Live Monitor alone polls every 5s per open tab, so the
 * staff console spent a large share of its database time re-proving identity.
 *
 * The cache is keyed by the exact credentials the request carried (Authorization
 * header + Cookie header). Staleness is bounded by `ttlMs` (10s by default): a
 * signed-out, disabled or re-permissioned account keeps its old rights for at most
 * that long, and every write that changes a staff account or signs out calls
 * `invalidate()` so the common cases apply immediately.
 *
 * SAFETY: callers get a fresh COPY of the profile on every call. The auth
 * middleware mutates `profile.tenantId` from the per-request X-Tenant-Id header, and
 * a shared object would leak one request's college scope into the next.
 */
export type CachedIdentity<U, P> = {
  user: U | null;
  profile: P | null;
  /** For a super admin with no tenant and no scope header: the sole tenant, if exactly one exists. */
  defaultTenantId: string | null;
};

export class AuthCache<U extends object, P extends object> {
  private readonly entries = new Map<string, { at: number; value: CachedIdentity<U, P> }>();
  private readonly inFlight = new Map<string, Promise<CachedIdentity<U, P>>>();
  private generation = 0;

  constructor(
    private readonly ttlMs = 10_000,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 5_000,
  ) {}

  /** Credentials -> cache key. Empty string = no credentials (never cached). */
  static keyOf(authorization: string | undefined | null, cookie: string | undefined | null): string {
    const a = (authorization ?? "").trim();
    const c = (cookie ?? "").trim();
    return a || c ? `${a}\u0000${c}` : "";
  }

  async resolve(key: string, load: () => Promise<CachedIdentity<U, P>>): Promise<CachedIdentity<U, P>> {
    if (!key) return this.copy(await load());
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return this.copy(hit.value);
    let pending = this.inFlight.get(key);
    if (!pending) {
      const gen = this.generation;
      pending = (async () => {
        try {
          const value = await load();
          // An invalidate() that landed while we were loading wins: do not
          // resurrect what it just dropped.
          if (gen === this.generation) {
            if (this.entries.size >= this.maxEntries) this.entries.clear();
            this.entries.set(key, { at: this.now(), value });
          }
          return value;
        } finally {
          this.inFlight.delete(key);
        }
      })();
      this.inFlight.set(key, pending);
    }
    return this.copy(await pending);
  }

  /** Drop everything (account changed, permissions changed, someone signed out). */
  invalidate(): void {
    this.generation += 1;
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private copy(v: CachedIdentity<U, P>): CachedIdentity<U, P> {
    return {
      user: v.user ? { ...v.user } : null,
      profile: v.profile ? (structuredClone(v.profile) as P) : null,
      defaultTenantId: v.defaultTenantId,
    };
  }
}
