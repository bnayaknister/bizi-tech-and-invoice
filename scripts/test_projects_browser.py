# -*- coding: utf-8 -*-
"""
Loads /projects in a REAL browser as a logged-in money user and fails on any
page error or console error.

This is the check that was missing. Every earlier suite fetched HTML over HTTP
and asserted on the markup — which proves the server rendered, and proves
nothing at all about whether React can mount the component in a browser. A
client component that throws during render still returns 200 with a full SSR
body, so all 80 of those assertions passed while the page was broken.

It also drives the month <select>, because the month switch is pure client
state: a crash that only happens after hydration, on a re-render, is invisible
to anything that just loads the page once.

Requires: pip install playwright && playwright install chromium
Run with the dev server up:  python3 scripts/test_projects_browser.py
"""
import base64, json, os, sys, time, uuid
import requests
from playwright.sync_api import sync_playwright

for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())
U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]; APP = "http://localhost:3000"
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
ref = U.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"
def rest(p): return f"{U}/rest/v1/{p}"

for _ in range(180):
    try:
        if requests.get(APP, timeout=3).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("dev server never came up"); sys.exit(1)

em = f"br-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
uid = requests.post(f"{U}/auth/v1/admin/users", headers=A,
                    json={"email": em, "password": pw, "email_confirm": True}).json()["id"]

problems = []
try:
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers=A,
                   json={"name": "ZTESTBROWSER", "approved": True, "role": "bookkeeper",
                         "can_view_money": True, "can_edit_money": False})
    td = requests.post(f"{U}/auth/v1/token?grant_type=password",
                       headers={"apikey": AN, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    cookie_val = "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")

    with sync_playwright() as pw_ctx:
        browser = pw_ctx.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1500, "height": 1000})
        ctx.add_cookies([{"name": CN, "value": cookie_val, "domain": "localhost", "path": "/"}])
        page = ctx.new_page()

        errors, console_errors = [], []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

        page.goto(f"{APP}/projects", wait_until="networkidle", timeout=120_000)
        page.wait_for_timeout(2500)  # let hydration finish

        title = page.text_content("h1") or ""
        print(f"h1: {title.strip()!r}")
        rows_aug = page.locator("tbody tr").count()
        print(f"rows rendered (August, default): {rows_aug}")
        sel = page.locator("select#month")
        opts = sel.locator("option").all_text_contents()
        print(f"month options: {opts}")

        # drive the client-side month switch — this is where a re-render crash lives
        sel.select_option("2026-07")
        page.wait_for_timeout(1500)
        rows_jul = page.locator("tbody tr").count()
        print(f"rows rendered after switching to July: {rows_jul}")
        summary_jul = (page.text_content("main") or "")

        sel.select_option("2026-08")
        page.wait_for_timeout(1200)
        rows_back = page.locator("tbody tr").count()
        print(f"rows rendered after switching back to August: {rows_back}")

        page.screenshot(path=os.path.join(os.path.dirname(__file__), "..", ".next", "projects-check.png"), full_page=True)
        browser.close()

    print("\n── page errors ──")
    if errors:
        for e in errors: print("  PAGEERROR:", e[:400])
        problems.append(f"{len(errors)} page error(s)")
    else:
        print("  none")
    print("── console errors ──")
    real = [c for c in console_errors if "Failed to load resource" not in c]
    if real:
        for c in real: print("  CONSOLE:", c[:400])
        problems.append(f"{len(real)} console error(s)")
    else:
        print("  none")

    if rows_aug == 0: problems.append("August rendered 0 rows")
    if rows_jul == 0: problems.append("July rendered 0 rows")
    if rows_aug != 28: problems.append(f"August rendered {rows_aug} rows, expected 28")
    if rows_jul != 34: problems.append(f"July rendered {rows_jul} rows, expected 34")
    if rows_back != 28: problems.append(f"switching back gave {rows_back} rows, expected 28")
    if "עבודת חוזה" not in summary_jul and "עבודת פרויקטים" not in summary_jul:
        problems.append("July summary did not render")

finally:
    requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=A)
    requests.delete(rest(f"approval_requests?requested_by=eq.{uid}"), headers=A)
    requests.delete(rest(f"profiles?id=eq.{uid}"), headers=A)
    d = requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = (requests.get(rest(f"profiles?id=eq.{uid}&select=id"), headers=A).json()
            + requests.get(rest(f"events?actor_id=eq.{uid}&select=id"), headers=A).json()
            + requests.get(rest(f"approval_requests?requested_by=eq.{uid}&select=id"), headers=A).json())
    print(f"\ncleanup: auth={d.status_code} leftovers={left}")
    if left: problems.append("cleanup incomplete")

print("\nBROWSER CHECK PASSED — 0 errors." if not problems else f"\nFAILED: {problems}")
sys.exit(1 if problems else 0)
