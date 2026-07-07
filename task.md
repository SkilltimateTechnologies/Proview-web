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
