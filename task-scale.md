# Scale incident — pages not loading at ~1000 concurrent students

Goal: 1000 students writing one exam at the same time must be able to load pages.
Every claim below is backed by a command result, not a guess.

## What was actually wrong (measured before any fix)

### 1. Static assets: uncompressed and uncacheable  ← the "page won't load" itself
`curl -sSI -H 'Accept-Encoding: gzip, br' https://proview-web-production.up.railway.app/assets/index-JyX1_AkR.js`
- `content-length: 1617049`
- **no `content-encoding`** → Railway's edge does not compress for us
- **no `cache-control`, no `etag`, no `last-modified`** → nothing cacheable, so a
  refresh / SEB restart re-downloads everything

Reproduced locally against the previous commit (37cdb88) — cold load of the student
page transferred **1 667 142 bytes** with `encoding=None cache=None` on every asset.
The offline service worker made it worse: its stale-while-revalidate `fetch(req)`
re-downloaded every asset on every boot, because with no `Cache-Control` the HTTP
cache could never answer it.

`src/server.ts` also did an `await file.exists()` stat per request and returned a
bare `new Response(file)` — no compression, no cache headers, no ETag, no 304.

### 2. Oversized images on the login path
`dist/assets/exam-lab-*.png` = **1 029 679 bytes**, imported eagerly by
`src/web/student/pages/login.tsx` and `src/web/register/RegisterPage.tsx`.
`dist/og-image.png` = 6 541 652 bytes. `du -sh dist` = 12M.

### 3. Every student request paid multiple REMOTE database round trips
The database is Turso over HTTP (`src/api/database/index.ts`), so every `await db.…`
is a network hop and sequential awaits multiply. Measured with the new
`/api/health` → `db.queries` counter, same script against both builds:

| endpoint (per request)   | before (37cdb88) | after | note |
|--------------------------|-----------------:|------:|------|
| heartbeat (every 15s)    | 3 | **1** | exam read + attempt read + update → one `UPDATE … RETURNING` |
| autosave, 1 answer       | 7 | **4** | |
| autosave, batch of 7     | 13 | **4** | one batched upsert instead of one per answer |
| status poll              | 6 | **3** | |
| event flush (3 new)      | 3 | 3 | statements unchanged; rows read now bounded |
| event flush (nothing new)| 2 | 2 | |

Whole-run figure from the 1000-student load test (identical request mix, fresh seed):
**46 049 statements / 11 872 requests = 3.88** before → **26 477 / 11 855 = 2.23**
after, i.e. **-43% database round trips**.

Also on the hot path before the fix: `authMiddleware` ran `auth.api.getSession()` on
**every** `/api/student/*` request even though students are not Better Auth users and
no student route reads `user`/`profile`; `verifyStudentToken` re-imported the HMAC key
on every verification; `getGlobalSettings` re-read its single row on every call.

### 4. Missing indexes
`integrity_events` had only `integrity_attempt_idx`. The Live Monitor's violation
count (`type NOT IN (…)` per attempt) and the every-10s dedupe read both scanned
every row of an attempt — hundreds per attempt in a 90-minute exam, hundreds of
thousands in the table for 1000 students.

## What was changed
- **F1 `src/server.ts` + `src/api/lib/static-assets.ts` (new, unit-tested).** Boot-time
  manifest (no per-request stat), brotli/gzip negotiation with variants held in memory
  and compressed off the request path, `public, max-age=31536000, immutable` on vite's
  content-hashed `/assets/*`, `no-cache` + ETag/304 on `index.html` and `sw.js`,
  traversal-safe route normalisation.
- **F2** `exam-lab.png` (1 029 679 B) → `exam-lab.webp` (**42 020 B**, same 768×1024);
  `og-image.png` (6 541 652 B) → `og-image.jpg` 1200×673 (**242 364 B**).
- **F3** `src/api/lib/ttl-cache.ts` (new, unit-tested): TTL + in-flight coalescing, so
  1000 simultaneous readers of one exam row cause ONE query. Applied to the global
  settings row (5s), the exam row on the polling paths only (3s), and the exam question
  set used by autosave + option-order translation (30s). Writes invalidate their key.
  `authMiddleware` skips session work for `/api/student/*`. HMAC key cached.
  Heartbeat is one `UPDATE … RETURNING`. Autosave upserts the whole batch in one
  statement (deduped by questionId first — SQLite refuses ON CONFLICT twice on one row)
  and reads only the `response` column to recompute `answeredCount`. The event dedupe
  read is bounded to `at >= the oldest incoming event`.
- **F4** `integrity_attempt_type_idx (attempt_id, type)` and
  `integrity_attempt_at_idx (attempt_id, at)` — declared in `schema.ts` AND created at
  boot by `ensurePerformanceIndexes()` in `database/invariants.ts`, because nothing in
  the deploy path runs a migration. Reported by `/api/admin/invariants` → `perfIndexes`
  but deliberately kept out of `ok`: a missing perf index is slow, not wrong.
- **Observability**: `/api/health` now reports `db.queries` (statements since boot) and
  what the read caches hold.

## Results (measured)
- Cold student page load: **1 667 142 → 484 145 bytes** (3.4x less; the JS bundle alone
  2 108 681 → 474 154, 4.4x). Chromium `performance.getEntriesByType('resource')` after
  a reload: **transferSize 0 for every asset** (was a full re-download every time).
- 1000 virtual students at the real cadence for 60s: **197 req/s, 0 errors** (before:
  197 req/s, 0 errors — the local file DB was never the bottleneck, which is why the
  round-trip count and the transferred bytes are the numbers that matter).
- Database round trips per request: **3.88 → 2.23**.
- `bash scripts/mutate-scale.sh`: **killed=37 survived=0 of 37**, source restored.
- `python3 scripts/verify-scale.py`: all behaviour + budget checks pass, both perf
  indexes present, unique indexes intact with 0 duplicate groups.
- Browser: student login page renders with no console errors, webp loads (42 020 B).

Honest caveat: on a LOCAL file database the heartbeat endpoint measures ~1.4ms slower
per request (2.9ms vs 1.6ms sequential) even though it now issues one statement instead
of three, because a local statement costs almost nothing while `UPDATE … RETURNING`
costs ~0.8ms more than a bare update (`/tmp/dbbench.ts`). In production every statement
is a network hop to Turso, so 1 round trip beats 3 by a wide margin. Local wall-clock
is not a proxy for the production topology.

## Status
- [x] F1 static serving (compression + immutable caching + ETag/304 + no per-request stat)
- [x] F2 login/OG images shrunk
- [x] F3 database round trips cut on the hot student paths
- [x] F4 the two `integrity_events` indexes, created at boot and reported
- [x] F5 load generator + measured before/after (`scripts/loadtest-exam.py`)
- [x] Unit tests (59 + 20 new) and mutation harness (37/37 killed)
- [x] Gates: `typecheck:api` 0 · `bun test` 215 pass / 0 fail · `build` 0 · `typecheck:web` 57
- [ ] Commit + push to main (needs a fresh GITHUB_TOKEN)
- [ ] Prod verify: headers on the new bundle, `/api/health`, `/api/admin/invariants`
      (`perfIndexes` present), `/api/monitor`

## Guardrails honoured
- Exam integrity untouched: option-order translation round trip asserted end to end, the
  three unique indexes still asserted at boot with 0 duplicate groups, violation evidence
  and dedupe semantics unchanged (a full submit-style resend still saves 0).
- Only admin-authored rows are cached, never per-attempt state a student is mutating.
  Every cache is invalidated by its own write path, and worst-case staleness is one TTL
  (3s for exam holds, against a 15s heartbeat).
