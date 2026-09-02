# -*- coding: utf-8 -*-
"""
The document TITLE on a bundled queue row, in a REAL browser, on the REAL DOM.

WHY THIS FILE EXISTS
--------------------
The title field was never gated on the server — only hidden in the UI. Had it
been sent, /api/documents/pending/edit wrote it to payload.description AND over
income[0].description, destroying the first episode line of a bundle. On a 320
that is unrecoverable: a tax document cannot be corrected after issuance, only
credited. `d952b85` closed it and exposed the field beside the line editor.

The API suite (test_edit_title_multiline.py) proves the SERVER. This file proves
what a person actually sees and clicks: that the new field is on screen, that
typing in it and pressing שמור does not remove a line from the form, and that
the five lines are still there when the page is reloaded. Same lesson as
test_reject_browser.py and test_projects_browser.py — a client component that
throws still returns 200 with a full SSR body, so an HTML assertion proves the
server rendered and proves nothing about the browser.

SCOPED TO ITS OWN ROW, DELIBERATELY. The queue holds real rows for real clients.
An earlier draft used `.first` and opened someone else's document; nothing was
saved, but on a money screen that is the distance between a test and an
incident. Every interaction below is inside the card belonging to this run's
throwaway client, and there is an assertion that says so before anything is
typed.

TOUCHES MORNING: never. Nothing here approves or issues; the edit route calls
Morning only for a RECIPIENT change (listClients), which this file never sends.

Rule 40 (TICKETS.md): the server URL comes from TEST_APP_URL and is never
hard-coded, so this can be pointed at a dedicated dry-run server.

Requires: pip install playwright && playwright install chromium
Run:              TEST_APP_URL=http://localhost:3100 python3 scripts/test_edit_title_browser.py
Headed:           HEADED=1 TEST_APP_URL=... python3 scripts/test_edit_title_browser.py
Screenshots:      SHOT_DIR=/some/dir  (default: the system temp dir)
"""
import base64
import json
import os
import sys
import tempfile
import uuid
from urllib.parse import urlparse

import requests
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(__file__), "..")
for _line in open(os.path.join(ROOT, ".env.local"), encoding="utf-8"):
    _line = _line.strip()
    if _line and not _line.startswith("#") and "=" in _line:
        _k, _v = _line.split("=", 1)
        os.environ.setdefault(_k.strip(), _v.strip())

SUP = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SVC = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000").rstrip("/")
HEADED = os.environ.get("HEADED") == "1"
SHOT_DIR = os.environ.get("SHOT_DIR", tempfile.gettempdir())
REF = SUP.split("//")[1].split(".")[0]
# cookies are port-agnostic, so the host alone is the right domain — taking it
# from TEST_APP_URL rather than assuming localhost keeps the two in step
COOKIE_DOMAIN = urlparse(APP).hostname or "localhost"
ADMIN = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}
TITLE = "הפקת חומרים שיווקיים אוגוסט"

results = []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail and not ok else ""))
    results.append((name, bool(ok), detail))


def ins(table, body):
    r = requests.post(f"{SUP}/rest/v1/{table}", headers={**ADMIN, "Prefer": "return=representation"}, json=body)
    r.raise_for_status()
    return r.json()[0]


def row_state(doc_id):
    return requests.get(f"{SUP}/rest/v1/pending_documents?id=eq.{doc_id}&select=payload,amount",
                        headers=ADMIN).json()[0]


uid = doc_id = cli_id = None
try:
    print(f"target: {APP}   (cookie domain: {COOKIE_DOMAIN})")

    # ---- a money editor, and a throwaway client to own the row --------------
    email = f"ztest-{uuid.uuid4().hex[:8]}@example.com"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    u = requests.post(f"{SUP}/auth/v1/admin/users", headers=ADMIN,
                      json={"email": email, "password": pw, "email_confirm": True}).json()
    uid = u["id"]
    requests.patch(f"{SUP}/rest/v1/profiles?id=eq.{uid}", headers=ADMIN,
                   json={"approved": True, "can_view_stages": True, "can_edit_stages": True,
                         "can_view_money": True, "can_edit_money": True, "role": "owner"})
    tok = requests.post(f"{SUP}/auth/v1/token?grant_type=password",
                        headers={"apikey": ANON, "Content-Type": "application/json"},
                        json={"email": email, "password": pw}).json()
    val = "base64-" + base64.b64encode(json.dumps(tok, separators=(",", ":")).encode()).decode()
    cname = f"sb-{REF}-auth-token"
    pairs = ([(cname, val)] if len(val) <= 3180
             else [(f"{cname}.{i}", val[s:s + 3180]) for i, s in enumerate(range(0, len(val), 3180))])
    cookies = [{"name": n, "value": v, "domain": COOKIE_DOMAIN, "path": "/"} for n, v in pairs]

    cli = ins("clients", {"name": f"ZTESTUI {uuid.uuid4().hex[:5]}",
                          "normalized_name": f"ztestui{uuid.uuid4().hex[:8]}"})
    cli_id = cli["id"]

    # a consolidated 320's lines are inherited verbatim from the work order, so
    # they still read "הזמנת עבודה — …" — which is precisely why she needs a
    # heading of her own over them
    LINES = [f"הזמנת עבודה — דעה לא פופולרית · אורח {i} · 0{i}.08.26" for i in range(1, 6)]
    row = ins("pending_documents", {
        "doc_type": "tax_invoice", "production_id": None, "job_id": None, "client_id": cli_id,
        "amount": 3000,
        "payload": {"type": 305, "lang": "he", "currency": "ILS", "vatType": 0, "date": "2026-09-02",
                    "description": "חשבונית מס — ZTESTUI",
                    "client": {"id": "ztest", "name": "ZTESTUI", "add": False},
                    "income": [{"description": d, "quantity": 1, "price": 600,
                                "currency": "ILS", "vatType": 0} for d in LINES]},
        "status": "pending"})
    doc_id = row["id"]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not HEADED, slow_mo=400 if HEADED else 0)
        ctx = browser.new_context(viewport={"width": 1400, "height": 1100})
        ctx.add_cookies(cookies)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        page.goto(f"{APP}/documents", wait_until="networkidle", timeout=60000)
        check("1. /documents painted", len(page.inner_text("body").strip()) > 300)

        card = page.locator("div.rounded-2xl").filter(has_text=cli["name"]).last
        check("1b. our own test row is on the queue (nothing else will be touched)",
              card.count() == 1, f"count={card.count()}")
        card.get_by_role("button", name="ערוך לפני אישור").click()
        page.wait_for_timeout(900)

        # ---- the field must be on screen ----
        check("2. the 'כותרת המסמך' field is present in the multi-line form",
              card.get_by_text("כותרת המסמך", exact=True).count() > 0)

        card_txt = card.inner_text()
        check("3. the note says the AMOUNT is derived (not the title)",
              "נגזר מהעבודות שאוגדו ואינו נערך כאן" in card_txt, "note text not found")
        check("4. the stale 'וכותרת המסמך נגזרים' wording is gone",
              "וכותרת המסמך נגזרים" not in card_txt)
        line_inputs = [i for i in card.locator("input").all()
                       if (i.get_attribute("value") or "") in LINES]
        check("5. all five line inputs are rendered with their text",
              len(line_inputs) == 5, f"{len(line_inputs)} of 5")
        page.screenshot(path=os.path.join(SHOT_DIR, "edit_title_form.png"))

        # ---- type a heading and save ----
        boxes = card.locator("input").all()
        target = next((b for b in boxes if b.get_attribute("value") == "חשבונית מס — ZTESTUI"), None)
        check("6. the title input is prefilled with the current heading", target is not None,
              str([b.get_attribute("value") for b in boxes]))
        if target:
            target.fill(TITLE)
            card.get_by_role("button", name="שמור").click()
            page.wait_for_timeout(2500)

        st = row_state(doc_id)
        got_lines = [l["description"] for l in st["payload"]["income"]]
        check("7. saved: payload.description is the typed heading",
              st["payload"]["description"] == TITLE, repr(st["payload"]["description"]))
        check("8. ★ saved: all five lines intact after the UI save (the bug d952b85 fixed)",
              got_lines == LINES, f"got {got_lines}")
        check("9. saved: the amount column did not move", float(st["amount"]) == 3000.0, str(st["amount"]))

        # ---- reload and RE-OPEN: line texts live inside the edit form, so a
        #      closed card legitimately does not show them ----
        page.reload(wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(800)
        card2 = page.locator("div.rounded-2xl").filter(has_text=cli["name"]).last
        card2.get_by_role("button", name="ערוך לפני אישור").click()
        page.wait_for_timeout(900)
        vals_after = [b.get_attribute("value") for b in card2.locator("input").all()]
        shown = sum(1 for d in LINES if d in vals_after)
        check("10. all five lines still rendered in the form after the save",
              shown == 5, f"{shown}/5 — inputs now: {vals_after}")
        check("11. the title input now holds the saved heading", TITLE in vals_after, str(vals_after))
        page.screenshot(path=os.path.join(SHOT_DIR, "edit_title_saved.png"))

        real = [e for e in errors if "favicon" not in e.lower()]
        check("12. no console/page errors anywhere in the flow", not real, str(real[:3]))
        browser.close()

finally:
    if doc_id:
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{doc_id}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/pending_documents?id=eq.{doc_id}", headers=ADMIN)
    if cli_id:
        requests.delete(f"{SUP}/rest/v1/clients?id=eq.{cli_id}", headers=ADMIN)
    if uid:
        requests.delete(f"{SUP}/rest/v1/events?actor_id=eq.{uid}", headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{uid}", headers=ADMIN)

    left_doc = requests.get(f"{SUP}/rest/v1/pending_documents?id=eq.{doc_id}&select=id",
                            headers=ADMIN).json() if doc_id else []
    left_cli = requests.get(f"{SUP}/rest/v1/clients?id=eq.{cli_id}&select=id",
                            headers=ADMIN).json() if cli_id else []
    left_prof = requests.get(f"{SUP}/rest/v1/profiles?id=eq.{uid}&select=id",
                             headers=ADMIN).json() if uid else []
    check("cleanup: no test document left", left_doc == [], json.dumps(left_doc)[:120])
    check("cleanup: no test client left", left_cli == [], json.dumps(left_cli)[:120])
    check("cleanup: no test profile left", left_prof == [], json.dumps(left_prof)[:120])

failed = [n for n, ok, _ in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
if failed:
    print("FAILED: " + " · ".join(failed))
# Exit code decided AFTER cleanup, never inside finally (eb0115f).
sys.exit(1 if failed else 0)
