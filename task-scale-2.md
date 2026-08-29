# Proview scaling review — Aug 29 2026

Trigger: exam-time slowdown reported again by the operator, after `ce2fa29` (student path) and
`e423f25` (admin path). This is an architecture review, not a fix. Every claim is tagged
**[measured]**, **[from code]**, **[arithmetic]** or **[unverified]** so nothing here reads as
more certain than it is.

---

## 1. The single most important structural fact

**Everything runs in one Bun process, on one Railway replica.** [measured]

Six consecutive `/api/health` calls returned the identical boot timestamp
(`2026-08-29T16:40:47.958Z`) and a query counter that rose monotonically (1020 → 1035, +3 per
request). One instance, one process, one event loop.

That single event loop is currently doing, at the same time:

| work | cadence | source |
|---|---|---|
| every student's autosave / heartbeat / event flush / snapshot presign | continuous | `src/api/index.ts` |
| serving the JS/CSS/image bundle to every student | on load | `src/server.ts` |
| Live Monitor snapshot builds for every invigilator | 5 s poll | `src/api/index.ts` + `lib/watchdog.ts` |
| AI grading of subjective answers (`MAX_CONCURRENT` 12) | on submit | `lib/grade-queue.ts` |
| Judge0 code-run polling, 700 ms per job | on run/submit | `lib/judge0-queue.ts` |
| auto-submit sweep — full scan of **all** `in_progress` attempts | 60 s | `lib/grade-queue.ts:385` |
| pending-grading reconciliation sweep | 60 s | `lib/grade-queue.ts:451` |

Nothing here is isolated from anything else. A slow grading burst, a Judge0 stall or one heavy
monitor build competes directly with a student trying to save an answer. This — not Turso — is
the first thing to change.

**Why we cannot just raise the replica count today:** the sweeps and the grade queue are
in-process timers with no leader election, so two replicas would both scan and both grade the
same attempts. The in-memory caches would also diverge per replica (tolerable — they are TTL
based), but duplicated grading is not. **Splitting the worker role out of the web process is the
prerequisite for horizontal scale.** [from code]

---

## 2. Database: what is and is not the problem

Turso over HTTP, `aws-ap-south-1` (Mumbai). [measured, from `.env`]

Per-statement latency looks like **~13 ms**, estimated from the gap between two prod endpoints:
`/api/reports` 16.6 statements ≈ 344 ms of server time vs `/api/dashboard` 5.6 statements
≈ 202 ms. [arithmetic on measured values] So app and database are co-located — there is no
cross-region blunder to find here. Good news, and it means the remaining cost is *volume*, not
distance.

### Volume at 1000 concurrent students

Client cadences, read out of `src/web/student/pages/exam-runner.tsx` and `shell.tsx`: heartbeat
15 s, autosave debounce 20 s (plus on every answer/navigate), event flush 10 s, webcam snapshot
~27 s, waiting-room exam list 15 s. Statement costs per call are the post-`ce2fa29` budgets
asserted by `scripts/verify-scale.py`: heartbeat 1, autosave 4, status 3, events 2–3.

| path | calls/s at 1000 students | statements/s |
|---|---:|---:|
| heartbeat (15 s) | 67 | ~67 |
| event flush (10 s) | 100 | ~250 |
| autosave (~3/min) | 50 | ~200 |
| snapshot + status + list | ~60 | ~120 |
| **total** | | **~600 statements/s** |

[arithmetic — not yet measured at 1000. `bun run loadtest --students 1000 --seconds 60` exists
precisely to confirm or refute this, and it should be run before the next big exam.]

A large fraction of those are **writes to a single SQLite primary**. That is the ceiling we are
approaching, and it is the honest answer to "does Turso need attention": yes, but the cheapest
wins are in *how much we ask of it*, not in replacing it.

### Three specific pieces of waste on the hot path [from code]

1. **Every autosave, event flush and snapshot-url call re-reads the attempt row** just to check
   ownership (`select … from attempts where id = ? and student_id = ?` at index.ts 1888, 1973,
   1990). That is ~150 statements/s of pure authorization at 1000 students. The attempt↔student
   binding never changes, so it belongs in the signed student token or a TTL map.
2. **The heartbeat writes one row per student every 15 s** — 67 writes/s whose only purpose is
   `lastSeenAt` for the Live Monitor. Buffer them in memory and flush one multi-row UPDATE per
   second: 67 writes/s → ~1.
3. **`integrity_events` has no retention.** One exam already holds 27,153 rows (documented in
   the monitor comment at index.ts ~2820). It grows forever, and both Turso's row-read billing
   and every monitor build pay for it.

### What to do about Turso specifically

- **Check the dashboard for the incident window first.** Turso meters and throttles on monthly
  rows read / rows written. A plan throttle looks *exactly* like "the system slowed down while
  students were writing". One 1000-student exam writes on the order of 0.5–1 M rows
  [arithmetic], so a free/entry plan can be consumed by a handful of exams. This is the single
  highest-value 5-minute check available and I cannot do it from here. [unverified]
- **Embedded replicas** keep a local SQLite file in the container: reads become microseconds,
  writes still go to the primary. This is the structural fix for read latency and would make
  most of the TTL caches I added redundant. Caveats: sync lag (fine for question sets and
  bundles, which are immutable during an exam; needs thought for the Live Monitor), one local
  file per replica, and it needs testing on Bun — Turso ships Bun examples but we must prove it
  on our own workload.
- **Concurrent writes (`BEGIN CONCURRENT`, MVCC)** are in early preview on Turso Cloud and
  claim ~4× write throughput plus no `SQLITE_BUSY`. Worth asking their support whether our
  account can enable it. [unverified — vendor claim]
- **Database-per-tenant** is Turso's native multi-tenant scaling model and the right long-term
  shape: one college's exam load then cannot touch another's, and each database keeps its own
  writer. Significant migration; plan it, do not rush it.
- **The honest limit:** if the target is materially beyond ~1000 concurrent writers, the
  append-heavy tables (`answers`, `integrity_events`, heartbeats) belong on Postgres. Not today,
  and not before the cheaper items above are done — but it should be a conscious decision rather
  than a surprise at 5000 students.

---

## 3. Other real exposure

- **No CDN.** Static assets are correctly compressed and immutably cached since `ce2fa29`, but
  they are still served *from the exam process*. 1000 students cold-loading an exam hall at
  09:00 all pull the bundle through the same instance that is saving their answers. Putting
  Cloudflare in front of the Railway domain moves that to the edge and is close to free. [from code]
- **Submit does grading on the request path.** `finalizeAttempt` runs inline in
  `POST /student/attempts/:attemptId/submit` (objective inline, subjective/coding handed to the
  in-process queue). At the bell, ~1000 submits land in a couple of minutes, so the heaviest
  database work of the whole exam is concentrated in the narrowest window — on the same event
  loop serving everyone else. Grading should be a durable claim-based queue table drained by the
  worker process. Bonus: an in-process queue loses its backlog on every restart. [from code]
- **No load shedding.** There is no rate limit, no 429, no queue cap on any student endpoint
  (the only `rate limit` matches in the tree are AI-provider comments). Under overload the
  server accepts everything and gets slower for everyone instead of protecting the students
  already writing. [from code]
- **Live Monitor is poll-based** — 5 s per invigilator, 3 s server-side cache, and the watchdog
  already has a `degraded` flag because this froze once. Currently healthy: `lastBuildMs` 460,
  `overBudget` 0, `degraded` false — but with 0 rows, i.e. no live exam. That number means
  nothing until it is read *during* an exam. [measured]

---

## 4. What I would do, in order

### P0 — before the next large exam (about a day of work)
1. Read Turso usage/throttling for the reported incident window. If we were throttled, most of
   the rest is secondary.
2. Run `bun run loadtest --students 1000 --seconds 60` against the throwaway database and
   reproduce the slowdown locally. Guessing stops here.
3. Remove the per-request attempt re-read on autosave / events / snapshot-url.
4. Coalesce heartbeats into one batched UPDATE per second.

### P1 — within a week
5. Split the process into roles (`ROLE=web|worker` off the same image): sweeps, grading and
   Judge0 polling move to a single worker service, web replicas become stateless. Then raise
   Railway to 2–3 web replicas.
6. Put Cloudflare in front for static assets.
7. Move grading off the submit path into a durable queue table with idempotent claiming.
8. Add a retention/archival job for `integrity_events` (aggregate + ship detail to R2).

### P2 — the "true platform" work
9. Turso embedded replicas, proven under the load test before it goes near an exam.
10. Live Monitor over SSE from a single per-tenant builder instead of N pollers.
11. Load shedding: per-token rate limits, 429 with `Retry-After`, and a client that respects it.
12. Publish a capacity number ("N concurrent students per web replica"), assert it in
    `verify:scale`, and re-check it every release.

---

## 5. What I could not verify from here

- Turso plan tier, current usage and whether any throttling occurred. Needs the dashboard.
- Railway replica count and region as configured (I can only observe one live instance).
- The actual timestamp of the reported slowdown, which decides whether the Railway logs still
  hold the watchdog's `[watchdog]` warnings for it.

---

# Addendum — the reproduction run (Aug 29, later)

Written after the review above. The instruction was *reproduce before changing anything*, so this
section is only measurement. **No production code path was altered.**

## 6. The 300-student test does not break. Here is what it does instead

You said the last exam slowed down at **just below 300** students, so 300 is the number I drove.

First attempt reproduced nothing: 3,606 requests, p95 ≤ 31 ms, zero errors. That result was
**not** worth believing, because the harness differed from a real exam in four ways. I closed
three of them (`scripts/loadtest-exam.py`):

- `--monitor-poll` — an invigilator with the Live Monitor open, polling `/api/monitor` every 5 s
  for the whole run, signed in for real. The first test left `monitor.builds` at **0**; this is
  the path that froze the app once before.
- `--submit-storm` — the end-of-exam bell: all 300 submits inside 45 s. Submit grades inline.
- `--start-burst` — the exam-start stampede: all 300 fetch `/bundle` (the heaviest read in the
  app) and `POST /start`.
- `DB_FAKE_LATENCY_MS` on the server — **the important one.** The test drives a local SQLite
  file at microseconds per statement. Production is Turso over HTTP at ~13 ms per statement.
  The original test deleted the dominant cost in production, which is why it looked healthy.
  Off by default, never set in prod. [measured]

## 7. Result: the app degrades linearly with database latency and never falls over

300 students, 60 s steady state, one invigilator on the Live Monitor, then 300 submits.
Only the simulated per-statement latency changes between rows. All figures p50, ms. [measured]

| +ms per statement | heartbeat | snapshot-url | events | status | autosave | **submit** | monitor build | errors |
|---|---|---|---|---|---|---|---|---|
| 0 (local file) | 4 | 3 | 4 | 5 | 6 | – | – | **0** |
| **13 (prod estimate)** | 18 | 17 | 46 | 47 | 62 | **334** | 92 | **0** |
| 40 | 45 | 44 | 127 | 132 | 169 | **889** | 255 | **0** |
| 100 | 105 | 104 | 307 | 316 | 409 | **2151** | 613 | **0** |

With the start stampede added at 13 ms: `/bundle` 61 ms p50, `/start` 93 ms p50, zero errors.
Throughput held at 30–37 req/s throughout — that is what 300 students' cadence *produces*, not a
ceiling the server hit. `degraded` never fired. Nothing queued, nothing timed out, nothing 5xx'd.

**This is the finding.** Divide any cell by its row's latency and you get an integer — the number
of statements that endpoint runs:

| endpoint | statements per request (derived) |
|---|---|
| heartbeat / snapshot-url | ~1 |
| events / status | ~3 |
| autosave | ~4 |
| monitor build | ~6 |
| **submit** | **~21** |

Response time is `statements × per-statement latency`, with no saturation term. So:

1. **The app did not run out of CPU, connections or event loop at 300 students.** It has no
   cliff in this range — which means "it got slow" is *not* the app hitting a concurrency limit.
2. **A slowdown of the kind you saw is what rising per-statement latency looks like.** If Turso
   went from ~13 ms to ~100 ms during the exam — plan throttling on Developer/Starter, or a
   network wobble — every student's autosave goes 62 ms → 409 ms and every submit goes 334 ms →
   **2.15 s**, with zero errors in the logs. That matches "slowed down" exactly, and it is
   invisible from inside the app.
3. **The lever is statements per request, and it works regardless of what Turso does.** Killing
   the ownership re-read on autosave/events/snapshot-url (§3) is a straight 25–33 % cut on those
   endpoints at any latency. Submit at ~21 statements is the worst offender by a factor of five.

## 8. What this still does not prove

- Simulated latency is a fixed delay, not a real network: no connection limits, no TLS, no
  server-side queueing at the database. Real throttling behaves worse than this. [unverified]
- The sandbox is not the Railway container. CPU headroom here may exceed prod. [unverified]
- No snapshot JPEGs were uploaded to R2, no real page/bundle download over college wi-fi. The
  paper was 15 MCQs, so no AI grading and no Judge0 ran. [from code]
- **Turso plan usage and throttling during the last exam — still the single unchecked item that
  could explain everything.** I cannot see that dashboard.

---

# Addendum 2 — "couldn't submit" + "blank pages" are a different bug from slowness

You reported the symptoms as **not able to submit** and **some had blank pages**, with one
invigilator on the Live Monitor. Those are *failures*, not slowness — and my load test reported
zero errors precisely because it never injected any. Both symptoms trace to verified code.

## 9. Symptom 1: "not able to submit" — the client retries zero times

`src/web/student/lib/api.ts`, `req()` — every student call goes through this:

- **One `fetch`. No timeout, no retry, no backoff.** Any non-2xx or dropped connection throws.
- `doSubmit` (`exam-runner.tsx:1194-1214`) catches it, flips back to `running` and shows
  *"Couldn't submit — connection lost. Reconnect and press Submit again."*

So **a single failed request blocks a student's submit**, and the only recovery is the student
pressing Submit again. The message blames the student's connection even when the cause was a
server-side 500. [from code]

Two things make submit the most likely request to fail:

- It is **the heaviest endpoint in the app, ~21 statements** — 334 ms at 13 ms/statement,
  **2.15 s at 100 ms** (§7). Everything else is 1–4 statements.
- All ~300 land inside a couple of minutes at the bell. That is ~6,300 statements through one
  process, in a burst, on the request path.

> **CORRECTION (later the same day).** An earlier version of this section said submit "grades
> inline" and named *moving grading off the request path* as the biggest win. **That was wrong**
> and I am leaving the correction visible rather than quietly editing it away:
>
> - Objective grading (`mcq/multi/truefalse/fillblank`) runs via `autoGrade` — **pure in-memory
>   arithmetic, zero database statements.** It costs nothing.
> - Subjective + coding grading was **already** off the request path: `queueAttemptGrading` is
>   explicitly fire-and-forget and is called at the very end of `finalizeAttempt`.
>
> So the work I proposed was already done. The real ~21 statements are almost entirely **answer
> writes**: `finalizeAttempt` looped `for (const r of rows)` and issued **one upsert per
> question**, so a 15-question paper spent 15 sequential round trips inside submit. That is what
> got fixed — see Addendum 3. [from code]

**The fix is small and safe: retry with backoff.** The server already makes submit idempotent —
`if (attempt.status === "submitted" || "graded") return { ok: true, alreadySubmitted: true }`
(`src/api/index.ts:2008`). Retrying cannot double-submit or double-grade. [from code]

## 10. Symptom 2: "blank pages" — nothing catches a render failure

- **There is no error boundary anywhere in `src/web`** — `ErrorBoundary` and `componentDidCatch`
  both return zero matches across the whole web tree. Any uncaught throw during render unmounts
  the app to a **white screen with no message and no way back**. [measured]
- The two data paths I checked do handle their errors properly: `shell.tsx:56-64` falls back to
  an error string and an empty list, and the bundle fetch (`exam-runner.tsx:473-476`) falls back
  to the cached paper and only surfaces an error when there is no cache. So the blank screen is
  **upstream of React**, not those handlers. [measured]
- Which leaves the most likely cause: **the same single process serves the JS bundle** (no CDN,
  §3). The HTML shell can load while the 473 KB chunk request fails or is starved — and the
  result is exactly a blank page for *some* students and not others.

## 11. What this changes about priorities

The Turso plan is **no longer the first suspect**. At 100 ms per statement — 8x the production
estimate — 300 students still submitted with **zero errors** (§7). Latency alone does not block a
submit. A client that retries zero times turns any momentary blip into a blocked student, and a
missing error boundary turns any transient asset failure into a white screen. Both are cheap to
fix and neither touches the database.

Still worth the 5-minute check on the Turso dashboard for that window, but as confirmation now,
not as the hypothesis.


# Addendum 3 — the fixes, implemented and measured (Aug 29, later still)

Four changes, all local, **nothing pushed to production**. `bun run build` green:
**261 tests pass** (was 252), `typecheck:api` clean, `vite build` clean. `typecheck:web` still has
its 57 pre-existing errors, none in the files touched.

## 12. What changed

**1. Batched the answer upserts on submit** — `src/api/lib/grade-queue.ts`, `finalizeAttempt`.
One `insert().onConflictDoUpdate()` per question became **one statement per 50 rows** using
`excluded.*`, matching the pattern the autosave endpoint already used. Rows are deduped by
`questionId` first, because SQLite refuses to apply `ON CONFLICT` twice to the same row inside one
statement.

Both hard-won invariants in that function are untouched: it still does **not** delete-then-reinsert
(the bug that once left a student with 23 blank twin rows and a score of 0), and the merge rule —
*the client response wins only when it `hasContent`, else keep the prior autosaved answer* — is
byte-for-byte the same. [from code]

**2. Retry + timeout on the student client** — `src/web/student/lib/api.ts`, `req()`. Was one bare
`fetch` with no timeout and no retry. Now takes a per-call policy, opt in only where the server is
idempotent: **submit (4 retries / 20 s), bundle (3 / 20 s), start (3 / 15 s), status (3 / 15 s),
heartbeat (2 / 10 s)**. Deliberately **not** `login`, `changePassword` or `runCode` — those are not
safe to repeat. Backoff is exponential (400 ms → 4 s cap) **with jitter**, so 300 students whose
submits failed together do not retry in lockstep and rebuild the spike that broke them. Retries
stop immediately on any 4xx: that is the server's considered answer, not a blip.

**3. An error boundary at the app root** — `src/web/components/error-boundary.tsx`, wired into the
single `createRoot` in `main.tsx`, so it covers the student runner, the admin app and the register
page. There was **no boundary anywhere in `src/web`** before this (§10). It is dependency-free and
inline-styled on purpose — it has to render even when the failure is in the stylesheet or a UI
component it would otherwise import. Shows the error text (so an invigilator can read it off the
screen), a **Reload and continue** button, and the reassurance that answers are saved.
Console-only logging: shipping these to the server would mean a new unauthenticated write
endpoint, which is not worth opening for this.

**4. Honest submit-failure copy** — `exam-runner.tsx`. The old message always said *"connection
lost"*, blaming the student's wifi even on a server 500. It now distinguishes *the server returned
an error (500)* from *we couldn't reach the server*, and says so only **after** the 4 retries are
exhausted.

## 13. Tests

New file `src/api/lib/answer-upsert.test.ts`, **9 tests**, against real in-memory libSQL databases
(no `DATABASE_URL`, no network, no fixtures — not the app's `db` singleton).

The rewrite has one genuinely dangerous failure mode: if `excluded.*` did **not** resolve per row,
every row in a batch would land the *same* score and a whole class would be silently mis-marked
while the endpoint still returned 200. So the tests run **the old per-row loop and the new batch
side by side against two separate databases and compare every column of every row**:

- fresh 15-question paper → identical rows both ways, and **1 statement instead of 15**
- **each row keeps its own score** — the mis-marking guard, with 15 deliberately different scores
- re-finalize (submit racing the auto-submit sweep) → converges, **no twins**, per-row values win
- an autosaved answer is overwritten by the merged submit value, and a deferred subjective answer
  keeps its content with `score: null` for the background grader
- nulls round-trip as real nulls, not the string `"null"`
- a 120-question paper → **3 statements instead of 120**, still identical
- duplicate `questionId`s collapse instead of crashing the statement
- empty paper → zero statements; another attempt's answers are never touched

## 14. Measured result

Same scenario as §7 — 300 students, 60 s steady state, one invigilator polling the Live Monitor,
start stampede, then 300 submits. Only the simulated per-statement latency changes between rows.
**Submit, p50 ms:**

| +ms/statement | submit before | submit after | change |
|---|---|---|---|
| 13 (prod estimate) | 334 | **112** | **3.0x faster** |
| 40 | 889 | **299** | **3.0x faster** |
| 100 | 2151 | **715** | **3.0x faster** |

Divide by the row's latency and the statement count is confirmed: **~21 statements → ~7.2**, exactly
as predicted. Everything else is unchanged, which is the point — this was a targeted fix, not a
rewrite (at 13 ms: heartbeat 18→17, snapshot-url 17→17, events 46→46, status 47→45, autosave 62→61,
bundle 61→60, start 93→90, monitor build 92→93). [measured]

Errors: **0 at 13 ms, 0 at 40 ms.** At 100 ms — 8x the production estimate — there was **1 failed
`/start` out of 300 (99.7%)**, where the baseline run had 0. One request in 4,486, at a latency 8x
worse than production, and I did not reproduce or explain it. Recording it rather than rounding it
to zero. [measured]

`degraded` never fired at any latency. Throughput held ~30 req/s throughout, which is what 300
students' cadence *produces*, not a ceiling.

## 15. What is deliberately NOT done

- **The autosave read is left alone.** An attempt→student binding cache would make `/snapshot-url`
  cost zero statements, and the binding is immutable so caching it is safe. But the autosave
  handler genuinely needs the **live** row: it reads `status` for the frozen check, plus `examId`,
  `optionOrder` and `answeredCount`. Caching `status` would let a **post-submit autosave write
  through** — corrupting a submitted paper to save ~13 ms. Not worth it.
- **No CDN for the JS bundle.** Still the most likely cause of the blank pages (§10), still the
  single process serving a 473 KB chunk. The error boundary makes the failure *visible and
  recoverable*; it does not remove the cause.
- **`/api/reports` still runs 16.6 statements** — the per-exam N+1, untouched, still the biggest
  remaining admin win.
- **Turso plan: still no evidence it is the problem.** Nothing here changes §11. The dashboard
  check for the incident window remains worth 5 minutes as *confirmation*.

---

# Addendum 4 — the blank pages (2026-08-29)

Submit is fixed and live (`b3a1e40`). This addendum covers the **other** symptom students
reported: **blank pages**. §15 listed the JS bundle as "the most likely cause… still the single
process serving a 473 KB chunk". That is now addressed at the cause, not just made recoverable.

## 16. What a student was actually downloading

`src/web/main.tsx` decides between three roots — the admin console, the student exam client and the
public register page — from the URL, before anything mounts. All three were **static imports**, so
Rollup put all three in one chunk. A student sitting down to an exam downloaded the entire admin
console (13 pages, recharts, the whole question-bank UI) to render a login box. [from code]

| | raw | brotli q9 |
|---|---|---|
| `assets/index-*.js`, one file, everything | 2,112,465 B | **474,795 B** |

[measured, `node zlib brotliCompressSync` at the same q9 the server uses]

Served by the one Bun process that is simultaneously answering 300 students' heartbeats, autosaves
and submits, with no CDN in front of it.

There was also a second, separate blank-page path: **a chunk that fails to fetch renders nothing, so
the error boundary from §12 cannot catch it** — there is no component mounted to catch anything. Two
causes: a transient fetch failure (plausible during a start stampede), and a stale `index.html`
pointing at hashed filenames a deploy has replaced, which 404s forever no matter how many times it
is retried.

## 17. What changed

**1. The admin console left the student's critical path.** [from code]
Admin and register are now lazy chunks behind `Suspense`; **the student app stays a static import**
on purpose — it is the exam-critical path, so it must arrive in the first round trip, and it must
appear in the document's own resource list for the service worker's offline pre-cache to see it
(that pre-cache is what lets an exam survive an internet drop plus a refresh; a lazily-loaded
student chunk could miss it and reintroduce the exact blank page it was written to prevent).

**2. A chunk that cannot be fetched now recovers instead of showing nothing.** New
`src/web/lib/lazy-chunk.ts`: retry with jittered exponential backoff, then **reload once per session**
(sessionStorage guard) to pick up a new deploy's hashes, then rethrow so the error boundary renders
something readable. Plus `installChunkErrorRecovery()` for Vite's `vite:preloadError`, which would
otherwise become an unhandled rejection and a white screen.

The reload guard is the part that had to be right in both directions: no reload and the student
keeps the blank page; an unguarded reload and they are trapped in a flicker they cannot read or
escape. It fires at most once per chunk key per session.

## 18. Measured result

| chunk | raw | brotli | who fetches it |
|---|---|---|---|
| `index-*.js` (entry + student client) | 1,178,403 | **275,646** | everyone |
| `app-*.js` (admin console) | 910,662 | 202,318 | admins only |
| `RegisterPage-*.js` | 18,351 | 3,024 | register page only |
| `react-pdf.browser-*.js` | 1,623,166 | 473,637 | admin, on PDF export (already lazy) |

**A student's JS drops from 474,795 B to 275,646 B — 42% less, 199 KB saved per cold load.** Across
300 students that is ~58 MB less egress through the single process per load wave. [measured]

Verified in a real browser, not inferred from the build output — `scripts/verify-chunks.py` drives
Chromium at both pages and records every JS request: [measured]

```
student page /px9k2m7/login →  index-BgZIRisR.js
admin page   /            →  index-BgZIRisR.js, app-Cgo2colK.js
PASS  admin console stays off the student's wire, both pages render
```

That script exists because the thing that can silently regress is Rollup's chunk graph, not our
source: one stray static import from the student tree into an admin page would quietly put the whole
console back into the entry chunk, the build would still pass, and 300 students would download it
again.

Tests: **271 pass** (was 261) — 10 new in `src/web/lib/lazy-chunk.test.ts`, all with injected clock,
sleep, storage and reload so there is no timer and no browser in the suite. `bun run build` green.
`typecheck:web` still has its 57 pre-existing errors, none in the touched files. [measured]

## 19. The honest cost, and what is still not fixed

- **Admins pay for this, slightly.** Their total is now 275,646 + 202,318 = **477,964 B across two
  files plus one extra round trip**, against 474,795 B in one file before. ~3 KB and one RTT worse,
  at a desk, not mid-exam. Deliberate. [arithmetic]
- **The CSS is untouched** (49,755 B / 9,700 B brotli, one file). Tailwind emits a single sheet and
  the student components use those utilities; splitting it risks an unstyled exam for a 9.7 KB
  saving. Not worth it.
- **Still no CDN.** 275 KB is a much smaller blast radius, not a different architecture: one process
  still serves every student's bundle. [unverified] whether this alone would have prevented the
  blank pages in the last exam — 42% fewer bytes and a recoverable failure are strictly better, but
  I cannot claim it as the proven root cause without the Railway metrics for that window.
- **`/api/reports` still runs 16.6 statements.** Unchanged, still the biggest remaining admin win.
- **Turso plan: still no evidence it is the problem.** Nothing here changes §11.
