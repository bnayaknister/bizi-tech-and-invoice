# -*- coding: utf-8 -*-
"""
The manual DOCUMENT DATE in the approval modal, in a REAL browser (2026-09-02).

The API suite (test_document_date_override.py) proves the server guards. This
file proves what a person sees: the document date is now STATED in the modal
(its absence is what made the owner read the payment date as the document
date), the display line updates live when a date is picked, and the
month-crossing gate is a real panel demanding a second, named click — with the
main button dead while it is open.

SCOPED TO ITS OWN ROW — same lesson as test_edit_title_browser.py: the queue
holds real rows for real clients; every click below happens inside the card
belonging to this run's throwaway client, asserted before anything is pressed.

TOUCHES MORNING: never — the run refuses to start unless /api/morning/status
reports dryRun:true (rule 40), and the URL comes from TEST_APP_URL.

Requires: pip install playwright && playwright install chromium
Run:     TEST_APP_URL=http://localhost:3100 python3 scripts/test_doc_date_browser.py
Headed:  HEADED=1 TEST_APP_URL=... python3 scripts/test_doc_date_browser.py
"""
import base64
import json
import os
import sys
import tempfile
import uuid
from datetime import datetime, timedelta
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

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
COOKIE_DOMAIN = urlparse(APP).hostname or "localhost"
ADMIN = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}

TODAY = datetime.now(ZoneInfo("Asia/Jerusalem"))
TODAY_IL = TODAY.strftime("%Y-%m-%d")
PREV_MONTH_END = TODAY.replace(day=1) - timedelta(days=1)
CROSS_OK = (TODAY.date() - PREV_MONTH_END.date()).days <= 14
CROSS_ISO = PREV_MONTH_END.strftime("%Y-%m-%d")


def as_il(iso):
    return ".".join(reversed(iso.split("-")))


results = []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail and not ok else ""))
    results.append((name, bool(ok), detail))


def ins(table, body):
    r = requests.post(f"{SUP}/rest/v1/{table}", headers={**ADMIN, "Prefer": "return=representation"}, json=body)
    r.raise_for_status()
    return r.json()[0]


uid = doc_id = cli_id = None
mdid = None
try:
    print(f"target: {APP}  ·  today (Israel) = {TODAY_IL}  ·  month-cross date = {CROSS_ISO} ({'in window' if CROSS_OK else 'OUT OF WINDOW — will skip the 409 leg'})")

    # ---- a money editor + throwaway client + a 305 queue row ----------------
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

    cli = ins("clients", {"name": f"ZTESTDDB {uuid.uuid4().hex[:5]}",
                          "normalized_name": f"ztestddb{uuid.uuid4().hex[:8]}",
                          "morning_client_id": f"mddb-{uuid.uuid4().hex[:8]}"})
    cli_id = cli["id"]
    # a 305: goes through the confirmation modal, needs no payment block, so
    # the only date input in the modal is the new document-date field
    row = ins("pending_documents", {
        "doc_type": "tax_invoice", "client_id": cli_id, "amount": 600, "status": "pending",
        "payload": {"type": 305, "lang": "he", "currency": "ILS", "vatType": 0, "date": "2026-06-15",
                    "description": "חשבונית מס — ZTESTDDB",
                    "client": {"id": cli["morning_client_id"], "add": False},
                    "income": [{"description": "פרק בדיקה", "quantity": 1, "price": 600,
                                "currency": "ILS", "vatType": 0}]},
    })
    doc_id = row["id"]

    # ---- rule 40 gate, before any click -------------------------------------
    jar = {n: v for n, v in pairs}
    st = requests.get(f"{APP}/api/morning/status", cookies=jar, timeout=20)
    dry = st.status_code == 200 and st.json().get("dryRun") is True
    check("0. server is DRY_RUN (rule 40)", dry, f"{st.status_code}: {st.text[:120]}")
    if not dry:
        raise SystemExit("REFUSING: server is not in dry-run")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not HEADED, slow_mo=400 if HEADED else 0)
        ctx = browser.new_context(viewport={"width": 1400, "height": 1100})
        ctx.add_cookies(cookies)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        page.goto(f"{APP}/documents", wait_until="networkidle", timeout=60000)
        card = page.locator("div.rounded-2xl").filter(has_text=cli["name"]).last
        check("1. our own test row is on the queue (nothing else will be touched)",
              card.count() == 1, f"count={card.count()}")
        card.get_by_role("button", name="אשר", exact=True).click()
        page.wait_for_timeout(900)

        modal = page.locator("div.fixed").filter(has_text="אישור הנפקת מסמך מס").last
        check("2. the confirmation modal opened", modal.count() == 1, f"count={modal.count()}")

        # ---- the document date is STATED before anything is chosen ----------
        mtxt = modal.inner_text()
        check("3. the document date line is shown with the default (today — issuance day)",
              f"{as_il(TODAY_IL)} — יום ההנפקה" in mtxt, mtxt[:300])
        check("4. the new field is present, labelled optional",
              "תאריך המסמך (אופציונלי)" in mtxt)

        # ---- pick a date; the display line updates live ---------------------
        pick = CROSS_ISO if CROSS_OK else (TODAY - timedelta(days=1)).strftime("%Y-%m-%d")
        modal.locator('input[type="date"]').fill(pick)
        page.wait_for_timeout(400)
        mtxt = modal.inner_text()
        check("5. display line updates LIVE to the chosen date, marked manual",
              f"{as_il(pick)} — נבחר ידנית" in mtxt, mtxt[:300])
        page.screenshot(path=os.path.join(SHOT_DIR, "doc_date_picked.png"))

        if CROSS_OK:
            # ---- the month-crossing gate: panel + second click --------------
            modal.get_by_role("button", name="כן, הנפק").click()
            page.wait_for_timeout(1800)
            mtxt = modal.inner_text()
            check("6. month-cross → warning panel appears inside the modal",
                  "חודש הדיווח הקודם" in mtxt, mtxt[:400])
            confirm_btn = modal.get_by_role("button", name=f"אני מאשרת — הנפק בתאריך {as_il(pick)}")
            check("7. the second button NAMES the date it will issue with",
                  confirm_btn.count() == 1, f"count={confirm_btn.count()}")
            check("8. the main button is dead while the panel is open",
                  modal.get_by_role("button", name="כן, הנפק").is_disabled())
            page.screenshot(path=os.path.join(SHOT_DIR, "doc_date_gate.png"))
            confirm_btn.click()
        else:
            print("  ⚠ SKIP 6-8: no in-window month-cross exists today — issuing with the plain backdate")
            modal.get_by_role("button", name="כן, הנפק").click()
        page.wait_for_timeout(3000)

        # ---- issued (DRY_RUN) with the chosen date, end to end --------------
        after = requests.get(f"{SUP}/rest/v1/pending_documents?id=eq.{doc_id}&select=status,morning_doc_id",
                             headers=ADMIN).json()[0]
        check("9. the row issued through the gate", after["status"] == "issued", str(after))
        mdid = after.get("morning_doc_id")
        if mdid:
            reg = requests.get(f"{SUP}/rest/v1/documents?morning_doc_id=eq.{mdid}&select=document_date",
                               headers=ADMIN).json()
            check("10. registry document_date = the chosen date",
                  reg and reg[0]["document_date"] == pick, str(reg))
        ev = requests.get(f"{SUP}/rest/v1/events?entity_id=eq.{doc_id}"
                          f"&event_type=eq.document_date_overridden&select=payload", headers=ADMIN).json()
        check("11. document_date_overridden event recorded (from=today, to=chosen)",
              bool(ev) and ev[0]["payload"].get("from") == TODAY_IL and ev[0]["payload"].get("to") == pick,
              json.dumps(ev)[:200])
        if CROSS_OK and ev:
            check("11b. ...crossed_month: true", ev[0]["payload"].get("crossed_month") is True)

        # the deliberate 409 of the month-cross gate shows up in the console as
        # a network "error" — it is the very thing under test, not a defect.
        # Only that exact status is excluded; a 500 or a page error still fails.
        real = [e for e in errors
                if "favicon" not in e.lower() and "status of 409" not in e]
        check("12. no console/page errors in the flow (the tested 409 excluded)", not real, str(real[:3]))
        browser.close()

finally:
    if mdid:
        requests.delete(f"{SUP}/rest/v1/invoices?morning_doc_id=eq.{mdid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/documents?morning_doc_id=eq.{mdid}", headers=ADMIN)
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
