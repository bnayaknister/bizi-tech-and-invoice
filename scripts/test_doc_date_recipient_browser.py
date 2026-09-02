# -*- coding: utf-8 -*-
"""
The manual DOCUMENT DATE on the RECIPIENT modal — 100 and 300 (2026-09-02).

Companion to test_doc_date_browser.py, which proves the same field on the tax
confirmation modal (305/320/400). This one covers the OTHER modal, the one a
work order and a deal invoice go through, and it exists for a reason that is
mostly about the case the field must NOT appear in:

  the recipient modal is SINGLE-DOCUMENT ONLY. The bulk buttons never open it —
  they call the review route directly with N ids — and the server refuses a
  manual date on a batch with a 400. If the field ever reached a batch flow the
  bookkeeper would pick a date and be told no. Assertions 8-11 are that case.

SCOPED TO ITS OWN ROWS — the queue holds real rows for real clients. Three
throwaway clients, one per row, so every card can be addressed by name and
nothing else is ever clicked. The bulk approval is driven from the two per-card
checkboxes, NEVER from "בחר את כל N" (which would select real rows too).

TOUCHES MORNING: never — the run refuses to start unless /api/morning/status
reports dryRun:true (rule 40), and the URL comes from TEST_APP_URL.

Requires: pip install playwright && playwright install chromium
Run:     TEST_APP_URL=http://localhost:3000 python3 scripts/test_doc_date_recipient_browser.py
Headed:  HEADED=1 TEST_APP_URL=... python3 scripts/test_doc_date_recipient_browser.py
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
APP = os.environ.get("TEST_APP_URL", "http://localhost:3100").rstrip("/")
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
YESTERDAY = (TODAY - timedelta(days=1)).strftime("%Y-%m-%d")

DATE_FIELD_LABEL = "תאריך המסמך (אופציונלי)"


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


def rows_of(doc_id):
    return requests.get(
        f"{SUP}/rest/v1/pending_documents?id=eq.{doc_id}&select=status,morning_doc_id", headers=ADMIN
    ).json()[0]


def registry_date(mdid):
    reg = requests.get(f"{SUP}/rest/v1/documents?morning_doc_id=eq.{mdid}&select=document_date",
                       headers=ADMIN).json()
    return reg[0]["document_date"] if reg else None


def override_events(doc_id):
    return requests.get(f"{SUP}/rest/v1/events?entity_id=eq.{doc_id}"
                        f"&event_type=eq.document_date_overridden&select=payload", headers=ADMIN).json()


uid = None
clients = []   # ids, for cleanup
docs = []      # pending_documents ids, for cleanup
mdids = []
try:
    print(f"target: {APP}  ·  today (Israel) = {TODAY_IL}  ·  "
          f"month-cross date = {CROSS_ISO} ({'in window' if CROSS_OK else 'OUT OF WINDOW — will skip the 409 leg'})")

    # ---- a money editor -----------------------------------------------------
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

    # ---- one client per row, so every card is addressable by name -----------
    def mk(tag, doc_type, code, amount):
        c = ins("clients", {"name": f"ZTESTRCP{tag} {uuid.uuid4().hex[:5]}",
                            "normalized_name": f"ztestrcp{tag.lower()}{uuid.uuid4().hex[:8]}",
                            "morning_client_id": f"mrcp-{uuid.uuid4().hex[:8]}"})
        clients.append(c["id"])
        r = ins("pending_documents", {
            "doc_type": doc_type, "client_id": c["id"], "amount": amount, "status": "pending",
            # a stale payload date on purpose: whatever happens, it must never win
            "payload": {"type": code, "lang": "he", "currency": "ILS", "vatType": 0, "date": "2026-06-15",
                        "description": f"ZTESTRCP{tag}",
                        "client": {"id": c["morning_client_id"], "add": False},
                        "income": [{"description": "פרק בדיקה", "quantity": 1, "price": amount,
                                    "currency": "ILS", "vatType": 0}]},
        })
        docs.append(r["id"])
        return c, r

    cli_s, row_s = mk("S", "work_order", 100, 700)     # single flow, a 100
    cli_a, row_a = mk("A", "deal_invoice", 300, 800)   # batch flow, two 300s
    cli_b, row_b = mk("B", "deal_invoice", 300, 900)

    # ---- rule 40 gate, before any click -------------------------------------
    jar = {n: v for n, v in pairs}
    st = requests.get(f"{APP}/api/morning/status", cookies=jar, timeout=20)
    dry = st.status_code == 200 and st.json().get("dryRun") is True
    check("0. server is DRY_RUN (rule 40 — verified with a cookie, before any click)", dry,
          f"{st.status_code}: {st.text[:120]}")
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

        # ================= SINGLE: the field is there, and it works ===========
        card = page.locator("div.rounded-2xl").filter(has_text=cli_s["name"]).last
        check("1. our work order (100) is on the queue", card.count() == 1, f"count={card.count()}")
        card.get_by_role("button", name="אשר", exact=True).click()
        page.wait_for_timeout(900)

        modal = page.locator("div.fixed").filter(has_text="שליחת המסמך במייל").last
        check("2. the RECIPIENT modal opened (not the tax one)", modal.count() == 1, f"count={modal.count()}")

        mtxt = modal.inner_text()
        check("3. the document date is STATED with the default (today — issuance day)",
              f"{as_il(TODAY_IL)} — יום ההנפקה" in mtxt, mtxt[:400])
        check("4. the field is present on the recipient modal, labelled optional",
              DATE_FIELD_LABEL in mtxt, mtxt[:400])

        pick = CROSS_ISO if CROSS_OK else YESTERDAY
        modal.locator('input[type="date"]').fill(pick)
        page.wait_for_timeout(400)
        mtxt = modal.inner_text()
        check("5. the display line updates LIVE to the chosen date, marked manual",
              f"{as_il(pick)} — נבחר ידנית" in mtxt, mtxt[:400])
        page.screenshot(path=os.path.join(SHOT_DIR, "doc_date_recipient_picked.png"))

        approve_btn = modal.get_by_role("button", name="אשר בלי שליחה")
        if approve_btn.count() == 0:  # the client had emails, so the label is the other one
            approve_btn = modal.get_by_role("button", name="אשר ושלח")
        approve_btn.click()
        page.wait_for_timeout(1800)

        if CROSS_OK:
            mtxt = modal.inner_text()
            check("6. month-cross → the warning panel appears INSIDE the recipient modal",
                  "חודש הדיווח הקודם" in mtxt, mtxt[:500])
            confirm_btn = modal.get_by_role("button", name=f"אני מאשרת — הנפק בתאריך {as_il(pick)}")
            check("7. the second button NAMES the date it will issue with",
                  confirm_btn.count() == 1, f"count={confirm_btn.count()}")
            check("7b. the plain approve button is dead while the panel is open",
                  approve_btn.is_disabled())
            page.screenshot(path=os.path.join(SHOT_DIR, "doc_date_recipient_gate.png"))
            confirm_btn.click()
            page.wait_for_timeout(3000)
        else:
            print("  ⚠ SKIP 6-7: no in-window month-cross exists today — issued on a plain backdate")

        after = rows_of(row_s["id"])
        check("8. the 100 issued through the modal", after["status"] == "issued", str(after))
        if after.get("morning_doc_id"):
            mdids.append(after["morning_doc_id"])
            check("8b. registry document_date = the chosen date",
                  registry_date(after["morning_doc_id"]) == pick,
                  str(registry_date(after["morning_doc_id"])))
        ev = override_events(row_s["id"])
        check("8c. document_date_overridden recorded (from=today, to=chosen)",
              bool(ev) and ev[0]["payload"].get("from") == TODAY_IL and ev[0]["payload"].get("to") == pick,
              json.dumps(ev)[:200])

        # ================= BATCH: the field must not exist at all =============
        # Driven from the per-card checkboxes, never from "בחר את כל N": that
        # button selects every pending row of the type, including real ones.
        page.goto(f"{APP}/documents", wait_until="networkidle", timeout=60000)
        card_a = page.locator("div.rounded-2xl").filter(has_text=cli_a["name"]).last
        card_b = page.locator("div.rounded-2xl").filter(has_text=cli_b["name"]).last
        check("9. both deal invoices (300) are on the queue",
              card_a.count() == 1 and card_b.count() == 1, f"a={card_a.count()} b={card_b.count()}")
        card_a.locator('input[type="checkbox"]').first.check()
        card_b.locator('input[type="checkbox"]').first.check()
        page.wait_for_timeout(400)

        bulk = page.get_by_role("button", name="אשר 2 מסמכים שנבחרו")
        check("10. the bulk approve button appeared for exactly our two rows",
              bulk.count() == 1, f"count={bulk.count()}")
        # THE POINT OF THIS FILE: no modal, therefore no date field, therefore
        # no date can be chosen for a batch the server would refuse.
        check("10b. no date field anywhere on the page in the batch flow",
              DATE_FIELD_LABEL not in page.inner_text("body"))
        check("10c. no recipient modal is open before the bulk click",
              page.locator("div.fixed").filter(has_text="שליחת המסמך במייל").count() == 0)
        page.screenshot(path=os.path.join(SHOT_DIR, "doc_date_batch_no_field.png"))

        bulk.click()
        page.wait_for_timeout(1200)
        check("10d. the bulk click opened no modal and offered no date",
              DATE_FIELD_LABEL not in page.inner_text("body"))
        page.wait_for_timeout(2500)

        for tag, r in (("A", row_a), ("B", row_b)):
            got = rows_of(r["id"])
            check(f"11{tag}. the batched 300 issued", got["status"] == "issued", str(got))
            if got.get("morning_doc_id"):
                mdids.append(got["morning_doc_id"])
                check(f"11{tag}b. it carries TODAY's date — the default, untouched by the batch path",
                      registry_date(got["morning_doc_id"]) == TODAY_IL,
                      str(registry_date(got["morning_doc_id"])))
            check(f"11{tag}c. no override event on a batched row", override_events(r["id"]) == [],
                  json.dumps(override_events(r["id"]))[:160])

        # the deliberate 409 of the month-cross gate shows up in the console as a
        # network "error" — it is the very thing under test, not a defect.
        real = [e for e in errors if "favicon" not in e.lower() and "status of 409" not in e]
        check("12. no console/page errors in either flow (the tested 409 excluded)", not real, str(real[:3]))
        browser.close()

finally:
    for md in mdids:
        requests.delete(f"{SUP}/rest/v1/invoices?morning_doc_id=eq.{md}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/documents?morning_doc_id=eq.{md}", headers=ADMIN)
    for d in docs:
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{d}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/pending_documents?id=eq.{d}", headers=ADMIN)
    for c in clients:
        requests.delete(f"{SUP}/rest/v1/clients?id=eq.{c}", headers=ADMIN)
    if uid:
        requests.delete(f"{SUP}/rest/v1/events?actor_id=eq.{uid}", headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{uid}", headers=ADMIN)

    left_docs = [d for d in docs
                 if requests.get(f"{SUP}/rest/v1/pending_documents?id=eq.{d}&select=id",
                                 headers=ADMIN).json()]
    left_cli = [c for c in clients
                if requests.get(f"{SUP}/rest/v1/clients?id=eq.{c}&select=id", headers=ADMIN).json()]
    left_prof = requests.get(f"{SUP}/rest/v1/profiles?id=eq.{uid}&select=id",
                             headers=ADMIN).json() if uid else []
    check("cleanup: no test documents left", left_docs == [], json.dumps(left_docs)[:160])
    check("cleanup: no test clients left", left_cli == [], json.dumps(left_cli)[:160])
    check("cleanup: no test profile left", left_prof == [], json.dumps(left_prof)[:160])

failed = [n for n, ok, _ in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
if failed:
    print("FAILED: " + " · ".join(failed))
# Exit code decided AFTER cleanup, never inside finally (eb0115f).
sys.exit(1 if failed else 0)
