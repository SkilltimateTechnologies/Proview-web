"""Load generator: N students sitting one exam at the real client cadence.

WHY THIS EXISTS
---------------
"Pages don't load at 1000 students" has to be reproduced before it can be called
fixed. This drives a locally running server with the SAME request mix the desktop
exam client produces, at the same intervals, from N independent virtual students,
and reports throughput, per-endpoint latency percentiles and errors — plus what a
cold page load actually transfers, which is what "the page won't load" was.

It seeds its own students and attempts straight into the throwaway SQLite file
(1000 logins would measure bcrypt, not the server) and mints the same HMAC
`x-student-token` the app issues, so every request travels the real code path.

NEVER point this at production: it writes attempts, answers and integrity events.

    # server already running against a seeded throwaway DB (see verify-scale.py)
    python3 scripts/loadtest-exam.py --db .tmp-verify.db --base http://localhost:3100 \
        --students 1000 --seconds 60

Cadence per student, taken from src/web/student/pages/exam-runner.tsx:
    heartbeat        every 15s   (POST /student/heartbeat/:examId)
    answer autosave  every 20s   (POST /student/attempts/:id/answers)
    event flush      every 30s   (POST /student/attempts/:id/events)
    snapshot url     every 27s   (POST /student/attempts/:id/snapshot-url)
    status poll        once      (GET  /student/attempts/:examId/status)
"""

import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import os
import random
import sqlite3
import statistics
import time
import urllib.error
import urllib.request
import uuid

HEARTBEAT_S = 15
AUTOSAVE_S = 20
EVENTS_S = 30
SNAPSHOT_S = 27


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def student_token(student_id: str, secret: str) -> str:
    """Same format as src/api/lib/student-token.ts: b64url(payload).b64url(hmac)."""
    payload = f"{student_id}.{int(time.time() * 1000)}".encode()
    sig = hmac.new(secret.encode(), payload, hashlib.sha256).digest()
    return f"{b64url(payload)}.{b64url(sig)}"


def read_secret(env_path: str) -> str:
    if os.environ.get("BETTER_AUTH_SECRET"):
        return os.environ["BETTER_AUTH_SECRET"]
    with open(env_path) as handle:
        for line in handle:
            if line.startswith("BETTER_AUTH_SECRET="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("BETTER_AUTH_SECRET not found — needed to mint student tokens")


def rid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def seed_students(db_path: str, count: int):
    """Create `count` students on the live exam, each with a running attempt."""
    con = sqlite3.connect(db_path)
    con.execute("PRAGMA busy_timeout = 5000")
    exam = con.execute(
        "SELECT id, tenant_id FROM exams WHERE status = 'live' ORDER BY created_at LIMIT 1"
    ).fetchone()
    if not exam:
        raise SystemExit("no live exam in this database — run `bun run seed` first")
    exam_id, tenant_id = exam
    question_ids = [
        row[0]
        for row in con.execute(
            "SELECT question_id FROM exam_questions WHERE exam_id = ? ORDER BY \"order\"", (exam_id,)
        )
    ]
    class_id = con.execute(
        "SELECT id FROM classes WHERE tenant_id = ? LIMIT 1", (tenant_id,)
    ).fetchone()[0]
    # A pre-hashed password nobody logs in with: the students exist so the exam
    # endpoints have real rows to read, and tokens are minted directly.
    pw = "$2b$10$loadtestloadtestloadtestloadtestloadtestloadtestloadtestloadte"
    now = int(time.time() * 1000)

    existing = {
        row[0]: row[1]
        for row in con.execute(
            "SELECT s.id, a.id FROM students s LEFT JOIN attempts a"
            " ON a.student_id = s.id AND a.exam_id = ?"
            " WHERE s.roll_no LIKE 'LOAD-%'",
            (exam_id,),
        )
    }
    students = []
    for i in range(count):
        roll = f"LOAD-{i:05d}"
        row = con.execute("SELECT id FROM students WHERE roll_no = ?", (roll,)).fetchone()
        student_id = row[0] if row else rid("stu")
        if not row:
            con.execute(
                "INSERT INTO students (id, tenant_id, class_id, roll_no, name, email, password,"
                " must_change_password, enabled, created_at)"
                " VALUES (?,?,?,?,?,?,?,0,1,?)",
                (student_id, tenant_id, class_id, roll, f"Load Test {i}", f"{roll.lower()}@load.test", pw, now),
            )
        attempt_id = existing.get(student_id)
        if not attempt_id:
            attempt_id = rid("att")
            con.execute(
                "INSERT INTO attempts (id, exam_id, student_id, status, started_at, paused_ms,"
                " last_seen_at, answered_count, disconnected, created_at)"
                " VALUES (?,?,?,'in_progress',?,0,?,0,0,?)",
                (attempt_id, exam_id, student_id, now, now, now),
            )
        students.append({"studentId": student_id, "attemptId": attempt_id})
    con.commit()
    con.close()
    return exam_id, question_ids, students


class Stats:
    def __init__(self):
        self.samples = {}
        self.errors = {}

    def record(self, label, ms, ok):
        self.samples.setdefault(label, []).append(ms)
        if not ok:
            self.errors[label] = self.errors.get(label, 0) + 1

    def report(self, seconds):
        total = sum(len(v) for v in self.samples.values())
        print(f"\n  requests: {total} in {seconds:.1f}s = {total / seconds:.1f} req/s")
        print(f"  {'endpoint':<24}{'n':>7}{'ok%':>8}{'p50':>9}{'p95':>9}{'p99':>9}{'max':>9}")
        for label in sorted(self.samples):
            values = sorted(self.samples[label])
            n = len(values)
            failed = self.errors.get(label, 0)
            def pct(p):
                return values[min(n - 1, int(n * p))]
            print(
                f"  {label:<24}{n:>7}{100 * (n - failed) / n:>7.1f}%"
                f"{pct(0.5):>8.0f}ms{pct(0.95):>8.0f}ms{pct(0.99):>8.0f}ms{values[-1]:>8.0f}ms"
            )
        failures = sum(self.errors.values())
        print(f"  errors: {failures}" + ("" if not failures else f"  {json.dumps(self.errors)}"))
        return failures


async def call(session, stats, label, method, url, token, body=None):
    """One request through asyncio's thread pool (stdlib only, no extra deps)."""
    started = time.perf_counter()
    ok = True
    try:
        await asyncio.get_running_loop().run_in_executor(
            session, lambda: blocking_request(method, url, token, body)
        )
    except Exception:
        ok = False
    stats.record(label, (time.perf_counter() - started) * 1000, ok)


def blocking_request(method, url, token, body):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("x-student-token", token)
    with urllib.request.urlopen(req, timeout=30) as res:
        res.read()
        if res.status >= 400:
            raise RuntimeError(f"status {res.status}")


async def student_loop(pool, stats, base, exam_id, question_ids, student, token, deadline):
    """One virtual student, jittered so 1000 clients do not fire in lockstep."""
    attempt = student["attemptId"]
    await asyncio.sleep(random.uniform(0, 2))
    await call(pool, stats, "status", "GET",
               f"{base}/api/student/attempts/{exam_id}/status?optionOrder=v1", token)
    next_beat = time.monotonic() + random.uniform(0, HEARTBEAT_S)
    next_save = time.monotonic() + random.uniform(0, AUTOSAVE_S)
    next_events = time.monotonic() + random.uniform(0, EVENTS_S)
    next_snapshot = time.monotonic() + random.uniform(0, SNAPSHOT_S)

    while time.monotonic() < deadline:
        now = time.monotonic()
        if now >= next_beat:
            next_beat = now + HEARTBEAT_S
            await call(pool, stats, "heartbeat", "POST", f"{base}/api/student/heartbeat/{exam_id}", token, {})
        if now >= next_save:
            next_save = now + AUTOSAVE_S
            question = random.choice(question_ids)
            await call(pool, stats, "autosave", "POST",
                       f"{base}/api/student/attempts/{attempt}/answers", token,
                       {"answers": [{"questionId": question, "response": random.randint(0, 3)}],
                        "optionOrder": "v1"})
        if now >= next_events:
            next_events = now + EVENTS_S
            await call(pool, stats, "events", "POST",
                       f"{base}/api/student/attempts/{attempt}/events", token,
                       {"events": [{"type": "periodic_snapshot", "at": int(time.time() * 1000)}]})
        if now >= next_snapshot:
            next_snapshot = now + SNAPSHOT_S
            await call(pool, stats, "snapshot-url", "POST",
                       f"{base}/api/student/attempts/{attempt}/snapshot-url", token, {})
        await asyncio.sleep(0.25)


def page_load_cost(base):
    """What one cold page load actually transfers, and what a refresh re-transfers."""
    print("\n=== cold page load ===")
    shell = urllib.request.Request(base + "/")
    shell.add_header("Accept-Encoding", "gzip, br")
    with urllib.request.urlopen(shell) as res:
        html = res.read()
        etag = res.headers.get("ETag")
        encoding = res.headers.get("Content-Encoding")
        cache = res.headers.get("Cache-Control")
    print(f"  /                 {len(html):>9} bytes  encoding={encoding} cache={cache} etag={etag}")

    # Read it again uncompressed purely to parse out the asset URLs: urllib does
    # not decode brotli, and the point of the first read was the transferred size.
    plain = urllib.request.Request(base + "/")
    plain.add_header("Accept-Encoding", "identity")
    with urllib.request.urlopen(plain) as res:
        raw_html = res.read()
    print(f"  {'  (identity)':<18}{len(raw_html):>9} bytes  uncompressed shell")

    total = len(html)
    assets = []
    text = raw_html.decode(errors="replace")
    for marker in ('src="/assets/', 'href="/assets/'):
        start = 0
        while True:
            found = text.find(marker, start)
            if found < 0:
                break
            begin = found + len(marker) - len("assets/")
            end = text.find('"', begin)
            assets.append("/" + text[begin:end])
            start = end
    for path in assets:
        req = urllib.request.Request(base + path)
        req.add_header("Accept-Encoding", "gzip, br")
        with urllib.request.urlopen(req) as res:
            body = res.read()
            identity_len = res.headers.get("X-Identity-Length")
            print(f"  {path:<18}{len(body):>9} bytes  encoding={res.headers.get('Content-Encoding')} "
                  f"cache={res.headers.get('Cache-Control')}"
                  + (f" identity={identity_len}" if identity_len else ""))
            total += len(body)
            asset_etag = res.headers.get("ETag")
        uncompressed = urllib.request.Request(base + path)
        uncompressed.add_header("Accept-Encoding", "identity")
        with urllib.request.urlopen(uncompressed) as res:
            print(f"  {'  (identity)':<18}{len(res.read()):>9} bytes  what the old handler sent")
        if asset_etag:
            revalidate = urllib.request.Request(base + path)
            revalidate.add_header("If-None-Match", asset_etag)
            revalidate.add_header("Accept-Encoding", "gzip, br")
            try:
                with urllib.request.urlopen(revalidate) as res:
                    status = res.status
            except urllib.error.HTTPError as err:
                status = err.code
            print(f"  {'  revalidate':<18}{'':>9}         -> {status} (304 = nothing re-sent)")
    print(f"  TOTAL transferred for a cold load: {total} bytes ({total / 1024:.0f} KB)")
    return total


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://localhost:3100")
    parser.add_argument("--db", default=".tmp-verify.db")
    parser.add_argument("--env", default=".env")
    parser.add_argument("--students", type=int, default=1000)
    parser.add_argument("--seconds", type=float, default=60)
    parser.add_argument("--workers", type=int, default=64, help="OS threads issuing requests")
    args = parser.parse_args()

    if "localhost" not in args.base and "127.0.0.1" not in args.base:
        raise SystemExit("refusing to load-test a non-local server")

    secret = read_secret(args.env)
    exam_id, question_ids, students = seed_students(args.db, args.students)
    print(f"exam {exam_id}: {len(students)} virtual students, {len(question_ids)} questions")
    print(f"cadence: heartbeat {HEARTBEAT_S}s · autosave {AUTOSAVE_S}s · events {EVENTS_S}s · snapshot {SNAPSHOT_S}s")

    page_load_cost(args.base)

    stats = Stats()
    from concurrent.futures import ThreadPoolExecutor

    async def run():
        deadline = time.monotonic() + args.seconds
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            await asyncio.gather(*[
                student_loop(pool, stats, args.base, exam_id, question_ids, student,
                             student_token(student["studentId"], secret), deadline)
                for student in students
            ])

    print(f"\n=== {len(students)} students, {args.seconds:.0f}s ===")
    started = time.perf_counter()
    asyncio.run(run())
    elapsed = time.perf_counter() - started
    failures = stats.report(elapsed)

    health = urllib.request.urlopen(args.base + "/api/health").read()
    payload = json.loads(health)
    print(f"  server db counter: {json.dumps(payload.get('db'))}")
    print(f"  monitor: {json.dumps(payload.get('monitor'))}")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
