import { describe, expect, test } from "bun:test";
import { TtlCache } from "./ttl-cache";

/** A clock we control, so TTL behaviour is tested without sleeping. */
function fakeClock(start = 1_000_000) {
	let now = start;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("TtlCache.get/set", () => {
	test("serves a value inside the ttl", () => {
		const clock = fakeClock();
		const cache = new TtlCache<string>(3000, clock.now);
		cache.set("exam_1", "live");
		expect(cache.get("exam_1")).toBe("live");
		clock.advance(2999);
		expect(cache.get("exam_1")).toBe("live");
	});

	test("expires exactly at the ttl boundary", () => {
		const clock = fakeClock();
		const cache = new TtlCache<string>(3000, clock.now);
		cache.set("exam_1", "live");
		clock.advance(3000);
		expect(cache.get("exam_1")).toBeUndefined();
	});

	test("an expired entry is dropped, not just hidden", () => {
		const clock = fakeClock();
		const cache = new TtlCache<string>(1000, clock.now);
		cache.set("a", "x");
		clock.advance(1001);
		expect(cache.get("a")).toBeUndefined();
		expect(cache.size).toBe(0);
	});

	test("a missing key is a miss", () => {
		const cache = new TtlCache<string>(1000);
		expect(cache.get("nope")).toBeUndefined();
	});

	test("set refreshes the expiry of an existing key", () => {
		const clock = fakeClock();
		const cache = new TtlCache<string>(1000, clock.now);
		cache.set("a", "one");
		clock.advance(900);
		cache.set("a", "two");
		clock.advance(900);
		expect(cache.get("a")).toBe("two");
	});

	test("null is a cacheable value, so 'no such row' is remembered", async () => {
		const clock = fakeClock();
		const cache = new TtlCache<string | null>(1000, clock.now);
		let loads = 0;
		const loader = async () => {
			loads += 1;
			return null;
		};
		expect(await cache.load("ghost", loader)).toBe(null);
		expect(await cache.load("ghost", loader)).toBe(null);
		expect(loads).toBe(1);
	});
});

describe("TtlCache.invalidate/clear", () => {
	test("invalidate forces the next read to be authoritative", async () => {
		const cache = new TtlCache<number>(10_000);
		let value = 1;
		const loader = async () => value;
		expect(await cache.load("k", loader)).toBe(1);
		value = 2;
		expect(await cache.load("k", loader)).toBe(1);
		cache.invalidate("k");
		expect(await cache.load("k", loader)).toBe(2);
	});

	test("invalidate touches only its own key", () => {
		const cache = new TtlCache<string>(10_000);
		cache.set("a", "1");
		cache.set("b", "2");
		cache.invalidate("a");
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBe("2");
	});

	test("invalidating an absent key is a no-op", () => {
		const cache = new TtlCache<string>(10_000);
		cache.set("a", "1");
		cache.invalidate("zzz");
		expect(cache.get("a")).toBe("1");
	});

	test("clear empties everything", () => {
		const cache = new TtlCache<string>(10_000);
		cache.set("a", "1");
		cache.set("b", "2");
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.get("a")).toBeUndefined();
	});
});

describe("TtlCache.load", () => {
	test("runs the loader once per ttl window, not once per call", async () => {
		const clock = fakeClock();
		const cache = new TtlCache<number>(3000, clock.now);
		let loads = 0;
		const loader = async () => {
			loads += 1;
			return loads;
		};
		expect(await cache.load("exam_1", loader)).toBe(1);
		expect(await cache.load("exam_1", loader)).toBe(1);
		clock.advance(3000);
		expect(await cache.load("exam_1", loader)).toBe(2);
		expect(loads).toBe(2);
	});

	test("1000 concurrent readers of one exam row share a single query", async () => {
		const cache = new TtlCache<string>(3000);
		let queries = 0;
		const loader = async () => {
			queries += 1;
			await Bun.sleep(5);
			return "exam-row";
		};
		const results = await Promise.all(
			Array.from({ length: 1000 }, () => cache.load("exam_1", loader)),
		);
		expect(queries).toBe(1);
		expect(new Set(results)).toEqual(new Set(["exam-row"]));
	});

	test("different keys do not coalesce into each other", async () => {
		const cache = new TtlCache<string>(3000);
		const loader = (key: string) => async () => {
			await Bun.sleep(1);
			return `row:${key}`;
		};
		const [a, b] = await Promise.all([
			cache.load("a", loader("a")),
			cache.load("b", loader("b")),
		]);
		expect(a).toBe("row:a");
		expect(b).toBe("row:b");
	});

	test("a rejected loader is not cached and does not wedge the key", async () => {
		const cache = new TtlCache<string>(3000);
		let calls = 0;
		const flaky = async () => {
			calls += 1;
			if (calls === 1) throw new Error("libsql socket reset");
			return "ok";
		};
		await expect(cache.load("k", flaky)).rejects.toThrow("libsql socket reset");
		expect(cache.pending).toBe(0);
		expect(await cache.load("k", flaky)).toBe("ok");
		expect(calls).toBe(2);
	});

	test("every concurrent caller sees a rejection, and the retry still works", async () => {
		const cache = new TtlCache<string>(3000);
		let calls = 0;
		const loader = async () => {
			calls += 1;
			await Bun.sleep(2);
			if (calls === 1) throw new Error("boom");
			return "ok";
		};
		const settled = await Promise.allSettled([
			cache.load("k", loader),
			cache.load("k", loader),
			cache.load("k", loader),
		]);
		expect(settled.every((r) => r.status === "rejected")).toBe(true);
		expect(calls).toBe(1);
		expect(await cache.load("k", loader)).toBe("ok");
	});

	test("in-flight bookkeeping is released after success", async () => {
		const cache = new TtlCache<string>(3000);
		const promise = cache.load("k", async () => {
			await Bun.sleep(2);
			return "v";
		});
		expect(cache.pending).toBe(1);
		await promise;
		expect(cache.pending).toBe(0);
	});
});

describe("TtlCache bounds", () => {
	test("stops growing past maxEntries", () => {
		const cache = new TtlCache<number>(10_000, Date.now, 3);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3);
		expect(cache.size).toBe(3);
		cache.set("d", 4);
		// The cliff drops everything and keeps the newcomer; memory stays bounded.
		expect(cache.size).toBe(1);
		expect(cache.get("d")).toBe(4);
		expect(cache.get("a")).toBeUndefined();
	});

	test("overwriting an existing key at the cap does not wipe the cache", () => {
		const cache = new TtlCache<number>(10_000, Date.now, 2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("a", 9);
		expect(cache.size).toBe(2);
		expect(cache.get("a")).toBe(9);
		expect(cache.get("b")).toBe(2);
	});
});

describe("the exam-server behaviour this cache exists for", () => {
	test("a hold flipped by an admin is visible after an invalidate, without waiting out the ttl", async () => {
		const clock = fakeClock();
		const cache = new TtlCache<{ held: boolean }>(3000, clock.now);
		let row = { held: false };
		const read = async () => row;

		expect((await cache.load("exam_1", read)).held).toBe(false);
		row = { held: true };
		cache.invalidate("exam_1");
		expect((await cache.load("exam_1", read)).held).toBe(true);
	});

	test("worst case staleness is one ttl, so a 3s ttl cannot hide a hold for a whole 15s heartbeat", async () => {
		const clock = fakeClock();
		const cache = new TtlCache<{ held: boolean }>(3000, clock.now);
		let row = { held: false };
		await cache.load("exam_1", async () => row);
		row = { held: true };
		clock.advance(2999);
		expect((await cache.load("exam_1", async () => row)).held).toBe(false);
		clock.advance(1);
		expect((await cache.load("exam_1", async () => row)).held).toBe(true);
	});
});
