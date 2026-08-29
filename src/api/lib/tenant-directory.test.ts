import { describe, expect, test } from "bun:test";
import { TenantDirectory } from "./tenant-directory";

type Stu = { id: string; classId: string | null; enabled: boolean; name: string };
type Cls = { id: string; code: string };

/**
 * Build a directory over fixed rows with a manual clock and per-table load
 * counters, so TTL and invalidation are asserted without sleeps or a database.
 */
function harness(opts?: { ttlMs?: number }) {
	let clock = 1_000;
	const counts = { students: 0, classes: 0 };
	const students: Record<string, Stu[]> = {
		t1: [
			{ id: "s1", classId: "c1", enabled: true, name: "Asha" },
			{ id: "s2", classId: "c2", enabled: false, name: "Bhanu" },
			{ id: "s3", classId: null, enabled: true, name: "Chandra" },
		],
		t2: [{ id: "s9", classId: "c9", enabled: true, name: "Other tenant" }],
	};
	const classes: Record<string, Cls[]> = {
		t1: [
			{ id: "c1", code: "CSM-A" },
			{ id: "c2", code: "CIVIL" },
		],
		t2: [{ id: "c9", code: "ECE-B" }],
	};
	const dir = new TenantDirectory<Stu, Cls>({
		ttlMs: opts?.ttlMs ?? 10_000,
		now: () => clock,
		loadStudents: async (tid) => {
			counts.students++;
			return students[tid] ?? [];
		},
		loadClasses: async (tid) => {
			counts.classes++;
			return classes[tid] ?? [];
		},
	});
	return {
		dir,
		counts,
		students,
		classes,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

describe("TenantDirectory indexes", () => {
	test("students are indexed by id, including disabled ones", async () => {
		const { dir } = harness();
		const idx = await dir.studentIndex("t1");
		expect(idx.all.length).toBe(3);
		// An attempt can outlive an account, so a disabled student must still resolve.
		expect(idx.byId.get("s2")?.name).toBe("Bhanu");
		expect(idx.byId.size).toBe(3);
	});

	test("enabled is the assignable cohort only", async () => {
		const { dir } = harness();
		const idx = await dir.studentIndex("t1");
		expect(idx.enabled.map((s) => s.id)).toEqual(["s1", "s3"]);
	});

	test("classes expose both the row and a classId to code map", async () => {
		const { dir } = harness();
		const idx = await dir.classIndex("t1");
		expect(idx.byId.get("c1")?.code).toBe("CSM-A");
		expect(idx.codeById.get("c2")).toBe("CIVIL");
		expect(idx.codeById.get("nope")).toBeUndefined();
	});

	test("a tenant with no rows yields empty indexes, not a throw", async () => {
		const { dir } = harness();
		const s = await dir.studentIndex("unknown");
		const c = await dir.classIndex("unknown");
		expect(s.all).toEqual([]);
		expect(s.enabled).toEqual([]);
		expect(s.byId.size).toBe(0);
		expect(c.all).toEqual([]);
		expect(c.codeById.size).toBe(0);
	});
});

describe("TenantDirectory caching", () => {
	test("repeat reads inside the TTL cost one query", async () => {
		const { dir, counts } = harness();
		await dir.studentIndex("t1");
		await dir.studentIndex("t1");
		await dir.studentIndex("t1");
		expect(counts.students).toBe(1);
	});

	test("the index object itself is reused, so a hit allocates no map", async () => {
		const { dir } = harness();
		const a = await dir.studentIndex("t1");
		const b = await dir.studentIndex("t1");
		expect(b).toBe(a);
		expect(b.byId).toBe(a.byId);
	});

	test("concurrent misses share one query", async () => {
		const { dir, counts } = harness();
		const [a, b, c] = await Promise.all([
			dir.studentIndex("t1"),
			dir.studentIndex("t1"),
			dir.studentIndex("t1"),
		]);
		expect(counts.students).toBe(1);
		expect(b).toBe(a);
		expect(c).toBe(a);
	});

	test("students and classes are cached independently", async () => {
		const { dir, counts } = harness();
		await dir.studentIndex("t1");
		await dir.classIndex("t1");
		await dir.studentIndex("t1");
		await dir.classIndex("t1");
		expect(counts).toEqual({ students: 1, classes: 1 });
	});

	test("tenants do not share a cache entry", async () => {
		const { dir, counts } = harness();
		const t1 = await dir.studentIndex("t1");
		const t2 = await dir.studentIndex("t2");
		expect(counts.students).toBe(2);
		expect(t1.all.length).toBe(3);
		expect(t2.all.map((s) => s.id)).toEqual(["s9"]);
	});

	test("the snapshot is re-read once the TTL lapses", async () => {
		const { dir, counts, advance } = harness({ ttlMs: 10_000 });
		await dir.studentIndex("t1");
		advance(9_999);
		await dir.studentIndex("t1");
		expect(counts.students).toBe(1);
		advance(2);
		await dir.studentIndex("t1");
		expect(counts.students).toBe(2);
	});

	test("a stale snapshot is served until the TTL lapses", async () => {
		const { dir, students, advance } = harness({ ttlMs: 10_000 });
		await dir.studentIndex("t1");
		students.t1 = [...students.t1, { id: "s4", classId: "c1", enabled: true, name: "Late" }];
		expect((await dir.studentIndex("t1")).all.length).toBe(3);
		advance(10_001);
		expect((await dir.studentIndex("t1")).all.length).toBe(4);
	});
});

describe("TenantDirectory invalidation", () => {
	test("invalidateStudents makes the very next read authoritative", async () => {
		const { dir, students } = harness();
		await dir.studentIndex("t1");
		students.t1 = [...students.t1, { id: "s4", classId: "c1", enabled: true, name: "Fresh" }];
		dir.invalidateStudents("t1");
		const idx = await dir.studentIndex("t1");
		expect(idx.all.length).toBe(4);
		expect(idx.byId.get("s4")?.name).toBe("Fresh");
	});

	test("invalidating students leaves classes cached", async () => {
		const { dir, counts } = harness();
		await dir.studentIndex("t1");
		await dir.classIndex("t1");
		dir.invalidateStudents("t1");
		await dir.studentIndex("t1");
		await dir.classIndex("t1");
		expect(counts).toEqual({ students: 2, classes: 1 });
	});

	test("invalidating one tenant leaves other tenants cached", async () => {
		const { dir, counts } = harness();
		await dir.studentIndex("t1");
		await dir.studentIndex("t2");
		dir.invalidateStudents("t1");
		await dir.studentIndex("t1");
		await dir.studentIndex("t2");
		expect(counts.students).toBe(3);
	});

	test("invalidate() drops both tables for the tenant", async () => {
		const { dir, counts } = harness();
		await dir.studentIndex("t1");
		await dir.classIndex("t1");
		dir.invalidate("t1");
		await dir.studentIndex("t1");
		await dir.classIndex("t1");
		expect(counts).toEqual({ students: 2, classes: 2 });
	});

	test("a missing tenant id clears every tenant rather than silently keeping stale rows", async () => {
		const { dir, counts } = harness();
		await dir.studentIndex("t1");
		await dir.studentIndex("t2");
		// Write paths that only know a studentId pass undefined; correctness beats
		// precision here, so everything is dropped.
		dir.invalidateStudents(undefined);
		await dir.studentIndex("t1");
		await dir.studentIndex("t2");
		expect(counts.students).toBe(4);
	});

	test("a null tenant id clears every tenant too", async () => {
		const { dir, counts } = harness();
		await dir.classIndex("t1");
		dir.invalidateClasses(null);
		await dir.classIndex("t1");
		expect(counts.classes).toBe(2);
	});
});

describe("TenantDirectory stats", () => {
	test("stats count cached tenants per table", async () => {
		const { dir } = harness();
		expect(dir.stats()).toEqual({ students: 0, classes: 0 });
		await dir.studentIndex("t1");
		await dir.studentIndex("t2");
		await dir.classIndex("t1");
		expect(dir.stats()).toEqual({ students: 2, classes: 1 });
	});

	test("a rejected load is not cached", async () => {
		let calls = 0;
		const dir = new TenantDirectory<Stu, Cls>({
			ttlMs: 10_000,
			loadStudents: async () => {
				calls++;
				throw new Error("turso down");
			},
			loadClasses: async () => [],
		});
		await expect(dir.studentIndex("t1")).rejects.toThrow("turso down");
		await expect(dir.studentIndex("t1")).rejects.toThrow("turso down");
		expect(calls).toBe(2);
		expect(dir.stats().students).toBe(0);
	});
});
