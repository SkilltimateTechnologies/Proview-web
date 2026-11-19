"""End-to-end check: a student sits a whole exam in a real browser.

Needs a server running against a SEEDED throwaway database (never production —
this creates exams, changes settings and submits real attempts) and the built
assets:

    rm -f .tmp-verify.db*
    export DATABASE_URL="file:$PWD/.tmp-verify.db"; unset DATABASE_AUTH_TOKEN
    bun run db:push --force && bun run seed
    bun run build
    PORT=3100 bun src/server.ts &
    bun run e2e

It refuses any base that is not localhost. Set VERIFY_BASE to use another port.

WHAT IT COVERS
--------------
1. Happy path, the way a candidate does it: first sign-in with the default
   password, the forced password change, the dashboard, the brief, the system
   check, "Start secure exam", answering an MCQ and a short answer, Submit, the
   thank-you screen — and then, from the ADMIN side, that the attempt is
   submitted with both answers counted.
2. The minimum-time rule: with "Minimum time before Submit" at 20 minutes the
   Submit button reads "Submit in mm:ss" and is disabled, and the API refuses
   an early submit with 409 too_early.
3. A lab PC whose clock is 82 minutes fast (a real case from 19 Nov 2026): the
   exam must keep running on server time — no auto-submit, the timer shows the
   real time left, and the attempt is still in progress after 12 seconds.

None of this is reachable from a unit test: each part only exists once a real
attempt is running in a real browser.
"""
import asyncio, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from playwright.async_api import async_playwright

BASE = os.environ.get("VERIFY_BASE", "http://localhost:3100").rstrip("/")
if urllib.parse.urlparse(BASE).hostname not in ("localhost", "127.0.0.1", "::1"):
    sys.exit(f"refusing to run against {BASE}: this check writes exams and attempts. Use a local throwaway server.")

ADMIN = ("admin@skilltimate.com", "Admin@123")
SEED_PW = "Welcome@123"
NEW_PW = "Verify@1234"
FAILS = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        FAILS.append(name)


def call(method, path, body=None, headers=None):
    h = {"Content-Type": "application/json", "Origin": BASE, **(headers or {})}
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
            return r.status, dict(r.headers), (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, dict(e.headers), json.loads(raw)
        except Exception:
            return e.code, dict(e.headers), {"raw": raw[:200].decode(errors="replace")}


def admin_headers():
    st, hd, _ = call("POST", "/api/auth/sign-in/email", {"email": ADMIN[0], "password": ADMIN[1]})
    token = next((v for k, v in hd.items() if k.lower() == "set-auth-token"), None)
    if st != 200 or not token:
        sys.exit(f"admin sign-in failed ({st}). Is the database seeded?")
    A = {"Authorization": f"Bearer {token}"}
    _, _, t = call("GET", "/api/tenants", headers=A)
    A["X-Tenant-Id"] = (t.get("tenants") if isinstance(t, dict) else t)[0]["id"]
    return A


def set_proctoring(A, **kw):
    # Webcam and fullscreen are off: headless Chromium has no real camera to
    # judge and cannot hold kiosk fullscreen. Those paths have their own checks
    # (verify:camera-*). Everything else here is the real flow.
    base = dict(requireWebcam=False, fullscreenRequired=False, requireSingleScreen=False,
                webcamSnapshots=False, detectCameraBlock=False)
    st, _, _ = call("PATCH", "/api/settings", {"proctoring": {**base, **kw}}, A)
    if st != 200:
        sys.exit(f"could not update settings ({st})")


def make_exam(A, roll, title, duration=30):
    _, _, s = call("GET", "/api/students", headers=A)
    stu = next(x for x in s["students"] if x["rollNo"] == roll)
    _, _, mcq = call("POST", "/api/questions", {
        "type": "mcq", "prompt": "E2E: which number is even?", "points": 2,
        "options": ["7", "4", "9", "11"], "correct": 1, "difficulty": "easy"}, A)
    _, _, short = call("POST", "/api/questions", {"type": "short", "prompt": "E2E: say hello", "points": 1, "difficulty": "easy"}, A)
    qids = [mcq["question"]["id"], short["question"]["id"]]
    st, _, ex = call("POST", "/api/exams", {
        "title": title, "questionIds": qids, "durationMin": duration,
        "startAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - 10)),
        "status": "scheduled", "assignMode": "students", "studentIds": [stu["id"]]}, A)
    if st not in (200, 201):
        sys.exit(f"could not create exam ({st}): {ex}")
    return ex["exam"]["id"], mcq["question"]


async def sign_in(pg, roll):
    """Sign in through the UI, handling the first-sign-in password change."""
    await pg.goto(f"{BASE}/px9k2m7/login", wait_until="networkidle")
    for pw in (SEED_PW, NEW_PW):
        await pg.get_by_placeholder("STU-21CS102").fill(roll)
        await pg.locator("input[type=password]").first.fill(pw)
        await pg.get_by_role("button", name=re.compile(r"^Sign in")).click()
        await pg.wait_for_timeout(3000)
        body = await pg.inner_text("body")
        if "Create a new password" in body:
            fields = pg.locator("input[type=password]")
            for i, v in enumerate((pw, NEW_PW, NEW_PW)):
                await fields.nth(i).fill(v)
            await pg.get_by_role("button", name=re.compile("Set new password")).click()
            await pg.wait_for_timeout(3500)
            return "changed"
        if "/login" not in pg.url:
            return "signed-in"
        await pg.goto(f"{BASE}/px9k2m7/login", wait_until="networkidle")
    return None


async def open_exam(pg, exam_id):
    """Dashboard -> brief -> system check -> Start secure exam."""
    await pg.goto(f"{BASE}/px9k2m7/exam/{exam_id}", wait_until="networkidle")
    await pg.wait_for_timeout(1500)
    check("a reload keeps the session and the deep link", f"/exam/{exam_id}" in pg.url, pg.url)
    await pg.get_by_role("button", name=re.compile("Start exam")).first.click(timeout=20000)
    await pg.get_by_role("button", name=re.compile("Start secure exam")).click(timeout=20000)
    await pg.wait_for_timeout(4000)


async def happy_path(browser, A):
    print("\n=== 1. full exam, as a candidate ===")
    set_proctoring(A, minSubmitMinutes=0)
    title = f"E2E flow {int(time.time())}"
    exam_id, mcq = make_exam(A, "STU-21CS102", title)
    ctx = await browser.new_context(viewport={"width": 1366, "height": 860}, permissions=["camera"])
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)[:200]))

    how = await sign_in(pg, "STU-21CS102")
    check("student signs in (first-sign-in password change handled)", how is not None, str(how))
    body = await pg.inner_text("body")
    check("dashboard lists the new exam", title in body, body[:160].replace("\n", " | "))

    await open_exam(pg, exam_id)
    body = await pg.inner_text("body")
    check("exam is running", "Submit" in body or "Next" in body, body[:160].replace("\n", " | "))

    # Answer both questions. Question order and option order are shuffled per
    # candidate, so work from what is on screen and pick the MCQ option by TEXT.
    for i in range(2):
        if await pg.locator(".opt-row").count():
            await pg.locator(".opt-row").filter(has=pg.locator("span", has_text=re.compile(r"^4$"))).first.click()
            await pg.wait_for_timeout(500)
            check("MCQ option is marked as chosen", await pg.locator(".opt-row.sel").count() == 1)
        else:
            await pg.get_by_placeholder("Type your answer…").fill("hello from the e2e check")
            await pg.wait_for_timeout(800)
        if i == 0:
            await pg.get_by_role("button", name=re.compile(r"^Next")).click()
            await pg.wait_for_timeout(600)
    body = await pg.inner_text("body")
    check("answered counter shows 2 of 2", "2 of 2 answered" in body.replace("\n", " "), "")

    submit = pg.get_by_role("button", name=re.compile("Submit exam"))
    check("Submit is enabled with no minimum time", await submit.is_enabled())
    await submit.click()
    await pg.wait_for_timeout(5000)
    body = await pg.inner_text("body")
    check("thank-you screen shown", "Thank you for taking the exam" in body, body[:200].replace("\n", " | "))
    await pg.screenshot(path="/tmp/e2e_1_done.png")

    # Admin side: the attempt is submitted and both answers were received.
    _, _, rep = call("GET", f"/api/reports/{exam_id}", headers=A)
    atts = rep.get("results") or []
    att = atts[0] if atts else {}
    check("admin report shows the attempt as submitted",
          att.get("status") in ("submitted", "graded", "evaluated"), json.dumps(att)[:200])
    check("admin report counts 2 answers", att.get("answeredCount") == 2, str(att.get("answeredCount")))
    # MCQ (2 pts) right, short answer (1 pt) waits for evaluation: 2/3 = 66.7%.
    # Proves the option picked by TEXT through the shuffle was scored as correct.
    check("MCQ scored correct through the option shuffle", att.get("score") is not None and abs(att["score"] - 66.7) < 0.2, str(att.get("score")))
    check("no uncaught page errors", not errors, "; ".join(errors[:3]))
    await ctx.close()


async def min_time_and_fast_clock(browser, A):
    print("\n=== 2+3. minimum time before Submit, on a PC whose clock is 82 minutes fast ===")
    set_proctoring(A, minSubmitMinutes=20)
    exam_id, _ = make_exam(A, "STU-21CS044", f"E2E clock {int(time.time())}")
    ctx = await browser.new_context(viewport={"width": 1366, "height": 860}, permissions=["camera"])
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)[:200]))
    await pg.clock.set_system_time(time.time() + 82 * 60)  # the PC clock is wrong; real timers still run

    how = await sign_in(pg, "STU-21CS044")
    check("student signs in on the fast-clock PC", how is not None, str(how))
    await open_exam(pg, exam_id)
    await pg.wait_for_timeout(12000)  # the old code auto-submitted ~5 s in

    body = await pg.inner_text("body")
    check("not auto-submitted", not re.search(r"Submitting your exam|Thank you for taking", body), body[:160].replace("\n", " | "))
    tok = await pg.evaluate("localStorage.getItem('examly:token')")  # the page's own session
    _, _, s = call("GET", f"/api/student/attempts/{exam_id}/status", headers={"X-Student-Token": tok or ""})
    check("attempt still in progress after 12 s", s.get("status") == "in_progress", str(s.get("status")))
    timers = re.findall(r"\b(\d{1,2}):(\d{2})\b", body)
    mins = [int(m) for m, _ in timers]
    check("timer shows the real time left (~29 min)", any(28 <= m <= 30 for m in mins), str(timers[:4]))

    await pg.get_by_role("button", name=re.compile(r"^Next")).click()
    await pg.wait_for_timeout(600)
    btn = pg.get_by_role("button", name=re.compile(r"Submit in \d+:\d\d"))
    label = (await btn.first.text_content() or "").strip() if await btn.count() else ""
    check("Submit is locked with a countdown", bool(label) and not await btn.first.is_enabled(), label)
    m = re.search(r"Submit in (\d+):", label)
    check("countdown is ~20 minutes, not skewed by the PC clock", bool(m) and 18 <= int(m.group(1)) <= 20, label)

    st, _, j = call("POST", f"/api/student/attempts/{s.get('attemptId')}/submit", {}, {"X-Student-Token": tok or ""})
    check("API refuses an early submit with 409 too_early", st == 409 and j.get("code") == "too_early", f"{st} {j}")
    check("no uncaught page errors", not errors, "; ".join(errors[:3]))
    await pg.screenshot(path="/tmp/e2e_2_fastclock.png")
    await ctx.close()


async def main():
    A = admin_headers()
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=[
            "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
        try:
            await happy_path(browser, A)
            await min_time_and_fast_clock(browser, A)
        finally:
            set_proctoring(A, minSubmitMinutes=20)
            await browser.close()
    print("\n" + ("ALL PASS" if not FAILS else f"{len(FAILS)} FAILED: " + "; ".join(FAILS)))
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    asyncio.run(main())
