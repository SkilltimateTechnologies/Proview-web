"""Ops check: prove that COVERING the camera locks the exam for a full 2 minutes.

Distinct from verify-camera-block.py. There the camera is DEAD (permission denied,
track ended) and the browser tells us so. Here the camera is perfectly healthy —
live track, frames flowing — and the candidate has simply put tape, a hand or a
sticky note over the lens. Nothing at the track level can see that, so the only
signal is the picture itself, and the only honest response is a timed penalty.

Needs a server running against a SEEDED throwaway database (never production —
this starts a real attempt) and the built assets:

    rm -f .tmp-verify.db*
    export DATABASE_URL="file:$PWD/.tmp-verify.db"; unset DATABASE_AUTH_TOKEN
    bun run db:push --force && bun run seed
    bun run build
    PORT=3100 bun src/server.ts &
    python3 scripts/verify-camera-covered.py

RE-SEED BETWEEN RUNS. A leftover in_progress attempt turns the student's Start
button into Resume and the login phase times out.

WHY THIS EXISTS
---------------
The lock is a promise about TIME, and no unit test can prove the promise reaches
the candidate: obstruction-lock.test.ts proves the state machine, but the thing
that actually matters is that the overlay stays on screen for two minutes with no
way out. Three of these checks are the ones that would catch a regression back to
the old behaviour, where a student could wait 60s and click "my room is just dim":

  * there is NO dismiss control anywhere on the overlay
  * uncovering the lens EARLY does not release it — the period is served in full
  * still covered at expiry starts another period, visible as the countdown
    jumping back to ~2:00 without the overlay ever going away

SLOW BY NATURE (~6 minutes). The lock is two real minutes and the code holds no
test hook to shorten it — a window-exposed override would be a cheat vector, since
anything the test can call from the page, a candidate can call from a console.

HOW THE COVERED LENS IS FAKED
-----------------------------
Chromium's fake capture device produces a moving pattern, and there is no way to
cover it mid-run. So the double sits at the pixel boundary instead: getImageData
returns an all-black buffer while __coverLens() is on. Everything above that line
is the real thing — the real detector, its 3-consecutive-frames rule, the real
lock machine, the real overlay, the real event queue.
"""
import asyncio, sys
from playwright.async_api import async_playwright

BASE = "http://localhost:3100"
NEWPW = "Verify@1234"
LOCK_MS = 120_000
FAILS = []

def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        FAILS.append(name)

# Pixel-level double. Black frame while covered; otherwise a pattern that MOVES
# every call — a static pattern would be bit-identical frame to frame and trip the
# frozen-feed detector instead, which is a different verdict and would mask a
# broken covered-lens path.
INIT = r"""
(() => {
  const orig = CanvasRenderingContext2D.prototype.getImageData;
  window.__covered = false;
  window.__jit = 0;
  CanvasRenderingContext2D.prototype.getImageData = function (x, y, w, h, ...rest) {
    const img = orig.call(this, x, y, w, h, ...rest);
    const d = img.data;
    if (window.__covered) { d.fill(0); for (let i = 3; i < d.length; i += 4) d[i] = 255; return img; }
    const j = (window.__jit += 37);
    for (let i = 0; i < d.length; i += 4) {
      const v = ((i >> 2) + j) % 255;
      d[i] = v; d[i + 1] = 255 - v; d[i + 2] = (v * 7) % 255; d[i + 3] = 255;
    }
    return img;
  };
  window.__coverLens = () => { window.__covered = true; };
  window.__uncoverLens = () => { window.__covered = false; };
})();
"""

OVERLAY = "div[style*='z-index: 78']"

async def overlay(pg):
    el = await pg.query_selector(OVERLAY)
    return await el.inner_text() if el else None

async def countdown(pg):
    """The M:SS the candidate is staring at, or None when the overlay is gone."""
    return await pg.evaluate("""() => {
        const ov = document.querySelector("div[style*='z-index: 78']");
        if (!ov) return null;
        const t = ov.querySelector('.timer-big');
        return t ? t.innerText.trim() : 'NO_TIMER'; }""")

def secs(mmss):
    """'1:57' -> 117. None/garbage -> None."""
    if not mmss or ":" not in mmss:
        return None
    try:
        m, s = mmss.strip().split(":")[-2:]
        return int(m) * 60 + int(s)
    except ValueError:
        return None

async def wait_for_overlay(pg, timeout_ms, want=True):
    """Poll until the overlay is present/absent. Returns elapsed ms, or None."""
    waited = 0
    while waited < timeout_ms:
        el = await pg.query_selector(OVERLAY)
        if bool(el) == want:
            return waited
        await pg.wait_for_timeout(1000)
        waited += 1000
    return None

async def main():
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
        for pw in ["Welcome@123", "Verify@1234"]:
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

        # ---- home -> brief -> preflight -> running ----
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
        check("no lock while the lens is clear", await overlay(pg) is None)

        # ---- 1. COVER THE LENS ----
        print("\n=== covering the lens ===")
        await pg.evaluate("window.__coverLens()")
        took = await wait_for_overlay(pg, 60_000, want=True)
        check("covering the lens locks the exam", took is not None, f"waited {took}ms" if took else "no overlay in 60s")
        if took is None:
            print("\nFAILURES:", ", ".join(FAILS)); await b.close(); sys.exit(1)
        # 3 consecutive bad frames at a 10s cadence.
        check("caught within ~40s of the lens being covered", took <= 45_000, f"{took}ms")
        await pg.screenshot(path="/tmp/c1_locked.png", full_page=True)

        ov = await overlay(pg)
        print("  --- overlay text ---")
        for line in (ov or "").strip().splitlines():
            if line.strip():
                print("   |", line.strip())

        check("title says we can't see them", "We can't see you" in ov)
        check("says the exam is locked", "locked" in ov.lower())
        check("states the two minutes", "two minutes" in ov.lower())
        check("warns the exam timer keeps running", "timer keeps running" in ov.lower())
        check("warns another period follows if still blocked", "another two minutes" in ov.lower())
        check("says it was recorded", "recorded" in ov.lower())

        # THE regression guard: the old build had "My room is just dim — continue".
        btns = await pg.evaluate("""() => {
            const ov = document.querySelector("div[style*='z-index: 78']");
            return ov ? [...ov.querySelectorAll('button,a,[role=button]')].map(e => e.innerText.trim()) : 'NO_OVERLAY'; }""")
        check("NO dismiss control of any kind", btns == [], f"controls={btns!r}")
        check("no escape-hatch wording", not any(s in (ov or "").lower() for s in
              ["just dim", "continue the exam", "continue anyway", "dismiss", "close"]))

        cd = await countdown(pg)
        check("a countdown is visible", secs(cd) is not None, f"countdown={cd!r}")
        check("countdown starts near two minutes", (secs(cd) or 0) > 100, f"{cd}")

        box = await pg.evaluate("""() => {
            const ov = document.querySelector("div[style*='z-index: 78']");
            const r = ov.getBoundingClientRect();
            return {w: r.width, h: r.height, iw: innerWidth, ih: innerHeight}; }""")
        check("lock covers the whole screen", box["w"] >= box["iw"] - 2 and box["h"] >= box["ih"] - 2, str(box))
        hit = await pg.evaluate("""() => {
            const ov = document.querySelector("div[style*='z-index: 78']");
            const r = ov.getBoundingClientRect();
            const el = document.elementFromPoint(r.width / 2, r.height * 0.9);
            return el ? (ov.contains(el) ? 'OVERLAY' : el.tagName + '.' + el.className) : 'NONE'; }""")
        check("clicks land on the lock, not the paper", hit == "OVERLAY", str(hit))

        cd1 = secs(await countdown(pg))
        await pg.wait_for_timeout(5000)
        cd2 = secs(await countdown(pg))
        check("countdown actually counts down", cd1 and cd2 and cd2 < cd1, f"{cd1} -> {cd2}")

        # ---- 2. UNCOVERING EARLY MUST NOT RELEASE ----
        print("\n=== uncovering the lens early (must NOT release) ===")
        await pg.evaluate("window.__uncoverLens()")
        await pg.wait_for_timeout(25_000)   # >2 analysis samples: the detector has seen clear frames
        still = await overlay(pg)
        check("uncovering early does NOT release the lock", still is not None,
              "overlay vanished — the penalty can be undone")
        left = secs(await countdown(pg))
        check("still counting down the original period", left is not None and left < 100, f"{left}s left")
        await pg.screenshot(path="/tmp/c2_still_locked.png", full_page=True)

        # ---- 3. THE FULL PERIOD IS SERVED, THEN IT RELEASES ----
        print(f"\n=== serving out the period ({left}s left) ===")
        gone = await wait_for_overlay(pg, (left or 120) * 1000 + 20_000, want=False)
        check("releases once the full two minutes are served", gone is not None,
              "still locked well past expiry")
        await pg.screenshot(path="/tmp/c3_released.png", full_page=True)
        body = await pg.inner_text("body")
        check("candidate is back on their paper", "Question" in body or "Submit" in body, body[:120])

        # ---- 4. STILL COVERED AT EXPIRY -> ANOTHER PERIOD ----
        print("\n=== covering again and staying covered through expiry ===")
        await pg.evaluate("window.__coverLens()")
        took2 = await wait_for_overlay(pg, 60_000, want=True)
        check("a second obstruction locks again", took2 is not None, f"waited {took2}ms")
        if took2 is not None:
            low = 999
            relocked = False
            # Watch the countdown across the expiry without ever letting the overlay go.
            for _ in range(150):
                await pg.wait_for_timeout(1000)
                c = await countdown(pg)
                if c is None:
                    check("overlay never drops while still covered", False, "released with the lens covered")
                    break
                v = secs(c)
                if v is None:
                    continue
                if v < low:
                    low = v
                # The countdown jumping back up is the re-lock, seen from the candidate's chair.
                if low <= 3 and v > 100:
                    relocked = True
                    break
            check("still covered at expiry starts another two minutes", relocked,
                  f"lowest seen {low}s, no jump back to ~2:00")
        await pg.screenshot(path="/tmp/c4_relocked.png", full_page=True)

        print("\n=== screenshots: /tmp/c1_locked.png /tmp/c2_still_locked.png /tmp/c3_released.png /tmp/c4_relocked.png ===")
        await b.close()

    print(f"\n{'ALL CHECKS PASSED' if not FAILS else 'FAILURES: ' + ', '.join(FAILS)}")
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
