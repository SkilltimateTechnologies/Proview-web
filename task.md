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
