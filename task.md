# Task: post-submit score, exam window, connectivity, absent

## Requests
1. DONE(src, uncommitted): score shows X/100 (not %), no report link, back to dashboard clears progress.
2. Exam window: close at scheduledStart + duration (10:30 + 60m = 11:30). Currently endAt = startAt + 2h.
   - Internet disconnect → lost time added back (pausedMs must extend past window cap).
   - Monitor connection + give in-exam alert.
3. Live monitor: no-shows show "Finished" (STALE BUILD). Source shows "Not started". User wants "Absent"
   when student didn't show up (window passed / never engaged). Add absent state client+server.

## Findings
- demo test 2: scheduled, startAt 09:30Z, endAt 11:30Z (=start+2h), dur 60. Only 3 real graded attempts.
- Server monitor: engaged=status!=not_started -> in_progress|finished; others -> not_started. CORRECT.
- Server timing: endAtMs = startedMs + dur + pausedMs, capped by exam.endAt (lines 604-608, 638-640).
  exam.endAt set on create/update = startAt + 2h (line ~1048, ~1067).
- Client network loss (exam-runner ~248): saves progress, pauses server, LOGS OUT -> login -> resume adds time.

## Plan
- [ ] Server: exam.endAt = startAt + durationMin (create+update). Keep results/absent gating on endAt.
- [ ] Server: base=min(startedMs+dur, examEnd); endAt=base+pausedMs (both start & resume) so outage time survives window cap.
- [ ] Client: offline alert overlay during exam (pause + reconnect resume) instead of hard logout. Give alert.
- [ ] Monitor: add "absent" for not-started once window passed. client type + render + server status.
- [ ] typecheck+build both repos, commit+push proview-web, mirror examly.

## 15 Aug — answers duplicate bug (23K91A04H1 scored 103/100)
Root cause: NO unique index on answers(attempt_id, question_id) + two racy writers.
 1. POST /answers autosave: select-then-insert race (same shape as /start).
 2. finalizeAttempt: DELETE all answers then INSERT — a second overlapping
    finalize read `prior` after the delete, saw nothing, wrote BLANK rows over
    real work. Data loss, not just double count.
Grader sums every answer row (earned = reduce(score), max = reduce(maxScore)),
so duplicate rows inflate the score. 23K91A04H1: 103 -> 96.

Blast radius (read-only, verified):
 - 248 duplicate pairs / 176 extra rows / 108 live attempts (+2 orphan attempt ids)
 - 23 attempts have a WRONG score: 22 inflated (max -7), 1 under-scored (+10)
 - 12 attempts hold 35 answers with real content but score=null (never graded)
 - Worst: 23K91A66K1 Yashwanth, Grand Test-1 B3, scored 0, has 23 real ungraded
 - Confirmed contained: max_score sum == exam total_points on 2129/2130 graded
 - Confirmed the ungraded-content issue exists ONLY inside the duplicate set

Code fix DONE (tsc exit 0), NOT deployed:
 - schema.ts: uniqueIndex answers_attempt_question_uq on (attemptId, questionId)
 - index.ts /answers: onConflictDoUpdate, only touches `response`
 - grade-queue.ts finalizeAttempt: removed blanket delete, per-row upsert,
   + targeted notInArray delete for questions dropped from the paper
 - grade-queue.ts imports: and, notInArray

BLOCKED: index cannot be applied until the 176 dup rows are removed, and the
deploy needs the index (SQLite ON CONFLICT requires the constraint to exist).
Dedupe + rescore changes published student marks -> waiting on user approval.
Plan written to _dedupe_plan.json (110 attempts, keeper rule: content > scored >
higher score > lowest id).

## 15 Aug — grading "stall" was two undefined identifiers + a false-green build

Reported symptom: re-queued attempts never reached `graded`; suspected AI outage
(`settings.ai_used` was 0).

Findings:
1. `ai_used` is a red herring — only `/questions/generate` and `/ai/grade` bump it.
   The grading queue never does. Gateway was healthy the whole time.
2. `src/api/lib/grade-queue.ts` used `retryCounts` and `MAX_GRADE_RETRIES` which
   were **never declared anywhere**. `gradeAttempt` threw
   `ReferenceError: retryCounts is not defined` on line 129 — the FIRST statement
   of its success path. So gradeAttempt could never flip an attempt to "graded";
   every graded attempt only got there via the 60s `sweepPendingGrading`
   reconcile. The retry-with-backoff and give-up-after-N paths were dead code
   that threw, so a genuinely un-gradeable answer stuck its attempt at
   "submitted" forever while the sweep re-queued it every 60s.
   Verified against prod: attempt stayed `submitted` before the fix, flips to
   `graded` after.
3. `src/api/index.ts` `/ai/grade` referenced `gradeSubjective` without importing
   it, and queried `schema.settings.tenantId` which does not exist (settings is a
   single global row). Endpoint 500'd on every call — prod curl 500 in 0.55s,
   200 in 4.2s after the fix.
4. **Why it shipped:** root `tsconfig.json` is `"files": []` + project
   references, so `tsc --noEmit` (used by both `build` and `typecheck`) checked
   NOTHING and exited 0. `tsc -p tsconfig.node.json` reported 23 errors including
   all of the above. Scripts now point at real projects; `build` runs
   `typecheck:api`, which is at 0 errors.
5. Throughput, not a stall, for the rest: `MAX_CONCURRENT = 3` at ~5s/call =
   38.4 answers/min measured, i.e. ~4h for a 454-student batch. Now
   `GRADE_CONCURRENCY` env, default 12 → measured 163.7 answers/min (4.3x).
6. Added `AbortSignal.timeout(90s)` + `maxRetries: 2` to both `generateText`
   calls. Previously a hung request would hold a semaphore slot forever and
   silently stall all grading with nothing logged.

Known debt: `tsc -p tsconfig.app.json` (web) has 57 pre-existing errors, mostly
Hono RPC response-union narrowing (`{ message: string }` variants not narrowed).
Not gated yet — `typecheck:web` runs it.

### Post-deploy verification (2f02d01 live on prod)
- Deploy marker: `POST /api/ai/grade` returned `200` with a real Anthropic grade
  (`{"score":2,...}`). Before this commit it 500'd on every call (unimported
  `gradeSubjective` + nonexistent `settings.tenantId`), so a 200 proves the new
  build is serving.
- Grading backlog cleared on its own once the deploy landed: all 2325 attempts
  `graded`, 0 ungraded answers carrying content, `settings.ai_used` moved 0 -> 2.
  The earlier stall was the `retryCounts` ReferenceError, not an API-key problem.
- Scores after dedupe + rescore: `23K91A04H1` Elite Assessment - 1 = **96/100**
  (was 103), `23K91A66K1` Grand Test - 1 (Batch-3) = **41** (was 0).
- DB-wide: duplicate `(attempt_id, question_id)` pairs = **0**, attempts with
  `score > 100` = **0**, graded/submitted attempts whose answer `max_score` sum
  != `exams.total_points` = **0**.
- Race tests against prod on a throwaway exam (`ZZ RACE TEST`, deleted after,
  0 leftovers):
  - 12 concurrent single-answer autosaves, same question -> 12x `200`, **1** row.
  - 12 concurrent 2-question batch autosaves -> 12x `200`, **1** row per question.
  - 3 concurrent `/submit` -> 3x `200`, 1 row per question and **content intact**
    (this is the exact case that used to blank real answers), attempt `graded`.
  No `UNIQUE constraint failed` 500s anywhere.

## 15 Aug — making the duplicate-row corruption structurally impossible

The dedupe + unique index fixed the incident. This pass is about the bug not
being able to come back, because two things still made recurrence possible:

1. **The index was not guaranteed to exist.** It was created by hand on the live
   database. `start` is `bun src/server.ts` — there is no migrate step — and
   `drizzle/` is a stale 6 Jul snapshot that predates both unique indexes
   (regenerating emits table DROPs, so it cannot be run). A fresh environment, a
   restored backup, or a rebuilt database would have come up WITHOUT the
   constraint, and the upserts would have had nothing to conflict on. Silent.
2. **Nothing tested any of it.** The repo had zero test files. The same gap let
   `retryCounts is not defined` reach production.

### Layers now in place
- **`src/api/database/invariants.ts`** — `ensureDatabaseInvariants()` asserts
  every required unique index at boot via `CREATE UNIQUE INDEX IF NOT EXISTS`.
  Self-healing on a database that lacks one; a no-op when present. If duplicates
  already exist it cannot create the index, so it logs the exact duplicate-group
  count and the keeper rule instead of a bare SQLite error. Never throws — an
  exam server must boot even if this check fails.
- **`/api/health`** now returns **503 `degraded`** with the failure detail when an
  invariant could not be put in place, so uptime monitoring catches it rather than
  it hiding in a boot log.
- **`GET /api/admin/invariants`** (super-admin) — full live audit: index presence,
  duplicate groups, attempts with impossible scores, attempts whose denominator
  != paper total.
- **`scoreFromAnswers()` / `dedupeAnswerRows()`** in grade-queue — the single
  scoring path. Collapses to one row per question (same keeper rule as the
  production dedupe, `max_score` tiebreak included) and clamps to 0..100, so the
  arithmetic cannot emit an impossible score even if a duplicate reaches it. Logs
  `INVARIANT VIOLATION` when it has to dedupe. Replaced both raw
  `reduce`-over-answer-rows sites (`gradeAttempt`, `sweepPendingGrading`).
- **`src/api/lib/scoring.test.ts`** — 11 tests, no DB or network needed, wired
  into `bun run build`. Covers the 103/100 shape, the blank-twin data loss, the
  asymmetric `max_score` twin that once yielded 102.1 instead of 96, and both
  clamps.
- **`scripts/verify-invariants.ts`** (`bun run verify:db`) — ops check against a
  real database; `--race <url>` additionally fires 12 concurrent autosaves, 12
  concurrent batch autosaves and 3 concurrent submits at a live server, then
  asserts one row per question with content intact. Exits non-zero, so it can
  gate a deploy. Run it after any change to answer persistence, grading, or the
  schema, and after provisioning or restoring any database.

### Verified (not assumed)
- Guard vs a deliberately broken database: **7 FAILs, exit 1** — caught the
  missing indexes, duplicate rows, the 103 score, the denominator mismatch and
  the lost-answers case.
- Boot check vs that database: refused both indexes and printed the duplicate
  counts. After removing the duplicates it **created both**; the next boot
  reported them present with `created: []` (idempotent).
- `/api/health` returned **503** with the failure payload on the broken database
  and the server still came up; **200 `ok`** on the real database.
- `/api/admin/invariants` on the live database: `ok: true`, both indexes present,
  0 duplicate groups, 0 impossible scores, 0 denominator mismatches.
- **Mutation-tested the tests**: removing the dedupe fails 1, removing the clamp
  fails 2. They are not decoration.
- `--race` mode vs a local server on the real database: **16/16 PASS**, fixture
  cleaned up (`{"e":0,"a":0,"ans":0}`).
- `bun run build` (typecheck + tests + vite) passes **with `DATABASE_URL` unset**,
  so adding tests to the build cannot break the Railway deploy.

---

## Incident 2 — Live Monitor froze during live exams (14 Aug 2026)

### What was reported
The Live Monitor page hung / stopped updating while exams were running.

### Root cause (measured, not guessed)
`src/web/pages/monitor.tsx` polls `GET /api/monitor` every **5 s**. On every poll
the handler did, per live exam:

1. `SELECT *` from `integrity_events` for **every** engaged attempt, in chunked
   100-id `IN` lists, and aggregated the violation count + newest snapshot **in
   JS**. On *Elite Assessment – 1* that is **27,153 rows, 1,712,100 bytes of photo
   keys alone**, pulled over the network on every poll. *Weekly Assessment – 1*
   was another 17,731 rows / 1,125,605 bytes.
2. Re-signed **268** S3 URLs — one per attempt — even though a presigned GET is
   valid for 24 h.
3. Read the full ~1,124-row `students` table **twice**.

Two exams were live at once, so all of that was doubled. Measured against the
production database: the integrity aggregation alone took **3,079 ms + 841 ms**
and the double students read **2,066 ms** — over **6 s of work inside a 5 s poll**.
Polls therefore overlapped, requests stacked up, and the page stopped responding.

### Fix
- **Aggregate in SQL, not in JS.** Two statements per exam now return **one row
  per attempt**: a `COUNT(*) ... GROUP BY attempt_id` for violations (excluding
  `NON_VIOLATION_TYPES`) and a `ROW_NUMBER() OVER (PARTITION BY attempt_id ORDER
  BY at DESC, rowid DESC)` for the newest snapshot. Joining `attempts` on
  `exam_id` also removes the chunked `IN` lists. **27,153 rows → 427 rows.**
- **`presignGetCached()`** in `lib/s3.ts` — same key, same URL, cached for half the
  URL lifetime (bounded map, oldest-20% eviction). 268 keys: **171 ms → 0 ms** warm.
- **One students read** plus an in-memory `enabled` filter instead of two full
  reads: **2,066 ms → 248 ms**.
- **`getMonitorSnapshot(tid)`** — 3 s per-tenant response cache **plus in-flight
  coalescing**, so N invigilator tabs cause at most one build, not N.

### Verified (not assumed)
- **Parity, query level** (`old JS aggregation` vs `new SQL`, both against the
  production database, both heavy exams): identical attempt counts, identical
  per-attempt violation counts, identical newest-photo keys, identical totals
  (725 and 368). **0 mismatches.** Confirms `ROW_NUMBER()` works on libsql.
- **Parity, endpoint level**: a load-test clone of the worst exam (268 attempts,
  27,153 integrity events, 1,124 students, exam forced live) served by the old
  code (git worktree at `HEAD`) and the new code on the same database returned a
  **byte-identical payload** (294,704 bytes; equal after stripping the presigned
  URL signature params).
- **Timing on that clone**: cold **331 ms → 270 ms**, warm **~80 ms**;
  **10 concurrent polls 1,870 ms → 135 ms** (14x). The clone is a local file DB, so
  it understates the win — the real cost was network round trips, which the
  query-level numbers above measure.
- **Re-verified before deploy, both heavy exams live at once** on a fresh clone
  (44,884 integrity events, 2,325 attempts, 1,124 students): payload identical
  between old and new code (559,997 bytes; 1,123 student rows; violation totals
  725 / 368; 452 snapshots). Sequential polls **321 ms → 126 ms**, **10 concurrent
  polls 2,786 ms → 222 ms** (12.5x). Against the *production* (remote) database the
  old per-exam pull was **27,153 rows / 1,712,100 photo-key bytes in 1,954 ms** for
  one exam, versus **247 ms** for the SQL aggregation that replaced it — and
  `ROW_NUMBER()` runs on the Turso server, not just local sqlite.

---

## Incident 3 — Duplicate student records (14 Aug 2026)

### Root cause
Three write paths, three different dedupe rules, and **no unique index** to catch
what they missed:

| Path | Old behaviour |
| --- | --- |
| `POST /students` (TPO adds one) | **no duplicate check at all** |
| `POST /students/bulk` (CSV import) | exact-string match only |
| `POST /register/:code` (public self-registration) | exact-string match, and accepted a pasted college **email** as the roll number |

So `23k91a0491`, ` 23K91A0491 ` and `23K91A0491@TKRCET.COM` were three different
students, splitting one person's results across rows and duplicating them in
reports and the Live Monitor.

### Fix — validation *and* a database constraint
- **`src/api/lib/students.ts`** — one shared implementation: `normalizeRoll()`
  (trim, strip inner whitespace, upper-case), `rollNoProblem()` (rejects a pasted
  email, junk characters, absurd lengths) and `isDuplicateRollError()`. Used by
  every write path, including `PATCH /students/:id` — the edit form was how the
  email-shaped rolls got "fixed" into second copies.
- **`students_tenant_roll_uq`** — `UNIQUE (tenant_id, upper(trim(roll_no)))`, an
  **expression** index so case and padding variants collide. Created and, when
  weaker than required, **replaced** at boot by `ensureDatabaseInvariants()`.
- **Boot check now compares the index DEFINITION, not just its name.** Drizzle
  cannot express an expression index, so `db:push` creates
  `students_tenant_roll_uq ON students(tenant_id, roll_no)` — right name, weaker
  guarantee. The old name-only check would have accepted it and the bug would be
  back on any freshly provisioned database.
- **Bulk import now reports what it refused** (`rejected[]` with a reason per row)
  instead of silently skipping, and inserts with `onConflictDoNothing()`.
- **`GET /api/admin/invariants`** additionally reports `duplicateStudentSuspects`
  (same name + same section) and `malformedRollNumbers`. Same-name pairs are
  **reported, never auto-deleted** — real namesakes exist.

### Data repair
`scripts/merge-duplicate-students.ts`, dry-run by default, explicit action list,
refuses to delete a row that has attempts or to merge two rows that sat the same
exam. Applied: 2 merges (`23K91A0491@TKRCET.COM` → `23K91A0491`,
`24K95A0503@TKRCET.COM` → `24K95A0503`, moving their attempts) and 8 zero-attempt
ghost rows deleted. Backup written to `student-merge-backup-*.json`.
`23K91A0539` was left alone — a genuinely different student who happens to share
a name.

### Verified (not assumed)
- Against a clone of production, through the HTTP API — **12/12 guards pass**:
  exact duplicate → 409, case/padding variant → 409, pasted email → 400, new roll
  stored normalised, same roll twice → 409, `PATCH` into a collision → 409,
  `PATCH` to a free roll → 200, bulk import of 4 rows inserts 1 and reports 3 with
  reasons, and **6 simultaneous identical creates → exactly one student**
  (`201, 409 x5`).
- Public self-registration, same clone — **4/4**, including **6 simultaneous
  registrations → exactly one student**.
- That race first returned `201 + 5x500`: drizzle wraps the SQLite error in a
  `DrizzleQueryError` whose own message hides the constraint, so
  `isDuplicateRollError()` now walks the `cause` chain. The index was always
  correct — only the HTTP status was wrong.
- **Boot-time self-heal proven**: pointed the server at a `db:push`-created
  database carrying the weak plain-column index; it logged `exists but does not
  enforce ... replacing it` and the expression index was in place afterwards.
- `bun run verify:db` gained a `really enforces` check per index and **fails** on
  that weak index (mutation-tested, not decoration), plus malformed-roll and
  orphaned-attempt checks. Production: **all PASS**, 1 same-name group flagged as
  a NOTE for manual review.
- `src/api/lib/students.test.ts` — 12 tests wired into `bun run build`.
  Mutation-tested: dropping `toUpperCase()` fails 1, dropping the `cause` walk
  fails 2.
