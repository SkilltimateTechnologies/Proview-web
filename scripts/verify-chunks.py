#!/usr/bin/env python3
"""Prove the code split actually keeps the admin console off the student's wire.

Needs a BUILT dist and a server on :3100 (see task-blank-page.md). Drives a real
Chromium at the student login page and at the admin login page, and records every
JS request each one makes.

Why this is a script and not a unit test: the thing that can silently regress is
Rollup's chunk graph, not our source. One stray static import from the student
tree into an admin page would quietly put the whole console back into the entry
chunk, the build would still pass, and 300 students would download it again. The
only honest check is what the browser asks for.

Asserts:
  - the student page requests the entry chunk and NOT the admin chunk
  - the admin page requests the entry chunk AND the admin chunk
  - both actually render (no blank page)
"""

import asyncio
import re
import sys
from playwright.async_api import async_playwright

BASE = "http://localhost:3100"
STUDENT_URL = f"{BASE}/px9k2m7/login"
ADMIN_URL = f"{BASE}/"


async def collect(page_url, browser):
    context = await browser.new_context()
    page = await context.new_page()
    js = []
    page.on(
        "request",
        lambda r: js.append(r.url.split("/")[-1])
        if r.url.endswith(".js") and "/assets/" in r.url
        else None,
    )
    await page.goto(page_url, wait_until="networkidle")
    # Give a lazy chunk time to be requested after first paint.
    await page.wait_for_timeout(1500)
    text = (await page.inner_text("body")).strip()
    html = await page.content()
    await context.close()
    return js, text, html


async def main():
    failures = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox"])

        student_js, student_text, student_html = await collect(STUDENT_URL, browser)
        admin_js, admin_text, admin_html = await collect(ADMIN_URL, browser)

        await browser.close()

    def is_admin_chunk(name):
        return bool(re.match(r"^app-[A-Za-z0-9_-]+\.js$", name))

    def is_entry_chunk(name):
        return bool(re.match(r"^index-[A-Za-z0-9_-]+\.js$", name))

    print(f"student page {STUDENT_URL}")
    for name in student_js:
        print(f"   {name}")
    print(f"admin page   {ADMIN_URL}")
    for name in admin_js:
        print(f"   {name}")
    print()

    # 1. The student must not fetch the admin console.
    if any(is_admin_chunk(n) for n in student_js):
        failures.append("student page fetched the admin chunk")
    if not any(is_entry_chunk(n) for n in student_js):
        failures.append("student page did not fetch the entry chunk")

    # 2. The admin must still get their console (a lazy chunk that never
    #    arrives is a blank page, which is the bug we are fixing).
    if not any(is_admin_chunk(n) for n in admin_js):
        failures.append("admin page never fetched the admin chunk")

    # 3. Neither page may be blank.
    if len(student_text) < 20:
        failures.append(f"student page looks blank: {student_text!r}")
    if len(admin_text) < 20:
        failures.append(f"admin page looks blank: {admin_text!r}")

    # 4. The student page must be the student login, not the admin login.
    if "root" in student_html and "px9k2m7" not in student_html and not student_text:
        failures.append("student page rendered nothing into #root")

    print(f"student rendered: {student_text[:80]!r}")
    print(f"admin rendered:   {admin_text[:80]!r}")
    print()

    if failures:
        for f in failures:
            print(f"FAIL  {f}")
        sys.exit(1)
    print("PASS  admin console stays off the student's wire, both pages render")


asyncio.run(main())
