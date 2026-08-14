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
];

export type IndexState = {
  checkedAt: string | null;
  ok: boolean;
  present: string[];
  created: string[];
  failed: { index: string; error: string; duplicateGroups?: number }[];
};

export const INDEX_STATE: IndexState = {
  checkedAt: null,
  ok: false,
  present: [],
  created: [],
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

/** Count logical keys that already have more than one row. */
async function countDuplicateGroups(spec: IndexSpec): Promise<number> {
  const [a, b] = spec.columns;
  const rows = await db.all<{ c: number }>(
    sql`SELECT COUNT(*) AS c FROM (
          SELECT 1 FROM ${sql.raw(spec.table)}
          GROUP BY ${sql.raw(a)}, ${sql.raw(b)}
          HAVING COUNT(*) > 1
        )`,
  );
  return Number(rows[0]?.c ?? 0);
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
  INDEX_STATE.failed = [];

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
