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
