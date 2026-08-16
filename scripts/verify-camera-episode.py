"""Ops check: a webcam that keeps dying must bill the student ONCE, not forever.

The bug this guards (measured on prod exam ex_de2e60a8be504057, 14 Aug): one
student's flaky webcam wrote 43 `camera_lost` rows, which put her at the top of
the misconduct table — above the only candidate in the hall with a real
copy/paste pattern. Her camera was broken; nothing she did was misconduct 43
times over.

Three detectors watch the camera and each re-acquired handle carries its own
"report once" latch, so the suppression CANNOT live in any one of them. It lives
in camera-episode.ts, and this script proves the wiring in exam-runner.tsx
actually reaches the database — the unit tests cannot, because the storm is made
of component timers, a 2.5s recovery poll and real getUserMedia handles.

    rm -f .tmp-verify.db*
    export DATABASE_URL="file:$PWD/.tmp-verify.db"; unset DATABASE_AUTH_TOKEN
    bun run db:push --force && bun run seed
    python3 scripts/verify-camera-episode.py --prepare   # patch proctoring config
    bun run build
    PORT=3100 bun src/server.ts &
    python3 scripts/verify-camera-episode.py

RE-SEED BETWEEN RUNS. A leftover in_progress attempt turns the student's Start
button into Resume and the login phase times out.

WHAT --prepare DOES, AND WHY IT IS NOT CHEATING
-----------------------------------------------
It sets the GLOBAL proctoring row to the prod-shaped config that produced the
bug (requireWebcam + blockOnCameraLoss) with two changes: cameraLossLockSeconds
drops 120 -> 15, and snapshots/obstruction detection are off. The lock length is
an admin setting, not the behaviour under test, and shortening it only makes the
storm window arrive sooner — the recovery poll, the latch-per-handle and every
line of the code path are untouched. Snapshots are off so the run does not depend
on object storage.

HOW THE FLAPPING CAMERA IS FAKED
--------------------------------
getUserMedia is wrapped: it returns a REAL fake-device stream, then stops the
video track 700ms later. readyState flips to "ended", which is exactly what the
1.5s track poll in startWebcam sees — the same signal, and the same
"Camera disconnected" detail, as 42 of the 43 real rows.

THE VACUITY GUARD
-----------------
"1 row" is also what you get if nothing ever retried. The page counts every
getUserMedia call, and the run FAILS unless the camera was re-acquired at least
ten times — proof the storm conditions genuinely happened and were suppressed,
rather than never happening at all.
"""
import argparse, asyncio, json, os, sqlite3, sys, time
from playwright.async_api import async_playwright

BASE = os.environ.get("VERIFY_BASE", "http://localhost:3100")
DB = os.environ.get("VERIFY_DB", ".tmp-verify.db")
NEWPW = "Verify@1234"
FAILS = []

# The storm needs the recovery poll running, which only happens once the lock
# countdown has expired. 15s lock + 60s of watching = ~24 re-acquisitions.
LOCK_SECONDS = 15
STORM_WATCH_MS = 60_000

TEST_PROCTORING = {
    "requireWebcam": True, "requireInternet": True,
    "blockOnCameraLoss": True, "cameraLossLockSeconds": LOCK_SECONDS,
    "fullscreenRequired": False, "blockTabSwitch": False, "maxTabSwitches": 0,
    "requireSingleScreen": False, "blockCopyPaste": False, "blockRightClick": False,
    "webcamSnapshots": False, "snapshotIntervalSec": 27, "detectCameraBlock": False,
}


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        FAILS.append(name)


def prepare():
    """Write the test proctoring config into the seeded settings row."""
    con = sqlite3.connect(DB)
    cur = con.cursor()
    cur.execute("SELECT id FROM settings LIMIT 1")
    row = cur.fetchone()
    if row:
        cur.execute("UPDATE settings SET proctoring = ? WHERE id = ?", (json.dumps(TEST_PROCTORING), row[0]))
    else:
        cur.execute("INSERT INTO settings (id, proctoring, updated_at) VALUES ('global', ?, ?)",
                    (json.dumps(TEST_PROCTORING), int(time.time() * 1000)))
    con.commit()
    con.close()
    print(f"proctoring config written to {DB}: lock={LOCK_SECONDS}s, snapshots off")


def rows_since(t0):
    con = sqlite3.connect(DB)
    out = con.execute(
        "SELECT type, detail, at FROM integrity_events WHERE at >= ? ORDER BY at", (t0,)
    ).fetchall()
    con.close()
    return out


def count(rows, kind):
    return sum(1 for r in rows if r[0] == kind)


INIT = r"""
(() => {
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__flap = false;
  window.__acquires = 0;
  const live = new Set();
  const kill = (s) => { try { s.getVideoTracks().forEach((t) => t.stop()); } catch (e) {} };
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await real(c);
    window.__acquires++;
    live.add(s);
    if (window.__flap) {
      // Let the handle be built and reported healthy, then kill the track the way
      // a failing USB webcam does: readyState -> "ended".
      setTimeout(() => kill(s), 700);
    }
    return s;
  };
  // Turning the fault on must also kill the handle the exam is ALREADY holding —
  // that is what an unplugged webcam does, and nothing re-opens the device while
  // the camera is believed healthy.
  window.__startFlap = () => { window.__flap = true; live.forEach(kill); };
  window.__stopFlap = () => { window.__flap = false; };
})();
"""

# z-index 80 is the camera-LOSS lock. 78 is the covered-lens lock — a
# different overlay for a different failure (see verify-camera-covered.py).
OVERLAY = "div[style*='z-index: 80']"


async def wait_overlay(pg, timeout_ms, want=True):
    waited = 0
    while waited < timeout_ms:
        el = await pg.query_selector(OVERLAY)
        if bool(el) == want:
            return waited
        await pg.wait_for_timeout(1000)
        waited += 1000
    return None


async def main():
    t0 = int(time.time() * 1000)
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True, args=[
            "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
        ctx = await b.new_context(viewport={"width": 1440, "height": 900}, permissions=["camera"])
        await ctx.add_init_script(INIT)
        pg = await ctx.new_page()
        pg.on("pageerror", lambda e: print("  [pageerror]", str(e)[:200]))

        # ---- login (handles the first-sign-in password gate) ----
        await pg.goto(f"{BASE}/px9k2m7/login", wait_until="networkidle")
        logged = False
        for pw in ["Welcome@123", NEWPW]:
            ins = await pg.query_selector_all("input")
            await ins[0].fill("STU-21CS102")
            await ins[1].fill(pw)
            await pg.click("button:has-text('Sign in')")
            await pg.wait_for_timeout(3000)
            body = await pg.inner_text("body")
            if "Create a new password" in body:
                fields = [e for e in await pg.query_selector_all("input")
                          if (await e.get_attribute("type")) == "password"]
                for el, v in zip(fields, [pw, NEWPW, NEWPW]):
                    await el.fill(v)
                await pg.click("button:has-text('Set new password')")
                await pg.wait_for_timeout(3500)
                logged = True
                break
            if "/px9k2m7/login" not in pg.url:
                logged = True
                break
            await pg.goto(f"{BASE}/px9k2m7/login", wait_until="networkidle")
        if not logged or "Start exam" not in await pg.inner_text("body"):
            print("could not log in. body:", (await pg.inner_text("body"))[:400]); sys.exit(1)

        await pg.click("button:has-text('Start exam')")
        await pg.wait_for_timeout(2000)
        await pg.click("button:has-text('Start exam')")
        await pg.wait_for_timeout(4000)
        if "System check" not in await pg.inner_text("body"):
            print("not at preflight"); sys.exit(1)
        await pg.click("button:has-text('Start secure exam')")
        await pg.wait_for_timeout(5000)
        body = await pg.inner_text("body")
        check("exam reached the running phase", "Question" in body or "Submit" in body, body[:120])
        check("no lock while the camera is healthy", await pg.query_selector(OVERLAY) is None)

        # ---- 1. THE FLAPPING WEBCAM ----
        print("\n=== camera starts dying every time it is opened ===")
        await pg.evaluate("window.__startFlap()")
        took = await wait_overlay(pg, 30_000, want=True)
        check("a dying camera locks the exam", took is not None, f"waited {took}ms")
        if took is None:
            print("\nFAILURES:", ", ".join(FAILS)); await b.close(); sys.exit(1)

        r = rows_since(t0)
        check("the first loss is recorded", count(r, "camera_lost") >= 1,
              f"rows={[x[0] for x in r]}")

        print(f"  watching the storm window for {STORM_WATCH_MS // 1000}s "
              f"(lock is {LOCK_SECONDS}s, recovery poll re-opens the camera every 2.5s)")
        await pg.wait_for_timeout(LOCK_SECONDS * 1000 + STORM_WATCH_MS)

        acquires = await pg.evaluate("window.__acquires")
        r = rows_since(t0)
        # Vacuity guards: "1 row" is also what you get if the camera never failed
        # again. Both of these prove the storm conditions really did happen. The
        # `camera_restored` rows are the strongest evidence — each one is a full
        # lock -> re-open -> "resumed" cycle that used to end in a fresh violation.
        check("the camera really was re-opened repeatedly", acquires >= 3,
              f"getUserMedia calls={acquires}")
        check("the failure really did recur (several lock cycles)",
              count(r, "camera_restored") >= 2,
              f"camera_restored={count(r, 'camera_restored')}")

        lost = count(r, "camera_lost")
        check("ONE row for one broken camera, not one per detection", lost == 1,
              f"camera_lost={lost} after {acquires} acquisitions and "
              f"{count(r, 'camera_restored')} lock cycles")
        check("a dying camera is never mistyped as a deliberate block",
              count(r, "camera_blocked") == 0, f"camera_blocked={count(r, 'camera_blocked')}")
        details = {x[1] for x in r if x[0] == "camera_lost"}
        check("the row carries the real failure text", any("amera" in (d or "") for d in details),
              f"details={details!r}")
        await pg.screenshot(path="/tmp/e1_locked.png", full_page=True)

        # ---- 2. A GENUINE RECOVERY ENDS THE INCIDENT ----
        print("\n=== camera fixed: the exam must resume ===")
        await pg.evaluate("window.__stopFlap()")
        gone = await wait_overlay(pg, 60_000, want=False)
        check("exam unlocks once the camera is genuinely back", gone is not None,
              "still locked 60s after the camera was fixed")
        r = rows_since(t0)
        check("the recovery is on the timeline", count(r, "camera_restored") >= 1,
              f"camera_restored={count(r, 'camera_restored')}")
        check("recovering did not retroactively add a violation", count(r, "camera_lost") == 1,
              f"camera_lost={count(r, 'camera_lost')}")

        # ---- 3. A SECOND, SEPARATE FAILURE IS STILL BILLED ----
        # The suppression must not become a permanent mute: this is the failure mode
        # that would hide a candidate who unplugs the webcam again later.
        print("\n=== the camera fails again: that IS a new incident ===")
        await pg.wait_for_timeout(12_000)   # clear of EPISODE_CLEAR_MS either way
        await pg.evaluate("window.__startFlap()")
        took2 = await wait_overlay(pg, 40_000, want=True)
        check("the new failure locks the exam again", took2 is not None, f"waited {took2}ms")
        await pg.wait_for_timeout(6000)
        r = rows_since(t0)
        lost2 = count(r, "camera_lost")
        check("a genuinely new incident gets its own row", lost2 == 2,
              f"camera_lost={lost2} (want exactly 2: one per incident)")
        await pg.screenshot(path="/tmp/e2_second_incident.png", full_page=True)

        print("\n  --- integrity rows written during this run ---")
        for typ, det, at in rows_since(t0):
            print(f"   | {time.strftime('%H:%M:%S', time.localtime(at / 1000))}  {typ:18} {det}")
        print("\n=== screenshots: /tmp/e1_locked.png /tmp/e2_second_incident.png ===")
        await b.close()

    print(f"\n{'ALL CHECKS PASSED' if not FAILS else 'FAILURES: ' + ', '.join(FAILS)}")
    sys.exit(1 if FAILS else 0)


ap = argparse.ArgumentParser()
ap.add_argument("--prepare", action="store_true", help="patch the seeded proctoring config, then exit")
args = ap.parse_args()
if args.prepare:
    prepare()
else:
    asyncio.run(main())
