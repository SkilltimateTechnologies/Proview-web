/**
 * Small TTL cache with request coalescing, for rows that 1000 students all read
 * at the same moment.
 *
 * WHY: the database is remote Turso over HTTP, so every `await db.…` is a network
 * round trip. During an exam, 1000 clients heartbeat every 15s (≈67 requests a
 * second) and each one re-read the SAME exam row, plus the same global settings
 * row and the same exam→question list. That is a thundering herd against a single
 * row that changes maybe twice an hour.
 *
 * `load()` gives two guarantees:
 *  - within `ttlMs`, the row is answered from memory (zero round trips)
 *  - on a miss, concurrent callers for the same key share ONE in-flight read
 *    instead of firing 67 identical queries
 *
 * The clock is injectable so the TTL behaviour can be unit-tested without sleeps,
 * and nothing here touches the database or Hono — this module is pure state.
 *
 * Anything cached here MUST be safe to read up to `ttlMs` stale. Use it for
 * admin-authored data (exam window, hold flag, question list, platform
 * settings); never for per-attempt state a student is actively mutating.
 */
export class TtlCache<V> {
	private readonly entries = new Map<string, { value: V; expiresAt: number }>();
	private readonly inFlight = new Map<string, Promise<V>>();

	constructor(
		private readonly ttlMs: number,
		private readonly now: () => number = Date.now,
		/** Hard cap so a long-lived process cannot grow the map without bound. */
		private readonly maxEntries = 2000,
	) {}

	get size(): number {
		return this.entries.size;
	}

	/** Fresh value, or undefined when absent or expired. */
	get(key: string): V | undefined {
		const hit = this.entries.get(key);
		if (!hit) return undefined;
		if (hit.expiresAt <= this.now()) {
			this.entries.delete(key);
			return undefined;
		}
		return hit.value;
	}

	set(key: string, value: V): void {
		// Evicting everything on overflow (rather than tracking an LRU) keeps this
		// allocation-free on the hot path. The map only holds a handful of live
		// exams in practice, so the cliff is never reached in normal operation.
		if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
			this.entries.clear();
		}
		this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
	}

	/** Drop one key so the next read is authoritative (call after a write). */
	invalidate(key: string): void {
		this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}

	/**
	 * Return the cached value, or run `loader` once and cache what it returns.
	 * Concurrent callers for the same key await the same loader call. A rejected
	 * loader is never cached — the next caller retries.
	 *
	 * Represent "no such row" as `null`, never `undefined`: `undefined` is this
	 * cache's miss marker, so a loader that returns it would be re-run on every
	 * request and a bogus id could be used to hammer the database.
	 */
	async load(key: string, loader: () => Promise<V>): Promise<V> {
		const hit = this.get(key);
		if (hit !== undefined) return hit;
		const existing = this.inFlight.get(key);
		if (existing) return existing;
		const started = (async () => {
			try {
				const value = await loader();
				this.set(key, value);
				return value;
			} finally {
				this.inFlight.delete(key);
			}
		})();
		this.inFlight.set(key, started);
		return started;
	}

	/** In-flight loads, for assertions in tests and for diagnostics. */
	get pending(): number {
		return this.inFlight.size;
	}
}
