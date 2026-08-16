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

## Incident 4 — why the server now self-monitors instead of running a nightly cron (15 Aug 2026)

The obvious fix for "how do we know this doesn't come back" was a scheduled job
that scans the database every night. That was **rejected on purpose**, for two
reasons:

1. **There is nothing left to scan for.** The three unique indexes added in
   Incident 3 reject the bad row at write time. A nightly scan of a database that
   cannot hold duplicates is a job whose only possible output is "clean".
2. **A 2 AM report about a 11 AM freeze is useless.** The Live Monitor froze in
   the middle of a live exam. The people who needed to know were the invigilators
   in the hall at that moment, and nobody reads a cron email at 2 AM.

So the checks run **at the two moments that actually matter**, inside the exam
server, with no cron and no new infrastructure:

- **Every uncached `/api/monitor` build is timed** (`recordMonitorBuild`). This is
  the exact code path that froze.
- **When an exam finishes grading, that exam's data is checked once**
  (`maybeCheckExamAfterGrading`) — duplicate answer groups, impossible scores,
  denominator mismatches, attempts with no answers. Scoped to one exam using
  indexed aggregates, so it is cheap enough to run inline; a full-table audit
  would not be.

### Escalation rules (and why)

- `MONITOR_BUDGET_MS = MONITOR_POLL_MS / 2` — 2500ms of the 5000ms poll. The
  budget **must** sit strictly below the poll interval, otherwise the warning only
  arrives after requests are already stacking, which is the freeze itself.
- **3 consecutive** over-budget builds before flagging degraded. One spike must
  not cry wolf.
- **One** healthy build clears it. No latching, so a recovered server does not
  keep showing a stale warning.
- Cache hits and coalesced callers are deliberately **not** timed — they would
  dilute the average and hide a genuinely slow build.

### `warn`, not 503

A slow monitor or a failed exam check makes `/api/health` return
`status: "warn"` with **HTTP 200**. The exam server is still serving students
correctly and must stay in the load balancer — pulling it out mid-exam would turn
a lagging invigilator page into an outage for 500 students. Only a **failed
database invariant** returns 503.

The watchdog never throws into a request path: every DB call is wrapped, every
trigger is fire-and-forget `void`.

### Invigilator-facing signal

`monitor.tsx` shows an amber banner from **two independent signals**:

- server `health.degraded`, and
- client-side staleness — `dataUpdatedAt` older than 15s (3 poll intervals).

Staleness covers what the server cannot report: request stacking, a network
stall, or the server being gone entirely. Both banner variants state
"Students are unaffected", because they are.

### Verified

- `src/api/lib/watchdog.test.ts` — **10 pass**. Mutation-tested: threshold 3→1
  fails 1, removing the streak-clear fails 2, `{...timing}`→`timing` fails 2.
- **Degraded path end-to-end** (budget temporarily forced to 1ms): poll 1 false,
  poll 2 false, **poll 3 true**; `/api/health` → `warn`, `streak: 3`; log line
  `LIVE MONITOR DEGRADED: 3 consecutive builds over budget...`. Budget restored
  and re-verified afterwards.
- **No false alarms at the real budget**: 1,123-row payload, 3 polls →
  `status: ok`, `degraded: false`, worst build **367ms** against a 2500ms budget,
  **0 watchdog warnings** in the log.
- **Exam self-check against the real production database, all 10 exams → clean**
  (`dupGroups=0 badScore=0 denom=0 noAns=0`): Grand Test - 1 Batch 1-4
  (221/239/212/198), Python DSA Screening Batch 1-4 (277/284/221/219),
  Elite Assessment – 1 (268), Weekly Assessment – 1 (186).
- Bug caught by that run and fixed: a nonexistent exam id passed the
  "0 pending" test and recorded a meaningless "data clean" entry. Now returns
  early when the exam has 0 attempts.
- On demand: `POST /api/admin/exam-check/:examId` → 200 with the result, 404 on
  an unknown exam.
- `orphan-answers-delete-backup-*.json` is gitignored; the 797 orphan rows it
  contains were deleted after a dry run confirmed none of their 23 parent
  attempts still existed.

## Incident 5 — the answer key rewarded guessers (15 Aug 2026)

Not a crash — a fairness defect, and it had been live for every exam so far.

### What was wrong

Question order was already randomised per student, but **option order was not**,
so the answer key was identical for all 268 candidates. Measured on the real
question bank:

| Category | MCQs | correct = A | B | C | D |
|---|---|---|---|---|---|
| General Set-1 (`cat_d11d8ce36cab420f`) | 40 | 6 | **22** | 12 | 0 |
| Python DSA SET 4 (`cat_e0b71ddb435746c2`) | 20 | **16** | 2 | 2 | 0 |

A student who knew nothing and pressed **B** down the whole General paper scored
**55%**; on the DSA set, **A** scored **80%**. **D was never correct once.** That
is not an exam, it is a lottery with a published winning ticket — and it silently
penalised the students who actually attempted the questions.

Bank-wide: 430 questions, 210 with options, all `mcq`, all exactly 4 options.

### What was NOT done, and why

**Rewriting `questions.options` / `questions.correct` was rejected.** Questions
are shared across exams through categories, and `answers.response` stores the
chosen option **index**. Reordering stored options would silently reinterpret
every answer row ever written — a student who correctly picked index 1 in July
would become wrong retroactively. Any fix had to leave stored data meaning
exactly what it meant before.

### The fix: permute for DISPLAY only

Options are permuted per `(student, exam, question)` when the paper is rendered.
The server translates displayed→original on write and original→displayed on
read, so **`answers.response` always holds the ORIGINAL index**. Grading,
history, reports and every already-graded attempt are byte-for-byte unaffected.

Deterministic seed `${studentId}:${examId}:${questionId}:opt-v1`, so the order is
stable across reloads, resumes and a different machine — a student never sees the
paper shift under them.

Five places carry the mapping. Missing any one of them silently corrupts an
answer, so they are listed here for whoever touches this next:

1. `GET /student/exams/:id/bundle` — render in display order, ship the token
2. `POST .../answers` (autosave) — display → original before storing
3. `POST .../submit` — display → original before grading
4. `POST .../start` and `GET .../status` — original → display when prefilling a resume
5. `GET .../review` — options, `correct` and `response` translated together

Questions whose options reference each other ("All of the above", "Both A and B")
are detected and left in authored order. The regex is deliberately narrow:
production question `q_ce2e7ec9cff34e54` has options `["A | B","A & B","A - B",
"A ^ B"]` — bitwise operators, not option references — and must still shuffle.

### Two traps this design had to survive

**Stale bundles.** The bundle is cached in `localStorage` and served offline
first, so a client can be sitting on a paper rendered by an OLDER build, in the
original order. Translating its indices would corrupt a correct answer. The
bundle therefore carries `optionOrder: "v1"`, the client echoes it on every
write, and the server translates **only** when the token is current. No token or
an unknown token ⇒ inert pass-through. The token names the scheme; it never
encodes the permutation. The client also refuses to adopt a background bundle
refresh whose token differs while an attempt is in flight — the order of a paper
being sat never changes.

**Review after the fact.** A finished attempt has no bundle left to consult, so
the scheme is stamped on the attempt itself: new nullable `attempts.option_order`
(written at `/start`, backstopped at autosave and submit, never cleared). Every
attempt sat before this deploy has **NULL**, and NULL renders in the authored
order — which is exactly what those students saw.

`option_order` is added by a new `REQUIRED_COLUMNS` check in
`database/invariants.ts` (`pragma_table_info` + `ALTER TABLE`, idempotent, never
throws), awaited **before** the server starts listening: Drizzle names every
column in its SELECTs, so a missing one would break every attempts query, not
just the new feature. There is still no migrate step in the deploy path.

Rejected: forcing the correct answer into display slot `(k + studentOffset) % 4`
("balanced rotation"). It couples the permutation to `correct` and to the
student's shuffled question order for no extra benefit — a plain deterministic
shuffle already removes the exploit.

### Verified

- `src/api/lib/option-order.test.ts` — **23 pass**, 2682 expect() calls:
  exhaustive inverse round-trip for 2–6 options, displayed-text↔stored-index
  equivalence, `autoGrade` still awards full marks, non-index answers untouched,
  and a cohort check over 800 students where **every letter lands 18–32%** — no
  letter beats chance any more. Mutation-tested: **all 10 mutations caught**.
- `bun run verify:option-order` (new) — the wiring, which no unit test can reach.
  Creates a throwaway exam from real bank MCQs, logs in as a real student over
  HTTP, answers every question **by option TEXT**, and asserts against the
  database: **21/21 PASS**, score **100**, stored responses still original
  indices, review self-consistent, unstamped attempt renders authored order.
  Cleans up everything it created, including on failure.
- Mutation-tested end to end — all 5 wiring faults caught: inverted autosave
  (3 fails), inverted submit (4 fails, score 50), review gate ignoring
  `option_order` (2 fails), bundle not permuted (6 fails, score 25), `/start`
  not stamping (2 fails), token check removed (1 fail).
- `bun test` 56 pass / 0 fail; `typecheck:api` clean; `typecheck:web` still 57
  pre-existing errors (unchanged); `bun run build` exit 0.

### Deployed and verified in production

Commit `a1f25fc`, pushed `205f490..a1f25fc`, live on Railway at
`checkedAt 2026-08-15T05:59:05.859Z`.

Pre-deploy safety, because this changes the student answer path: `/api/monitor`
showed `live: []` and `nextScheduled: null`, and the database showed **0
`in_progress` attempts** — nobody was mid-paper. All **2325** existing attempts
had `option_order = NULL`, so every historical review still renders in the
authored order.

Post-deploy, against the live server:

- `/api/health` → `status: ok`, `invariants.ok: true`.
- `GET /api/admin/invariants` → `ok: true`, all 3 unique indexes present with 0
  duplicate groups, and `columnsPresent: ["attempts.option_order"]` — the boot
  DDL is confirmed working on the production database.
- `bun run verify:option-order --base <prod>` → **21/21 PASS**, score **100**.
  All 6 questions genuinely reordered, order stable across refetches, attempt
  stamped `option_order=v1`, stored responses still ORIGINAL indices, and the
  no-token client's indices stored verbatim. Throwaway exam cleaned up (verified
  gone).
- `bun scripts/verify-invariants.ts --race <prod>` → **ALL INVARIANTS HOLD**:
  14 DB checks PASS, 9/9 race checks PASS (concurrent autosaves/submits still
  collapse to exactly 1 row per question with content preserved), monitor latency
  cold 874ms / warm 429ms against a 2500ms budget. One NOTE, the known real
  namesakes `boda sandeep: 23K91A0539,24K95A0503`.

Net effect: from the next exam onward, the answer key differs per student. Held
constant: every stored response, every graded attempt, every report, and every
review of a paper sat before this deploy.

---

## Incident 6 — a blocked camera left the exam running

**Reported:** a student can deliberately switch off or block the camera mid-exam
and simply keep answering. The screenshot supplied showed Chrome's *"Camera
blocked — this page has been blocked from accessing your camera"* state.

### Why the existing lock did not catch it

Loss detection lived entirely at the **track** level: `startWebcam` listened for
the track's `ended` event and polled `readyState`/`muted` every 1.5s. Revoking
permission does not reliably end or mute a stream that is already running — in
some Chromium builds the old track keeps delivering frames — so nothing fired,
and the exam carried on.

The recovery path was worse than useless. Once Chromium records a **Block** for
an origin, `getUserMedia` rejects with `NotAllowedError` **instantly and without
prompting, forever**. The overlay's "Re-enable camera now" button called exactly
that, so it could only ever print *"Camera is still unavailable. Please reconnect
/ allow your camera."* The student was told to allow access with no way to allow
it.

And the usual advice — *click the camera icon in the address bar* — is
unusable here. Students sit inside **Safe Exam Browser**: kiosk Chromium with no
address bar, no padlock and no site-settings menu. Every instruction has to be
achievable from the seat.

### What changed

1. **`src/web/student/lib/camera-failure.ts` (new).** Classifies a
   `getUserMedia` rejection into `permission_denied` / `no_device` / `in_use` /
   `unsupported` / `unknown`, each with a title, a message and ordered remedies
   that are true inside a kiosk: privacy shutter → camera function key → USB
   reconnect → raise your hand (permission can only be restored by relaunching
   the secure browser and choosing Allow). Matches on `DOMException.name` first
   because that is what the spec pins down, with a message sniff as a fallback.
   Deliberately DOM-free so it is unit-testable without a browser.
2. **`watchCameraPermission` in `proctor.ts`.** Subscribes to
   `navigator.permissions.query({name:"camera"})` and reacts to `denied` the
   moment it happens, independent of the track. Defensive by necessity: the
   Permissions API is optional, `"camera"` is not a valid `PermissionName`
   everywhere (Firefox throws), and this repo already has a case of a permission
   query hanging forever in SEB kiosk (`getDisplayCount`). The query is raced
   against a 1500ms timeout and every path is wrapped; unsupported means no
   watcher and we fall back to track-level detection.
3. **`camera_blocked`, a new event type** distinct from `camera_lost`. A denied
   permission can only happen by choice; a dead track can be a fallen-out USB
   cable. Keeping them apart is the difference between evidence and an
   accusation. Surfaced in Live Monitor and in the report timeline, and counted
   as serious in both.
4. **Hard block, no dismiss.** Unlike the obstruction overlay (which has a "my
   room is just dim" escape hatch after a delay), this one cannot be dismissed.
   The countdown is **hidden** while access is denied — waiting cannot clear a
   recorded Block, so showing a clock would promise something that cannot happen.
5. **The timer keeps running.** `endAt` is server-anchored and absolute, so this
   needed no change: blocking the camera buys no thinking time. The overlay says
   so explicitly.

### Four defects found while verifying, all fixed

- **Evidence was thrown away when the freeze was off.** `engageLock` returned
  early on `!blockOnCameraLoss` *before recording anything*, so an exam with
  "Lock exam if camera is closed" disabled swallowed a deliberate block
  completely — no timeline entry, no report row. The event is now recorded
  **before** that gate. The toggle governs whether the candidate is interrupted,
  not whether the invigilator gets to see it.
- **The overlay lied after the camera came back.** Restoring the camera mid-
  penalty cleared `camFail`, so the overlay fell back to *"Your camera was turned
  off. The exam is paused until it is back"* — while the camera was
  demonstrably back — above a footer promising it would resume as soon as it was.
  There is now an explicit "Camera is back" state: stale remedies and the dead
  retry button disappear, the countdown appears, and the copy names the
  countdown as the only thing being waited on.
- **One incident produced a violation every few seconds.** `startWebcam`'s poll
  called `onLost` on every 1.5s tick for as long as the track stayed dead, and
  each call re-recorded an event and re-armed the lock. A single unplugged webcam
  became ~20 entries in the student's integrity report and a penalty clock that
  could never reach zero. `onLost` is now latched to fire **once per handle**
  (the poll stops with it), and `engageLock` refuses to re-arm the countdown
  while already locked. Recovery is unaffected: the unlock loop re-reads the live
  track via `isCameraActive`, so an OS un-mute is still noticed, and every
  re-acquisition builds a fresh handle with a fresh latch.
- **The correct diagnosis was overwritten ~1.5s later by the vague one.** Found
  only by scripting the *combined* real-world scenario, which the earlier browser
  pass had not covered: it flipped the permission to `denied` but left the track
  alive. Chromium does both — revoking access also **ends the live track**. So
  the permission watcher correctly showed *"Camera access is blocked"*, and then
  the track poll fired `engageLock` again with the generic
  `cameraLostFailure`, which replaced `camFail` wholesale. The student ended up
  looking at *"Camera turned off"*, hardware advice for a permission problem,
  **and the countdown back on screen** — the exact two things this incident was
  raised to fix. `escalateFailure(previouslyDenied, incoming)` now guards the
  latch: once access is known to be denied, only a real diagnosis
  (`no_device`, `in_use`, `unsupported`) may replace it, never the
  non-diagnosis `unknown`. Deliberately narrow — a webcam genuinely unplugged
  after a denial is a new fact the student needs.

### Verification

`camera-failure.test.ts`, 39 tests: every `DOMException.name` maps to the right
code; a real `DOMException` classifies the same as a plain object; non-Error
inputs (`null`, `undefined`, `""`, numbers, `Symbol`, `[]`, a numeric `name`)
never throw; every branch returns non-empty steps, always names a way out, and
**never** mentions the address bar, padlock or site settings; `eventDetail` is
capped at 200 chars on both paths.

**Mutation tested, 12/12 killed** — including dropping `SecurityError` from the
permission branch, classifying unknown errors as a deliberate block, removing the
relaunch instruction, swapping the relaunch step for address-bar advice, dropping
either 200-char cap, making `cameraLostFailure` accuse the candidate, and letting
`OverconstrainedError`/`AbortError` fall through.

Then driven in a **real Chromium** against a throwaway SQLite database seeded
with a live exam — full student flow: login, first-sign-in password gate, the
brief, the preflight system check with a fake camera device, into a running
attempt. The camera is then blocked the way Chromium actually does it: a stubbed
Permissions API flips to `denied`, `getUserMedia` starts rejecting
`NotAllowedError`, **and the live track is stopped**. Kept as
`scripts/verify-camera-block.py` (`bun run verify:camera-block`) because none of
this is reachable from a unit test.

**The first run of that script failed 2 of 15 checks** — title and countdown —
which is what uncovered the fourth defect above. A previous browser pass had
missed it by revoking permission without ending the track, so the two detectors
never raced. After the `escalateFailure` fix, **15/15 pass**:

- Overlay up and covering the viewport; `elementFromPoint` at the exam controls
  returns the overlay, so nothing underneath is clickable.
- Title *"Camera access is blocked"*, four kiosk-true numbered steps, and no
  step naming the address bar, padlock, site settings or a lock icon.
- **No countdown** — asserted absent, not merely unread.
- No dismiss control; the only button is "I've turned my camera back on".
- Exam timer confirmed still counting down while locked (59:48 → 59:44).
- Exactly one `camera_blocked` row in `integrity_events`, detail *"Camera access
  blocked by the candidate (permission denied)"*.
- On regaining access the overlay switches to "Camera is back" **with no click**.

`escalateFailure` is covered by 5 unit tests and **mutation tested, 3/3 killed**:
making it a no-op (which reproduces the original bug), escalating everything
(which would hide a real `no_device`), and ignoring the latch.

One cosmetic bug caught in the screenshot: Tailwind's preflight resets `ol` to
`list-style:none`, so the numbered remedies rendered as an unbroken wall of
text. `listStyle` is now set explicitly and the steps read 1–4.

Gates: `bun run typecheck:api` clean, `bun test` **95/95**, `vite build` clean,
and `typecheck:web` held at its pre-existing **57** errors (the app code adds
none — an earlier reading of 8 was tsc bailing out on a syntax error, not an
improvement).

#### The invigilator's half of the same promise

Stopping the candidate is only half of it: if a block never surfaces on the Live
Monitor, an invigilator cannot act on it and the evidence is invisible until
after the exam. That path was previously argued from the diff, never observed —
and it is not obvious, because the monitor drawer loads its events from the
**reports** endpoint (`/api/reports/:examId/attempt/:attemptId`), not from
`/api/monitor`. `EVENT_LABEL` can be perfectly correct while the data never
arrives.

`scripts/verify-monitor-camera-block.py` (`bun run verify:monitor-camera-block`)
now drives both sides in one run: phase A blocks a real candidate's camera,
phase B signs in as the tenant admin and asserts what they see. **16/16 pass**:

- `/api/monitor` lists the exam as live and the candidate as `in_progress`, with
  `violations: 1` and an `examId` (without which the drawer cannot load evidence).
- The reports endpoint returns exactly `['camera_blocked']`.
- The row's **FLAGS cell reads `1`** — visible without opening anything.
- The drawer's title element reads *"Camera access blocked"*, not the raw
  `camera_blocked`, with detail *"…by the candidate (permission denied)"*, and
  the badge computes to `rgb(192, 69, 59)` — serious red, not routine amber.
- It never falls back to "No violations recorded".

**Mutation tested, 2/2 killed — and both mutants first exposed a vacuous check
of my own**, which is the real value of the exercise:

1. Removing `camera_blocked` from `EVENT_LABEL` + `SERIOUS` initially killed only
   the colour check. The label assertion searched the whole page for "Camera
   access blocked" — but the *detail* line starts with those exact words, so it
   passed with the label gone. It now asserts on the title **element**.
2. Adding `camera_blocked` to `NON_VIOLATION_TYPES` initially killed only the API
   count check. The row assertion looked for `"1"` anywhere in the row text and
   matched the **roll number** `STU-21CS102`, passing while the cell displayed
   "Clean". It now reads the FLAGS cell by its column header.

After tightening, each mutant is killed by 2 checks, and the restored source
passes 16/16. Re-seed between runs: a leftover `in_progress` attempt turns the
student's Start button into Resume and phase A times out.

### The other camera failure: a lens that is simply covered

The block work above is about a camera that is **dead** — permission denied, the
track ended, the browser tells us so. It says nothing about the cheaper trick:
leave the camera running and put tape, a sticky note or a hand over the lens. The
track stays `live` and unmuted, frames keep arriving, every track-level signal
reports a healthy camera. Only the picture knows, and until now the response to
that picture was a warning the candidate could click away.

**It was not a control.** After 60s the overlay offered *"My room is just dim —
continue the exam"*. A candidate covering their lens deliberately only had to
wait one minute and click. The detector produced a flag for the reviewer and
nothing else, which is the same as producing nothing while the exam is live.

The lock is now a **timer, and only a timer**:

- A covered lens locks the exam for **two minutes**, with the countdown on screen.
- There is **no dismiss control** of any kind.
- **Uncovering early does not release it.** This is the part that makes it work.
  If early release were allowed the optimal cheat would be: cover, do the thing,
  uncover, resume — the lock would cost nothing. The period IS the penalty, and
  the exam timer keeps running underneath it.
- Still covered when the period expires? Another two minutes, repeating for as
  long as the lens stays covered.

The uncomfortable part, stated plainly: **the detector cannot tell a taped lens
from an unlit room.** Both are flat, dark frames. So this deliberately punishes a
candidate sitting in the dark — they lose two minutes and are told to turn on a
light. What it never does is lock them out of their paper: it is a pure timer, so
they always get back in. That trade is the whole reason there is no "my room is
dim" button. The old button was an escape hatch for exactly the person it was
built to catch, and it is worth two minutes of an honest candidate's time to
close it. Venues that cannot light a hall should turn the check off in Settings —
whose help text claimed "it never locks the exam" and has been rewritten.

A **frozen** feed (a still image or virtual camera injected into the stream) is
flagged and warned about, but deliberately does **not** lock: unlike a covered
lens, a candidate cannot fix a driver repeating a frame from their chair, and a
repeating lock with no available remedy is a lockout, not a penalty.

Detection went from ~54-81s to **~30s**, by splitting the two things the webcam
loop was doing at once. `grabFrame` used to upload every frame it analysed, so
sampling faster meant uploading faster — a 150-candidate hall would have gone
from ~333 to ~900 uploads a minute, with R2 and the reviewer's ZIP growing to
match. Analysis is a local canvas read that never touches the server, so it is
now its own 10s loop (`analyzeOnly`) and the 27s upload loop is untouched. One
consequence worth naming: the analysis loop is the **sole** producer feeding the
detector. Two producers on different clocks would make its "3 consecutive bad
frames" rule meaningless, so `capturePeriodic` no longer pushes into it.

The lock machine is DOM-free in `src/web/student/lib/obstruction-lock.ts` — 22
unit tests, **5/5 mutants killed** (release while still covered, drop the
early-tick guard, extend from `until` instead of `now`, make `isLocked` inclusive
at the deadline, unclamp the remaining time).

But a state machine passing tests proves nothing about what a candidate can do
with a mouse, so `scripts/verify-camera-covered.py` (`bun run
verify:camera-covered`) drives a real Chromium through a real attempt and covers
the lens at the pixel boundary. **24/24 pass**, including: the lock appears 25s
after covering, the countdown starts at `2:00` and ticks, the overlay contains
**zero** buttons or links, uncovering at 25s leaves it locked with 90s still to
serve, it releases only after the full period, and covering again then holding
through expiry sends the countdown from 1s back over 100s without the overlay
ever dropping.

**Mutation tested, 2/2 killed**, both restoring exactly the behaviour that was
removed: re-adding the "my room is just dim" button was caught by the
no-controls check, and releasing the lock as soon as the lens reads clear was
caught by the early-uncover check.

It takes ~6 minutes to run, because the lock is two real minutes and there is no
way to shorten it from the page. That is not an oversight — a test hook that
shortens a lock is a cheat vector, since anything the script can call from the
page a candidate can call from a console.

### One broken webcam, forty-three violations

Pulled the numbers to confirm a backlog item ("recount violations now that
`focus_loss` is non-scoring") and found it was already a no-op — counts are
computed live in SQL, there is no denormalised column, every read already
excludes the type. The audit that proved it surfaced something worse.

`scripts/audit-violation-cadence.py` asks of every event type in a finished exam:
does this repeat on a machine-regular cadence, or at irregular human intervals?
Against prod exam `ex_de2e60a8be504057` (186 attempts), `camera_lost` had the
exact signature `focus_loss` was demoted for — **65% of gaps within 1s of a 60.0s
median, longest run 36 consecutive gaps** — while the genuinely human types were
irregular (`context_menu` 3%, `copy_in_answer` 0%, `tab_switch` 0%).

The top of that exam's violation table:

```
  46  23K91A66K3  camera_lost=43, focus_loss=32     <- one failing webcam
  21  24K95A6612  camera_lost=20
  16  23K91A66C8  paste_in_answer=9, copy_in_answer=5, cut=1   <- the actual case
```

42 of those 43 rows carry the identical detail "Camera disconnected". **The harm
is the ordering**: a TPO scanning "most violations" sees two students with broken
hardware above the one student in the hall with a real copy/paste pattern. The
flag that should start an investigation is buried under noise from a USB port.

`camera_lost` still scores — a camera dying mid-exam is a real integrity gap. The
duplicate billing is what is wrong, and the existing per-handle latch in
`startWebcam` cannot fix it: the unlock poll builds a **new handle with a new
latch** every 2.5s, and in `engageLock` the `lockedRef` guard sits below the
record call by design (it only protects the countdown). So the rule moved into a
DOM-free machine, `src/web/student/lib/camera-episode.ts`: one row per
**episode**, one permitted escalation `camera_lost` → `camera_blocked`, never a
de-escalation. 19 unit tests, **8/8 mutants killed**.

**The unit tests were not enough, and this is the part worth remembering.** The
first version also cleared the episode when the exam unlocked, reasoning that
resuming is unambiguous proof the camera is back. `scripts/verify-camera-episode.py`
— real Chromium, real attempt, a webcam faked to die 700ms after every open —
failed it on the first run: five lock cycles, five rows.

```
camera_lost  ->  15s lock  ->  camera_restored  ->  dead 700ms later  ->  camera_lost
```

One row per lock period. Which is **precisely the 60.0s cadence measured on prod**,
where the lock is 60s: the unlock was never the cure, it was the storm's clock.
The unlock poll releases on a *single instantaneous* `isCameraActive()` reading,
and a flapping camera hands it one every time the device is re-opened. `onRestored()`
was deleted; an episode now ends only after the camera stays continuously live for
10s, which a real recovery clears within seconds of the unlock anyway.

That reading has to arrive even while the exam is locked, so it comes from a
dedicated 2s feeder rather than an existing loop — the snapshot tick skips while
`lockedRef` is set, and the obstruction loop is gated on `detectCameraBlock`.

`bun run verify:camera-episode` now passes **14/14**: one row across five
lock/re-open cycles, with the `camera_restored` count proving the failure really
did recur (otherwise "1 row" is also what you get when nothing ever retried), and
a genuinely new failure after a real recovery still getting its own row. The
browser check is itself mutation tested (`scripts/mutate-verify-camera-episode.sh`,
**2/2 killed**): restoring the original bug, and restoring the unlock-resets-the-
episode leak. Its harness bundles with `vite build` directly rather than
`bun run build`, because the latter runs the unit suite first and mutant 1 is a
bug the unit tests already kill — the build would abort before the browser ever
opened.

The 14 Aug rows are not being retro-edited. They are the historical record, the
timeline already groups them, and the count that misleads is computed live — so
it corrects itself from the next exam onward. Re-run the cadence audit after the
next real exam: `camera_lost` should no longer trip the SUSPECT rule.
