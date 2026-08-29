/* Recovery for a JS chunk that fails to load.
 *
 * Why this exists: students reported blank pages during a live exam. The error
 * boundary catches a *render* crash, but it cannot catch the other blank-page
 * path — the browser failing to fetch a script at all. Before this, a dropped
 * chunk fetch meant React never mounted, so there was nothing on screen and
 * nothing to click.
 *
 * Two real failure modes, both of which end in a white page:
 *
 *  1. A transient network failure while fetching a lazily-imported chunk. One
 *     retry usually fixes it; the exam server is a single process behind no CDN,
 *     so a blip during a 300-student stampede is entirely plausible.
 *  2. A stale `index.html` pointing at hashed filenames a deploy has replaced.
 *     Every fetch of the old hash 404s forever, so retrying is pointless — the
 *     only fix is a reload, which revalidates the shell and picks up the new
 *     hashes.
 *
 * Reloading is the recovery for (2), but a reload loop is worse than a blank
 * page: it would trap a student in a flicker with no way to read an error. So
 * the reload is fired at most once per session per key, recorded in
 * sessionStorage, and after that the failure is rethrown so the error boundary
 * can render something a human can act on.
 *
 * Everything here takes its clock, sleep, storage and reload as parameters so
 * it can be unit-tested without a browser.
 */

export type ChunkRecoveryDeps = {
	sleep?: (ms: number) => Promise<void>;
	reload?: () => void;
	storage?: Pick<Storage, "getItem" | "setItem"> | null;
	random?: () => number;
	log?: (message: string, error?: unknown) => void;
};

export type ImportWithRetryOptions = ChunkRecoveryDeps & {
	/** Extra attempts after the first one. */
	retries?: number;
	/** First backoff step; doubles each attempt. */
	baseDelayMs?: number;
	/** Distinguishes reload guards for different chunks. */
	key?: string;
};

const RELOAD_GUARD_PREFIX = "pv:chunk-reload:";

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
	try {
		return typeof sessionStorage === "undefined" ? null : sessionStorage;
	} catch {
		// Safari in private mode throws on access rather than returning null.
		return null;
	}
}

/**
 * Has this session already reloaded trying to recover `key`?
 *
 * A missing/throwing sessionStorage is treated as "already reloaded": without
 * somewhere to record the attempt there is no way to stop a loop, and a visible
 * error beats an endless flicker.
 */
export function hasReloadedFor(
	key: string,
	storage: Pick<Storage, "getItem" | "setItem"> | null,
): boolean {
	if (!storage) return true;
	try {
		return storage.getItem(RELOAD_GUARD_PREFIX + key) !== null;
	} catch {
		return true;
	}
}

function markReloaded(
	key: string,
	storage: Pick<Storage, "getItem" | "setItem"> | null,
): boolean {
	if (!storage) return false;
	try {
		storage.setItem(RELOAD_GUARD_PREFIX + key, String(Date.now()));
		return true;
	} catch {
		return false;
	}
}

/**
 * Reload once to recover from a chunk that cannot be fetched. Returns true if a
 * reload was actually triggered, false if this session already tried (in which
 * case the caller must surface the error instead).
 */
export function reloadOnceForChunk(key: string, deps: ChunkRecoveryDeps = {}): boolean {
	const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
	if (hasReloadedFor(key, storage)) return false;
	if (!markReloaded(key, storage)) return false;
	deps.log?.(`[chunk] reloading once to recover ${key}`);
	(deps.reload ?? (() => window.location.reload()))();
	return true;
}

/**
 * Load a lazily-imported module, retrying a failed fetch before giving up.
 *
 * On the last failure it reloads once (stale-deploy recovery) and returns a
 * promise that never settles — the page is going away, and resolving would only
 * flash an error the student cannot read. If the session has already used its
 * reload, the original error is rethrown for the error boundary.
 */
export function importWithRetry<T>(
	load: () => Promise<T>,
	options: ImportWithRetryOptions = {},
): Promise<T> {
	const retries = options.retries ?? 2;
	const baseDelayMs = options.baseDelayMs ?? 300;
	const key = options.key ?? "chunk";
	const sleep = options.sleep ?? defaultSleep;
	const random = options.random ?? Math.random;
	const log = options.log ?? ((message: string, error?: unknown) => console.error(message, error));

	const attempt = async (remaining: number, delayMs: number): Promise<T> => {
		try {
			return await load();
		} catch (error) {
			if (remaining <= 0) {
				log(`[chunk] ${key} failed to load after retries`, error);
				// Jittered nothing here on purpose: the reload is once per session.
				if (reloadOnceForChunk(key, { ...options, log })) {
					return await new Promise<T>(() => {
						/* page is reloading */
					});
				}
				throw error;
			}
			log(`[chunk] ${key} failed to load, retrying in ${Math.round(delayMs)}ms`, error);
			// Jitter so a hall full of students that failed together does not
			// retry in lockstep and rebuild the spike they just caused.
			await sleep(delayMs * (0.5 + random() * 0.5));
			return attempt(remaining - 1, delayMs * 2);
		}
	};

	return attempt(retries, baseDelayMs);
}

/**
 * Catch chunk failures that never reach `importWithRetry`.
 *
 * Vite fires `vite:preloadError` when a `<link rel=modulepreload>` for a lazy
 * chunk fails; left alone it becomes an unhandled rejection and a blank page.
 * Preventing the default and reloading once turns a stale deploy into a
 * self-healing refresh.
 */
export function installChunkErrorRecovery(deps: ChunkRecoveryDeps = {}): () => void {
	const onPreloadError = (event: Event) => {
		event.preventDefault();
		if (!reloadOnceForChunk("preload", deps)) {
			(deps.log ?? console.error)("[chunk] preload failed and this session already reloaded");
		}
	};
	window.addEventListener("vite:preloadError", onPreloadError);
	return () => window.removeEventListener("vite:preloadError", onPreloadError);
}
