# One broken webcam should be one violation, not forty-three

## How this was found

Backlog said "recount violations now that `focus_loss` is non-scoring (36 affected
attempts)". That recount turned out to be a **no-op**: violation counts are computed
live in SQL (`src/api/index.ts` ~line 250, `NOT IN (NON_VIOLATION_TYPES)`), there is
no denormalised `violations` column in `schema.ts`, so every read already excludes
`focus_loss`. Nothing to migrate. Verified against prod.

But pulling the numbers to confirm that surfaced something worse.

## The measurement

`scripts/audit-violation-cadence.py` — read-only, walks the admin report endpoints
for a finished exam and asks of every event type: does this repeat on a
machine-regular cadence, or at irregular human intervals?

Run against prod, exam `ex_de2e60a8be504057` ("Weekly Assessment – 1", 186 attempts):

```
type                      events  attempts   medGap  regular%  scoring
focus_loss                   751        36     60.0       89%       no
camera_lost                  114        18     60.0       65%      YES   <-- 
context_menu                  76        45    300.9        3%      YES
copy_in_answer                52        34    226.1        0%      YES
paste_in_answer               45        29      5.6       44%      YES
camera_obstructed             39        28    519.7        9%      YES
tab_switch                    11         9     11.4        0%      YES
```

`camera_lost` has the same signature `focus_loss` was demoted for: 65% of gaps land
within 1s of a 60.0s median, longest run **36 consecutive gaps at ~60.0s** for one
student. Real misconduct types (`context_menu` 3%, `copy_in_answer` 0%,
`tab_switch` 0%) are irregular, as a human act should be.

Top of the violation table for that exam:

```
  46  23K91A66K3  Yenugu Akshaya       camera_lost=43, focus_loss=32, tab_switch=1
  21  24K95A6612  Padala Niharika      camera_lost=20, tab_switch=1
  16  23K91A66C8  Mukka Surya Kiran    paste_in_answer=9, copy_in_answer=5, cut=1
  12  24K95A6717  Suraji Rasagna       camera_lost=11, tab_switch=1
```

42 of Yenugu Akshaya's 43 `camera_lost` rows carry the identical detail
"Camera disconnected". That is one failing webcam, billed 43 times.

**The harm is the ordering.** A TPO scanning "most violations" sees two students
with broken hardware above the one student in the exam with a real
copy/paste pattern. The flag that should trigger an investigation is buried under
noise from a USB port.

## Why the existing latch does not cover it

`proctor.ts` `startWebcam` already has a `lost` latch (shipped with the
camera-block work) so a dead track fires `onLost` **once per handle** instead of
every 1.5s poll. That fixed the within-handle storm.

It does not fix this one, because the latch dies with the handle:

- the unlock poll (`exam-runner.tsx` ~line 800) runs every **2.5s** while locked
- each tick calls `tryRestoreCamera()` → `startWebcam()` → a **brand new handle
  with a brand new latch**
- a camera that can be acquired but dies immediately (a flaky USB webcam) fires
  `onLost` again on the new handle → `engageLock` → another row

and in `engageLock` the `if (lockedRef.current) return;` guard sits **below** the
`recordEventRef.current(...)` call — by design, it only protects the countdown from
being re-armed. So while already locked, every fresh detection still writes a row,
rate-limited solely by `minGapMs: 3000`.

Worst case today: ~20 rows/minute for one unplugged webcam.

## The rule

One `camera_lost` per **episode**, not per detection. An episode ends when the
camera is genuinely back, not when it merely flickers.

- record on the first loss of an episode
- allow exactly one **escalation** `camera_lost` → `camera_blocked`: revoking
  permission also ends the track, so the vague row can land a beat before the
  watcher names the real cause, and that cause must reach the timeline (this is
  the behaviour commit 08df27e added; it must not regress)
- do **not** end an episode just because `isCameraActive` is momentarily true —
  that is precisely the flapping case, and `tryRestoreCamera` makes it true for a
  moment every 2.5s. Require the camera to stay continuously live for
  `EPISODE_CLEAR_MS` (10s)
- the continuous live run is the **only** thing that ends an episode — see below

### The unlock is NOT proof the camera works (found in the browser, not in tests)

The first version of this fix also cleared the episode where `camera_restored` is
recorded, on the reasoning that the exam resuming is unambiguous. It is not. The
unlock poll releases the overlay on a **single instantaneous** `isCameraActive()`
reading, and a camera that dies 700ms after every open supplies exactly that on
every attempt. `scripts/verify-camera-episode.py` caught it immediately: five lock
cycles, five rows.

```
10:56:08  camera_lost      Camera disconnected     <-- lock
10:56:23  camera_restored  Camera restored         <-- "fixed" for 700ms
10:56:25  camera_lost      Camera disconnected     <-- billed again
10:56:40  camera_restored  ...
10:56:41  camera_lost      ...
```

One row per lock period — **which is exactly the 60.0s cadence measured on prod**,
where the lock is 60s. So the unlock was never the cure; it was the storm's clock.
`onRestored()` was deleted. A genuinely working camera clears the episode through
the live run within seconds of the unlock anyway.

`camera_restored` could never have been the only reset in any case: it is written
only inside the unlock poll, which only runs when `locked`. With
`blockOnCameraLoss:false` nothing ever locks, so a restore-only latch would mute
the type for the whole exam after the first loss.

## Scope

- NOT changing what counts as a violation. `camera_lost` stays scoring — a camera
  that dies mid-exam is a real integrity gap and must still be reviewed.
- NOT retro-editing the 14 Aug rows. They are the historical record. The report
  already groups them on a timeline; the count is what misleads, and the count is
  computed live, so it corrects itself for future exams only.
- NOT touching `focus_loss` (already non-scoring) or the obstruction lock.

## Status

- [x] recount backlog item — verified a no-op, counts are live SQL
- [x] measured the whole exam, cadence audit script written
- [x] root-caused to the per-handle latch + the record-above-the-guard ordering
- [x] pure module `camera-episode.ts` + unit tests (19 tests)
- [x] mutation-tested the module — `scripts/mutate-camera-episode.sh`, 8/8 killed
- [x] wired into `engageLock` + a dedicated 2s camera-health feeder
- [x] browser-verified — `scripts/verify-camera-episode.py`, 14/14 checks
- [x] mutation-tested the browser check itself — `scripts/mutate-verify-camera-episode.sh`, 2/2 killed
- [x] gates, commit, push, prod verify — see below
- [ ] re-run the cadence audit after the next real exam: `camera_lost` must stop
      tripping the SUSPECT rule

## What ships

| file | role |
| --- | --- |
| `src/web/student/lib/camera-episode.ts` | the rule, DOM-free: `onLoss` / `onCameraSeen`, `EPISODE_CLEAR_MS = 10s` |
| `src/web/student/pages/exam-runner.tsx` | `engageLock` records only when `onLoss(...).record`; a 2s feeder supplies camera-health readings **regardless of `lockedRef`**, since the snapshot tick skips while locked and the obstruction loop is gated on `detectCameraBlock` |
| `scripts/verify-camera-episode.py` | real Chromium, real exam, flapping webcam → asserts ONE row |
| `scripts/mutate-*.sh` | both the module and the browser check are proven to fail against a broken fix |

Measured effect on the case that started this: 5 lock cycles wrote **1** row
instead of 5, and a genuinely separate failure afterwards still wrote its own.

## Shipped

Commit `324ba0f`, pushed to `main` 16 Aug 11:2x UTC. Railway rebuilt on the push:
boot check `2026-08-16T11:16:44Z`, bundle `index-CjmUoJZ6.js` -> `index-JyX1_AkR.js`.

Gates at `324ba0f`: `typecheck:api` exit 0 · `bun test` **136 pass / 0 fail**
(3235 expects, 7 files, was 117/6) · `build` exit 0 · `typecheck:web` **57**
(pre-existing baseline, unchanged).

Prod verified after the deploy:

- `/api/health` → `status: ok`, `invariants.ok: true`
- `/api/admin/invariants` → `ok:true`, all 3 unique indexes present,
  `failed: []`, every `duplicateGroups: 0`
- `/api/monitor` → `live: []`, `degraded:false`, `lastBuildMs 463` (budget 2500)

The deployed bundle was read back and the machine is in it — minified names
differ from a local build, the logic is byte-identical:

```
const XKe=1e4,_D=()=>({lost:!1,recorded:null,liveSince:null});
function YKe(e,t,n){const a=e.lost&&e.recorded==="camera_lost"&&t==="camera_blocked",i=!e.lost||a;
  return{record:i,episode:{lost:!0,recorded:i?t:e.recorded,liveSince:null}}}
function QKe(e,t,n){return t?e.lost?e.liveSince===null?{...e,liveSince:n}
  :n-e.liveSince>=XKe?_D():e:e:e.liveSince===null?e:{...e,liveSince:null}}
```

and all three wiring points are live in it too: the gated write
(`Ke=YKe(ce.current,...)` … `Ke.record&&wn.current(...)`), the 2s feeder
(`setInterval(...QKe(ce.current,dp(me.current),Date.now())...,2e3)`), and the
per-attempt reset (`ce.current=_D()`).

Left open on purpose: `camera_blocked` / `camera_obstructed` have still never
been seen rendering in the LIVE prod Live Monitor, because no real event of
either type exists in prod. Proven locally (16/16) and the strings are in the
deployed bundle.
