"""Ops check: prove a camera block reaches the INVIGILATOR, not just the candidate.

scripts/verify-camera-block.py proves the student's screen hard-stops. This one
proves the other half of that promise: that the resulting `camera_blocked` event
actually shows up on the Live Monitor while the exam is still running, with a
readable label and counted as a violation. Reading monitor.tsx was not enough —
the drawer loads its events from the REPORTS endpoint, not from /api/monitor, so
the label can be right while the data never arrives.

Needs a server running against a SEEDED throwaway database (never production —
this starts a real attempt) and the built assets:

    rm -f .tmp-verify.db*
    export DATABASE_URL="file:$PWD/.tmp-verify.db"; unset DATABASE_AUTH_TOKEN
    bun run db:push --force && bun run seed
    bun run build
    PORT=3100 bun src/server.ts &
    python3 scripts/verify-monitor-camera-block.py

Phase A drives a student into the blocked state. Phase B logs in as the tenant
admin and asserts what the invigilator sees.
"""
import asyncio, sys, json
from playwright.async_api import async_playwright

BASE = "http://localhost:3100"
STUDENT_PW = "Welcome@123"
NEWPW = "Verify@1234"
ADMIN = "meera@grce.edu"
ADMIN_PW = "Admin@123"
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
})();
"""


async def student_blocks_camera(ctx):
    """Phase A — get a real attempt into the camera-blocked state."""
    pg = await ctx.new_page()
    await pg.goto(f"{BASE}/px9k2m7/login", wait_until="networkidle")
    logged = False
    for pw in [STUDENT_PW, NEWPW]:
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
    if not logged:
        print("student could not log in"); sys.exit(1)

    await pg.click("button:has-text('Start exam')")
    await pg.wait_for_timeout(2000)
    await pg.click("button:has-text('Start exam')")
    await pg.wait_for_timeout(4000)
    await pg.click("button:has-text('Start secure exam')")
    await pg.wait_for_timeout(5000)
    body = await pg.inner_text("body")
    if not ("Question" in body or "Submit" in body):
        print("exam never started:\n", body[:400]); sys.exit(1)
    print("  student is in the running exam")

    await pg.evaluate("window.__blockCamera()")
    await pg.wait_for_timeout(6000)
    ov = await pg.query_selector("div[style*='z-index: 80']")
    if not ov:
        print("student was never locked out — nothing to show the invigilator"); sys.exit(1)
    print("  camera blocked, student is locked out")
    # Leave the tab OPEN and in_progress: the Live Monitor must show a live exam.
    return pg


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True, args=[
            "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])

        print("\n=== PHASE A: candidate blocks the camera ===")
        sctx = await b.new_context(viewport={"width": 1440, "height": 900}, permissions=["camera"])
        await sctx.add_init_script(INIT)
        spg = await student_blocks_camera(sctx)

        print("\n=== PHASE B: what the invigilator sees ===")
        actx = await b.new_context(viewport={"width": 1600, "height": 1000})
        apg = await actx.new_page()
        apg.on("pageerror", lambda e: print("  [pageerror]", str(e)[:200]))

        await apg.goto(f"{BASE}/login", wait_until="networkidle")
        ins = await apg.query_selector_all("input")
        await ins[0].fill(ADMIN)
        await ins[1].fill(ADMIN_PW)
        await apg.click("button:has-text('Sign in')")
        await apg.wait_for_timeout(4000)
        # Don't assert on the URL: the SPA can still be sitting on /login for a
        # beat after the session cookie lands. What matters is that the cookie
        # authorises an admin-only call.
        who = await apg.evaluate("""async () => {
            const r = await fetch('/api/monitor', { credentials: 'include' });
            return r.status; }""")
        check("admin can sign in", who == 200, f"/api/monitor -> {who}")

        # ---- the raw payload the page renders from ----
        payload = await apg.evaluate("""async () => {
            const r = await fetch('/api/monitor', { credentials: 'include' });
            return { status: r.status, body: await r.json() }; }""")
        check("/api/monitor authorises the invigilator", payload["status"] == 200, str(payload["status"]))
        live = payload["body"].get("live") or []
        check("the running exam is listed as live", len(live) > 0, f"live={len(live)}")

        row = None
        for ex in live:
            for st in ex.get("students", []):
                if st.get("status") == "in_progress":
                    row = st
                    break
            if row:
                break
        check("the blocked candidate appears as in progress", row is not None)
        if row:
            print("   |", json.dumps({k: row.get(k) for k in
                  ["student", "rollNo", "status", "violations", "examId", "online"]}))
            check("the block is counted as a violation", (row.get("violations") or 0) >= 1,
                  f"violations={row.get('violations')}")
            check("the row carries examId (the drawer needs it to load evidence)",
                  bool(row.get("examId")), str(row.get("examId")))

        # ---- the evidence feed the drawer actually reads ----
        if row and row.get("examId"):
            ev = await apg.evaluate("""async ([examId, attemptId]) => {
                const r = await fetch(`/api/reports/${examId}/attempt/${attemptId}`, { credentials: 'include' });
                return { status: r.status, body: await r.json() }; }""",
                [row["examId"], row["attemptId"]])
            check("the drawer's evidence endpoint answers", ev["status"] == 200, str(ev["status"]))
            events = (ev["body"] or {}).get("integrity") or []
            types = [e.get("type") for e in events]
            print("   | event types:", types)
            check("a camera_blocked event is in the feed", "camera_blocked" in types, str(types))

        # ---- the rendered page ----
        await apg.goto(f"{BASE}/monitor", wait_until="networkidle")
        await apg.wait_for_timeout(7000)
        body = await apg.inner_text("body")
        await apg.screenshot(path="/tmp/m1_monitor.png", full_page=True)
        check("the monitor is not stuck on an empty state",
              "Nothing live" not in body and "No live" not in body, body[:160].replace("\n", " | "))
        check("the candidate's name is on screen", "Priya" in body, body[:200].replace("\n", " | "))
        check("the monitor reports itself healthy (not degraded)", "degraded" not in body.lower())

        # The invigilator must see the flag WITHOUT opening anything.
        # Read the FLAGS CELL by its column header. Searching the whole row for
        # "1" is vacuous — the roll number STU-21CS102 contains a "1", so that
        # version passed while the cell actually read "Clean" (caught by mutation).
        flag = await apg.evaluate("""() => {
            const row = [...document.querySelectorAll('tr')]
              .find(r => (r.innerText||'').includes('STU-21CS102'));
            if (!row) return { err: 'NO_ROW' };
            const heads = [...row.closest('table').querySelectorAll('th')]
              .map(h => (h.innerText||'').trim().toUpperCase());
            const i = heads.indexOf('FLAGS');
            if (i < 0) return { err: 'NO_FLAGS_COLUMN', heads };
            const cells = [...row.querySelectorAll('td')];
            return { flags: (cells[i]?.innerText || '').trim(),
                     status: row.innerText.includes('In progress') }; }""")
        print("   | flags cell:", flag)
        check("the candidate's row shows a flag count at a glance",
              flag.get("flags") == "1" and flag.get("status") is True, str(flag))

        # open the drawer for that candidate
        opened = False
        for sel in ["text=Priya Nair", "text=STU-21CS102"]:
            el = await apg.query_selector(sel)
            if el:
                await el.click()
                await apg.wait_for_timeout(6000)
                opened = True
                break
        check("clicking the candidate opens their drawer", opened)
        if opened:
            dbody = await apg.inner_text("body")
            await apg.screenshot(path="/tmp/m2_drawer.png", full_page=True)
            # Assert on the TITLE ELEMENT, not on the page text. The detail line
            # reads "Camera access blocked by the candidate (permission denied)",
            # so a substring search over the body passes even when EVENT_LABEL has
            # no entry and the row falls back to the raw "camera blocked" — this
            # check was vacuous until a mutation run caught it.
            title = await apg.evaluate("""() => {
                const d = [...document.querySelectorAll('div')].find(
                  e => e.children.length === 0 && (e.textContent||'').trim() === 'Camera access blocked');
                return d ? d.textContent.trim() : null; }""")
            check("the drawer shows the readable label, not the raw event name",
                  title == "Camera access blocked", f"title={title!r}")
            check("it does NOT fall back to 'No violations recorded'",
                  "No violations recorded" not in dbody)
            check("the block is described as a deliberate denial",
                  "permission denied" in dbody.lower() or "blocked by the candidate" in dbody.lower())
            # serious events render red (#c0453b), routine ones amber
            red = await apg.evaluate("""() => {
                const label = [...document.querySelectorAll('div')].find(
                  d => d.children.length === 0 && (d.textContent||'').trim() === 'Camera access blocked');
                if (!label) return 'NO_ROW';
                const card = label.closest('.card');
                if (!card) return 'NO_CARD';
                const icon = card.firstElementChild;   // the coloured shield badge
                return icon ? getComputedStyle(icon).color : 'NO_ICON'; }""")
            check("it is flagged as serious (red), not routine (amber)",
                  isinstance(red, str) and "192, 69, 59" in red, str(red))

        print("\n=== RESULT ===")
        if FAILS:
            print(f"{len(FAILS)} FAILED: " + "; ".join(FAILS))
        else:
            print("all checks passed")
        print("screenshots: /tmp/m1_monitor.png /tmp/m2_drawer.png")
        await b.close()
        sys.exit(1 if FAILS else 0)


asyncio.run(main())
