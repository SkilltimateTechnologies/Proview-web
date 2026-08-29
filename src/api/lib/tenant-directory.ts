/**
 * Per-tenant cache of the students and classes tables, with the lookup maps every
 * admin screen rebuilds.
 *
 * WHY: the database is remote Turso over HTTP, so every `await db.…` is a network
 * round trip. Nine admin endpoints — /dashboard, /reports, /reports/:examId, the
 * roster pickers, /monitor — each began by reading the tenant's ENTIRE students
 * table (1,124 rows here) plus the ENTIRE classes table, purely to turn a
 * studentId into a name and a classId into a section code. Measured on prod:
 * 7.9 SQL statements per admin request, against 2.23 for the student exam path
 * that was tuned in the scale work. Every one of those full-table reads is the
 * same answer for every request in the same second.
 *
 * These rows are admin-authored and change on a human timescale (a student is
 * added, a section renamed) — several seconds of staleness is invisible on a
 * dashboard, and every write path invalidates its tenant so an admin action still
 * lands immediately instead of waiting out the TTL.
 *
 * The indexes (byId, enabled, codeById) are built INSIDE the loader, so a cache
 * hit costs no allocation at all — not even the ~1,100-entry Map that each of
 * those handlers used to build per request.
 *
 * Deliberately NOT cached: single-row reads by id (`where(students.id, sid)`),
 * and the read-then-write duplicate-roll checks in POST /students and
 * /students/bulk. Those must see the authoritative row, and the unique index —
 * not a cache — is what actually guarantees roll uniqueness.
 *
 * Returned arrays and maps are SHARED, cached instances: treat them as read-only.
 * Mutating one corrupts every later reader until the TTL lapses.
 */
import { TtlCache } from "./ttl-cache";

/** The student fields every consumer of this cache relies on. */
export type DirectoryStudent = { id: string; classId: string | null; enabled: boolean };
/** The class fields every consumer of this cache relies on. */
export type DirectoryClass = { id: string; code: string };

export type StudentIndex<S> = {
	/** Every student in the tenant, including disabled ones. */
	all: S[];
	/** Enabled students only — the assignable cohort. */
	enabled: S[];
	/** studentId → row, including disabled students (attempts outlive an account). */
	byId: Map<string, S>;
};

export type ClassIndex<C> = {
	all: C[];
	/** classId → row. */
	byId: Map<string, C>;
	/** classId → display code ("CSM-A"), the only field most callers want. */
	codeById: Map<string, string>;
};

export type TenantDirectoryOptions<S, C> = {
	/** How long a snapshot may be served before it is re-read. */
	ttlMs: number;
	loadStudents: (tenantId: string) => Promise<S[]>;
	loadClasses: (tenantId: string) => Promise<C[]>;
	/** Injectable for tests; defaults to the wall clock. */
	now?: () => number;
};

export class TenantDirectory<S extends DirectoryStudent, C extends DirectoryClass> {
	private readonly students: TtlCache<StudentIndex<S>>;
	private readonly classes: TtlCache<ClassIndex<C>>;
	private readonly loadStudentRows: (tenantId: string) => Promise<S[]>;
	private readonly loadClassRows: (tenantId: string) => Promise<C[]>;

	constructor(opts: TenantDirectoryOptions<S, C>) {
		// One entry per tenant, so the map stays tiny even on a large deployment.
		this.students = new TtlCache<StudentIndex<S>>(opts.ttlMs, opts.now);
		this.classes = new TtlCache<ClassIndex<C>>(opts.ttlMs, opts.now);
		this.loadStudentRows = opts.loadStudents;
		this.loadClassRows = opts.loadClasses;
	}

	/**
	 * Students for a tenant, indexed. Concurrent callers during a miss share one
	 * query (TtlCache coalesces), so a burst of admin requests is still one read.
	 */
	async studentIndex(tenantId: string): Promise<StudentIndex<S>> {
		return this.students.load(tenantId, async () => {
			const all = await this.loadStudentRows(tenantId);
			return {
				all,
				enabled: all.filter((s) => s.enabled),
				byId: new Map(all.map((s) => [s.id, s])),
			};
		});
	}

	async classIndex(tenantId: string): Promise<ClassIndex<C>> {
		return this.classes.load(tenantId, async () => {
			const all = await this.loadClassRows(tenantId);
			return {
				all,
				byId: new Map(all.map((cl) => [cl.id, cl])),
				codeById: new Map(all.map((cl) => [cl.id, cl.code])),
			};
		});
	}

	/** Drop one tenant's students, or every tenant's when the id is unknown. */
	invalidateStudents(tenantId?: string | null): void {
		if (tenantId) this.students.invalidate(tenantId);
		else this.students.clear();
	}

	/** Drop one tenant's classes, or every tenant's when the id is unknown. */
	invalidateClasses(tenantId?: string | null): void {
		if (tenantId) this.classes.invalidate(tenantId);
		else this.classes.clear();
	}

	/**
	 * Drop both. Used by writes that touch students AND classes together (deleting
	 * a section unassigns its students).
	 */
	invalidate(tenantId?: string | null): void {
		this.invalidateStudents(tenantId);
		this.invalidateClasses(tenantId);
	}

	/** Cached tenant counts, surfaced by /api/health for diagnosing a slow prod. */
	stats(): { students: number; classes: number } {
		return { students: this.students.size, classes: this.classes.size };
	}
}
