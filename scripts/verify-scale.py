"""Ops check: the hot student endpoints still behave, and now cost far fewer
database round trips.

WHY THIS EXISTS
---------------
At ~1000 concurrent students the exam pages stopped loading. Part of the cause was
the number of REMOTE database round trips each student request made — the database
is Turso over HTTP, so every statement is a network hop, and the hot paths ran
three to nine of them per request while the whole fleet polled every few seconds.

The fix rewrote those paths (cached exam row / question set / settings, an
UPDATE ... RETURNING heartbeat, one batched answer upsert, a bounded event-dedupe
read). Fewer statements is worthless if any of it changed what students get, so
this script asserts BOTH halves against a live server:

  * behaviour — login, bundle, start, status, autosave (including the per-student
    option-order round trip), event dedupe on resend, heartbeat reaching the
    invigilator's Live Monitor, and no duplicate rows anywhere afterwards
  * cost — statements per request, read from /api/health's `db.queries` counter,
    asserted against a budget so a future change that reintroduces a per-request
    read fails this check instead of failing an exam hall

Needs a server running against a SEEDED throwaway database — never production, it
starts a real attempt and writes answers:

    rm -f .tmp-verify.db*
    export DATABASE_URL="file:$PWD/.tmp-verify.db"; unset DATABASE_AUTH_TOKEN
    bun run db:push --force && bun run seed
    bun run build
    PORT=3100 bun src/server.ts &
    python3 scripts/verify-scale.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

# Overridable so the same measurement can be taken against another build
# (e.g. a worktree of the previous commit) for a real before/after.
BASE = os.environ.get("VERIFY_BASE", "http://localhost:3100")
STUDENT = "STU-21CS102"
STUDENT_PW = "Welcome@123"
ADMIN = "meera@grce.edu"
ADMIN_PW = "Admin@123"
# /api/admin/invariants is super-admin only; the tenant admin above is what an
# invigilator uses, so both sessions are needed.
SUPER_ADMIN = "admin@skilltimate.com"
SUPER_ADMIN_PW = "Admin@123"

FAILS = []
COSTS = {}


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        FAILS.append(name)


class Http:
    """Minimal JSON client with a cookie jar (needed for the admin session)."""

    def __init__(self):
        self.cookies = {}

    def request(self, method, path, body=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
        req.add_header("Content-Type", "application/json")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        if self.cookies:
            req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in self.cookies.items()))
        try:
            with urllib.request.urlopen(req) as res:
                raw = res.read()
                status = res.status
                for header in res.headers.get_all("Set-Cookie") or []:
                    pair = header.split(";")[0]
                    if "=" in pair:
                        k, v = pair.split("=", 1)
                        self.cookies[k] = v
        except urllib.error.HTTPError as err:
            raw, status = err.read(), err.code
        try:
            return status, json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return status, {"raw": raw[:200].decode(errors="replace")}

    def get(self, path, headers=None):
        return self.request("GET", path, None, headers)

    def post(self, path, body=None, headers=None):
        return self.request("POST", path, body or {}, headers)


http = Http()
admin = Http()
root = Http()


def db_queries():
    """Statements this server process has sent to the database since boot."""
    status, payload = http.get("/api/health")
    if status not in (200, 503):
        return None
    return ((payload.get("db") or {}).get("queries"))


def measure(label, fn, budget):
    """Run fn and record how many database statements it cost."""
    before = db_queries()
    result = fn()
    after = db_queries()
    if before is None or after is None:
        check(f"{label}: cost measurable", False, "/api/health has no db.queries counter")
        return result
    # The two /api/health reads themselves do not touch the database (they read
    # in-memory state), so the delta is the endpoint's own cost.
    cost = after - before
    COSTS[label] = cost
    check(f"{label}: {cost} db statement(s), budget {budget}", cost <= budget, f"measured {cost}")
    return result


def main():
    print("\n=== Phase 0: server reachable and reporting its query cost ===")
    status, health = http.get("/api/health")
    check("/api/health answers", status in (200, 503), f"status {status}")
    check("/api/health exposes db.queries", isinstance((health.get("db") or {}).get("queries"), int),
          json.dumps(health.get("db")))

    print("\n=== Phase 1: student login + bundle ===")
    status, login = http.post("/api/students/verify-login", {"identifier": STUDENT, "password": STUDENT_PW})
    check("student login", status == 200 and bool(login.get("token")), f"status {status}")
    if not login.get("token"):
        return finish()
    token = login["token"]
    auth = {"x-student-token": token}

    status, listing = http.get("/api/student/exams", auth)
    check("exam list", status == 200 and isinstance(listing.get("exams"), list), f"status {status}")
    live = [e for e in listing.get("exams", []) if e.get("phase") in ("available", "in_progress")]
    check("a startable exam is seeded", bool(live), f"{len(listing.get('exams', []))} exam(s) visible")
    if not live:
        return finish()
    exam_id = live[0]["id"]

    status, bundle = http.get(f"/api/student/exams/{exam_id}/bundle", auth)
    check("exam bundle", status == 200 and bool(bundle.get("questions")), f"status {status}")
    scheme = bundle.get("optionOrder")
    questions = bundle.get("questions", [])
    mcq = [q for q in questions if q.get("type") in ("mcq", "msq") and q.get("options")]
    check("bundle carries the option-order scheme token", bool(scheme), str(scheme))
    check("bundle has multiple-choice questions to translate", bool(mcq), f"{len(mcq)} of {len(questions)}")

    print("\n=== Phase 2: start the attempt ===")
    status, started = http.post(f"/api/student/attempts/{exam_id}/start", {"optionOrder": scheme}, auth)
    check("attempt starts", status == 200 and bool(started.get("attemptId")), f"status {status}")
    attempt_id = started.get("attemptId")
    if not attempt_id:
        return finish()

    print("\n=== Phase 3: heartbeat (was 3 statements: exam + attempt + update) ===")
    # Warm the exam cache first: the very first heartbeat of an exam legitimately
    # reads the exam row, every one after it must not.
    http.post(f"/api/student/heartbeat/{exam_id}", {}, auth)
    beat = measure("heartbeat", lambda: http.post(f"/api/student/heartbeat/{exam_id}", {}, auth), budget=1)
    status, body = beat
    check("heartbeat answers with the server-anchored deadline",
          status == 200 and bool(body.get("endAt")) and bool(body.get("serverNow")), f"status {status}")
    check("heartbeat reports the hold state", "held" in body, json.dumps(body)[:120])

    print("\n=== Phase 4: autosave (was 7+N: attempt + questions + translator×2 + N upserts + all answers + update) ===")
    first = mcq[0]
    display_index = 1 if len(first["options"]) > 1 else 0
    save = measure(
        "autosave one answer",
        lambda: http.post(
            f"/api/student/attempts/{attempt_id}/answers",
            {"answers": [{"questionId": first["id"], "response": display_index}], "optionOrder": scheme},
            auth,
        ),
        budget=4,
    )
    status, body = save
    check("autosave accepted", status == 200 and body.get("ok") is True, f"status {status}")
    check("answeredCount counts the saved answer", (body.get("answeredCount") or 0) >= 1, str(body.get("answeredCount")))

    # The whole point of the batched upsert: a reconnect flush carrying every
    # question must be one statement per chunk, not one per answer.
    batch = [
        {"questionId": q["id"], "response": (0 if q.get("type") == "mcq" else [0])}
        for q in mcq[1:]
    ]
    if batch:
        save_all = measure(
            f"autosave batch of {len(batch)}",
            lambda: http.post(
                f"/api/student/attempts/{attempt_id}/answers",
                {"answers": batch, "optionOrder": scheme},
                auth,
            ),
            budget=4,
        )
        status, body = save_all
        check("batch autosave accepted", status == 200 and body.get("ok") is True, f"status {status}")
        check("answeredCount counts the whole batch",
              (body.get("answeredCount") or 0) >= len(mcq), f"{body.get('answeredCount')} of {len(mcq)}")

    # Same question twice inside ONE batch: SQLite refuses to apply ON CONFLICT
    # twice to the same row, so the endpoint must collapse it and keep the last value.
    dup_display = 0 if display_index != 0 else 1
    status, body = http.post(
        f"/api/student/attempts/{attempt_id}/answers",
        {"answers": [{"questionId": first["id"], "response": display_index},
                     {"questionId": first["id"], "response": dup_display}],
         "optionOrder": scheme},
        auth,
    )
    check("a repeated questionId in one batch does not error", status == 200 and body.get("ok") is True,
          f"status {status} {json.dumps(body)[:120]}")

    print("\n=== Phase 5: option-order round trip survives the cached question set ===")
    status, st = measure(
        "status poll",
        lambda: http.get(f"/api/student/attempts/{exam_id}/status?optionOrder={scheme}", auth),
        budget=5,
    )
    check("status reports the running attempt", status == 200 and st.get("status") == "in_progress", f"status {status}")
    answers = st.get("answers") or {}
    check("the last write wins for a repeated questionId",
          answers.get(first["id"]) == dup_display,
          f"stored→display {answers.get(first['id'])}, expected {dup_display}")
    check("every batched answer reads back in display order",
          all(answers.get(q["id"]) is not None for q in mcq),
          f"{len(answers)} of {len(mcq)} present")

    print("\n=== Phase 6: integrity events dedupe on resend (bounded read) ===")
    now = int(time.time() * 1000)
    old_event = [{"type": "tab_switch", "detail": "first", "at": now - 3_600_000}]
    status, body = http.post(f"/api/student/attempts/{attempt_id}/events", {"events": old_event}, auth)
    check("an event is stored", status == 200 and body.get("saved") == 1, json.dumps(body))

    fresh = [{"type": "tab_switch", "detail": f"n{i}", "at": now - i * 1000} for i in range(1, 4)]
    status, body = measure(
        "event flush (3 new)",
        lambda: http.post(f"/api/student/attempts/{attempt_id}/events", {"events": fresh}, auth),
        budget=3,
    )
    check("newer events are stored", status == 200 and body.get("saved") == 3, json.dumps(body))

    status, body = measure(
        "event flush (nothing new)",
        lambda: http.post(f"/api/student/attempts/{attempt_id}/events", {"events": fresh}, auth),
        budget=2,
    )
    check("an immediate resend saves nothing", status == 200 and body.get("saved") == 0, json.dumps(body))

    # The submit backstop resends EVERYTHING, oldest first — the case the bounded
    # dedupe read has to get right.
    status, body = http.post(f"/api/student/attempts/{attempt_id}/events", {"events": old_event + fresh}, auth)
    check("the submit-style full resend saves nothing", status == 200 and body.get("saved") == 0, json.dumps(body))

    status, body = http.post(
        f"/api/student/attempts/{attempt_id}/events",
        {"events": old_event + fresh + [{"type": "fullscreen_exit", "detail": "new", "at": now + 1000}]},
        auth,
    )
    check("a genuinely new event inside a resend is still stored",
          status == 200 and body.get("saved") == 1, json.dumps(body))

    print("\n=== Phase 7: the invigilator still sees this student ===")
    status, signin = admin.post("/api/auth/sign-in/email", {"email": ADMIN, "password": ADMIN_PW})
    check("admin signs in", status == 200, f"status {status}")
    http.post(f"/api/student/heartbeat/{exam_id}", {}, auth)
    status, monitor = admin.get("/api/monitor")
    check("/api/monitor answers", status == 200, f"status {status}")
    rows = []
    for exam in monitor.get("live", []):
        rows.extend(exam.get("students", []) or exam.get("rows", []) or [])
    mine = [r for r in rows if r.get("attemptId") == attempt_id or r.get("rollNo") == STUDENT]
    check("the live attempt appears on the Live Monitor", bool(mine),
          f"{len(rows)} row(s) across {len(monitor.get('live', []))} live exam(s)")
    if mine:
        row = mine[0]
        seen = row.get("lastSeenAt") or row.get("seenAt")
        check("the heartbeat's lastSeenAt reached the monitor", bool(seen) or row.get("online") is True,
              json.dumps({k: row.get(k) for k in ("online", "lastSeenAt", "seenAt", "answered", "violations")}))
        check("violations counted for this attempt", (row.get("violations") or 0) >= 1, str(row.get("violations")))

    print("\n=== Phase 8: nothing was corrupted, and the perf indexes exist ===")
    status, signin = root.post("/api/auth/sign-in/email", {"email": SUPER_ADMIN, "password": SUPER_ADMIN_PW})
    check("super admin signs in", status == 200, f"status {status}")
    # NOTE: `ok` itself is not asserted here. `bun run seed` inserts four already
    # graded attempts that have no answer rows at all, so a freshly seeded database
    # always reports attemptsWithDenominatorMismatch: 4 and `ok: false` — a property
    # of the seed script, not of anything this check exercises. The individual
    # guarantees below are what must hold.
    status, inv = root.get("/api/admin/invariants")
    check("/api/admin/invariants answers", status in (200, 500) and "indexes" in inv, f"status {status}")
    check("no attempt has an impossible score", inv.get("attemptsWithImpossibleScore") == 0,
          str(inv.get("attemptsWithImpossibleScore")))
    print(f"  [note] attemptsWithDenominatorMismatch = {inv.get('attemptsWithDenominatorMismatch')} "
          "(seeded graded attempts carry no answer rows)")
    for entry in inv.get("indexes", []):
        check(f"unique index {entry['index']} present with no duplicates",
              entry.get("present") is True and entry.get("duplicateGroups") == 0, json.dumps(entry))
    perf = inv.get("perfIndexes", [])
    check("performance indexes are reported", len(perf) >= 2, json.dumps(perf))
    for entry in perf:
        check(f"perf index {entry['index']} created at boot", entry.get("present") is True, json.dumps(entry))

    finish()


def finish():
    print("\n=== Measured cost per request ===")
    for label, cost in COSTS.items():
        print(f"  {label}: {cost} statement(s)")
    print(f"\n{len(COSTS)} measurement(s), {len(FAILS)} failure(s)")
    if FAILS:
        print("FAILED: " + "; ".join(FAILS))
        sys.exit(1)
    print("ALL CHECKS PASSED")
    sys.exit(0)


if __name__ == "__main__":
    main()
