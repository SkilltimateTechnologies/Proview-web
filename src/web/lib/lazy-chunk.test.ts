import { describe, expect, it } from "bun:test";
import {
	hasReloadedFor,
	importWithRetry,
	reloadOnceForChunk,
} from "./lazy-chunk";

/* These tests exist because the failure mode is silent and total.
 *
 * If `importWithRetry` gets the reload guard wrong in one direction, a student
 * whose chunk 404s after a deploy sits in an infinite reload loop and cannot
 * read the error or reach their exam. Wrong in the other direction and they get
 * the blank page this change was meant to remove. Neither shows up in a build.
 *
 * Everything is injected (sleep, random, reload, storage), so there is no timer,
 * no browser and no real delay in the suite.
 */

/** sessionStorage stand-in that records writes. */
function fakeStorage(initial: Record<string, string> = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
		setItem: (key: string, value: string) => {
			map.set(key, value);
		},
		get size() {
			return map.size;
		},
		keys: () => [...map.keys()],
	};
}

/** Storage that throws on every access, like Safari in private mode. */
const hostileStorage = {
	getItem() {
		throw new Error("SecurityError");
	},
	setItem() {
		throw new Error("SecurityError");
	},
};

const noSleep = () => Promise.resolve();
const noLog = () => {};

describe("importWithRetry", () => {
	it("returns the module without retrying when the first load works", async () => {
		let calls = 0;
		const result = await importWithRetry(
			async () => {
				calls++;
				return { default: "student-app" };
			},
			{ storage: fakeStorage(), sleep: noSleep, log: noLog },
		);
		expect(result).toEqual({ default: "student-app" });
		expect(calls).toBe(1);
	});

	it("recovers a transient fetch failure without reloading the page", async () => {
		// The common case: one dropped request during a start stampede. The
		// student must never see a reload for this.
		let calls = 0;
		let reloads = 0;
		const storage = fakeStorage();
		const result = await importWithRetry(
			async () => {
				calls++;
				if (calls < 2) throw new TypeError("Failed to fetch dynamically imported module");
				return { default: "admin" };
			},
			{
				storage,
				sleep: noSleep,
				random: () => 0.5,
				reload: () => {
					reloads++;
				},
				log: noLog,
			},
		);
		expect(result).toEqual({ default: "admin" });
		expect(calls).toBe(2);
		expect(reloads).toBe(0);
		expect(storage.size).toBe(0);
	});

	it("makes exactly retries+1 attempts before giving up", async () => {
		let calls = 0;
		let reloads = 0;
		void importWithRetry(
			async () => {
				calls++;
				throw new Error("404");
			},
			{
				retries: 3,
				storage: fakeStorage(),
				sleep: noSleep,
				random: () => 0.5,
				reload: () => {
					reloads++;
				},
				log: noLog,
			},
		);
		// Let the retry chain drain; nothing in it waits on a real timer.
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(calls).toBe(4);
		expect(reloads).toBe(1);
	});

	it("backs off exponentially with jitter, and never in lockstep", async () => {
		const delays: number[] = [];
		void importWithRetry(async () => {
			throw new Error("404");
		}, {
			retries: 3,
			baseDelayMs: 400,
			storage: fakeStorage(),
			sleep: async (ms) => {
				delays.push(ms);
			},
			// Highest jitter multiplier (1.0) so the bounds below are exact.
			random: () => 1,
			reload: () => {},
			log: noLog,
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(delays).toEqual([400, 800, 1600]);

		// Same inputs, lowest jitter: half the delay. A hall of students that
		// failed together must not retry at the same instant.
		const jittered: number[] = [];
		void importWithRetry(async () => {
			throw new Error("404");
		}, {
			retries: 3,
			baseDelayMs: 400,
			storage: fakeStorage(),
			sleep: async (ms) => {
				jittered.push(ms);
			},
			random: () => 0,
			reload: () => {},
			log: noLog,
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(jittered).toEqual([200, 400, 800]);
	});

	it("reloads once for a stale deploy and does not settle afterwards", async () => {
		// A hash that no longer exists 404s forever, so retrying cannot fix it.
		// The promise must NOT resolve or reject: the page is going away, and
		// settling would flash an error nobody can read.
		let reloads = 0;
		const storage = fakeStorage();
		let settled = false;
		void importWithRetry(
			async () => {
				throw new Error("404 /assets/index-OLDHASH.js");
			},
			{
				retries: 1,
				storage,
				sleep: noSleep,
				random: () => 0.5,
				reload: () => {
					reloads++;
				},
				log: noLog,
			},
		).then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(reloads).toBe(1);
		expect(settled).toBe(false);
		expect(storage.keys()).toEqual(["pv:chunk-reload:chunk"]);
	});

	it("throws instead of looping when the session already reloaded", async () => {
		// The guard that matters most: a student trapped in a reload loop cannot
		// read an error, cannot reach their exam and cannot call for help.
		let reloads = 0;
		const storage = fakeStorage({ "pv:chunk-reload:admin": "1" });
		const original = new Error("still 404 after reload");
		let caught: unknown;
		await importWithRetry(
			async () => {
				throw original;
			},
			{
				key: "admin",
				retries: 1,
				storage,
				sleep: noSleep,
				random: () => 0.5,
				reload: () => {
					reloads++;
				},
				log: noLog,
			},
		).catch((error) => {
			caught = error;
		});
		expect(reloads).toBe(0);
		// The ORIGINAL error must survive, so the boundary can show something
		// specific rather than "something went wrong".
		expect(caught).toBe(original);
	});

	it("surfaces the error rather than reloading when there is no usable storage", async () => {
		// No storage means no way to record an attempt, so no way to stop a loop.
		// A visible error beats an endless flicker.
		for (const storage of [null, hostileStorage]) {
			let reloads = 0;
			let caught: unknown;
			await importWithRetry(
				async () => {
					throw new Error("no storage");
				},
				{
					retries: 0,
					storage: storage as never,
					sleep: noSleep,
					random: () => 0.5,
					reload: () => {
						reloads++;
					},
					log: noLog,
				},
			).catch((error) => {
				caught = error;
			});
			expect(reloads).toBe(0);
			expect((caught as Error).message).toBe("no storage");
		}
	});

	it("keys the reload guard per chunk, so admin and register do not share one", async () => {
		const storage = fakeStorage();
		expect(reloadOnceForChunk("admin", { storage, reload: () => {}, log: noLog })).toBe(true);
		// Second chunk still gets its own single reload.
		expect(reloadOnceForChunk("register", { storage, reload: () => {}, log: noLog })).toBe(true);
		// But neither gets a second one.
		expect(reloadOnceForChunk("admin", { storage, reload: () => {}, log: noLog })).toBe(false);
		expect(storage.keys().sort()).toEqual([
			"pv:chunk-reload:admin",
			"pv:chunk-reload:register",
		]);
	});
});

describe("hasReloadedFor", () => {
	it("treats a missing or throwing storage as already reloaded", () => {
		expect(hasReloadedFor("admin", null)).toBe(true);
		expect(hasReloadedFor("admin", hostileStorage)).toBe(true);
	});

	it("reads the per-key guard", () => {
		const storage = fakeStorage({ "pv:chunk-reload:admin": "1" });
		expect(hasReloadedFor("admin", storage)).toBe(true);
		expect(hasReloadedFor("register", storage)).toBe(false);
	});
});
