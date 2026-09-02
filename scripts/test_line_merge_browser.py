# -*- coding: utf-8 -*-
"""
Merging detail lines, in a REAL browser, on the REAL DOM (2026-09-02).

The API suites prove the server. This proves the form a person actually uses:
that the delete buttons exist, that deleting a line removes it from the screen,
that the LIVE BALANCE turns red the moment the lines stop adding up to the
document, that the save button is dead while it does, and that fixing the price
brings both back and saves correctly.

The balance line is the reason this file matters more than usual. Deleting four
of five lines leaves 600 against a 3,000 document; without a running total the
bookkeeper meets that fact as a refusal, or — before the gate existed — as a
wrong tax invoice. The server refuses either way; this is about whether she can
SEE it before she tries.

SCOPED TO ITS OWN ROW, as test_edit_title_browser.py is: the queue holds real
rows for real clients, and every click here happens inside the card belonging
to this run's throwaway client.

TOUCHES MORNING: never. Nothing is approved or issued.

Requires: pip install playwright && playwright install chromium
Run:     TEST_APP_URL=http://localhost:3100 python3 scripts/test_line_merge_browser.py
Headed:  HEADED=1 TEST_APP_URL=... python3 scripts/test_line_merge_browser.py
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
for _l in open(os.path.join(ROOT, ".env.local"), encoding="utf-8"):
    _l = _l.strip()
    if _l and not _l.startswith("#") and "=" in _l:
        _k, _v = _l.split("=", 1)
        os.environ.setdefault(_k.strip(), _v.strip())

SUP = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SVC = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000").rstrip("/")
HEADED = os.environ.get("HEADED") == "1"
SHOT_DIR = os.environ.get("SHOT_DIR", tempfile.gettempdir())
REF = SUP.split("//")[1].split(".")[0]
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


uid = doc_id = cli_id = None
try:
    print(f"target: {APP}  (cookie domain: {COOKIE_DOMAIN})")
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

    cli = ins("clients", {"name": f"ZTESTMB {uuid.uuid4().hex[:5]}",
                          "normalized_name": f"ztestmb{uuid.uuid4().hex[:8]}",
                          "morning_client_id": f"mmb-{uuid.uuid4().hex[:8]}"})
    cli_id = cli["id"]
    LINES = [f"הזמנת עבודה — פרק {i}" for i in range(1, 6)]
    row = ins("pending_documents", {
        "doc_type": "tax_invoice", "client_id": cli_id, "status": "pending", "amount": 3000,
        "payload": {"type": 305, "lang": "he", "currency": "ILS", "vatType": 0, "date": "2026-09-02",
                    "description": "חשבונית מס — ZTESTMB",
                    "client": {"id": cli["morning_client_id"], "add": False},
                    "income": [{"description": d, "quantity": 1, "price": 600,
                                "currency": "ILS", "vatType": 0} for d in LINES]},
    })
    doc_id = row["id"]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not HEADED, slow_mo=400 if HEADED else 0)
        ctx = browser.new_context(viewport={"width": 1400, "height": 1200})
        ctx.add_cookies(cookies)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        page.goto(f"{APP}/documents", wait_until="networkidle", timeout=60000)
        card = page.locator("div.rounded-2xl").filter(has_text=cli["name"]).last
        check("1. our own test row is on the queue (nothing else is touched)",
              card.count() == 1, f"count={card.count()}")
        card.get_by_role("button", name="ערוך לפני אישור").click()
        page.wait_for_timeout(900)

        txt = card.inner_text()
        check("2. the five lines are listed", "שורות פירוט (5)" in txt, txt[:200])
        check("3. the live balance shows the lines matching the document",
              "סכום השורות: 3,000 ₪" in txt and "✓ תואם" in txt, txt[:400])
        del_buttons = card.get_by_role("button", name="✕")
        check("4. a delete button per line", del_buttons.count() == 5, f"count={del_buttons.count()}")
        page.screenshot(path=os.path.join(SHOT_DIR, "merge_before.png"))

        # ---- delete four lines ------------------------------------------------
        for _ in range(4):
            card.get_by_role("button", name="✕").last.click()
            page.wait_for_timeout(250)
        txt = card.inner_text()
        check("5. one line left on screen, and the header says it was five",
              "שורות פירוט (1 — היו 5)" in txt, txt[:250])
        check("6. ★ the balance went RED: 600 against a 3,000 document",
              "סכום השורות: 600 ₪" in txt and "✗" in txt and "3,000" in txt, txt[:400])
        save = card.get_by_role("button", name="שמור")
        check("7. ★ the save button is disabled while unbalanced", save.is_disabled())
        check("8. the last line cannot be deleted",
              card.get_by_role("button", name="✕").first.is_disabled())
        page.screenshot(path=os.path.join(SHOT_DIR, "merge_unbalanced.png"))

        # ---- fix the price and the title --------------------------------------
        price_input = card.locator("input.w-20")
        check("9. the surviving line exposes an editable price", price_input.count() == 1,
              f"count={price_input.count()}")
        price_input.fill("3000")
        page.wait_for_timeout(400)
        txt = card.inner_text()
        check("10. ★ balance back to green the moment the price is corrected",
              "סכום השורות: 3,000 ₪" in txt and "✓ תואם" in txt, txt[:400])
        check("11. save is enabled again", not card.get_by_role("button", name="שמור").is_disabled())

        # title + the surviving line's text
        title_input = card.locator("input").first
        title_input.fill(TITLE)
        card.locator("input").nth(1).fill(TITLE)
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(SHOT_DIR, "merge_balanced.png"))
        card.get_by_role("button", name="שמור").click()
        page.wait_for_timeout(2500)

        # ---- what actually landed --------------------------------------------
        st = requests.get(f"{SUP}/rest/v1/pending_documents?id=eq.{doc_id}&select=amount,payload",
                          headers=ADMIN).json()[0]
        inc = st["payload"]["income"]
        check("12. saved: exactly one income line", len(inc) == 1, str(len(inc)))
        check("13. saved: it carries the full 3,000", float(inc[0]["price"]) == 3000.0, str(inc[0]))
        check("14. saved: the amount column did not move", float(st["amount"]) == 3000.0, str(st["amount"]))
        check("15. saved: the heading is what was typed", st["payload"]["description"] == TITLE,
              repr(st["payload"]["description"]))

        real = [e for e in errors if "favicon" not in e.lower()]
        check("16. no console/page errors in the flow", not real, str(real[:3]))
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
    left_d = requests.get(f"{SUP}/rest/v1/pending_documents?id=eq.{doc_id}&select=id",
                          headers=ADMIN).json() if doc_id else []
    left_c = requests.get(f"{SUP}/rest/v1/clients?id=eq.{cli_id}&select=id",
                          headers=ADMIN).json() if cli_id else []
    left_u = requests.get(f"{SUP}/rest/v1/profiles?id=eq.{uid}&select=id",
                          headers=ADMIN).json() if uid else []
    check("cleanup: no test document left", left_d == [], json.dumps(left_d)[:120])
    check("cleanup: no test client left", left_c == [], json.dumps(left_c)[:120])
    check("cleanup: no test profile left", left_u == [], json.dumps(left_u)[:120])

failed = [n for n, ok, _ in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
if failed:
    print("FAILED: " + " · ".join(failed))
# Exit code decided AFTER cleanup, never inside finally (eb0115f).
sys.exit(1 if failed else 0)
