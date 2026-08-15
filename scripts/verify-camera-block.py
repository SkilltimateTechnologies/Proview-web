"""Ops check: prove that blocking the camera mid-exam hard-stops the exam.

Needs a server running against a SEEDED throwaway database (never production —
this starts a real attempt) and the built assets:

    rm -f .tmp-verify.db*
    export DATABASE_URL="file:$PWD/.tmp-verify.db"; unset DATABASE_AUTH_TOKEN
    bun run db:push --force && bun run seed
    bun run build
    PORT=3100 bun src/server.ts &
    python3 scripts/verify-camera-block.py

WHY THIS EXISTS
---------------
The camera-block overlay cannot be exercised by a unit test: it only appears
after a real attempt is running, and it depends on how the BROWSER reports a
revoked camera. Reading the code was not enough — the first run of this script
found the overlay showing the generic "Camera turned off" plus a countdown
instead of "Camera access is blocked", because revoking access in Chromium also
ends the live track, so the vague track-poll detector overwrote the correct
diagnosis ~1.5s later. See escalateFailure() in src/web/student/lib/camera-failure.ts.

Students sit these exams inside Safe Exam Browser, which has no address bar, no
padlock and no site-settings menu, so the script also asserts that no remedy
names UI the kiosk hides.
"""
import asyncio, sys
from playwright.async_api import async_playwright

BASE = "http://localhost:3100"
NEWPW = "Verify@1234"
FAILS = []

def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        FAILS.append(name)

INIT = r"""
(() => {
  const listeners = new Set();
  const status = {
    state: 'granted', onchange: null,
    addEventListener(t, fn) { if (t === 'change') listeners.add(fn); },
    removeEventListener(t, fn) { listeners.delete(fn); },
    dispatchEvent() { return true; },
  };
  window.__setCamPerm = (s) => {
    status.state = s;
    const ev = { type: 'change', target: status, currentTarget: status };
    if (typeof status.onchange === 'function') status.onchange(ev);
    for (const fn of Array.from(listeners)) { try { fn(ev); } catch (e) {} }
  };
  if (navigator.permissions) {
    const orig = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (d) => (d && d.name === 'camera')
      ? Promise.resolve(status) : orig(d);
  }
  const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__blocked = false;
  navigator.mediaDevices.getUserMedia = (c) => window.__blocked
    ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
    : realGUM(c);
  window.__killTracks = () => {
    document.querySelectorAll('video').forEach(v => {
      const s = v.srcObject;
      if (s && s.getTracks) s.getTracks().forEach(t => t.stop());
    });
  };
  window.__blockCamera = () => { window.__blocked = true; window.__killTracks(); window.__setCamPerm('denied'); };
  window.__unblockCamera = () => { window.__blocked = false; window.__setCamPerm('granted'); };
})();
"""

async def overlay_text(pg):
    el = await pg.query_selector("div[style*='z-index: 80'], div[style*='zIndex: 80']")
    if not el:
        return None
    return await el.inner_text()

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
                vals = [pw, NEWPW, NEWPW]
                for el, v in zip(fields, vals):
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

        # ---- home -> brief -> preflight (both buttons read "Start exam") ----
        await pg.click("button:has-text('Start exam')")
        await pg.wait_for_timeout(2000)
        await pg.click("button:has-text('Start exam')")
        await pg.wait_for_timeout(4000)
        body = await pg.inner_text("body")
        if "System check" not in body:
            print("not at preflight:\n", body[:600]); sys.exit(1)

        # ---- start the exam ----
        await pg.click("button:has-text('Start secure exam')")
        await pg.wait_for_timeout(5000)
        body = await pg.inner_text("body")
        print(f"\n=== RUNNING? url={pg.url} ===")
        print(body[:400].replace("\n", " | "))
        check("exam reached the running phase", "Question" in body or "Submit" in body, body[:120])
        await pg.screenshot(path="/tmp/v1_running.png", full_page=True)

        # timer before the block
        t_before = await pg.evaluate("""() => {
            const el = document.querySelector('.timer-big, [class*=timer]');
            return el ? el.innerText.trim() : null; }""")
        print("  timer before block:", t_before)

        # ---- BLOCK THE CAMERA ----
        print("\n=== blocking the camera ===")
        await pg.evaluate("window.__blockCamera()")
        await pg.wait_for_timeout(6000)
        await pg.screenshot(path="/tmp/v2_blocked.png", full_page=True)

        ov = await overlay_text(pg)
        check("blocking popup appears", ov is not None, "no z-index:80 overlay found")
        if ov:
            print("  --- overlay text ---")
            for line in ov.strip().splitlines():
                if line.strip():
                    print("   |", line.strip())

            check("title says access is blocked",
                  "Camera access is blocked" in ov, repr(ov[:80]))
            check("explains the exam is paused", "paused" in ov.lower())
            check("gives the shutter remedy", "shutter" in ov.lower() or "privacy slider" in ov.lower())
            check("gives the camera-key remedy", "F8" in ov or "F10" in ov)
            check("tells them to raise their hand", "raise your hand" in ov.lower())
            check("never mentions UI SEB hides",
                  not any(s in ov.lower() for s in ["address bar", "padlock", "site settings", "lock icon"]))
            check("says the timer keeps running", "timer keeps running" in ov.lower())
            check("offers the retry control", "turned my camera back on" in ov.lower())
            check("no dismissal escape hatch",
                  not any(s in ov.lower() for s in ["dismiss", "continue anyway", "my room is", "close"]))

        # countdown must be hidden for a denied permission
        cd = await pg.evaluate("""() => {
            const ov = document.querySelector("div[style*='z-index: 80']");
            if (!ov) return 'NO_OVERLAY';
            const t = ov.querySelector('.timer-big');
            return t ? t.innerText.trim() : null; }""")
        check("no countdown shown (waiting cannot fix a block)", cd is None, f"countdown={cd!r}")

        # overlay must cover the whole viewport
        box = await pg.evaluate("""() => {
            const ov = document.querySelector("div[style*='z-index: 80']");
            if (!ov) return null;
            const r = ov.getBoundingClientRect();
            return {w: r.width, h: r.height, iw: innerWidth, ih: innerHeight}; }""")
        check("popup covers the whole screen", bool(box) and box["w"] >= box["iw"] - 2 and box["h"] >= box["ih"] - 2, str(box))

        # the exam timer must keep running while locked
        t1 = await pg.evaluate("""() => { const e = document.querySelector('.timer-big'); return e ? e.innerText.trim() : null; }""")
        hdr1 = await pg.evaluate("""() => {
            const els = [...document.querySelectorAll('*')].filter(e => /^\\d?\\d:\\d\\d(:\\d\\d)?$/.test(e.innerText||''));
            return els.length ? els[els.length-1].innerText.trim() : null; }""")
        await pg.wait_for_timeout(4000)
        hdr2 = await pg.evaluate("""() => {
            const els = [...document.querySelectorAll('*')].filter(e => /^\\d?\\d:\\d\\d(:\\d\\d)?$/.test(e.innerText||''));
            return els.length ? els[els.length-1].innerText.trim() : null; }""")
        check("exam timer keeps counting down while locked",
              hdr1 is not None and hdr2 is not None and hdr1 != hdr2, f"{hdr1} -> {hdr2}")

        # answering must be impossible underneath
        clicked = await pg.evaluate("""() => {
            const ov = document.querySelector("div[style*='z-index: 80']");
            if (!ov) return 'NO_OVERLAY';
            const r = ov.getBoundingClientRect();
            const el = document.elementFromPoint(r.width/2, r.height*0.9);
            return el ? (ov.contains(el) ? 'OVERLAY' : el.tagName + '.' + el.className) : 'NONE'; }""")
        check("clicks land on the popup, not the exam", clicked == "OVERLAY", str(clicked))

        # ---- RECOVERY ----
        print("\n=== unblocking the camera ===")
        await pg.evaluate("window.__unblockCamera()")
        await pg.wait_for_timeout(8000)
        ov2 = await overlay_text(pg)
        await pg.screenshot(path="/tmp/v3_recovering.png", full_page=True)
        if ov2:
            first = ov2.strip().splitlines()[0] if ov2.strip() else ""
            print("  overlay now:", first[:80])
        check("popup reacts to the camera coming back without any click",
              ov2 is None or "camera is back" in ov2.lower() or "Camera access is blocked" not in ov2,
              (ov2 or "")[:120])

        print("\n=== screenshots: /tmp/v1_running.png /tmp/v2_blocked.png /tmp/v3_recovering.png ===")
        await b.close()

    print(f"\n{'ALL CHECKS PASSED' if not FAILS else 'FAILURES: ' + ', '.join(FAILS)}")
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
