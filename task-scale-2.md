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

---

# Addendum 5 — the durable grading queue (2026-08-30)

## 20. First, a correction to my own backlog

An earlier summary of mine said "grading runs inline at the bell". **That is wrong.** [from code]

`finalizeAttempt` grades the *objective* questions inline — `autoGrade`, pure CPU, no network, no
AI — writes them in the batched upsert, flips the attempt, and only then calls
`queueAttemptGrading` **fire-and-forget**. AI grading of subjective answers was already off the
request path before this change. §3 of the original review said so correctly; my later summary did
not. Nothing in this addendum makes submit faster, and it was never going to.

What was actually broken is what happened to that background work *after* the request returned.

## 21. What was wrong

All four [from code], on the shipped `aa413bc`:

1. **The queue lived entirely in one process's memory** — an `inFlight` Set, a `retryCounts` Map, a
   12-slot semaphore and `setTimeout` backoff. A deploy mid-batch dropped the schedule. The 60 s
   recovery sweep found the work again, but **`retryCounts` reset to 0 on every restart**, so an
   answer the AI could never grade was retried forever, and billed forever.
2. **It is what blocks replicas.** With 2–3 Railway replicas, every replica's sweep picks up the
   same `submitted` attempts: the same paper graded 2–3×, 2–3× the AI bill, concurrent writes into
   the same answer rows. This is the prerequisite for horizontal scaling, not a side quest.
3. **The recovery sweep was an N+1 firing every 60 s straight through the submit burst.**
   `attempts` has no index on `status`, so it was a full table scan plus one answers query per row
   — ~300 queries a minute, competing with students who were still submitting.
4. **A give-up was a `console.error`.** After 3 retries the ungraded answers were written `score: 0`
   with a manual-review note and the attempt flipped `graded`. No admin could ever find those
   students.

## 22. What changed

**A row per attempt.** New `grade_jobs` table (`attempt_id` unique, `status`, `tries`,
`next_run_at`, `claimed_at`, `claimed_by`, `last_error`), plus
`grade_jobs_status_next_idx (status, next_run_at)` so the claim query is not a queue scan.

- **Created at boot by `invariants.ts`, not by a migration** — there is no migrate step in the
  deploy path (`start` is `bun src/server.ts`) and `drizzle/` is a stale snapshot whose regeneration
  emits table DROPs. Verified on the load server: `[invariants] created missing table grade_jobs`.
  [measured]
- **Its invariant failures are advisory** — a missing `grade_jobs` must not turn `/api/health` red
  mid-exam, because the feature degrades instead of failing.
- **New `src/api/lib/grade-jobs.ts`** — the persistence layer. Every function takes the database as
  a **parameter**, never the app singleton, which is what lets the tests drive the identical code
  against in-memory libSQL.
- **`grade-queue.ts` rewired.** `gradeAttempt` split into `gradeAttemptOnce` (one pure pass, no
  scheduling), `giveUpOnAttempt` (the terminal path) and the old in-memory chain, which survives as
  the fallback. New `gradeWorkerTick` claims due jobs every 5 s; `startGradeQueue` probes the table,
  adopts orphans and picks the mode.
- **Retries now live in the row.** `tries` and `next_run_at` are persisted, so a deploy can no
  longer wipe the counter — bug 1 closed.
- **Claim exclusivity** rests on SQLite/Turso's **single-writer serialization**, not row locks and
  not MVCC: two workers issuing the identical claim `UPDATE ... RETURNING` cannot interleave, and
  `RETURNING` is what tells each worker which rows it actually won — bug 2 closed. A 5-minute lease
  reclaims work orphaned by a worker killed mid-grade.
- **The sweep is now a reconcile, not the scheduler.** Off the 60 s auto-submit tick, onto its own
  10-minute timer, capped at 200 attempts, with **one grouped ungraded-count query** instead of one
  per attempt, and ≤50 lost-flip repairs per pass — bug 3 closed.
- **Terminal failures are queryable.** A `failed` row keeps `last_error` and the attempt id, so the
  papers that need a human can be listed — bug 4 closed. The student-visible outcome is deliberately
  **unchanged** (zero the ungraded answers, flip to `graded` so students stop polling); changing
  that is a product decision, not mine to make quietly.
- **`server.ts` gained `ROLE`.** Defaults to `all`, so today's single process still serves *and*
  grades — nothing about the current deployment changes. Going to 2–3 replicas later is
  `ROLE=web` on the web replicas and `ROLE=worker` on one background process: a config change, not
  a code change. An unrecognised value falls back to `all`, because a typo in a Railway variable
  must never silently stop grading.
- **Grading fails soft.** If `grade_jobs` is unreachable, `jobsAvailable` goes false, it logs once,
  and every path uses the in-memory schedule that shipped before this table. Degraded beats a
  missing table stopping grading altogether.
- **Submit cost: 7 → 8 statements.** One extra `INSERT ... ON CONFLICT` on the submit path. Paid
  deliberately.

The enqueue conflict rule is the one piece of logic worth reading twice: on conflict it resets
`status` and `next_run_at` but sets `tries = CASE WHEN status = 'done' THEN 0 ELSE tries END`.
Resetting unconditionally reopens the retry-forever hole; never resetting makes an attempt
legitimately reopened and re-sat weeks later hit the cap on its first pass.

## 23. Tests

**288 pass, was 271** — 17 new in `src/api/lib/grade-jobs.test.ts`. `bun run build` green.
`typecheck:web` still has its 57 pre-existing errors, none in the touched files. [measured]

The new tests exist because every one of these failures is invisible in a smoke test — grading
still "works", it just costs twice or stops silently:

- two connections to one database racing the same claim → **disjoint sets, never the same job id**
  (a real second connection, so a temp file rather than `:memory:`)
- a live lease is not stealable; an expired one is reclaimed, and the steal does **not** consume a
  retry
- `done` and `failed` are terminal — not reclaimed a day later
- backoff and `tries` survive a simulated restart, and the retry is **not** claimable before the
  backoff elapses (this is the bug that cost money)
- the third failure is terminal, never retried again, and leaves a `failed` row naming the attempt
- enqueue is idempotent per attempt; `tries` is kept on a retry and reset only after a `done`
- backfill adopts orphans, is idempotent, is bounded, and does not disturb an in-flight `tries`
- `closeStaleGradeJobs` retires jobs whose attempt no longer needs grading and leaves terminal
  failures findable

## 24. Measured on a 300-student run

Boot, on a database that had never seen the table: [measured]

```
[invariants] created missing table grade_jobs
[grade-queue] adopted 9 pre-existing submitted attempt(s) into the durable queue
[grade-queue] scheduling mode: durable
[grade-queue] worker: claimed 9, graded 9, retry/failed 0
```

Those 9 were attempts left `submitted` by earlier runs — work the old in-memory queue had no row
for and would only have found by chance on a sweep.

Then 300 students, 60 s steady state, one invigilator on Live Monitor, 300 submits over 45 s
(local file DB, no simulated latency): [measured]

| endpoint | n | ok% | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| BUNDLE | 300 | 100% | 4 ms | 10 ms | 2541 ms | 2681 ms |
| START | 300 | 96.3% | 5 ms | 12 ms | 22 ms | 27 ms |
| **SUBMIT** | 300 | **100%** | **2 ms** | **4 ms** | **13 ms** | **23 ms** |
| autosave | 875 | 100% | 2 ms | 6 ms | 15 ms | 70 ms |
| heartbeat | 1174 | 100% | 4 ms | 7 ms | 18 ms | 100 ms |

4,509 requests, 13,007 database queries, monitor build worst 6 ms, `degraded` never fired. **Submit
did not regress** despite the extra statement.

The 11 START failures are the reused load database, not a regression: `/start` returns **409
"Already submitted"** for an attempt already `submitted` or `graded`, and this database carried 9
such attempts plus graded ones from previous runs. [from code]

The queue drained completely: **300 jobs `done`, 0 `pending`, 0 `failed`; 304 attempts `graded`, 0
`submitted`; no attempt left without a score; no duplicate `(attempt_id, question_id)` answer
rows; scores within 0–92.** [measured]

## 25. The honest limits

- **This does not make anything faster for a student.** Submit is one statement *more* expensive.
  The wins are: retry state survives a deploy, an ungradeable answer stops costing money after 3
  tries, a failed paper is findable, the 60 s N+1 through the submit burst is gone, and replicas
  become possible.
- **Claim exclusivity is proven against local libSQL, not against Turso over HTTP under a real
  300-student burst.** [unverified] The argument rests on Turso serializing writers the way SQLite
  does. The load run above **never exercised the worker's claim path under contention** — the
  submit path's own fire-and-forget pass finished all 300 jobs first, which is the expected shape
  on a paper with no subjective answers. The claim race is covered by the tests, not by that run.
- **The load paper was 15 MCQs, so no AI grading and no Judge0 ran.** [from code] The queue was
  exercised end to end; the expensive grading path it protects was not.
- **`ROLE=worker` has not been run in production.** It defaults to today's behaviour on purpose;
  the multi-replica configuration is written but unproven. [unverified]
- **Terminal failures still zero the student's ungraded answers.** Unchanged by design, now merely
  visible. If you would rather those attempts stay `submitted` and visibly incomplete, say so — it
  is a one-line change and a product decision.
- **Turso plan usage and Railway metrics for the incident window remain unread.** Free, five
  minutes, and still the single item that could confirm or kill the throttling theory. It is not
  something I can reach from here.

## 26. A regression I shipped, and the fix

Commit `57a658f` broke `GET /api/admin/invariants` in production. Recording it here because a
write-up that hides a self-inflicted 500 is worth less than one that admits it.

**Cause.** The duplicate-row audit assumed every unique index it checks spans exactly two columns:

    const [a, b] = spec.columns;   // ... GROUP BY a, b

I generalised that to N columns in `src/api/database/invariants.ts` when I added the new
single-column spec `grade_jobs_attempt_uq(attempt_id)` — and missed a **second, independent copy of
the same two lines** in the route handler in `src/api/index.ts` (~L561). On the new spec `b` came
back `undefined`, `dsql.raw(undefined)` threw, and the endpoint returned 500. [from code]

**Blast radius.** Admin-only and read-only. Nothing on the exam, submit, autosave or grading path
touches that endpoint, and `/api/health` runs its own code path and stayed `ok` throughout the
deploy. [measured] No student was affected, and no data was written or lost.

**Fix** (`7a45063`): the route now uses `GROUP BY spec.columns.join(", ")`, the same shape as
`invariants.ts`. Proven at SQL level against the load database before pushing — the old shape
**throws** on `grade_jobs_attempt_uq` and works on the three two-column specs; the new shape
returns 0 duplicate groups for all four. [measured]

**Verified on production after deploy** [measured]:

    HTTP 200
    present: answers_attempt_question_uq, attempts_exam_student_uq,
             students_tenant_roll_uq, grade_jobs_attempt_uq
    perf:    integrity_attempt_type_idx, integrity_attempt_at_idx,
             grade_jobs_status_next_idx
    tablesPresent: grade_jobs
    duplicateGroups: 0 on all four unique indexes
    ok: true

That response is also the first outside-the-process confirmation that production really did create
`grade_jobs` and both its indexes at boot, rather than falling back to the in-memory path.

**The lesson, stated plainly:** when you generalise a shared assumption, grep for every copy of it
before you commit. Two files held the same two lines; the tests covered the library and not the
route, so `bun test` stayed green at 288 while production returned 500.


# Addendum 6 — what the Turso dashboard actually says (2026-08-30)

Two charts arrived: "Read/Write Operations by date" and "Rows Written, last 30 days". This is the
data point that was missing from every section above, and it changes two conclusions.

## 27. The throttling theory is dead

**Plan limits, read off Turso's pricing page today** [measured]:

| | Free | Developer $4.99 | Scaler $24.92 |
|---|---|---|---|
| Monthly rows read | 500 M | **2.5 B** + $1/B | 100 B |
| Monthly rows written | 10 M | **25 M** + $1/M | 100 M |
| Storage | 5 GB | 9 GB | 24 GB |

**What the charts show** [measured, read off the graphs, so ±10%]:

| | rows read | rows written |
|---|---|---|
| A day with no exam | ~5–6 M | ~0 |
| Aug 14 (peak) | ~56 M | ~800,000 |
| Aug 27 | ~43 M | ~355,000 |

Month to date: roughly **250 M rows read** and **1.2 M rows written** [arithmetic]. That is **10 % of
the read allowance and 5 % of the write allowance** on Developer. Even on the Free tier it would be
half the reads and a tenth of the writes.

Turso's documented behaviour when a monthly quota *is* exhausted is that **queries fail**, and on a
paid plan they are billed as overage rather than blocked. Neither happened: the write curve on
Aug 27 has no plateau and no cliff, it rises and falls in a clean bell.

**So Turso did not throttle the exam, and was not close to doing so.** The explanation for "not able
to submit" and "blank pages" remains the one in §9 and §10 — a client that retried zero times, an
admin console shipped inside every student's download, and 21 database round trips per submit. Those
are fixed. Nothing in this data suggests the plan needs changing.

## 28. Both spikes are exam days, and the incident was bigger than 300 students

Exam windows pulled from production `/api/reports` [measured], all times UTC:

| window | attempts | assigned | exam |
|---|---|---|---|
| Aug 14 14:30–15:30 | 186 | 598 | Weekly Assessment – 1 |
| Aug 14 14:30–15:30 | **268** | 525 | Elite Assessment – 1 |
| Aug 27 14:30–16:00 | 195 | 1,122 | Weekly Assessment – 2 |

The two read spikes land on exactly these two dates and nothing else in the month moved. But note
the first row: **two exams ran in the same hour on Aug 14**, so the process was serving **454
concurrent students**, not 268.

> **This probably corrects the capacity number in §6.** The working assumption all along was "it
> broke just below 300". If the incident was Aug 14 — the taller spike, and the only day with
> overlapping exams — then Proview was actually carrying **~454 concurrent students** when it
> started failing, and a single 300-student exam was never the breaking point. [unverified — needs
> the user to confirm which exam the students complained about.]

Separately, and worth a straight answer before the next exam: Weekly Assessment – 2 shows
**1,122 assigned, 195 attempts, 927 absent**, and Weekly Assessment – 1 shows 598 assigned against
186 attempts. If those rosters were "assign to everyone, only one section was expected to write",
the numbers are meaningless and fine. If those students *were* expected to write, then the failure
was an order of magnitude larger than reported and the reports have been quietly recording it as
absence. [unverified]

## 29. The real finding: two-thirds of the bill is spent while nothing is happening

The idle baseline is **~5–6 M rows read every single day**, including days with zero writes, zero
exams and (on weekends) essentially zero users. Over a month that is **~165 M of the ~250 M total —
about two-thirds of everything consumed** [arithmetic].

That flat, identical-every-day shape is the signature of a fixed-interval timer, not of people. And
the code says exactly which one [from code]:

- `attempts` carries indexes on `exam_id`, `student_id` and `(exam_id, student_id)` — and **no index
  on `status`**.
- `sweepAutoSubmit()` runs **every 60 s** and issues
  `SELECT * FROM attempts WHERE status = 'in_progress'`. With no index that is a **full scan of all
  2,520 attempt rows**, 1,440 times a day.
- Until this morning `sweepPendingGrading()` ran on the same 60 s tick with
  `WHERE status = 'submitted'` — a **second** full scan.

Two scans × 2,520 rows × 1,440 ticks = **7.3 M rows read per day from timers alone** [arithmetic],
against a measured baseline of 5–6 M. Same magnitude, same shape. The timers are the baseline.

**One of the two is already gone.** `57a658f` moved the grading sweep onto a 10-minute timer
(1,440 → 144 scans/day), which should remove ~3.5 M rows read/day, i.e. **~105 M rows/month**. The
baseline on the dashboard should visibly step down from ~5.5 M to roughly ~2 M/day starting today.
**That is a falsifiable prediction — check the chart tomorrow.** [unverified until then]

**The other one is a bomb, because its cost grows with history rather than with load.**
`sweepAutoSubmit` scans every attempt ever taken, once a minute, forever:

| attempts in history | rows read/day by that one timer | per month | vs 2.5 B Developer quota |
|---|---|---|---|
| 2,520 (today) | 3.6 M | 109 M | 4 % |
| **57,870** | 1.7 B | **2.5 B** | **100 %** |
| 1,000,000 (20 colleges, ~1 yr) | 1.44 B | 43 B | 1,700 % |

**At roughly 58,000 stored attempts, that single background query consumes the entire monthly plan
on its own** [arithmetic] — for a query that returns zero rows more than 99 % of the time. At twenty
colleges running weekly assessments, 58,000 attempts is about eight months away.

**The fix is small:**

1. `index("attempts_status_idx").on(t.status)` in `schema.ts`, plus an entry in
   `REQUIRED_PERF_INDEXES` so production creates it at boot — the same mechanism that just created
   `grade_jobs`. An indexed seek on `'in_progress'` reads ~0 rows instead of 2,520, and stays flat
   as history grows.
2. Guard the sweep: it can only matter when some exam is past its deadline. `exams` is 11 rows and
   indexed by tenant; read that first and skip the attempts query entirely when nothing is in
   window.
3. The same index also serves `sweepPendingGrading` (`grade-queue.ts:784`) and `backfillGradeJobs`
   (`grade-jobs.ts:251`), both of which filter `attempts.status`.

## 30. The number that decides per-college pricing

Subtracting baseline from each spike [arithmetic]:

| | reads above baseline | attempts | rows read per student |
|---|---|---|---|
| Aug 14 | ~50 M | 454 | **~110,000** |
| Aug 27 | ~37.5 M | 195 | **~190,000** |

Aug 27 had **fewer than half** the students of Aug 14 and cost nearly as much. The two things that
were larger on Aug 27 were the **duration** (90 min vs 60) and the **assigned roster** (1,122 vs
598/525) — not the number of people actually writing. That is the fingerprint of polling work that
scales with the roster and the clock instead of with real activity: Live Monitor rebuilds and
student polls re-reading whole collections.

Both changes aimed at that (`e423f25` tenant-directory cache, `b3a1e40` submit 21 → 7 round trips)
shipped on **Aug 29 — after both exams**. So the next exam is the first one that will show their
effect, and the per-student read cost is the metric to compare.

Why it matters for pricing: at 190,000 rows read per student, a 300-student exam costs ~57 M rows
read, so Developer's 2.5 B supports **~44 exams a month**. Twenty colleges running one weekly
assessment each is ~80 exam-days a month — **over the plan**, on reads, before any growth in exam
length or roster size. Getting this number down is the same work as making the platform cheaper per
college, and it is worth doing before the twentieth college, not after.

## 31. Turso 0.7.0 — interesting, not actionable for Proview

The 0.7.0 release is the **standalone Turso Database** (the Rust rewrite of SQLite), not the hosted
Turso Cloud API that Proview talks to over HTTP through `@libsql/client`. Highlights: MVCC
concurrent writes substantially faster, no blocking I/O in the core, cooperative CPU yielding so one
busy statement cannot starve other connections, fallible allocation instead of aborting on OOM,
experimental passive checkpoints, window functions, PostgreSQL-style sequences, and a
SQLite-compatible .NET provider. They have **dropped the beta warning** but are explicit that this
is **not 1.0** and that independent backups are still recommended.

**Why it changes nothing for Proview today:** every number above says the constraint is **reads**,
not write concurrency. Writes are 5 % of quota, and the 300-student load run measured submit at
p95 4 ms. `BEGIN CONCURRENT` and MVCC solve single-writer contention, which is a real ceiling for
Proview eventually (§ backlog) but is demonstrably not what hurt on Aug 14 or Aug 27. Migrating the
engine now would be replacing a component that is not the bottleneck, on a database holding exam
records, against software its own authors decline to call 1.0.

**Revisit when** Turso Cloud exposes concurrent writes on the managed path — the release notes say
the engine is being integrated into Cloud and that concurrent writes can now sync to Cloud. At that
point it arrives as a Cloud feature rather than a migration, which is the version worth taking.

**One thing worth acting on from that page:** they recommend keeping independent backups. Developer
includes 10-day point-in-time restore, which covers accidental damage but not account-level loss.
For a system of record for exam results, an independent periodic export is cheap insurance — and
right now there isn't one. [from code]

## 32. P0 shipped: `attempts_status_idx`

Commit `081f855`, deployed and verified on production 2026-08-30 05:49 UTC.

**What changed.** One line in `schema.ts` and one spec in `REQUIRED_PERF_INDEXES`:

    index("attempts_status_idx").on(t.status)

Both are needed, and for different reasons. `schema.ts` is the declaration any future
`db:push` or fresh environment reads. `REQUIRED_PERF_INDEXES` is what actually creates it in
production, because there is no migrate step in the deploy path (`start` is just
`bun src/server.ts`) and `drizzle/` is a stale snapshot whose regeneration emits table DROPs.
Same mechanism that created `grade_jobs` at boot in `57a658f`.

**Why this was P0 and not housekeeping.** Restating §29's number because it is the whole
argument: `sweepAutoSubmit` scans every attempt ever taken, once a minute, forever. The cost
grows with **history**, not with load, so it gets worse on quiet months too.

| attempts stored | rows read/month by that one timer | vs 2.5 B Developer quota |
|---|---|---|
| 2,520 (today) | 109 M | 4 % |
| **57,870** | **2.5 B** | **100 %** |
| 1,000,000 | 43 B | 1,700 % |

[arithmetic] At ~58,000 stored attempts a single background query consumes the entire monthly
allowance, for a query that returns zero rows more than 99 % of the time. Twenty colleges on
weekly assessments reach that in roughly eight months. An index seek stays flat as history grows;
a scan does not.

**What was verified, and how.**

Local, `EXPLAIN QUERY PLAN` against a seeded database [measured]:

    BEFORE  status='in_progress'  -> SCAN attempts
    BEFORE  status='submitted'    -> SCAN attempts
    AFTER   status='in_progress'  -> SEARCH attempts USING INDEX attempts_status_idx (status=?)
    AFTER   status='submitted'    -> SEARCH attempts USING INDEX attempts_status_idx (status=?)
    NOT INDEXED vs indexed: identical row sets

New `src/api/database/perf-indexes.test.ts`, 9 tests, pins both halves — that the spec stays in
`REQUIRED_PERF_INDEXES` on `attempts(status)`, and that the planner actually *uses* it for both
sweep filters. A declared index the planner refuses is worth nothing, so the plan assertion is
the one that matters. `bun test` 288 → **297 pass**, typecheck and `bun run build` green.
[measured]

Production, `GET /api/admin/invariants` after the deploy [measured]:

    attempts_status_idx  table: attempts  columns: [status]  present: true
    ok: true

`invariants.checkedAt` advanced `04:46:19Z` → `05:49:42Z`, which is what confirms the running
process re-ran the check rather than the response being cached.

**Nothing else changed.** No query text, no response shape, no behaviour. `CREATE INDEX IF NOT
EXISTS` on a non-unique index cannot fail on existing data the way a unique one can, so there
was no duplicate pre-check to pass and no failure mode at boot beyond "index absent, still
works, just slow".

**What was deliberately left out.** §29's own point 2 proposed guarding the sweep — read `exams`
first and skip the attempts query when nothing is in window. Dropped, and the reasoning is worth
keeping: with the index the query is an index seek returning ~0 rows, so the guard saves
nothing measurable, and `effectiveEndMs` (`src/api/lib/util.ts:52`) folds in per-attempt
`pausedMs`, which is unbounded. No exam-level time bound is provably safe — a paused attempt can
outlive any window derived from the exam row. That is correctness risk traded for zero gain, on
the auto-submit path, where the failure mode is a student's paper never being submitted.

**The prediction to check on the dashboard.** Two changes now act on the idle baseline: the
grading sweep moving to a 10-minute tick (`57a658f`, yesterday) and this index (today). The
~5–6 M rows read/day baseline should fall to a small fraction of that — the timers were the
baseline, and neither now scans. The read chart from Aug 31 onward either shows that or this
analysis is wrong. [unverified until the chart is read]

**Still open, both waiting on a decision rather than on work:**

- **P1** — heartbeat coalescing, the `/api/reports` N+1, and `integrity_events` retention. The
  retention part *deletes proctoring evidence*, so the window is a policy call: how long must a
  malpractice finding stay disputable? 27,153 rows came from one exam and nothing deletes them.
- **P2** — per-tenant quotas. `settings` is a single row `id = "global"` holding `judge0Limit`,
  `judge0Used`, `aiLimit`, `aiUsed`; `tenants` has no limit columns at all, so one college's
  coding exam can exhaust the allowance for every other college [from code]. This one changes
  behaviour by design — a tenant over its cap gets blocked. The only safe shape is every tenant
  defaulting to inherit-global/unlimited, so nothing changes until a number is deliberately set.
