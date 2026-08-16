#!/usr/bin/env python3
"""Audit how proctoring violations are actually distributed across a finished exam.

Why this exists
---------------
`focus_loss` was demoted to non-scoring after it was measured firing on a fixed
~60s cadence for students who had done nothing wrong. That demotion was correct,
but it was only ever applied to the ONE event type someone happened to look at.

This script asks the same question of every other type: does this event repeat on
a machine-regular cadence (a bug or a retry loop billing one incident many times)
or at irregular human intervals (a real, separate act)?

It is read-only. It hits the same admin report endpoints the UI uses, so it needs
no database access and can be pointed at production safely.

Usage:
  python3 scripts/audit-violation-cadence.py --exam ex_xxx [--base URL] [--limit N]
"""
from __future__ import annotations

import argparse
import collections
import concurrent.futures
import datetime
import json
import statistics
import sys
import urllib.request

# Types the server currently refuses to count as violations.
NON_SCORING = {"camera_restored", "camera_block_dismissed", "focus_loss"}
# Timed webcam frames: evidence, never misconduct.
FRAME_TYPES = {"frame", "snapshot", "webcam_frame", "periodic_frame"}


def ts(v) -> float:
    if isinstance(v, (int, float)):
        return v / 1000.0
    return datetime.datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()


def get_json(base: str, path: str, cookie: str) -> dict:
    req = urllib.request.Request(base + path, headers={"Cookie": cookie})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def login(base: str, email: str, password: str) -> str:
    body = json.dumps({"email": email, "password": password}).encode()
    req = urllib.request.Request(
        base + "/api/auth/sign-in/email", data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.headers.get_all("Set-Cookie") or []
    return "; ".join(c.split(";")[0] for c in raw)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--exam", required=True)
    ap.add_argument("--base", default="https://proview-web-production.up.railway.app")
    ap.add_argument("--email", default="admin@skilltimate.com")
    ap.add_argument("--password", default="Admin@123")
    ap.add_argument("--limit", type=int, default=0, help="0 = every attempt")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    cookie = login(args.base, args.email, args.password)
    report = get_json(args.base, f"/api/reports/{args.exam}", cookie)
    rows = [r for r in report["results"] if not r.get("absent")]
    if args.limit:
        rows = rows[: args.limit]
    print(f"exam {args.exam}: {len(rows)} attempts to audit", flush=True)

    per_attempt: dict[str, list] = {}

    def fetch(row):
        d = get_json(args.base, f"/api/reports/{args.exam}/attempt/{row['attemptId']}", cookie)
        return row, d["integrity"]

    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        for row, integrity in ex.map(fetch, rows):
            per_attempt[row["attemptId"]] = (row, integrity)
            done += 1
            if done % 25 == 0:
                print(f"  ...{done}/{len(rows)}", flush=True)

    # ---- cadence per event type, pooled across attempts -------------------
    gaps_by_type: dict[str, list[float]] = collections.defaultdict(list)
    count_by_type: collections.Counter = collections.Counter()
    attempts_with_type: collections.Counter = collections.Counter()
    # Per attempt, the longest run of near-identical consecutive gaps.
    worst_run: dict[str, tuple[int, float, str]] = {}

    for aid, (row, integrity) in per_attempt.items():
        by_type: dict[str, list[float]] = collections.defaultdict(list)
        for e in integrity:
            by_type[e["type"]].append(ts(e["at"]))
            count_by_type[e["type"]] += 1
        for t, times in by_type.items():
            attempts_with_type[t] += 1
            times.sort()
            gaps = [times[i + 1] - times[i] for i in range(len(times) - 1)]
            gaps_by_type[t].extend(gaps)
            run, best = 1, 1
            for i in range(1, len(gaps)):
                if abs(gaps[i] - gaps[i - 1]) <= 0.5:
                    run += 1
                    best = max(best, run)
                else:
                    run = 1
            if best >= 3:
                prev = worst_run.get(t)
                if not prev or best > prev[0]:
                    worst_run[t] = (best, round(statistics.median(gaps), 1), row["rollNo"])

    print("\n=== event types, pooled cadence ===")
    hdr = f"{'type':<24}{'events':>8}{'attempts':>10}{'medGap':>9}{'regular%':>10}{'scoring':>9}"
    print(hdr)
    print("-" * len(hdr))
    findings = []
    for t, n in count_by_type.most_common():
        gaps = gaps_by_type[t]
        med = round(statistics.median(gaps), 1) if gaps else 0.0
        # "regular" = gap within 1s of the median. Machines are regular; people are not.
        reg = (100.0 * sum(1 for g in gaps if abs(g - med) <= 1.0) / len(gaps)) if gaps else 0.0
        scoring = "no" if (t in NON_SCORING or t in FRAME_TYPES) else "YES"
        print(f"{t:<24}{n:>8}{attempts_with_type[t]:>10}{med:>9}{reg:>9.0f}%{scoring:>9}")
        if scoring == "YES" and len(gaps) >= 20 and reg >= 60.0:
            findings.append((t, n, med, reg, worst_run.get(t)))

    print("\n=== per-attempt scoring totals (server rule) ===")
    totals = []
    for aid, (row, integrity) in per_attempt.items():
        c = collections.Counter(e["type"] for e in integrity)
        score = sum(v for k, v in c.items() if k not in NON_SCORING and k not in FRAME_TYPES)
        totals.append((score, row["rollNo"], row["name"], dict(c)))
    totals.sort(reverse=True)
    for s, roll, name, c in totals[:10]:
        top = ", ".join(f"{k}={v}" for k, v in sorted(c.items(), key=lambda kv: -kv[1])[:4])
        print(f"  {s:>4}  {roll:<14}{name[:24]:<26}{top}")
    nonzero = [t[0] for t in totals if t[0] > 0]
    if nonzero:
        print(f"\n  attempts with >=1 scoring violation: {len(nonzero)}/{len(totals)}")
        print(f"  median {statistics.median(nonzero)}, mean {statistics.mean(nonzero):.1f}, max {max(nonzero)}")

    if findings:
        print("\n=== SUSPECT: counts as a violation, but repeats like a machine ===")
        for t, n, med, reg, wr in findings:
            print(f"  {t}: {n} events, {reg:.0f}% land within 1s of a {med}s median gap")
            if wr:
                print(f"    longest identical-gap run: {wr[0]} in a row at ~{wr[1]}s ({wr[2]})")
        print("\n  A person does not repeat an act every {}s to the second."
              .format(findings[0][2]))

    if args.out:
        with open(args.out, "w") as f:
            json.dump({
                "exam": args.exam,
                "counts": dict(count_by_type),
                "attempts": {k: v[1] for k, v in per_attempt.items()},
            }, f)
        print(f"\nraw written to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
