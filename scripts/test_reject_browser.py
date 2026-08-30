# -*- coding: utf-8 -*-
"""
The reject path of /documents, in a REAL browser, asserting on the REAL DOM.

WHY THIS FILE EXISTS
--------------------
Until 2026-08-30 the reject path answered `{ok:true, rejected: rows.length}`
without ever reading the UPDATE result, and carried no `results` array at all.
The client's `failed = (body.results ?? []).filter(...)` therefore saw an empty
list every single time: a rejection that never reached the database rendered as
a success. Nothing on any screen could contradict it.

That bug was invisible to every existing suite, and would still be invisible to
a unit test that asserts on component state. The only check that catches it is
the one that asks what a person actually SEES. So this file drives a real
Chromium, clicks the real "דחה" button, and reads text out of the live DOM.

See also test_projects_browser.py, which established this pattern, and the
lesson behind it: a client component that throws still returns 200 with a full
SSR body, so HTML assertions prove the server rendered and prove nothing about
the browser.

THE TWO SCENARIOS, AND WHY THEY ARE BUILT DIFFERENTLY
-----------------------------------------------------
  1. SUCCESS — NOT mocked. Runs against the real endpoint on a real seeded row.
     The assertion asked for is "the row disappears from the queue", and that
     can only be true if the row really was rejected: the client finishes with
     router.refresh(), which re-reads the table from the server. A stubbed 200
     would leave the row in the database, the refresh would bring it straight
     back, and the test would fail for a reason that has nothing to do with the
     code under test. Running it for real also proves the shape the server now
     returns is the shape the client expects — the response body is captured off
     the wire and asserted on.

  2. FAILURE — mocked, because a genuine UPDATE failure cannot be provoked from
     outside (the service role bypasses RLS, and the row is known to exist). The
     route is intercepted and answers with exactly what the new failure branch
     produces. What is under test here is not the server: it is whether that
     `detail` string reaches a human eye. This is the assertion that was missing.

Requires: pip install playwright && playwright install chromium
Run with the dev server up:  python3 scripts/test_reject_browser.py
Headed (watch it happen):    HEADED=1 python3 scripts/test_reject_browser.py
"""
import base64
import json
import os
import sys
import time
import uuid

import requests
from playwright.sync_api import sync_playwright

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")
for line in open(ENV_PATH, encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = "http://localhost:3000"
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json",
     "Prefer": "return=representation"}
ref = U.split("//")[1].split(".")[0]
CN = f"sb-{ref}-auth-token"
HEADED = os.environ.get("HEADED") == "1"


def rest(p):
    return f"{U}/rest/v1/{p}"


results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"   — {detail}" if detail else ""))


for _ in range(180):
    try:
        if requests.get(APP, timeout=3).status_code < 500:
            break
    except requests.exceptions.ConnectionError:
        pass
    time.sleep(1)
else:
    print("dev server never came up")
    sys.exit(1)

TAG = uuid.uuid4().hex[:8]
em = f"rej-{TAG}@bizi-test.local"
pw = f"Test-{uuid.uuid4().hex}!A1"
uid = requests.post(f"{U}/auth/v1/admin/users", headers=A,
                    json={"email": em, "password": pw, "email_confirm": True}).json()["id"]

client_ids = []
doc_ok = None
doc_fail = None
STARTED_AT = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())

try:
    # can_edit_money is what renders the buttons at all (`canApprove` in
    # page.tsx feeds DocumentsClient); without it the screen is read-only and
    # there is no "דחה" to click.
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers=A,
                   json={"name": f"ZTESTREJECT-{TAG}", "approved": True, "role": "bookkeeper",
                         "can_view_money": True, "can_edit_money": True})

    # `client_name` is the only field of a queue row that renders as free text we
    # control, so it is the handle for "this row is on screen" / "this row is
    # gone". Scenario 1 rejects for real, so scenario 2 needs a second document.
    #
    # TWO CLIENTS, NOT ONE. The first version of this file gave both documents
    # the same client name, and the locator's `.last` then resolved to whichever
    # row happened to be second in the DOM. Scenario 1 rejected the document
    # meant for scenario 2, and "the row is gone" failed because the OTHER row —
    # same name — was still on screen. A shared label makes the two rows
    # indistinguishable to the test, which is the one thing it must never be.
    def make_client(suffix):
        n = f"ZTESTREJECT-{suffix}-{TAG}"
        return n, requests.post(rest("clients"), headers=A,
                                json={"name": n, "normalized_name": n.lower()}).json()[0]["id"]

    NAME_OK, client_ok = make_client("OK")
    NAME_FAIL, client_fail = make_client("FAIL")
    client_ids = [client_ok, client_fail]

    def seed(cid, label):
        return requests.post(rest("pending_documents"), headers=A, json={
            "doc_type": "work_order",
            "status": "pending",
            "client_id": cid,
            "amount": 111,
            "payload": {"description": f"ZTESTREJECT {label} {TAG}",
                        "income": [{"description": f"ZTESTREJECT {label} {TAG}", "price": 111}]},
        }).json()[0]["id"]

    doc_ok = seed(client_ok, "OK")
    doc_fail = seed(client_fail, "FAIL")

    td = requests.post(f"{U}/auth/v1/token?grant_type=password",
                       headers={"apikey": AN, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"],
            "user": td["user"]}
    cookie_val = "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")

    # The error box is `border border-[var(--peak)]` (DocumentsClient.tsx:667).
    # Tailwind's bracket classes are a nightmare to escape in a CSS selector, and
    # a wrong escape fails OPEN — it matches nothing and "no error on screen"
    # passes for the wrong reason. Reading className in JS is exact and cannot
    # silently under-match.
    ERROR_BOX_JS = """() => Array.from(document.querySelectorAll('div'))
        .filter(d => typeof d.className === 'string'
                  && d.className.includes('border-[var(--peak)]'))
        .map(d => d.innerText.trim())"""

    def error_boxes(pg):
        return pg.evaluate(ERROR_BOX_JS)

    def our_row(pg, tag):
        """The queue row for OUR seeded document, and nothing else.

        `div:has-text(...)` alone is wrong twice over: it matches every ancestor
        up to <body>, and its innermost match is a leaf that holds the text but
        not the buttons (they live in a sibling subtree) — which is exactly how
        the first run of this file timed out looking for a button that was on
        screen the whole time.

        Filtering on BOTH the text and the presence of a דחה button, then taking
        the last match, lands on the row container itself. The caller asserts the
        isolation before clicking: there are real production rows in this queue,
        and clicking "דחה" on one of them would reject a live document.
        """
        return (pg.locator("div")
                  .filter(has_text=tag)
                  .filter(has=pg.get_by_role("button", name="דחה"))
                  .last)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not HEADED, slow_mo=400 if HEADED else 0)
        ctx = browser.new_context(viewport={"width": 1500, "height": 1100})
        ctx.add_cookies([{"name": CN, "value": cookie_val, "domain": "localhost", "path": "/"}])
        page = ctx.new_page()

        console_errors = []
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))
        # reject() opens window.prompt for the reason. Unhandled, Playwright
        # auto-dismisses it and reject() returns early on the falsy value — the
        # click would look like it did nothing and the failure would be blamed
        # on the button.
        page.on("dialog", lambda d: d.accept("ZTEST reason"))

        # ---- scenario 1: a real rejection ---------------------------------
        page.goto(f"{APP}/documents", wait_until="networkidle")

        body = page.inner_text("body")
        check("1a. seeded row is on screen before the click", NAME_OK in body,
              f"looked for {NAME_OK}")
        # NOT a body-length threshold. The first version of this check asserted
        # `len(body) > 400` and the real screen measured 359 — a healthy page
        # failed an arbitrary number. What actually distinguishes "rendered" from
        # "mounted and threw" is that the interactive parts exist.
        check("1b. the screen really mounted (heading + live buttons)",
              "מסמכים לאישור" in body and page.get_by_role("button", name="דחה").count() > 0,
              f"buttons={page.get_by_role('button', name='דחה').count()}")

        row = our_row(page, NAME_OK)
        row_text = row.inner_text()
        check("1c. the located row is OURS and only ours",
              NAME_OK in row_text and NAME_FAIL not in row_text
              and row.get_by_role("button", name="דחה").count() == 1,
              f"buttons in row={row.get_by_role('button', name='דחה').count()}")
        if row.get_by_role("button", name="דחה").count() != 1:
            raise SystemExit("refusing to click: row not isolated, a real document could be rejected")
        captured = {}

        def grab(resp):
            if "/api/documents/pending/review" in resp.url:
                captured["status"] = resp.status
                try:
                    captured["body"] = resp.json()
                except Exception:
                    captured["body"] = None

        page.on("response", grab)
        row.get_by_role("button", name="דחה").first.click()
        page.wait_for_timeout(3500)

        check("1d. server answered the new shape", bool(captured.get("body")) and
              captured["body"].get("ok") is True and captured["body"].get("rejected") == 1 and
              isinstance(captured["body"].get("results"), list) and
              captured["body"]["results"][0].get("ok") is True,
              json.dumps(captured.get("body"), ensure_ascii=False)[:160])

        after = page.inner_text("body")
        check("1e. the row is GONE from the rendered queue", NAME_OK not in after,
              "still present" if NAME_OK in after else "")
        boxes = error_boxes(page)
        check("1f. no error box on screen", boxes == [], " | ".join(boxes)[:160])

        db = requests.get(rest(f"pending_documents?id=eq.{doc_ok}&select=status"), headers=A).json()
        check("1g. the database really moved to rejected", db and db[0]["status"] == "rejected",
              json.dumps(db))

        page.remove_listener("response", grab)

        # ---- scenario 2: a failed rejection -------------------------------
        # The response the new failure branch produces, verbatim. The point of
        # the test is the LAST 10 pixels: does this string reach the screen.
        DETAIL = f"הדחייה לא נשמרה — בדיקה {TAG}"
        page.route("**/api/documents/pending/review", lambda route: route.fulfill(
            status=200, content_type="application/json",
            body=json.dumps({"ok": False, "rejected": 0,
                             "results": [{"id": doc_fail, "ok": False, "detail": DETAIL}]}),
        ))

        page.goto(f"{APP}/documents", wait_until="networkidle")
        body2 = page.inner_text("body")
        check("2a. second seeded row is on screen", NAME_FAIL in body2)

        row2 = our_row(page, NAME_FAIL)
        if row2.get_by_role("button", name="דחה").count() != 1:
            raise SystemExit("refusing to click: row not isolated, a real document could be rejected")
        row2.get_by_role("button", name="דחה").first.click()
        page.wait_for_timeout(2500)

        # THE assertion. Not "state was set" — the text, out of the live DOM.
        shown = page.inner_text("body")
        check("2b. the failure text is VISIBLE in the DOM", DETAIL in shown,
              "not found in body text" if DETAIL not in shown else "")

        boxes2 = error_boxes(page)
        check("2c. it is inside the error box", any(DETAIL in b for b in boxes2),
              " | ".join(boxes2)[:160])
        check("2d. the error box is actually visible to a person",
              page.get_by_text(DETAIL, exact=False).first.is_visible())

        db2 = requests.get(rest(f"pending_documents?id=eq.{doc_fail}&select=status"), headers=A).json()
        check("2e. the mocked failure left the row untouched", db2 and db2[0]["status"] == "pending",
              json.dumps(db2))

        check("2f. no console/page errors during either scenario", not console_errors,
              " | ".join(console_errors[:3]))

        browser.close()

finally:
    # Cleanup rule: events and children before the row, pending_documents before
    # the client, everything before the auth user (FK RESTRICT), and VERIFY.
    for d in [doc_ok, doc_fail]:
        if d:
            requests.delete(rest(f"events?entity_id=eq.{d}"), headers=A)
            requests.delete(rest(f"pending_documents?id=eq.{d}"), headers=A)
    for c in client_ids:
        requests.delete(rest(f"clients?id=eq.{c}"), headers=A)
    requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=A)
    requests.delete(rest(f"approval_requests?requested_by=eq.{uid}"), headers=A)
    requests.delete(rest(f"profiles?id=eq.{uid}"), headers=A)
    requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)

    left_docs = requests.get(rest(f"pending_documents?client_id=in.({','.join(client_ids)})&select=id"),
                             headers=A).json() if client_ids else []
    left_client = requests.get(rest(f"clients?id=in.({','.join(client_ids)})&select=id"),
                               headers=A).json() if client_ids else []
    left_prof = requests.get(rest(f"profiles?id=eq.{uid}&select=id"), headers=A).json()
    check("cleanup: no test documents left", left_docs == [], json.dumps(left_docs)[:120])
    check("cleanup: no test client left", left_client == [], json.dumps(left_client)[:120])
    check("cleanup: no test profile left", left_prof == [], json.dumps(left_prof)[:120])

failed = [n for n, ok, _ in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
if failed:
    print("FAILED: " + " · ".join(failed))
# Exit code decided AFTER cleanup, never inside finally (eb0115f).
sys.exit(1 if failed else 0)
