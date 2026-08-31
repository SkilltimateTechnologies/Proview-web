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

---

## 33. Shipped: AI grading no longer starts at the bell (`2893cff`)

**The ask, stated plainly.** Nobody complained about an exam. The request was capacity headroom:
*"as students submit, grading starts, more load on db and overall system... maybe give a notice
check after 2 hours for results, after exam closes we can grade."* So this section is not incident
repair, and nothing below should be read as fixing a reported failure.

**What was actually happening** [from code]. `finalizeAttempt` ended with two lines:

    await recordGradeJob(aid, attempt.examId);   // delayMs = 0
    queueAttemptGrading(aid, provider);           // an AI pass, right now

Objective questions are graded inline at submit (`autoGrade`, pure CPU, no network) — cheap, and
unchanged. But any paper containing a subjective or coding question started an **AI pass plus
Judge0 calls from the web process while the rest of the cohort was still writing**, funnelled
through the 12-slot semaphore, competing with live autosaves and heartbeats for the same database.

To be precise, and correcting a claim made earlier in this document: AI grading was already off
the request path — the student's submit did not wait for it. What was wrong was purely the
*timing*. The work started at the worst possible moment and there was no reason for it to, because
**the marks are not shown at submit anyway** — the student has always seen a "grading in progress"
screen.

**The change.** One pure function decides a release time, and the existing durable queue does the
rest:

    releaseAt = exam end + extraMin + holdMs + (hold still running) + GRADE_RELEASE_LAG_MS (5 min)
    delayMs   = max(0, releaseAt - now)

`gradeReleaseDelayMs` returns **0 — grade now, exactly today's behaviour** — for every case where
waiting makes no sense: an exam set to `immediate`, an exam with no end time (an open practice
paper, where "after close" never arrives), an unparseable date, a window that has already closed
(a late or auto-submitted paper), or an exam row that could not be read. The lag is not
decoration: the 60s auto-submit sweep needs its grace window to force-submit students who lost
their connection through the cutoff, and grading them in the same batch as the on-time submitters
keeps it to one batch instead of two.

**Why this was a small change.** `recordGradeJob(attemptId, examId, delayMs = 0)` already threaded
a delay into `enqueueGradeJob`, and the worker's claim query is already
`status='pending' AND next_run_at <= now` backed by `grade_jobs_status_next_idx` (`57a658f`). No
new table, no new timer, no new failure mode — only a number that used to always be zero.

**The trap that would have silently undone it.** `sweepPendingGrading` re-enqueues submitted
attempts every 10 minutes as a reconcile backstop, and it called `recordGradeJob` with no delay.
Left alone it would have reset every deferred job to *due now* within ten minutes, and the whole
change would have measured as doing nothing. It now applies the same release time, using one
batched `inArray` read for the distinct exams involved.

**Escape hatch.** `exams.grading_mode` — `NULL`/`after_close` defers, `immediate` grades at
submit. Nullable by necessity: `ensureRequiredColumns` adds columns with `ALTER TABLE ADD COLUMN`,
which cannot be `NOT NULL`, so every pre-existing exam reads back `NULL` — which is why `NULL`
*must* mean defer. Registered in `REQUIRED_COLUMNS`, not in a migration, for the reason in §21:
there is no migrate step in the deploy path, and Drizzle names every column in its SELECT list, so
a missing column breaks **every** exams query.

**Fail-soft, deliberately.** An unreadable exam row or an unavailable `grade_jobs` table both fall
back to grading in-process immediately — worse for load, but a paper nobody ever grades is worse
than a badly-timed one.

**MCQ-only papers are untouched.** No pending AI work means the branch is never entered: straight
to `graded`, instant results as before, and they do not even pay the extra exam read.

**The student-side load bug this created, and the fix.** `exam-runner.tsx` polls
`/student/exams/:id/status` after submit — 1.5s, then every 2.5s, up to 40 times — waiting for
`status === 'graded'`. With grading held for an hour, **every submitted student would have polled
the full 40 times and never seen it**: ~40 wasted status reads per student across the cohort,
precisely the load this change exists to remove. The poll is now 60s × 15 when the submit response
carries a future `gradeAt`. It is deliberately *not* switched off — the same poll detects an admin
**RESET** and bounces the student back into their exam with saved answers intact, and that had to
keep working. Copy changed from "your score will be updated soon" to evaluation beginning after
the exam closes, with a result **within 2 hours**.

**Does 2 hours hold?** [arithmetic] 300 papers × ~20 subjective answers = ~6,000 AI calls, at 12
concurrent × ~5s each ≈ **40 minutes**. Headroom, and the promise is a ceiling rather than a
target.

**Verified** [measured]: 16 new tests in `src/api/lib/grade-release.test.ts` pin the arithmetic and
every grade-now escape hatch (`bun test` 297 → **313 pass**), typecheck and `bun run build` green.
On production after deploy, `invariants.checkedAt` advanced `05:49:42Z` → `06:30:11Z` and
`GET /api/admin/invariants` reports `exams.grading_mode  type: text  present: true`, `ok: true`.

**What is still unverified.** No real exam has run under this yet. The first one is the test, and
the thing to watch is the Turso write/read curve during the exam window versus the hour after it:
the shape should change from one broad hump into a quiet exam followed by a distinct batch. If the
grading batch does not appear after the close, or attempts sit `submitted` past the release time,
suspect the reconcile path first.

---

## 34. A student with no proctoring evidence, and the hole that hid him (`5ae12ba`)

**The question.** *"Bonkuri Raju has no screenshots, why?"*

**The student** [measured, `/api/reports/:examId/attempt/:attemptId`]: `stu_55bd530dee754fec`, roll
`24K95A6602`, section CSM-A. Four attempts, all `graded`, all with **zero** snapshots:

| Exam | snapshots | integrity events |
|---|---|---|
| Weekly Assessment – 2 (Aug 27) | 0 | 2 (`paste_in_answer`, `copy_in_answer`) |
| Weekly Assessment – 1 (Aug 14) | 0 | 1 (`copy`) |
| Python DSA Screening B3 (Jul 23) | 0 | 0 |
| Grand Test – 1 B3 (Jul 8) | 0 | 0 |

**He is the only one** [measured]. 61 attempts sampled from Weekly-2: 60 have frames (median 120,
min 72, max 181). His own CSM-A classmates sat 105–177 frames each.

**It was not the exam and not storage.** Proctoring is a **single global JSON blob** on the
settings row (`schema.ts`, `ProctorConfig`) — there is no per-exam or per-student proctoring column
[from code], so the 60 students who did get frames were running the identical config:
`requireWebcam: true`, `webcamSnapshots: true`, `snapshotIntervalSec: 27` [measured,
`GET /api/settings`]. And his uplink was fine: his `paste_in_answer`/`copy_in_answer` rows reached
the server on the **same flush path** that carries snapshot keys.

**The tell** [from code + measured]. He has **zero camera events of any kind** across four exams —
no `camera_lost`, no `camera_blocked`, no `camera_obstructed`, no `camera_restored`, not even
`preflight_snapshot`. That is decisive, because `captureFrame` returns luminance **metrics even
when the upload fails**: a live-but-covered lens would still have produced `camera_obstructed`.
Nothing at all means there was never a decodable webcam stream on his machine — `grabFrame` bailed
at `captureFrame(webcamRef.current)` on every one of ~200 ticks per exam, for four exams over two
months.

**The real finding is not about him.** The platform recorded nothing and alerted nobody.
`capturePeriodic` pushed its event **only `if (photoKey)`** [from code], so *"camera dead for the
whole exam"* and *"camera fine"* were **byte-identical in the database**. `requireWebcam: true` did
not stop him starting or finishing. He scored 95 with zero proctoring evidence, and the only reason
anyone knows is that someone opened his review page and noticed an empty gallery.

Two questions the data still cannot answer: **which device** he sat on, and whether he knew.

### The fix

**1. `snapshot_failed` — a dead camera now leaves a trail.** `grabFrame` returns *why* it produced
nothing (`no_frame`, `capture_error`, `upload_failed`, vs the non-faults `snapshots_off`,
`no_attempt`, `offline`), and `capturePeriodic` records the camera-side ones, throttled to **one row
every 5 minutes** via the existing `minGapMs` idiom that `focus_loss` uses. ~18 rows across a
90-minute exam instead of one per 27s tick.

It is added to **`NON_VIOLATION_TYPES`**, and that is not a detail: a broken webcam is a device
fault the student may not even be able to see. Left scoring, it would have marked a faulty laptop as
misconduct and — at 18 rows an exam — swamped every real violation on the timeline. Same reasoning
that demoted `focus_loss` in §9.

**2. The roster shows who has no evidence.** `GET /reports/:examId` now returns `frames` and
`snapshotFailures` per attempt, and the report table renders a red **"No camera"** badge for any
real attempt with zero frames. The discovery that took two months and a lucky click now costs
nobody a click.

Two things it deliberately does *not* do:

- **It is not an N+1.** A count per row is ~200 round trips on a full cohort. It is **one grouped
  aggregate** over `integrity_events` (`attempt_id`, `type`), chunked at 200 ids only to stay under
  SQLite's bound-variable cap, riding `integrity_attempt_type_idx`.
- **It does not fire when snapshots are off.** With `webcamSnapshots: false` every attempt
  legitimately has zero frames, so the response carries `snapshotsExpected` and the badge is gated
  on it. The client defaults it to `true`, so an older bundle cannot hide a real failure.

**3. `attempts.user_agent`.** Stamped once at `/start` from the request header, truncated to 300
chars, **never overwritten** — the first device that opened the paper is the useful fact. Proctoring
is a *client* capability, so when a webcam or fullscreen check silently never worked, this string is
the only thing that can answer "what was it running on?". Diagnostic only: never used for scoring or
eligibility.

Declared in `schema.ts` **and** in `REQUIRED_COLUMNS` (`invariants.ts`), nullable — `ALTER TABLE ADD
COLUMN` cannot add NOT NULL, and there is no migrate step in the deploy path. Same mechanism as
`exams.grading_mode` in §33.

**Verified** [measured]: `bun run typecheck:api` clean; `bun test` **313 pass, 0 fail** (the schema
column broke 5 `grade-jobs` tests that build their own `attempts` DDL by hand — that DDL now mirrors
the column, which is exactly the tripwire it exists to be); `bun run build` green.

**What this does not fix** [unverified]. It cannot recover Bonkuri Raju's four exams — that evidence
was never captured and no change can create it. And it is detection, not prevention: a student whose
camera never works still starts, still submits, still scores. Blocking them outright is a policy
decision, not an engineering one, and nobody has asked for it. What changes is that the next such
student is visible on the roster the same day instead of two months later.

---

## 35. Heartbeats: 67 writes a second become one every five (`4707fb5`)

**Not a complaint — headroom.** Nobody reported anything. This is the P1 item queued behind the
deferred-grading work in §33, and it removes the single largest write source on the platform.

### What it cost

`POST /student/heartbeat/:examId` [from code]. Every running client pings it every ~15s so the Live
Monitor can show an online/offline dot. At 1000 concurrent students that is **~67 requests a
second**, and each one was a **write**:

```sql
UPDATE attempts SET last_seen_at = ? WHERE exam_id = ? AND student_id = ?
```

The endpoint was already well optimised for *round trips* — §7 took it from three to one (exam row
from a 3s coalesced cache, `UPDATE … RETURNING` doubling as the attempt read). What was left wrong
was not the count but the **kind**. Writes are the scarce resource twice over:

- **Quota** [measured]: the Developer plan allows **25M writes/month** against **2.5B reads** — reads
  have literally 100x the headroom. A 90-minute exam with 1000 students is ~360,000 heartbeat writes
  on its own, i.e. **1.4% of the monthly write budget for one exam**, spent entirely on a dot.
- **Serialization** [from code, Turso/SQLite model]: there is a single writer. Every heartbeat write
  queued behind every submit, every autosave and every grading write happening at the same moment —
  the exact resource a submit storm is already contending for.

### Why presence is the right thing to make cheap

`last_seen_at` is **presence, not evidence**. It is overwritten four times a minute per student, it
is never read historically, and the worst consequence of losing a few seconds of it is a dot in the
monitor turning grey slightly late. Compare that with an integrity event or an answer, where losing
seconds is losing data. That asymmetry is the whole justification: this is the one high-volume write
on the platform that can safely become eventually-consistent.

### The change

The route now does a **narrow SELECT** (`id`, `startedAt`, `pausedMs` — the row `effectiveEndMs`
needs anyway) and hands the timestamp to an in-process coalescing map. **Still exactly one round
trip, now a read.** A flusher folds every student's pending ping into ONE batched `UPDATE` every 5s:

**67 writes/s → ~0.2 writes/s.** [arithmetic] The same 1000-student, 90-minute exam goes from
~360,000 writes to **~1,080** — a 99.7% reduction — because the cost stops scaling with student
count and starts scaling with the clock.

`src/api/lib/heartbeat-queue.ts`, pure and dependency-injected (never the `db` singleton, so tests
drive the real SQL against in-memory libSQL):

```sql
UPDATE attempts
   SET last_seen_at = max(coalesce(last_seen_at, 0), CASE id WHEN … THEN … END)
 WHERE id IN (…)                                   -- chunked at 200 ids
```

Three things in that statement are load-bearing:

1. **The `max(coalesce(…))` guard.** Other paths still write `last_seen_at` directly and must keep
   doing so — autosave writes it alongside `answeredCount` (it needs the write anyway), and `/start`,
   resume and pause stamp it. A pending heartbeat is by definition *older* than a write that happened
   after it, so the flush may only move presence **forward, never backwards**. Without this, a flush
   landing 3s after an autosave would drag `last_seen_at` back and make an active student look idle.
2. **The `CASE`, not one statement per row.** 1000 students would otherwise be 1000 statements —
   trading a write storm for a round-trip storm. Chunked at 200 ids (~600 bound parameters) to stay
   under SQLite's cap.
3. **Failure re-merges.** A chunk that throws goes **back into the map**, so a transient socket error
   costs one tick of latency instead of a monitor that lies for the rest of the exam.

### Two decisions that are not obvious

**5s, not the 10s that was approved.** The staleness budget is what decides this. Worst case in the
database = heartbeat interval (15s) + flush period (5s) = **20s**, or **25s** if one flush fails and
lands on the next tick. The Live Monitor calls an attempt online within **40s**. At 5s both cases sit
comfortably inside that window, so **the 40s threshold did not have to change** — no semantics were
touched. At 10s the worst case is 25s (35s after a retry), which crowds 40s closely enough that
healthy students would eventually be shown offline, and the fix would have been widening the monitor.
Halving the period to avoid changing a threshold is the cheaper trade: it costs one extra write per
5s, total.

**The monitor overlays the pending map.** `buildMonitorSnapshot` reads `peekSeen(attemptId)` and takes
the max against the row it read. Served from the same process, the dot now has **zero** staleness —
strictly *more* accurate than before this change, not less. And it degrades gracefully: on split
replicas the overlay is partial and the answer falls back to the database's ≤20s-stale value, still
inside 40s.

**The flusher starts OUTSIDE the `ROLE` gate** in `src/server.ts` — deliberately, unlike
`startGradeQueue()` and `startAutoSubmitSweep()`. Heartbeats land on whichever process serves student
traffic and the map lives *in that process*, so a `ROLE=web` replica that skipped the flusher would
accumulate presence and never write it. This is not background work; it is the second half of an
endpoint. Unref'd, plus a best-effort final flush on `SIGTERM`/`SIGINT` so a deploy does not drop a
window.

### Verified

[measured] `bun run typecheck:api` clean · `bun test` **329 pass, 0 fail** (313 baseline + 16 new) ·
`bun run build` green · pushed `85a12db..4707fb5` · production `invariants.checkedAt` advanced to
**`2026-08-30T08:13:13.489Z`** with `ok: true`.

The 16 tests target the two ways this could fail while still returning 200 to every client: the
`CASE` writing one student's timestamp onto another student's attempt (every row asserted, not just
one), and the monotonic guard (a row with a fresher direct write must be left alone while its
neighbour moves forward). Plus the NULL branch, chunk boundaries, an id whose attempt row no longer
exists, and both re-merge paths — including a heartbeat that arrives *during* a failed flush, which
must still win.

### What this does not do [unverified]

No real exam has run under it. The falsifiable prediction: on the next exam the Turso **write** curve
should drop by roughly the heartbeat share — with §33 also deferring grading out of the exam window,
the exam-hour write rate should be dominated by autosaves and submits alone. If write volume during
the next exam looks like Aug 27's, the attribution here was wrong and I will say so.

It also does not touch the **read** side of polling, which §31 identified as the larger absolute
number (~190,000 rows per student on Aug 27). That is the rest of P1: the `/api/reports` per-exam
N+1, the `integrity_events` read cost (read cost only — the rows are kept forever, by decision), and
the redundant attempt re-reads on `/events` and `/snapshot-url`.

---

## 36. Reports list: every attempt row of every exam, on every page open (`e9ac941`)

### The shape of it [from code]

`GET /reports` renders one card per conducted exam — attempts, finished, in progress, graded, passed,
failed, average. It produced those seven integers like this (`src/api/index.ts` L2941):

```ts
const withStats = await Promise.all(rows.map(async (e) => {
  const atts = await db.select().from(schema.attempts).where(eq(schema.attempts.examId, e.id));
  … count in JS …
}));
```

A remote round trip per exam, each one selecting **every column of every attempt row** of that exam.
At 11 conducted exams and 2,520 stored attempts, opening the reports page transfers **every attempt
ever taken on the platform** across the network so that JavaScript can count them.

Two things make this worse than it first looks:

1. **It scales with exam HISTORY, not with load.** Nothing about it improves when the system is quiet.
   Every exam ever conducted adds a round trip and its attempts add rows, forever. This is the same
   family of bug as §32's missing `attempts_status_idx`: cost that grows on the calendar rather than
   on traffic, which is exactly the kind that never shows up in a load test.
2. **An admin page people refresh.** Reports is where TPOs sit after an exam. It is not a once-a-day
   cron; it is the tab someone reloads while waiting for results.

### The fix

One grouped aggregate, riding `attempts_exam_idx`, chunked at 200 exam ids:

```sql
SELECT exam_id,
       count(*),
       sum(CASE WHEN status IN ('submitted','graded') THEN 1 ELSE 0 END),   -- finished
       sum(CASE WHEN status = 'in_progress'           THEN 1 ELSE 0 END),   -- inProgress
       sum(CASE WHEN score IS NOT NULL                THEN 1 ELSE 0 END),  -- graded
       sum(CASE WHEN score >= 40                      THEN 1 ELSE 0 END),  -- passed
       sum(CASE WHEN score IS NOT NULL AND score < 40 THEN 1 ELSE 0 END),  -- failed
       sum(CASE WHEN score IS NOT NULL THEN score ELSE 0 END)              -- scoreSum
  FROM attempts WHERE exam_id IN (…) GROUP BY exam_id
```

`src/api/lib/report-rollup.ts` owns it, dependency-injected (never the `db` singleton), so tests drive
the real SQL against in-memory libSQL. The route's remaining work is now synchronous.

**`absent` deliberately stayed in the route.** It is `assigned - finished - inProgress`, gated on the
deadline having passed — it needs the roster and the exam window, not the attempt table, and folding
it into this module would have coupled two unrelated things.

### The definitions are the risky part

The counters are not what you would guess from the status column, and the difference is not cosmetic:

- **`graded`, `passed` and `failed` key off `score IS NOT NULL`, not off status.** A terminally-failed
  grading run leaves an attempt at status `graded` with a **null score** (§20's soft-fail rule keeps
  today's student-visible outcome). Counting those as failures would silently move the pass rate.
- `passed + failed == graded` **exactly**, because `NULL >= 40` is NULL in SQL and falls to the ELSE
  branch — the same reason `passed` needs no null test and `failed` does.
- `avg` is the mean over **graded only**, one decimal, and **`0` when none** — never `NaN` from a 0/0.
- `finished` = `submitted` OR `graded`. `wrote` is still returned, equal to `finished`, for compat.

### Why the old JavaScript is still in the repo

`rollupFromAttempts` — the original per-exam counting, preserved verbatim — is kept as a **test
oracle** and is not on the request path.

That is the whole verification strategy, because the failure mode here is silent and unfalsifiable by
eye: a card reading *190 attempts, 41% pass, average 62* is completely believable whether or not the
SQL is right, and nobody reconciles a dashboard against the database by hand. So the 9 tests in
`report-rollup.test.ts` assert the SQL and the oracle agree, exam by exam, over production-shaped
data: mixed statuses, ungraded attempts, scores exactly **on** the pass mark, a `graded` row with a
null score, exam isolation, duplicate ids, chunk boundaries, and an `EXPLAIN QUERY PLAN` check that
the aggregate rides `attempts_exam_idx` rather than scanning `attempts`.

### Verified [measured]

`bun run typecheck:api` clean · `bun test` **338 pass, 0 fail across 18 files** (329 baseline + 9 new)
· `bun run build` green · pushed `4707fb5..e9ac941` · production `invariants.checkedAt` advanced to
**`2026-08-30T08:24:15.699Z`** with `ok: true`.

Measured on production against the live 11-exam / 2,520-attempt tenant, by diffing the `db.queries`
counter on `/api/health` across 5 sequential calls (idle background noise measured separately at
~0.2 statements/s and subtracted):

| | statements per `/api/reports` call |
|---|---|
| before | **16.6** |
| after | **~6.4** |

**The prediction was ~4, so it was wrong** — I said the count would fall to about four and it landed
near six and a half. The 11 per-exam attempt queries are gone as expected; what I under-counted was
the fixed remainder the route pays regardless: the session/auth lookups, the tenant read, the
`exams` select and the `exam_roster` `inArray`. That fixed part is now the whole cost.

The number that matters more than the ratio: **statements per call no longer grows with the number of
exams.** Before, conducting an exam permanently added a round trip to every future page open. Now one
statement covers up to 200 exams, and the rows leaving the database went from every attempt ever
taken (2,520 rows × 18 columns) to **one row per exam card**.

Wall-clock from this sandbox was ~660ms per call, of which ~479ms is network round trip to Railway —
so only the relative server cost is meaningful, and a single-digit statement change is below the
noise floor of a timing measured from here. The statement count is the honest metric; the latency
number is not.

### Still open in P1

Next: the **`integrity_events` read cost** (read cost only — the rows are kept forever, by decision),
then the **redundant attempt re-reads on `/events` and `/snapshot-url`**, both of which re-`select()`
the entire attempt row purely to authorize the caller. Then P2: per-tenant quotas, every tenant
defaulting to inherit-global so nothing changes until a number is deliberately set.

## 37. The Live Monitor re-read every proctoring event ever recorded, every 3 seconds (`5011f3a`)

### The shape of it [from code]

The Live Monitor shows, per student, a violation count and the newest webcam thumbnail.
`buildMonitorSnapshot` (`src/api/index.ts` L288) produced both with two grouped statements per live
exam:

```sql
SELECT attempt_id, COUNT(*) … JOIN attempts … WHERE exam_id = ? AND type NOT IN (…) GROUP BY attempt_id
SELECT … ROW_NUMBER() OVER (PARTITION BY attempt_id ORDER BY at DESC, rowid DESC) … WHERE photo_url IS NOT NULL
```

Those are already the *fixed* version — an earlier pass in this program replaced code that shipped
every row to JavaScript, and the comment above them still says so. Grouping was the right fix for the
freeze. It did nothing about the volume: both statements still **touch every `integrity_events` row
of every engaged attempt, on every build**.

Three facts multiply together:

1. A webcam snapshot lands roughly **every 27s per student**, and the rows are kept forever by
   decision. One conducted exam therefore holds tens of thousands of events — "Elite Assessment – 1"
   holds **27,153**.
2. The monitor rebuilds at most every **3s** (`MONITOR_CACHE_MS = 3000`, L490) for as long as any
   admin has the page open.
3. So the cost grows with **exam duration × watch time**. This is the worst available shape: the
   longer someone watches, the more each look costs, and the second half of every exam is more
   expensive per poll than the first. Nothing about it is visible in a short load test.

The photo query was the worse of the two. `photo_url IS NOT NULL` matches no index, so SQLite reads
full rows — each carrying a ~60-byte object key — and then sorts them.

[arithmetic] At ~54k rows visited per build (two passes over ~27k rows) and 20 builds a minute, one
watched exam costs roughly **65M rows/hour**. A 90-minute watched exam is about **4% of the entire
2.5B monthly read allowance** from the Live Monitor alone, for a page showing a few hundred numbers.

### The fix: read each event row once, ever

Evidence is **monotonic** — a violation never un-happens, a snapshot never un-arrives. So the
aggregate can be carried forward and each build needs only the rows that appeared since the last one.
`integrity_events` is a rowid table and rowids are assigned increasing, so `rowid` is a natural
insert watermark:

```
build 1:  full aggregate, rowid <= W    → cursor = W
build 2:  only rowid in (W, W']         → cursor = W'
```

At 200 students flushing every 10s, a 3s tail is **~60 rows instead of ~27,000**. `src/api/lib/integrity-rollup.ts`
owns it, dependency-injected like `report-rollup.ts`, so tests drive the real SQL against in-memory libSQL.

### The four decisions that make it correct rather than merely fast

**1. The watermark lives in the database, not in an in-process counter.** Integrity events are written
by the student POST path, which may be a *different process* from the one serving the monitor. Reading
the tail out of the DB keeps the aggregate **exact across processes** — anything any process inserted
is in the tail. A counter fed by the writer would silently under-report during a split deploy, and
under-reporting violations is the one error direction that matters here.

This is deliberately **different from §35's heartbeat overlay**, which does accept single-process
degradation. That is defensible because a stale heartbeat only affects a dot; a missed violation
affects an accusation.

**2. `max(rowid)` is pinned BEFORE aggregating**, and both the full and tail queries are bounded by
`rowid <= watermark`. A row inserted while those statements run is *above* the watermark, so it is
picked up by the next tail read — never dropped, never counted twice.

**3. The cursor advances to the global `max(rowid)`, not to this exam's maximum.** If it tracked only
this exam's rows, a second live exam's writes would sit permanently above the cursor and the tail
would grow without bound — precisely when the monitor is under the most load. There is a test that
writes 500 rows for another exam and asserts the cursor still lands on the global max.

**4. Deletes are the one direction a watermark cannot follow.** SQLite reuses rowids below the maximum
once the top row is deleted, so a reused rowid could land *under* the cursor and never be read. Two
mitigations, belt and braces:

- All **six** admin paths that delete integrity events call `integrityRollup.invalidateAll()` —
  student delete, roster removal (×2), mark-absent, bulk remove, reset.
- `FULL_REBUILD_MS = 10min` forces a from-scratch rebuild regardless, so any drift is bounded and
  self-healing even if a seventh delete path is added later and someone forgets the call.

Semantics are unchanged: the `atMs >= lastAtMs` tie-break reproduces the old
`ORDER BY at DESC, rowid DESC` exactly (later insert wins ties), and non-violation types — timed
frames, `snapshot_failed`, `focus_loss`, `camera_restored` — still **feed the thumbnail without
counting as misconduct**. §34's rule that a device fault must never score a student survives intact.

### Verification

The failure mode is silent: a monitor row reading *"7 violations"* is equally believable whether the
carried aggregate is right or has been double-counting since the exam started. By the end of a
90-minute exam a double count would read as 400 violations, which is obvious — but a count that
double-counted only occasionally would not be. So 11 tests fold every row in JS with `applyEvents`
as an **oracle** and demand the SQL agree: a full build vs. the fold, evidence-only types excluded,
exam isolation and `not_started` exclusion, **20 consecutive polls with no new rows changing nothing**,
10 flush/poll ticks each matching the oracle, a late-arriving event with an older `at` not replacing a
newer thumbnail, an attempt starting mid-exam, the cursor skipping another exam's 500 rows, delete
drift **documented as not healed until invalidation** and then healed by `invalidateAll()`, the
automatic rebuild at `FULL_REBUILD_MS`, and idle-exam pruning.

One test assertion was wrong when first written and the code was right: an attempt whose only event is
a photo-less `snapshot_failed` keeps `lastAtMs: 0`, because `lastAtMs` tracks the newest *thumbnail*,
not the newest event. The oracle comparison in the same test passed, which is what caught it.

**Shipped [measured]:** `bun run typecheck:api` clean · `bun test` **349 pass, 0 fail across 19 files**
(338 baseline + 11 new) · `bun run build` green · pushed `e9ac941..5011f3a` · production
`invariants.checkedAt` advanced `2026-08-30T08:24:15.699Z` → **`2026-08-30T16:54:26.065Z`**, `ok: true`.

### Measured locally, on a realistic exam [measured]

Both paths run against the same seeded in-memory database — **200 engaged attempts, 41,000
`integrity_events`**, one snapshot per student per 27s over 90 minutes plus real violations — with the
old statements copied verbatim out of `e9ac941`:

| per monitor build | median | rows the DB visits |
|---|---|---|
| old full aggregate | **63.8ms** | ~83,200 (count pass + photo pass) |
| new incremental tail | **2.3ms** | **~60** |

**28× faster, and ~1,400× fewer rows visited.** Exactness held: the carried aggregate matched a
from-scratch build across all 200 attempts with **0 mismatches**.

**The caveat, stated plainly:** this is in-memory SQLite in the sandbox with no network. It measures
CPU and row-visiting only. It is *not* a production latency claim. The real-world gap should be wider
rather than narrower, because Turso bills **rows read** and adds a network round trip per statement —
but that is a prediction, not a measurement.

### The falsifiable prediction [unverified]

**No live exam has exercised this yet.** All 11 exams on production are `finished`, so the rollup was
not invoked once during deploy verification; a live exam with an admin watching is the only real test.

The prediction: monitor-driven `integrity_events` reads become **nearly flat in exam duration**.
Concretely, on the next watched exam the Turso read curve should no longer ramp upward through the
exam window the way it does today — a poll in the last five minutes should cost the same as a poll in
the first five. If the curve still climbs with the clock, the attribution is wrong and I will say so,
the same way §36's ~4-statements prediction was wrong and got corrected in place.

### Still open in P1

Next: the **redundant attempt re-reads on `/events` and `/snapshot-url`** (~L2010 and ~L2026), both of
which re-`select()` the entire attempt row purely to authorize the caller — on the student write path,
which is the scarce one. Then P2: per-tenant quotas, every tenant defaulting to inherit-global so
nothing changes until a number is deliberately set.

---

## 38. Two proctoring routes re-read the whole attempt row to answer a boolean (`ea98c5e`)

### The shape of it [from code]

`POST /student/attempts/:attemptId/events` and `POST /student/attempts/:attemptId/snapshot-url`
(`src/api/index.ts`, ~L1991 and ~L2008) both opened with the same six lines:

```ts
const [attempt] = await db.select().from(schema.attempts)
  .where(and(eq(schema.attempts.id, aid), eq(schema.attempts.studentId, sid))).limit(1);
if (!attempt) return c.json({ message: "Not found" }, 404);
```

…and then never touched `attempt` again. I checked both bodies line by line: `/events` passes only
`aid` to `persistIntegrityEvents`, which runs its own queries; `/snapshot-url` only builds
`INTEGRITY_PREFIX(aid)` for the object key. Neither reads a single column off the row.

Two things make that more than a style complaint:

1. **There is no projection.** A bare `select()` returns every column, which on `attempts` includes
   `section_snapshot` and `option_order` — `text` columns holding the student's entire paper layout,
   the questions and the shuffled option order. The largest payload in the schema, fetched to decide
   one boolean.
2. **It is on the student write path**, the one path that must stay responsive while an exam is
   running and the one whose budget is genuinely scarce (25M writes/month against 2.5B reads). Every
   captured webcam frame costs **both** routes: one call to get the presigned URL, one to attach the
   event.

[arithmetic] A frame lands roughly every 27s per student, so at 1000 students that is
~**74 authorization-only SELECTs per second**. Across a 90-minute exam, ~**400,000** SELECTs whose
entire job is to re-derive a fact that never changes. After the fix, one lookup per attempt per
5-minute window ≈ **18,000** for the same exam — about **22× fewer**.

### The fix: cache the owner, because the mapping is immutable

`src/api/lib/attempt-owner.ts` holds `attemptId → studentId` in memory with a 5-minute TTL, and both
routes collapse to one line:

```ts
if (!(await attemptOwners.authorize(db, aid, sid))) return c.json({ message: "Not found" }, 404);
```

The justification is narrow and worth stating precisely, because caching an **authorization** decision
is normally a bad idea. I grepped every write path: `attempts.studentId` is written once at creation
and **never updated** — no route, no sweep, no admin path reassigns an existing attempt to a different
student. So this particular mapping cannot go stale the way permissions usually do. That is the whole
basis for the cache, and it is why attempt *status*, which changes constantly, is deliberately **not**
cached here even though it sits in the same row.

### Three decisions that make it safe rather than merely fast

**1. The cache stores the OWNER, not a yes/no per caller.** A request from the wrong student is
answered `false` out of the same cached entry instead of falling through to the database. If it cached
per-(attempt, student) outcomes, a client sending a wrong id — a bug, or a probe — would miss the cache
on every request and get a free round trip out of the server for each one. Tested: 50 wrong-student
calls cost **0** queries.

**2. Misses are NOT cached.** A request for an attempt that does not exist pays its SELECT and 404s
every time, exactly as before. Caching negatives would mean an attempt created a second after a failed
poll stays locked out for the rest of the TTL — a real student blocked from an exam. A repeated query
on a path only a broken or deleted client takes is the cheaper mistake by a wide margin. There is a
test that polls an unknown attempt, creates it, and asserts the very next call is admitted.

**3. Deletes are the one direction the cache cannot see** — the same asymmetry as §37, for the same
reason. A stale entry would keep authorizing a deleted attempt's former owner, and `/events` would
then insert `integrity_events` rows pointing at an attempt that no longer exists. Those rows are
invisible to every read path (both the monitor and the reports join `attempts`), but they are junk in
a table that is kept forever by decision. Bounded twice over:

- all **six** admin paths that delete attempts now call `attemptOwners.invalidateAll()`, immediately
  after the `integrityRollup.invalidateAll()` §37 added — so in practice the window is zero;
- the TTL expires entries anyway, so even a seventh delete path added later and wired up by nobody
  self-heals within five minutes.

`MAX_ENTRIES = 20_000` plus expiry pruning keeps a long-running process bounded.

### Verification

The failure mode here is the ugliest kind: a cache that authorizes the wrong student would be
invisible in every log and every chart. So the 12 tests in `attempt-owner.test.ts` assert the security
property first and the performance property second, using a `counted(db)` Proxy that increments on
every `select` so query counts are facts rather than inferences.

Security: the owner is allowed; **every other student is refused**; an empty `studentId` is refused; an
empty `attemptId` never reaches the database; a wrong-student refusal costs no query; an unknown
attempt is refused, is not remembered, and is admitted the instant it is created.

Cost: 400 polls of one attempt = **1** SELECT. 200 attempts polled 5 rounds each = **200** SELECTs,
not 1,000. A re-read happens at exactly `OWNER_TTL_MS`.

Correctness under deletes: one test deletes an attempt and **documents the drift as unhealed**, then
proves `invalidateAll()` heals it; a second proves the TTL alone heals it with no invalidation call at
all. Plus per-attempt `invalidate()`, expiry pruning, and a finite `MAX_ENTRIES`.

**Shipped [measured]:** 12/12 new tests pass · `bun test` **361 pass, 0 fail across 20 files**
(349 + 12) · `bun run typecheck:api` clean · `bun run build` green · pushed `5011f3a..ea98c5e` ·
production `invariants.checkedAt` advanced `2026-08-30T16:54:26.065Z` →
**`2026-08-30T17:28:28.424Z`**, `ok: true`, stable across three polls.

Code counts, to make the wiring checkable rather than trusted:

```
rg -c "attemptOwners.authorize"       src/api/index.ts   → 2   (both routes)
rg -c "attemptOwners.invalidateAll"   src/api/index.ts   → 6   (all delete paths)
rg -c "integrityRollup.invalidateAll" src/api/index.ts   → 6   (same six, §37)
```

### The falsifiable prediction [unverified]

**No live exam has exercised this either** — all 11 production exams are `finished`, so neither route
ran once during deploy verification. The 400,000-SELECT figure above is arithmetic from the capture
interval, not a measurement.

The prediction: on the next live exam, statements on the student proctoring path drop by roughly the
frame rate — per captured snapshot, the steady-state statement count falls from about **4 to about 2**.
The Turso read curve during the exam window should fall materially even though nothing else about the
student path changed.

I am flagging that shape of prediction specifically because I got it wrong once already: in §36 I
predicted ~4 statements per `/api/reports` call and production measured ~6.4. If the next exam's read
curve does not drop, the attribution here is wrong too, and I will say so in place rather than quietly
moving on.

### Still open

**P1 is now clear.** Next is **P2: per-tenant quotas** — a per-tenant ceiling on concurrent attempts
and stored evidence, with **every tenant defaulting to inherit-global/unlimited**, so nothing about
today's behaviour changes until a number is deliberately set for a specific tenant.

Still unanswered, raised three times now: **Proview has no independent backup.** The Turso Developer
plan gives 10-day point-in-time recovery, which covers a bad deploy and does not cover a deleted
database or an accidental roster reconcile. It is the one remaining item on this list that is not a
performance problem.

---

## 39. Nothing in this program had an upper bound: per-tenant capacity quotas (`441e222`)

### The gap this closes [from code]

Every section from §32 onward made the same work cheaper. §32 indexed the status scan, §33 moved
grading off the bell, §35 coalesced heartbeats, §36 collapsed the reports N+1, §37 stopped re-reading
every proctoring event, §38 stopped re-reading the attempt row to answer a boolean. All of it is
efficiency, and none of it is a **bound**.

Cheaper is not bounded. A single tenant scheduling a 5,000-student exam at 10am, or a client bug that
captures a webcam frame every 200ms instead of every 27s, still consumes the whole shared database
budget — and every other college's exam degrades with it, at a moment when nobody can pause and debug.
Efficiency changes the slope; a quota changes the ceiling.

Two numbers, because these are the two quantities that scale with **a tenant's** behaviour rather than
with the platform's:

| ceiling | bounds |
|---|---|
| `maxConcurrentAttempts` | attempts one tenant may have `in_progress` at once → the live read/write load |
| `maxEvidencePerAttempt` | non-violation proctoring rows stored per attempt → the table kept forever |

### The default is "nothing changes", and that shaped the whole design

Per the instruction this work was approved under: every tenant defaults to inherit-global, and the
global default is unlimited. Until somebody deliberately types a number, this module changes **zero
decisions**.

Resolution order is `tenant value → platform default → unlimited (null)`.

**0, negatives, NaN and junk all mean "not set" — never "block everything."** This is the single most
dangerous input in the module, so it is worth being explicit about the asymmetry. A cleared number
field posts `0` or `""`; a JSON `null` becomes `0` somewhere in a form round trip. If 0 were read as a
ceiling, the first cleared field would refuse **every student in a college** the moment their exam
opened. The cost of reading 0 as unlimited is a quota that silently does nothing; the cost of reading
it as a ceiling is a cancelled exam. There is already a deliberate, obvious way to stop a tenant:
`tenants.enabled = false`. So `resolveLimit(0, 500) === 500` — zero falls through to the next level,
and `resolveLimit(0, 0) === null`.

**The honest cost when nothing is configured.** Per request: **zero queries** — the callers skip every
check when the resolved limit is `null`, and the resolver never reads a tenant row when there is
neither a global default nor any override on record. But it is not literally free: there is one cached
`count(*)` over the `tenants` table (one row per college) **per minute per process** — the "has anyone
set an override?" question. An in-process flag would cost nothing and would silently ignore any quota
set by another replica or set before a restart. That trade was made deliberately in favour of the
query, and it is written into the module header. On error that check resolves to `true`: do the extra
tenant read rather than ignore a configured ceiling.

### What the ceilings deliberately do not do

- **The concurrency gate never touches a student who is already writing.** It is checked in exactly one
  place — where a *new* live sitter is admitted (`POST /student/attempts/:examId/start`, either
  creating the attempt or transitioning `not_started → in_progress`). Resume, reload, autosave,
  heartbeat and submit are never gated. A quota that could eject a student from a paper they are
  halfway through would be worse than the overload it prevents. Refusal is a `429` with
  `code: "tenant_concurrency_quota"` and the live/limit numbers, not a generic error.
- **The evidence cap never drops a violation.** Only non-violation rows are trimmed — `periodic_snapshot`,
  `snapshot_failed`, `focus_loss`, `camera_restored`. Violation rows are inserted unconditionally
  regardless of the ceiling. Evidence volume is a load problem; misconduct is a record; §34's rule that
  a device fault must never score a student is the same principle pointed the other way.
- **It is a forward cap on new rows, never a deletion.** `integrity_events` is still kept forever, per
  the standing decision. Nothing in this section removes a row that exists.
- **The record says why the frames stop.** One `evidence_capped` marker is written per attempt per
  process, and it is registered in `NON_VIOLATION_TYPES` so it can never score a student — a platform
  decision is not student behaviour. Without the marker, a capped attempt would look exactly like a
  broken camera, which is the silence §34 was written to eliminate.

### The approximations, stated plainly rather than discovered later

1. **The concurrency gate is per-process.** The count is cached for 5s and each admission increments it
   locally, so the gate is *exact on the way up* inside a window (the increments are the admissions)
   and only approximate on the way down (submits inside the window are not seen until the count is
   re-read). It can briefly under-admit, never over-admit. Two API replicas each hold their own count,
   so the effective ceiling is per process for one TTL window — up to 2× for 5s. Acceptable for a
   capacity ceiling whose job is to stop a runaway order-of-magnitude; **not** acceptable for anything
   that must be exact, which is why nothing about correctness or eligibility is decided here.
2. **Evidence counts are carried in memory.** One indexed `COUNT` seeds an attempt, then the count is
   maintained as rows are inserted — evidence only grows, so a carried count is exact for the attempt's
   lifetime (the same monotonicity argument as §37's rollup). Deletes push the carried count too
   **high**, which engages the cap early and stores *less* than allowed: the harmless direction. The six
   admin delete paths clear it anyway, so a re-sit does not begin life at its ceiling.
3. **A one-row drift.** `evidence_capped` is itself counted as an evidence type, so after a restart the
   reseeded count includes the marker and the ceiling engages one row early. One row per attempt,
   deliberately not worth a second counter.

### Where it is wired [from code]

```
rg -c "attemptOwners.authorize"       src/api/index.ts   → 2   (§38, unchanged)
rg -c "integrityRollup.invalidateAll" src/api/index.ts   → 6   (§37)
rg -c "attemptOwners.invalidateAll"   src/api/index.ts   → 6   (§38)
rg -c "evidenceMeter.invalidateAll"   src/api/index.ts   → 6   (this section — same six delete paths)
```

`PATCH /settings` and `PATCH /tenants/:id` both normalise the two fields before writing (so a cleared
field stores `NULL`, not `0`) and then invalidate the caches, so an admin's change applies on the next
request instead of at the next TTL expiry. `PATCH /tenants/:id` also latches "an override exists", so a
per-college ceiling is honoured even when no platform default is set.

### The console [decision, not an omission]

Both fields are exposed, because an API-only quota is a quota nobody can set without `curl`:

- **Settings → Capacity limits** (super-admin): the two platform defaults. Blank = unlimited.
- **Colleges → edit form → Capacity limits**: the per-college override. Blank = inherit the platform
  default. The fields appear only when editing an existing college — `POST /tenants` does not accept
  them, so a new college always starts out inheriting, and you set its ceiling afterwards.

Both blocks say in plain words that these bound load only: a limit never interrupts a student who is
already writing, and never discards a proctoring violation. The tenant form points at "suspend"
for the deliberate-stop case, so nobody reaches for a ceiling of 0 to do it.

### Schema, the usual way [from code]

Four nullable columns — `max_concurrent_attempts` and `max_evidence_per_attempt` on both `tenants` and
`settings` — declared in `schema.ts` and added at boot by `src/api/database/invariants.ts`
(`ALTER TABLE ADD COLUMN`, which is exactly why all four are nullable). Four matching `REQUIRED_COLUMNS`
entries, so `/api/admin/invariants` reports them and a half-migrated database is visible rather than
mysterious.

### Tests [measured]

39 new tests in `src/api/lib/tenant-quota.test.ts`, run against in-memory libSQL with the real SQL, and
they pin the things that would actually hurt:

- an unconfigured platform is unlimited **and the tenant row is never read** (one query: the overrides
  count); 200 loads inside the TTL cost 1 query
- `0`, `-5`, `NaN`, `"abc"`, `Infinity` and `0.4` all resolve to "not set"; a `0` stored on a tenant row
  inherits the global 700 rather than blocking
- a start burst of admissions inside one 5s window is gated on the increments, not on a stale count —
  8 live + ceiling 10 admits exactly two more, on **1** database query
- the gate counts only *this* tenant's `in_progress` attempts (another college's 40 and this college's
  `submitted`/`not_started` rows are all ignored)
- 25 `tab_switch` + 15 `copy_paste` rows do **not** consume the evidence ceiling
- the `evidence_capped` marker fires exactly once, and never for an attempt that was never capped
- `attemptId → tenantId`: 400 lookups = 1 query, misses are not cached

### Shipped [measured]

- 39/39 new tests pass · `bun test` **400 pass, 0 fail across 21 files** (361 + 39) · `bun run typecheck`
  (web + api) clean · `bun run build` green.
- Pushed `ea98c5e..441e222`. Production `invariants.checkedAt` advanced
  `2026-08-30T17:28:28.424Z` → **`2026-08-31T05:37:09.399Z`**, `invariants.ok: true`.
- `/api/admin/invariants` reports **`ok: true`** with all four new columns `present: true` —
  `tenants.max_concurrent_attempts`, `tenants.max_evidence_per_attempt`,
  `settings.max_concurrent_attempts`, `settings.max_evidence_per_attempt`. The boot-time
  `ALTER TABLE ADD COLUMN` path did what it was supposed to; no migration step was involved.
- **The platform is confirmed unconfigured**, which is the shipped state: `GET /api/settings` returns
  `maxConcurrentAttempts: null, maxEvidencePerAttempt: null`, and the single tenant
  (`ten_bf5f745ef6ac4df4`, TKR College of Engineering & Technology) returns `null` for both. No ceiling
  is in force anywhere. Nothing about today's behaviour changed, by design.
- **Statement counts did not move.** `/api/health` `db.queries` across six sequential calls over ~10s:
  `79 → 80 → 80 → 81 → 81 → 83`, i.e. **4 statements across 6 requests**, ~0.4/s — the same order as
  the ~0.2/s idle drift measured in earlier sections, with no per-request step. Caveat stated plainly:
  this is idle traffic, and `/api/health` is not itself a quota path, so it bounds the background cost
  and does **not** yet prove the student paths are free. The ~479ms of any timing from this sandbox is
  network round trip and is not quoted here for that reason.

### The falsifiable prediction [unverified]

This one is deliberately awkward to claim credit for, because a correct quota system on an
unconfigured platform is **indistinguishable from not shipping it**. So the prediction is a null
result, and it is the one that matters:

With no number set anywhere, a statement-count diff must show **no added per-request statements**
versus before this deploy, and no more than one extra `count(*)` per minute per process. The idle half
of that is now measured above and holds. The half still open is the one that matters on an exam day:
on the next live exam, the per-student statement count on `/start`, autosave, heartbeat, `/events` and
`/snapshot-url` must be **identical** to §38's post-fix numbers, because every quota check short-circuits
on a `null` limit. If the next exam's statement count per student is higher than §38 predicted, this
section added cost to the path it was supposed to protect, and I will say so here rather than moving
on.

The second prediction, for whenever a number *is* set: refusals arrive as `429`
`tenant_concurrency_quota` at the ceiling and **never** as a failure for a student already writing —
no autosave, heartbeat, resume or submit can ever be refused by a quota, because the gate is not on
those paths at all. If any student ever reports being locked out of a paper mid-exam after a ceiling
is set, that is this section's bug and I will own it in place, the way §36's wrong prediction is
corrected in place.

### Still open

The quota ceilings are shipped but **unset**, which is the whole point — they are a seatbelt, not a
change of behaviour. Setting an actual number is a decision about what one college is allowed to
consume, and that is your call, not mine. A reasonable starting point when you want one: concurrent
attempts at roughly 2× the largest roster you actually run (today's largest was 1,122), and evidence
per attempt at roughly 2× a full exam's frame count (a 90-minute exam at one frame per 27s is ~200
frames, so ~400) — high enough that no legitimate exam ever touches them, low enough to stop a
runaway.

Still unanswered, raised four times now: **Proview has no independent backup.** The Turso Developer
plan gives 10-day point-in-time recovery, which covers a bad deploy and does not cover a deleted
database or an accidental roster reconcile. It remains the only item on this list that is not a
performance problem.
