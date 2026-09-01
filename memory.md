# Proview — project memory

**Purpose of this file.** A single, self-contained summary of what Proview is, what has been
changed, what was decided and what is still open — written so that a person (or an agent) who
has never seen this repo can pick the work up cold. It is committed to the repo on purpose:
chat sessions get compacted and lost, git does not.

**Every claim here is tagged.** `[measured]` = observed with a command or a request, and the
number is in the doc it came from. `[from code]` = read out of this repo at the stated path.
`[arithmetic]` = derived from measured numbers. `[unverified]` = believed but not proven.
If something is untagged it is structural fact about the codebase.

**Last verified:** 2026-09-01 against commit `8a962ed`, on a clean working tree.
**Verification run that day:** `bun test` → **400 pass / 0 fail / 21 files** `[measured]`;
production `GET /api/health` → `status: "ok"`, `invariants.ok: true`,
`checkedAt: 2026-09-01T07:37:27.274Z`, `db.queries: 5924`, `examChecks: []` `[measured]`.

---

## 1. What the product is

Multi-tenant online examination platform for engineering colleges: question banks, scheduled
proctored exams, AI-assisted grading, placement/report analytics.

- **Roles:** Super Admin (Skilltimate) and TPO (per-college operator, per-module permissions).
- **Students** sit exams in a browser or in a kiosk client (SEB integration), with on-device
  proctoring: periodic webcam frames, camera-health monitoring, focus/visibility events.
- **Production tenant today:** one — `ten_bf5f745ef6ac4df4`, TKR College of Engineering &
  Technology. 11 exams (all `finished`), 2,520 attempts, 1,124 students `[measured]`.
- **Largest real exam to date:** 1,122-student roster, 90 minutes, 27 Aug 2026 `[measured]`.

## 2. Stack and layout

Bun + Hono API, React 19 + Vite web, Drizzle ORM over Turso (libSQL), Tigris (S3-compatible)
object storage, deployed on Railway. `start` is `bun src/server.ts` — **there is no migrate
step in the deploy path.**

| Path | What lives there |
|---|---|
| `src/server.ts` | Bun HTTP server, static asset serving/compression, boot-time schema checks, background worker startup |
| `src/api/index.ts` | Every route, chained on one Hono instance, `.basePath("api")` |
| `src/api/database/schema.ts` | Drizzle schema — the only schema file (**not** `src/api/db/`) |
| `src/api/database/invariants.ts` | Boot-time schema repair + the required-index/column audit |
| `src/api/lib/*.ts` | One module per concern, each with a unit test beside it |
| `src/web/` | React app (student runner + admin console, separate lazy bundles) |
| `scripts/` | Ops verifiers and the load generator (see `package.json` `//verify:*` doc keys) |

Tables `[from code]`: `tenants`, `profiles`, `classes`, `students`, `categories`, `questions`,
`exams`, `exam_questions`, `exam_roster`, `attempts`, `answers`, `integrity_events`,
`grade_jobs`, `settings`.

Env keys `[from code, .env]`: `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `S3_ENDPOINT`,
`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `AI_GATEWAY_BASE_URL`,
`AI_GATEWAY_API_KEY`, `BETTER_AUTH_SECRET`, `AUTUMN_SECRET_KEY`, `WEBSITE_URL`,
`APPLICATION_ID`, `RUNABLE_URL`, `VITE_*`.

## 3. Non-negotiable rules of this codebase

1. **Schema changes happen at boot, not by migration.** `ensureRequiredColumns()` in
   `src/api/database/invariants.ts` runs `ALTER TABLE ADD COLUMN`, so **every new column must
   be nullable**. `drizzle/` is a stale snapshot; regenerating it emits table DROPs. Do not
   put a migrate step in the deploy path.
2. **Routes stay chained on the single `app` instance** and always return an explicit status
   (`c.json(data, 200)`). Breaking the chain or omitting the status destroys RPC type
   inference. Routes are declared without the `/api` prefix.
3. **`/api/health` must never go red during an exam.** Only a broken uniqueness invariant
   503s. Slow monitor, bad exam data, queue problems and (future) backup staleness are
   advisory `warn` only — a red health check pulls the process out of the load balancer while
   students are writing.
4. **Background work is `ROLE`-gated.** `src/server.ts`: `role = ROLE ?? "all"`,
   `runsBackgroundWork = role !== "web"`. Grading queue and auto-submit sweep run inside the
   gate. `heartbeats.start(db)` is deliberately **outside** it — heartbeats land on whichever
   process serves student traffic, so a `ROLE=web` replica must still flush them.
5. **Grading fails soft.** Unreachable `grade_jobs` → `jobsAvailable = false`, log once, fall
   back to the in-memory schedule. Unreadable exam row → grade now. Never throw.
6. **No delete-then-reinsert of answers.** Two overlapping finalizes once wrote blank rows
   over real student work. The merge rule is: the client's response wins **only** when it
   `hasContent`.
7. **Tests never use the app `db` singleton** — they build `createClient` + `drizzle(client,
   { schema })` and close clients in `afterEach`. Any new column on `attempts` must also be
   added to the hand-rolled DDL in the six lib tests that create the table themselves
   (`rg -n "option_order" src -g '*.test.ts'`).
8. **Statement count is the metric that matters.** The database is remote, so cost is round
   trips, not CPU. `/api/health` exposes `db.queries` (cumulative **since boot** — compare
   deltas, never absolutes across restarts).

## 4. Known landmines

- **`PATCH /api/exams/:id` has a destructive roster reconcile.** With
  `effAssignMode === "students"` and `Array.isArray(b.studentIds)`, students not in the list
  have their **attempts, answers and integrity events deleted** `[from code]`. Never send
  `studentIds` for an exam that has been conducted. This is the specific disaster the backup
  work exists for. A guard (refuse to delete on a conducted exam unless explicitly forced) has
  been proposed and is **not yet approved**.
- **`PATCH /api/categories/:id` nulls `description` and resets `color` when they are omitted** —
  always resend all fields.
- **`PATCH /api/settings`** only patches keys present in the body and ignores masked (`••`)
  API keys.
- **Never serve cached tenant-directory rows straight to a client** — they contain the
  password hash.
- **`exams.status` is admin intent, not reality.** An exam scheduled for last month still
  reads `scheduled`. Anything time-aware must derive status via `src/api/lib/exam-status.ts`
  (`examEffStatus`, `closesAtMs`, `isConcluded`, `isReportable`).
- **The load generator refuses a non-local base.** Never point load at production.

## 5. The scale/perf program (what shipped, in order)

All of the following are pushed and live. Full write-ups, with the measurements behind each,
are in `task-scale-2.md` (§1–§40); the earlier round is in `task-scale.md` and
`task-perf-admin.md`. Commit hashes verified with `git log` on 2026-09-01 `[measured]`.

| Commit | Change |
|---|---|
| `ce2fa29` | Static assets: brotli/gzip variants held in memory, immutable caching, ETag/304. Was serving a 1.6 MB uncompressed bundle to every student on every load. |
| `e423f25` | Tenant directory TTL cache — admin pages stopped re-reading all 1,124 students per request. |
| `b3a1e40` | Submit path: 21 database round trips → 7, batched answer upsert, client retry. |
| `aa413bc` | Admin console split out of the student bundle (202 KB off every student download). |
| `57a658f`, `7a45063` | Durable grading queue (`grade_jobs`), so a deploy no longer restarts AI grading from scratch. `7a45063` fixed a regression caused by a **second copy** of a shared assumption — when you generalize one, grep for every copy. |
| `081f855` | P0 index `attempts_status_idx`, declared in both `schema.ts` and `REQUIRED_PERF_INDEXES`; the test pins the spec *and* `EXPLAIN QUERY PLAN`. |
| `2893cff` | **Deferred grading**: grading is released `GRADE_RELEASE_LAG_MS` (5 min) after the exam, `exams.grading_mode` NULL means defer, client polls 60s × 15. Keeps the post-bell load off the exam window. |
| `5ae12ba`, `85a12db` | Camera evidence: throttled `snapshot_failed` (non-scoring — a device fault must never count as misconduct), "No camera" roster badge, `attempts.user_agent` stamped at start. |
| `4707fb5` | **Heartbeat coalescing**: ~67 writes/s become one flush every 5s, chunks of 200, monotonic guard. Do not widen the 40s online threshold or lengthen the flush period. |
| `e9ac941` | Reports list: one grouped `SUM(CASE …)` instead of every attempt row of every exam. `graded`/`passed`/`failed` key off `score IS NOT NULL`, not status. Measured 16.6 → ~6.4 statements (the §36 prediction of ~4 was wrong and is corrected in place). |
| `5011f3a` | Live Monitor read every `integrity_events` row on every 3s poll. Now a `rowid` watermark + in-memory rollup: bench 63.8 ms → 2.3 ms, ~83,200 → ~60 rows per poll `[measured, in-memory SQLite]`. |
| `ea98c5e` | `/events` and `/snapshot-url` re-read the whole attempt row to answer a boolean. Now `attempt-owner.ts` caches the **owner**, not a per-caller yes/no; misses are not cached. ~400,000 → ~18,000 authorization SELECTs per 90-min exam `[arithmetic]`. |
| `441e222` | **Per-tenant capacity quotas** — the first upper *bound* in the program (everything before made work cheaper, nothing capped it). |

### The quota system (current, active)

`src/api/lib/tenant-quota.ts`. Two ceilings, both nullable on `tenants` **and** `settings`:

- `maxConcurrentAttempts` — attempts one tenant may have in progress at once.
- `maxEvidencePerAttempt` — non-violation proctoring rows stored per attempt.

Rules that must not be re-litigated:

- Resolution is **tenant → global → unlimited (`null`)**. **0, negatives and junk all mean
  "not set", never "block everything"** — the likeliest route to 0 is an empty form field, and
  the deliberate way to stop a tenant is `tenants.enabled = false`.
- The concurrency gate is checked **only where a new live attempt is admitted**. Resume,
  reload, autosave, heartbeat and submit are never gated: a quota that throws a student out of
  a paper they are halfway through is worse than the overload it prevents.
- The evidence cap **never drops a violation** and **never deletes a row** — it is a forward
  cap on new periodic/device-fault rows, with one `evidence_capped` marker per attempt per
  process.
- Per-process and approximate downward, exact upward inside a 5s window.

**Live values in production** `[measured 2026-08-31]`: global `maxConcurrentAttempts = 2250`,
`maxEvidencePerAttempt = 400`; the TKR tenant has **no override** (still inheriting). 2,250 ≈
2× the largest real roster; 400 ≈ 2× a 90-minute exam's frame count (one frame / 27s).

**Cost of the quota system** `[arithmetic, §40]`: ~1,330 extra statements per 90-minute
1,122-student exam — under 0.4% of what §38 alone removed.

**Honest limits** `[from code]`: the gate is per-process; production replica count is
`[unverified]`. Two replicas mean an effective ~4,500 inside a 5s window.

## 6. Findings that are settled (do not reopen)

- **Turso never throttled anything.** Plan limits 2.5B reads / 25M writes / 9 GB; month-to-date
  ~250M reads (10%) and ~1.2M writes (5%) `[measured]`. Turso's documented behaviour on quota
  exhaustion is queries *failing*, not slowing.
- **Nobody complained about an exam.** The current work is capacity headroom, not incident
  repair. The user's framing: "no one complained, i just want grading also optimized… don't
  want to overload the system."
- **`integrity_events` is kept forever.** No retention, no deletion. Read cost was the problem
  and was fixed (§37).
- **Per-student read cost** `[arithmetic]`: ~110,000 rows/student on 14 Aug, ~190,000 on
  27 Aug. What grew was **duration** (60 → 90 min) and **roster** (598/525 → 1,122).
- **Turso 0.7.0** is the standalone Rust rewrite, unrelated to the hosted Cloud API this app
  uses through `@libsql/client`.
- PITR retention: dashboard says 10 days; public docs quote 24h/30d/90d by tier. Which applies
  to this plan is `[unverified]`, so no backup design may lean on it.

## 7. Backup posture (the current work item)

**Today Proview has no independent backup.** Turso PITR is the only copy, and it does not
protect against the realistic disaster, which is not Turso losing data but an **admin `PATCH`
deleting a conducted exam's attempts, answers and integrity events** (§4).

Measured end to end on 2026-08-31 against the production database `[measured]`:

| Step | Result |
|---|---|
| `GET https://<db-host>/dump` with the auth token | 200, **34,849,900 bytes (33.2 MB)** in **8.96 s** |
| `gzip -9` | **7,244,960 bytes (6.9 MB)** |
| `sqlite3 restore.db < dump.sql` | **1.9 s**, `pragma integrity_check` → **ok** |
| Row counts in the restored copy | exams 11 · attempts 2,520 · answers 93,878 · integrity_events 67,185 · students 1,124 · questions 465 |

The dump, the gzip and the restored copy were `shred`ed out of the sandbox immediately.
**Production student data must never be left sitting in `/tmp`.**

**Decided, not yet built (§41):**

- **Exam-anchored backup 12 hours after an exam closes**, gzipped dump into the existing
  Tigris bucket under a `backups/` prefix. 12h because results are released, grading has
  settled, and the data is at its most irreplaceable.
- **A synced second database was rejected.** A replica is not a backup: it replicates the
  destructive delete within seconds. A backup must be frozen in time and stored where the same
  mistake cannot reach it.
- **No schema change** — the bucket listing *is* the state. "Has this exam been backed up?" is
  a `ListObjectsV2` prefix query, cached in memory. Zero migration risk.
- **Keep every exam backup forever**, no pruning code. ~7 MB each, ~11 exams a term ≈ 77 MB/yr.
- **Skip if any exam is live** (a dump is a 166,329-row read; it must never land on exam-day
  load), defer ~30 min, retry next tick.
- **Fail soft**: a `file:` `DATABASE_URL` has no remote `/dump` endpoint → mark unavailable,
  log once, never throw. Same for S3 errors.
- **`ROLE`-gated**, so two Railway replicas never both dump.
- **Advisory health block only**: a `backups` section on `/api/health` with `lastOkAt`,
  `lastError`, count, enabled; flag if the newest is older than 48h, but `critical: false`.
- Trigger time comes from **`closesAtMs(exam)`** in `exam-status.ts` (`endAt + extraMin +
  holdMs`) — *not* `effectiveEndMs`, which is a per-attempt deadline and needs an attempt row.
- **Nothing has been written to the user's bucket yet.** No ad-hoc dump will be uploaded
  without asking first.

**Still unbuilt and unapproved:** a monthly automated **restore drill**. A backup nobody has
restored is a rumor; one manual restore has been done (1.9 s, integrity ok) and that is all.

## 8. Open predictions (falsifiable, `[unverified]` until the next exam)

- Idle Turso reads fall from 31 Aug onward.
- The next exam's curve is dominated by autosaves and submits, with a quiet exam window and a
  distinct grading batch *after* close (deferred grading).
- Monitor-driven `integrity_events` reads stay nearly flat in exam duration (§37).
- No 429s at a 2,250 ceiling with a 1,122 roster; zero `evidence_capped` rows; per-student
  statement counts unchanged from §38 plus the ~1,330 constant (§39–§40).
- Once §41 ships: exactly one new object under an exam's prefix ~12h after it closes, ~7 MB,
  and `backups.lastOkAt` within 48h. If a dump ever runs while an exam is live, the guard is
  broken.

If a chart disagrees with any of these, the attribution was wrong — say so in the doc rather
than quietly dropping the prediction. §36 contains a worked example of exactly that.

## 9. Ops quick reference

```bash
bun test                     # 400 tests, 21 files
bun run typecheck            # API project (a bare `tsc --noEmit` checks NOTHING here)
bun run typecheck:web        # web project
bun run build                # typecheck:api + tests + vite build
bun run verify:db            # unique indexes exist, no duplicate/impossible-score rows
bun run verify:scale         # asserts per-endpoint statement budgets on the hot student paths
python3 scripts/loadtest-exam.py --students 1000 --seconds 60   # local only
```

`package.json` documents each script in a `"//<name>"` key immediately above it — read those
before running anything against a database.

**Deploy signal:** for API-only commits the asset hash does not change; poll `/api/health` and
watch `invariants.checkedAt` advance. `/api/admin/invariants` returns `checkedAt: null` — use
it for the `columns` list, not the timestamp.

**Timing caveat:** from a remote sandbox, ~479 ms of any measured request time is network round
trip. Only *relative* server cost is meaningful, and that caveat belongs in every number.

## 10. Where the detail lives

- **`task-scale-2.md`** — §1–§40, the current program, every claim tagged. §9 and §20 carry
  visible `> **CORRECTION**` blocks; §36 documents a wrong prediction in place. Keep those
  visible: the point of the document is that it can be checked, not that it looks clean.
- **`task-scale.md`**, **`task-perf-admin.md`** — the earlier rounds.
- **`task-camera-episode.md`** — the camera-failure investigation.
- **This file** — updated whenever meaningful work ships.
