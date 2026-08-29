# Admin-side performance work (Aug 29 2026)

Follow-up to `ce2fa29` (student exam path). That commit did NOT touch staff screens.

## Measured before (prod, best of 3, super-admin cookie)

| endpoint | best of 3 | payload (no AE) |
|---|---:|---:|
| /api/admin/invariants | 1063 ms | 2.2 KB |
| /api/reports/ex_d0414a4afb984401 | 978 ms | 70.1 KB |
| /api/reports | 936 ms | 7.5 KB |
| /api/dashboard | 872 ms | 2.6 KB |
| /api/students | 709 ms | 284.2 KB |
| /api/questions | 685 ms | 267.5 KB |
| /api/classes | 546 ms | 3.5 KB |
| /api/exams | 530 ms | 6.1 KB |
| /api/monitor | 479 ms | 0.1 KB |

- `/api/health` db.queries: 213 statements for 27 requests = **7.9 per request** (student path = 2.23).
- `caches` was `{}` for admin traffic — every cache from ce2fa29 is student-path only.
- ~479 ms of every number is sandbox->Railway round trip (that is what near-empty /monitor costs).

## Correction found mid-work

Payload was NOT a problem. With `Accept-Encoding: gzip, br`:
- /api/students 291 KB -> **41.7 KB**
- /api/questions 274 KB -> **41.6 KB**
- /api/reports 7.7 KB -> 1.5 KB

Compression already works on the wire, so the earlier 284/268 KB figures overstated what a
browser actually downloads. DROPPED: /students pagination, /questions field trimming.
Told the user. Remaining work is query count only.

## Root cause

Nine admin endpoints each open with a full read of the tenant's `students` table (1,124 rows)
plus the full `classes` table, only to map studentId->name and classId->section code. Nothing
cached, per request.

Call sites (src/api/index.ts): 313/317 (monitor snapshot), 2494/2496 (exam roster),
2515/2516 (roster candidates), 2534/2535 (roster eligible), 2764/2765 (dashboard),
2861 (reports list), 2905/2907 (report detail), 3023/3024 (reports roster candidates).

## Plan

1. [x] `src/api/lib/tenant-directory.ts` — per-tenant TTL cache over students+classes, built on
   the existing tested `TtlCache` (coalesces concurrent misses). Indexes (byId / enabled /
   codeById) built inside the loader so a cache hit allocates nothing.
2. [x] `src/api/lib/tenant-directory.test.ts` — 20 tests, injected clock, no DB.
3. [x] Wired all 8 read-only call sites (report detail uses `.all`, not `.enabled`, because that
   block already filters `enabled === false` itself — semantics preserved exactly).
4. [x] Invalidate on every students/classes write (12 paths):
   students 820, 1120, 1232, 1268, 1344, 1373, 1399, 1419, 1472; classes 1041, 1054, 1067-69.
5. [x] Exposed `directoryStudents` / `directoryClasses` in /api/health `db.cached`.
6. [x] `bun run build` (= typecheck:api && bun test && vite build), then measure prod after.

## Do NOT cache
- Single-row reads by id.
- Duplicate-roll read-then-write checks in POST /students and /students/bulk (1163/1169) —
  must be authoritative; the unique index is the real guarantee.
- /students GET projection excludes the password hash; the cache holds full rows, so never
  serve cached rows straight to a client.

## Constraints carried over
- PATCH /api/exams/:id has a destructive roster reconcile — never send `studentIds`.
- typecheck:web has 57 pre-existing errors, not a regression.
- Duplicate-account audit is CLOSED by the user. No writes to student records.

## Measured after (deployed e423f25, boot 2026-08-29T16:40:47Z)

Both columns are best-of-3 with NO Accept-Encoding, so they are directly comparable.
The ~480 ms sandbox->Railway round trip (= near-empty /api/monitor) is in every number.

| endpoint | before | after | server-side (minus ~480 ms floor) |
|---|---:|---:|---|
| /api/admin/invariants | 1063 | 1056 | 583 -> 576 (flat, untouched) |
| /api/reports/ex_d0414a4afb984401 | 978 | 744 | 498 -> 264 (-47%) |
| /api/reports | 936 | 824 | 456 -> 344 (-25%) |
| /api/dashboard | 872 | 682 | 392 -> 202 (-48%) |
| /api/students | 709 | 645 | not a directory user; noise |
| /api/questions?limit=50 | 685 | 685 | flat (untouched) |
| /api/classes | 546 | 522 | flat |
| /api/exams | 530 | 523 | flat |
| /api/monitor | 479 | 486 | flat (already had its own cache) |

Behaviour: all 8 captured payloads byte-identical to /tmp/perf_before (sha256), including
dashboard. /api/health db.cached shows directoryStudents:1, directoryClasses:1, status ok.

### Honest miss on the aggregate statement count

Same 27-request burst: 213 statements before -> 205 after = 7.9 -> 7.59 per request. Almost
no movement, for two reasons worth writing down:
- 5 of the 9 endpoints in that burst (invariants, students, questions, classes, exams) never
  touched the directory, and /admin/invariants alone is a large share of the statements.
- The burst spans ~20 s while the directory TTL is 15 s, so later rounds re-loaded anyway.

Warm-cache, per-endpoint (5 requests each, straight after a warming hit):
- /api/dashboard 5.6 statements/request
- /api/reports/ex_d0414a4afb984401 8.0
- /api/reports **16.6** <- next thing to fix; the reports list still does per-exam queries.

## Next (not done)

1. /api/reports at 16.6 statements/request is a per-exam N+1 in the list handler. Biggest
   remaining admin win.
2. /api/admin/invariants (~576 ms of server time) is a full audit and by far the slowest
   endpoint. Untouched on purpose; it is admin-triggered, not on a hot path.
3. Consider raising DIRECTORY_CACHE_MS above 15 s only if staff report stale rosters is not
   an issue; 15 s was chosen so a just-added student shows up on the next page load.
