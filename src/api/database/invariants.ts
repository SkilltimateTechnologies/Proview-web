/**
 * Boot-time database invariants.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two production incidents had the same root cause: a select-then-insert race
 * that wrote a SECOND row for a logical key that should only ever have one.
 *
 *   1. `attempts` — two rows for one (exam, student). Broke the Live Monitor and
 *      split one student's work across two attempts.
 *   2. `answers`  — two rows for one (attempt, question). The grader sums every
 *      answer row, so a duplicate inflated BOTH numerator and denominator and a
 *      student was shown 103/100. Worse, the old delete-then-insert finalize
 *      could write blank twins over real work, scoring a full paper 0.
 *
 * Application-level "check then write" cannot fix this — only the database can.
 * The fix is a UNIQUE index plus upserts that target it.
 *
 * The catch: nothing in the deploy path creates those indexes. `start` is just
 * `bun src/server.ts`, there is no migrate step, and `drizzle/` is a stale
 * snapshot that predates both indexes (regenerating it emits table DROPs, so it
 * is not safe to run). Declaring the index in `schema.ts` only affects databases
 * someone remembers to `db:push`. A fresh environment, a restored backup, or a
 * rebuilt database would silently come up WITHOUT the constraint — and the bug
 * would be back with no signal until a student sees an impossible score.
 *
 * So we assert the invariants at boot, idempotently, on whatever database we are
 * actually pointed at. `CREATE UNIQUE INDEX IF NOT EXISTS` is a no-op when the
 * index is already there, and self-healing when it is not.
 *
 * Failure policy: log loudly and keep serving. This runs on an exam server; a
 * transient libsql hiccup at boot must never stop students from sitting an exam.
 * `INDEX_STATE` records the outcome so `/api/health` can surface it instead of
 * the problem hiding in a log nobody reads.
 */
import { sql } from "drizzle-orm";
import { db } from "./index";

type IndexSpec = {
  name: string;
  table: string;
  columns: string[];
  /** What breaks if this index is missing — used in the alert text. */
  guards: string;
  /**
   * `false` when the index guards a background feature rather than exam
   * correctness: still asserted and still reported, but it must not flip
   * `/api/health` red in the middle of an exam. Defaults to critical.
   */
  critical?: boolean;
};

/**
 * Every uniqueness guarantee the app's correctness depends on.
 * Keep in sync with the `uniqueIndex(...)` declarations in `schema.ts`.
 */
export const REQUIRED_UNIQUE_INDEXES: IndexSpec[] = [
  {
    name: "answers_attempt_question_uq",
    table: "answers",
    columns: ["attempt_id", "question_id"],
    guards: "duplicate answer rows inflating scores past 100 and blanking real work",
  },
  {
    name: "attempts_exam_student_uq",
    table: "attempts",
    columns: ["exam_id", "student_id"],
    guards: "duplicate attempts splitting one student's work and breaking Live Monitor",
  },
  {
    // Expression columns, not plain ones: roll numbers arrived from CSV imports and
    // a public registration page with inconsistent case and padding, so "23k91a0491"
    // and " 23K91A0491 " must collide with "23K91A0491". SQLite indexes expressions
    // fine, and the GROUP BY duplicate check below uses the same expressions.
    name: "students_tenant_roll_uq",
    table: "students",
    columns: ["tenant_id", "upper(trim(roll_no))"],
    guards: "duplicate student records splitting one student's results across two rows",
  },
  {
    name: "grade_jobs_attempt_uq",
    table: "grade_jobs",
    columns: ["attempt_id"],
    guards:
      "duplicate grading jobs for one attempt — two workers would grade the same paper " +
      "at the same time, billing the AI provider twice and writing the same answer rows concurrently",
    // Advisory: the queue is a background feature that falls back to the in-memory
    // schedule when the table is unavailable, so a failure here must not turn
    // /api/health red while an exam is running.
    critical: false,
  },
];

/**
 * Non-unique indexes the app needs to stay fast enough to serve a full exam hall.
 *
 * Same deploy problem as the unique indexes above: `schema.ts` declaring an index
 * only affects databases someone remembers to `db:push`, and there is no migrate
 * step, so production would never get them. Unlike the unique ones these carry NO
 * correctness weight — a missing perf index makes the app slow, not wrong — so a
 * failure here is reported but must never flip `/api/health` to 503.
 *
 * Keep in sync with the `index(...)` declarations in `schema.ts`.
 */
export const REQUIRED_PERF_INDEXES: IndexSpec[] = [
  {
    name: "integrity_attempt_type_idx",
    table: "integrity_events",
    columns: ["attempt_id", "type"],
    guards:
      "the Live Monitor's per-attempt violation count scanning every integrity row " +
      "of every attempt (hundreds of thousands of rows in a 1000-student exam)",
  },
  {
    name: "integrity_attempt_at_idx",
    table: "integrity_events",
    columns: ["attempt_id", "at"],
    guards:
      "the every-10s event-flush dedupe re-reading an attempt's entire event history " +
      "instead of the recent window it can actually collide with",
  },
  {
    name: "grade_jobs_status_next_idx",
    table: "grade_jobs",
    columns: ["status", "next_run_at"],
    guards:
      "the grading worker's claim query scanning the whole queue on every tick instead " +
      "of the few jobs that are actually due",
  },
  {
    name: "attempts_status_idx",
    table: "attempts",
    columns: ["status"],
    guards:
      "the background sweeps full-scanning every attempt ever taken, once a minute, " +
      "forever — auto-submit filters status='in_progress' and the grading reconcile " +
      "filters status='submitted', so the cost grew with exam history rather than with " +
      "load (at ~58k stored attempts one 60s scan alone consumes a 2.5B-row monthly plan)",
  },
];

type TableSpec = {
  name: string;
  /** Full `CREATE TABLE IF NOT EXISTS` statement. Must match schema.ts exactly. */
  ddl: string;
  /** Indexes to create with the table, as `CREATE ... IF NOT EXISTS` statements. */
  indexes: string[];
  /** What breaks if this table is missing — used in the alert text. */
  guards: string;
};

/**
 * Tables that `schema.ts` declares but that no migration creates.
 *
 * Same deploy gap as the indexes and columns above, one step worse: a brand-new
 * table does not exist on production at all until something creates it, so the
 * feature that depends on it is dead on arrival after a deploy. `db:push` is not
 * part of `start`, so this is the only thing that creates it.
 *
 * Rules for anything added here:
 *  - `CREATE TABLE IF NOT EXISTS` only. Never a DROP, never an ALTER of an
 *    existing table — use REQUIRED_COLUMNS for additive columns.
 *  - The DDL must mirror schema.ts column for column, including NOT NULL and
 *    DEFAULT, or Drizzle's SELECT list will not match the real table.
 *  - The feature using the table must degrade gracefully if creation fails, not
 *    take the exam server with it.
 */
export const REQUIRED_TABLES: TableSpec[] = [
  {
    name: "grade_jobs",
    ddl: `CREATE TABLE IF NOT EXISTS grade_jobs (
            id TEXT PRIMARY KEY,
            attempt_id TEXT NOT NULL,
            exam_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            tries INTEGER NOT NULL DEFAULT 0,
            next_run_at INTEGER NOT NULL,
            claimed_at INTEGER,
            claimed_by TEXT,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )`,
    indexes: [
      `CREATE UNIQUE INDEX IF NOT EXISTS grade_jobs_attempt_uq ON grade_jobs (attempt_id)`,
      `CREATE INDEX IF NOT EXISTS grade_jobs_status_next_idx ON grade_jobs (status, next_run_at)`,
    ],
    guards:
      "the durable grading queue — without it AI grading falls back to the in-memory " +
      "schedule, which loses its retry state on every deploy and cannot be run on more " +
      "than one replica without double-grading (and double-billing) every attempt",
  },
];

type ColumnSpec = {
  table: string;
  column: string;
  /** SQLite column type + any default. Must be nullable — see the note below. */
  type: string;
  /** What breaks if this column is missing — used in the alert text. */
  guards: string;
};

/**
 * Columns that `schema.ts` declares but that no migration adds.
 *
 * This is the structural twin of REQUIRED_UNIQUE_INDEXES and it is even less
 * optional: Drizzle names every column of a table in its SELECT list, so a column
 * that exists in `schema.ts` but NOT in the connected database turns every query
 * on that table into `no such column` — the exam would not run at all. There is no
 * migrate step in the deploy path (see the header), so the column has to be
 * asserted here.
 *
 * Rules for anything added to this list:
 *  - NULLABLE, no NOT NULL. `ALTER TABLE ... ADD COLUMN` backfills existing rows
 *    with NULL, and the code must treat NULL as "row predates this feature".
 *  - Additive only. Never put a rename, a type change or a drop here; SQLite would
 *    need a table rebuild and that is not something to do at boot on an exam server.
 */
export const REQUIRED_COLUMNS: ColumnSpec[] = [
  {
    table: "attempts",
    column: "option_order",
    type: "text",
    guards:
      "student answer review re-ordering options for attempts sat before per-student " +
      "option shuffling existed (NULL = original authored order, render as-is)",
  },
  {
    table: "attempts",
    column: "user_agent",
    type: "text",
    guards:
      "the diagnostic record of which browser/device an attempt was sat on (NULL = " +
      "unknown, an attempt that predates the column). Without it every attempts " +
      "query fails, since Drizzle names it in the SELECT list",
  },
  {
    table: "tenants",
    column: "max_concurrent_attempts",
    type: "integer",
    guards:
      "the per-tenant ceiling on simultaneously in-progress attempts (NULL = inherit " +
      "the platform-global default, which is itself NULL = unlimited). Without the " +
      "column every tenants query fails, since Drizzle names it in the SELECT list",
  },
  {
    table: "tenants",
    column: "max_evidence_per_attempt",
    type: "integer",
    guards:
      "the per-tenant ceiling on stored non-violation proctoring rows per attempt " +
      "(NULL = inherit global = unlimited). Without the column every tenants query " +
      "fails, since Drizzle names it in the SELECT list",
  },
  {
    table: "settings",
    column: "max_concurrent_attempts",
    type: "integer",
    guards:
      "the platform-global default concurrent-attempt ceiling every tenant inherits " +
      "(NULL = unlimited, the shipped default). Without the column the global " +
      "settings read fails, which every exam page depends on",
  },
  {
    table: "settings",
    column: "max_evidence_per_attempt",
    type: "integer",
    guards:
      "the platform-global default stored-evidence ceiling per attempt (NULL = " +
      "unlimited, the shipped default). Without the column the global settings read " +
      "fails, which every exam page depends on",
  },
  {
    table: "exams",
    column: "grading_mode",
    type: "text",
    guards:
      "the per-exam grading release policy (NULL = defer AI/coding grading until the " +
      "exam window closes, 'immediate' = grade at submit). Without the column every " +
      "exams query fails, since Drizzle names it in the SELECT list",
  },
];

export type IndexState = {
  checkedAt: string | null;
  ok: boolean;
  present: string[];
  created: string[];
  /** Performance indexes: informational only, never part of `ok`. */
  perf: { present: string[]; created: string[]; failed: { index: string; error: string }[] };
  /** Columns already on the connected database, as `table.column`. */
  columnsPresent: string[];
  /** Columns this boot had to add, as `table.column`. */
  columnsAdded: string[];
  /** Tables already on the connected database. */
  tablesPresent: string[];
  /** Tables this boot had to create. */
  tablesCreated: string[];
  /**
   * `advisory: true` means the failure degrades a background feature but cannot
   * corrupt an exam, so it is reported without flipping `ok` (and therefore without
   * turning /api/health red mid-exam). Everything else is a correctness failure.
   */
  failed: { index: string; error: string; duplicateGroups?: number; advisory?: boolean }[];
};

export const INDEX_STATE: IndexState = {
  checkedAt: null,
  ok: false,
  present: [],
  created: [],
  perf: { present: [], created: [], failed: [] },
  columnsPresent: [],
  columnsAdded: [],
  tablesPresent: [],
  tablesCreated: [],
  failed: [],
};

/** The stored CREATE INDEX statement, or null when the index does not exist. */
async function indexDefinition(name: string): Promise<string | null> {
  const rows = await db.all<{ sql: string | null }>(
    sql`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ${name}`,
  );
  if (!rows.length) return null;
  return rows[0]?.sql ?? "";
}

/** Strip quoting/whitespace so two spellings of the same index compare equal. */
function normalizeSql(s: string): string {
  return s.replace(/[`"\[\]]/g, "").replace(/\s+/g, "").toLowerCase();
}

/**
 * True when an existing index actually enforces what the spec requires.
 *
 * Name equality is NOT enough. `schema.ts` can only declare the plain-column
 * approximation of an expression index, so a database created with `db:push`
 * comes up with `students_tenant_roll_uq ON students(tenant_id, roll_no)` — the
 * right NAME wrapping a WEAKER guarantee, which would let "23k91a0491" and
 * " 23K91A0491 " both insert. Compare the definition, not the name.
 */
function definitionSatisfies(spec: IndexSpec, definition: string): boolean {
  const norm = normalizeSql(definition);
  if (!/createuniqueindex/.test(norm)) return false;
  return spec.columns.every((col) => norm.includes(normalizeSql(col)));
}

/** True when `table` exists on the connected database. */
async function tableExists(table: string): Promise<boolean> {
  const rows = await db.all<{ c: number }>(
    sql`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
  );
  return Number(rows[0]?.c ?? 0) > 0;
}

/**
 * True when `column` exists on `table`.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, and a second `ADD COLUMN` errors with
 * "duplicate column name" — so the existence check IS the idempotency mechanism.
 * `pragma_table_info` is the table-valued form of the pragma and takes a bound
 * parameter, which keeps the table name out of the SQL string.
 */
async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await db.all<{ c: number }>(
    sql`SELECT COUNT(*) AS c FROM pragma_table_info(${table}) WHERE name = ${column}`,
  );
  return Number(rows[0]?.c ?? 0) > 0;
}

/**
 * Ensure every column `schema.ts` relies on exists on the connected database.
 *
 * Split out from ensureDatabaseInvariants and awaited BEFORE the server starts
 * listening (see server.ts): a missing column breaks reads outright, so unlike the
 * unique indexes it cannot be repaired concurrently with serving traffic. Cheap —
 * one pragma read per column on the happy path.
 *
 * Idempotent. Never throws.
 */
export async function ensureRequiredColumns(): Promise<Pick<IndexState, "columnsPresent" | "columnsAdded" | "failed">> {
  const columnsPresent: string[] = [];
  const columnsAdded: string[] = [];
  const failed: { index: string; error: string }[] = [];

  for (const spec of REQUIRED_COLUMNS) {
    const label = `${spec.table}.${spec.column}`;
    try {
      if (await columnExists(spec.table, spec.column)) {
        columnsPresent.push(label);
        continue;
      }
      // No table at all means we are pointed at an empty/unprovisioned database.
      // Adding a column is impossible and `db:push` is the right fix, so say that
      // rather than emitting a confusing "no such table" from the ALTER.
      if (!(await tableExists(spec.table))) {
        const msg = `table ${spec.table} does not exist — run \`bun run db:push\` against this database`;
        console.error(`[invariants] CRITICAL ${label}: ${msg}`);
        failed.push({ index: label, error: msg });
        continue;
      }
      await db.run(
        sql`ALTER TABLE ${sql.raw(spec.table)} ADD COLUMN ${sql.raw(spec.column)} ${sql.raw(spec.type)}`,
      );
      console.warn(
        `[invariants] added missing column ${label} ${spec.type} — guards against ${spec.guards}`,
      );
      columnsAdded.push(label);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Two boots racing the same ALTER: one wins, the loser sees "duplicate column
      // name". The column is there, which is all we wanted, so that is not a failure.
      if (/duplicate column name/i.test(msg)) {
        columnsPresent.push(label);
        continue;
      }
      console.error(`[invariants] CRITICAL failed to ensure column ${label}:`, msg);
      failed.push({ index: label, error: msg });
    }
  }

  INDEX_STATE.columnsPresent = columnsPresent;
  INDEX_STATE.columnsAdded = columnsAdded;
  return { columnsPresent, columnsAdded, failed };
}

/**
 * Ensure the performance indexes exist. Idempotent, never throws, and never
 * affects `INDEX_STATE.ok` — this is speed, not correctness. A non-unique
 * `CREATE INDEX IF NOT EXISTS` cannot fail on existing data the way a unique one
 * can, so there is no duplicate pre-check to do here.
 */
async function ensurePerformanceIndexes(): Promise<void> {
  const present: string[] = [];
  const created: string[] = [];
  const failed: { index: string; error: string }[] = [];

  for (const spec of REQUIRED_PERF_INDEXES) {
    try {
      if ((await indexDefinition(spec.name)) !== null) {
        present.push(spec.name);
        continue;
      }
      await db.run(
        sql`CREATE INDEX IF NOT EXISTS ${sql.raw(spec.name)} ON ${sql.raw(spec.table)} (${sql.raw(spec.columns.join(", "))})`,
      );
      console.warn(
        `[invariants] created missing performance index ${spec.name} on ` +
          `${spec.table}(${spec.columns.join(", ")}) — guards against ${spec.guards}`,
      );
      created.push(spec.name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Slow is survivable; do not let this stop the exam server.
      console.error(`[invariants] could not ensure performance index ${spec.name}:`, msg);
      failed.push({ index: spec.name, error: msg });
    }
  }

  INDEX_STATE.perf = { present, created, failed };
}

/**
 * Count logical keys that already have more than one row.
 *
 * Groups by ALL of `spec.columns`, whatever their number. This used to destructure
 * exactly two (`const [a, b] = spec.columns`), which silently emitted
 * `sql.raw(undefined)` for a single-column spec — so the first single-column
 * unique index added to the list (grade_jobs_attempt_uq) would have crashed the
 * pre-check instead of reporting duplicates.
 */
async function countDuplicateGroups(spec: IndexSpec): Promise<number> {
  const cols = spec.columns.filter((c) => c && c.trim() !== "");
  if (!cols.length) return 0;
  const rows = await db.all<{ c: number }>(
    sql`SELECT COUNT(*) AS c FROM (
          SELECT 1 FROM ${sql.raw(spec.table)}
          GROUP BY ${sql.raw(cols.join(", "))}
          HAVING COUNT(*) > 1
        )`,
  );
  return Number(rows[0]?.c ?? 0);
}

/**
 * Ensure every table `schema.ts` declares exists on the connected database.
 *
 * Runs FIRST in ensureDatabaseInvariants: a column check or an index creation on a
 * table that does not exist can only fail. Idempotent (`IF NOT EXISTS`) and never
 * throws — a table this creates belongs to a background feature that is required
 * to degrade gracefully, so a failure here must not stop the exam server.
 */
export async function ensureRequiredTables(): Promise<{ tablesPresent: string[]; tablesCreated: string[]; failed: { index: string; error: string }[] }> {
  const tablesPresent: string[] = [];
  const tablesCreated: string[] = [];
  const failed: { index: string; error: string }[] = [];

  for (const spec of REQUIRED_TABLES) {
    try {
      const existed = await tableExists(spec.name);
      await db.run(sql.raw(spec.ddl));
      // Indexes are asserted even when the table already existed: an older
      // deployment could have created the table before an index was added here.
      for (const stmt of spec.indexes) await db.run(sql.raw(stmt));
      if (existed) {
        tablesPresent.push(spec.name);
      } else {
        console.warn(`[invariants] created missing table ${spec.name} — guards against ${spec.guards}`);
        tablesCreated.push(spec.name);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[invariants] could not ensure table ${spec.name}:`, msg);
      failed.push({ index: spec.name, error: msg });
    }
  }

  INDEX_STATE.tablesPresent = tablesPresent;
  INDEX_STATE.tablesCreated = tablesCreated;
  return { tablesPresent, tablesCreated, failed };
}

/**
 * Ensure every uniqueness invariant exists on the connected database.
 *
 * Idempotent and safe to call on every boot. Never throws — an exam server must
 * come up even if this check cannot complete.
 */
export async function ensureDatabaseInvariants(): Promise<IndexState> {
  INDEX_STATE.present = [];
  INDEX_STATE.created = [];
  INDEX_STATE.columnsPresent = [];
  INDEX_STATE.columnsAdded = [];
  INDEX_STATE.tablesPresent = [];
  INDEX_STATE.tablesCreated = [];
  INDEX_STATE.failed = [];
  INDEX_STATE.perf = { present: [], created: [], failed: [] };

  // Tables first: a column check or an index creation on a table that does not
  // exist can only fail. Advisory — every table here belongs to a background
  // feature that degrades gracefully, so it must not flip `ok`.
  const tables = await ensureRequiredTables();
  INDEX_STATE.failed.push(...tables.failed.map((f) => ({ ...f, advisory: true })));

  // Columns next: an index cannot be built on a column that is not there, and
  // this call is idempotent so it is safe even though server.ts already ran it
  // before listening (a restored/swapped database would be caught here).
  const cols = await ensureRequiredColumns();
  INDEX_STATE.failed.push(...cols.failed);

  for (const spec of REQUIRED_UNIQUE_INDEXES) {
    try {
      const existing = await indexDefinition(spec.name);
      if (existing !== null && definitionSatisfies(spec, existing)) {
        INDEX_STATE.present.push(spec.name);
        continue;
      }

      // Missing — or present but enforcing less than it should (see
      // definitionSatisfies). Creating a UNIQUE index fails if duplicates already
      // exist, so report the exact blast radius rather than a bare SQLite error —
      // whoever reads this needs to know a dedupe has to run first.
      const dupes = await countDuplicateGroups(spec);
      if (dupes > 0) {
        const msg =
          `cannot create: ${dupes} duplicate ${spec.columns.join("+")} group(s) already in ${spec.table}. ` +
          `Dedupe first (keeper rule: real content > has score > has max_score > higher score > lowest id), then restart.`;
        console.error(`[invariants] CRITICAL ${spec.name}: ${msg}`);
        INDEX_STATE.failed.push({ index: spec.name, error: msg, duplicateGroups: dupes });
        continue;
      }

      // A same-named but weaker index has to go first: CREATE ... IF NOT EXISTS
      // would otherwise see the name, do nothing, and leave the gap open. Dropping
      // is safe — an index carries no data, and the duplicate check above already
      // proved the stricter version can be built.
      if (existing !== null) {
        console.warn(
          `[invariants] ${spec.name} exists but does not enforce ` +
            `${spec.table}(${spec.columns.join(", ")}) — replacing it. Found: ${existing}`,
        );
        await db.run(sql`DROP INDEX IF EXISTS ${sql.raw(spec.name)}`);
      }

      await db.run(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.raw(spec.name)} ON ${sql.raw(spec.table)} (${sql.raw(spec.columns.join(", "))})`,
      );
      console.warn(
        `[invariants] ${existing === null ? "created missing" : "replaced weaker"} unique index ${spec.name} ` +
          `on ${spec.table}(${spec.columns.join(", ")}) — guards against ${spec.guards}`,
      );
      INDEX_STATE.created.push(spec.name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[invariants] CRITICAL failed to ensure ${spec.name}:`, msg);
      INDEX_STATE.failed.push({ index: spec.name, error: msg });
    }
  }

  // After the correctness invariants, and deliberately outside `ok`.
  await ensurePerformanceIndexes();

  INDEX_STATE.checkedAt = new Date().toISOString();
  INDEX_STATE.ok = INDEX_STATE.failed.length === 0;

  if (!INDEX_STATE.ok) {
    console.error(
      "[invariants] DATABASE IS MISSING A UNIQUENESS GUARANTEE. Duplicate rows can " +
        "reappear and corrupt scores. See /api/health for details.",
    );
  }
  return INDEX_STATE;
}
