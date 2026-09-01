# -*- coding: utf-8 -*-
"""
The stage-1/stage-2 button matrix on /contracts, in a REAL browser.

WHY THIS FILE EXISTS
--------------------
/contracts is a client component, and an SSR 200 proves nothing about what a
person sees — the lesson from test_projects_browser.py and again from
test_reject_browser.py: a client component that throws still returns 200 with a
full HTML body. The whole of stage 2 is a DISPLAY decision (which of three
buttons is live, given four booleans), so the only check that can fail
truthfully is one that reads the live DOM.

SELECTORS ARE SCOPED TO THE MILESTONE ROW, ON PURPOSE
-----------------------------------------------------
The lesson from test_reject_browser.py's 1f, which failed for a whole session on
something unrelated: a page-wide selector (`border-[var(--peak)]`) matched the
72-hour aging banner as well as the error box it was written for. So every query
here runs INSIDE the row for our own milestone, located by its unique name, and
the buttons carry `data-ms-action` attributes rather than being matched on their
Hebrew label — a label is a design decision and will change.

TOUCHES MORNING: never. Nothing is approved and no button that queues a document
is clicked; the test asserts which buttons EXIST, which is the whole contract.
Parents are seeded exactly as test_milestone_tax.py seeds them — see its header
for why the morning_doc_id is synthetic and must not start with "dry-".

The matrix, one milestone per state:
  A  no job, nothing queued            -> work_order only
  B  work order QUEUED, not issued     -> nothing (no real parent yet)
  C  work order ISSUED                 -> deal_invoice + tax
  D  deal invoice QUEUED, not issued   -> nothing (tax hidden: owner decision)
  E  job carries invoice_biz           -> tax only
  F  job carries invoice_tax           -> nothing
  G  issued amount != milestone amount -> the warning line is visible

Run:  TEST_APP_URL=http://localhost:3100 python3 scripts/test_milestone_buttons_browser.py
      HEADED=1 to watch it.
Requires: pip install playwright && playwright install chromium
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
with open(ENV_PATH, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
# rule 40: never hard-code :3000
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
REPR = {"Prefer": "return=representation"}
REF = U.split("//")[1].split(".")[0]
CN = f"sb-{REF}-auth-token"
HEADED = os.environ.get("HEADED") == "1"

fails = []
users = []
contract_ids = []
milestone_ids = []
job_ids = []
pending_ids = []
client_ids = []


def check(name, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + name + (f"  — {detail}" if detail and not ok else ""))
    if not ok:
        fails.append(name)


def rest(p):
    return f"{U}/rest/v1/{p}"


def ins(table, row):
    r = requests.post(rest(table), headers={**A, **REPR}, json=row)
    if r.status_code >= 300:
        raise RuntimeError(f"{table}: {r.status_code} {r.text[:300]}")
    return r.json()[0]


try:
    for _ in range(180):
        try:
            if requests.get(APP, timeout=3).status_code < 500:
                break
        except Exception:
            pass
        time.sleep(1)
    print(f"APP = {APP}\n")

    TAG = uuid.uuid4().hex[:8]
    em = f"ztest-{TAG}@example.com"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{U}/auth/v1/admin/users", headers=A,
                        json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers=A,
                   json={"approved": True, "can_view_money": True, "can_edit_money": True,
                         "can_view_stages": True, "role": "owner"})
    tok = requests.post(f"{U}/auth/v1/token?grant_type=password",
                        headers={"apikey": AN, "Content-Type": "application/json"},
                        json={"email": em, "password": pw}).json()
    cookie_val = "base64-" + base64.b64encode(json.dumps(tok).encode()).decode()

    mcid = str(uuid.uuid4())
    cli = ins("clients", {"name": f"ZBTN לקוח {TAG}", "normalized_name": f"zbtn-{TAG}",
                          "morning_client_id": mcid})
    client_ids.append(cli["id"])
    con = ins("contracts", {"name": f"ZBTN חוזה {TAG}", "client_id": cli["id"], "total_amount": 99000})
    contract_ids.append(con["id"])

    def milestone(name, amount):
        m = ins("contract_milestones", {"contract_id": con["id"], "name": name, "amount": amount})
        milestone_ids.append(m["id"])
        return m

    def job(name, amount, **extra):
        j = ins("jobs", {"client_id": cli["id"], "contract_id": con["id"],
                         "campaign": f"ZBTN {name}", "amount": amount, "paid": "לא",
                         "legacy": False, **extra})
        job_ids.append(j["id"])
        return j

    def link(m, j):
        requests.patch(rest(f"contract_milestones?id=eq.{m['id']}"), headers=A, json={"job_id": j["id"]})

    def parent(job_id, doc_type, amount, number, status="issued"):
        payload = {"type": 100 if doc_type == "work_order" else 300, "lang": "he", "currency": "ILS",
                   "vatType": 0, "description": f"ZBTN {doc_type}",
                   "client": {"id": mcid, "add": False},
                   "income": [{"description": "ZBTN", "quantity": 1, "price": amount,
                               "currency": "ILS", "vatType": 0}]}
        row = ins("pending_documents", {
            "doc_type": doc_type, "status": status, "job_id": job_id, "production_id": None,
            "client_id": cli["id"], "amount": amount, "payload": payload,
            **({"morning_doc_id": str(uuid.uuid4()), "morning_doc_number": number}
               if status == "issued" else {}),
        })
        pending_ids.append(row["id"])
        return row

    # ---- the seven states --------------------------------------------------
    names = {k: f"ZBTN-{k}-{TAG}" for k in "ABCDEFG"}
    milestone(names["A"], 1000)  # A: no job at all

    mB, jB = milestone(names["B"], 1000), job(f"B-{TAG}", 1000)
    link(mB, jB); parent(jB["id"], "work_order", 1000, None, status="pending")

    mC, jC = milestone(names["C"], 1000), job(f"C-{TAG}", 1000)
    link(mC, jC); parent(jC["id"], "work_order", 1000, f"ZB-100C-{TAG}")

    mD, jD = milestone(names["D"], 1000), job(f"D-{TAG}", 1000)
    link(mD, jD); parent(jD["id"], "work_order", 1000, f"ZB-100D-{TAG}")
    parent(jD["id"], "deal_invoice", 1000, None, status="pending")

    mE, jE = milestone(names["E"], 1000), job(f"E-{TAG}", 1000, invoice_biz=f"ZB-4{TAG[:4]}")
    link(mE, jE); parent(jE["id"], "work_order", 1000, f"ZB-100E-{TAG}")

    mF, jF = milestone(names["F"], 1000), job(f"F-{TAG}", 1000, invoice_tax=f"ZB-5{TAG[:4]}")
    link(mF, jF); parent(jF["id"], "work_order", 1000, f"ZB-100F-{TAG}")

    # G: the issued parent billed 1234, the milestone says 1000
    mG, jG = milestone(names["G"], 1000), job(f"G-{TAG}", 1000)
    link(mG, jG); parent(jG["id"], "work_order", 1234, f"ZB-100G-{TAG}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not HEADED, slow_mo=300 if HEADED else 0)
        ctx = browser.new_context(viewport={"width": 1600, "height": 1200})
        ctx.add_cookies([{"name": CN, "value": cookie_val, "domain": "localhost", "path": "/"}])
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        page.goto(f"{APP}/contracts", wait_until="networkidle")
        page.wait_for_timeout(1200)

        body = page.inner_text("body")
        check("0a. המסך נטען והחוזה מופיע", f"ZBTN חוזה {TAG}" in body,
              body[:200].replace("\n", " "))
        check("0b. אין שגיאות קונסולה/דף", errors == [], " | ".join(errors)[:200])

        def row(nm):
            """The milestone row itself: the innermost element that holds the
            name AND is a milestone row. Scoped — never the page."""
            return (page.locator("div")
                    .filter(has_text=nm)
                    .filter(has=page.locator("[data-ms-action], [data-ms-warn]"))
                    .last)

        def actions(nm):
            """Which data-ms-action buttons live inside THIS row."""
            loc = page.locator("div").filter(has_text=nm).last
            return sorted(loc.locator("[data-ms-action]").evaluate_all(
                "els => els.map(e => e.getAttribute('data-ms-action'))"))

        expected = {
            "A": ["work_order"],
            "B": [],
            "C": ["deal_invoice", "tax"],
            "D": [],
            "E": ["tax"],
            "F": [],
            "G": ["deal_invoice", "tax"],
        }
        labels = {
            "A": "אין job — רק הזמנת עבודה",
            "B": "הזמנה בתור ולא מונפקת — אין כפתורים",
            "C": "הזמנה מונפקת — חשבון עסקה + מס",
            "D": "חשבון עסקה בתור — המס מוסתר",
            "E": "יש invoice_biz — מס בלבד",
            "F": "יש invoice_tax — אין כפתורים",
            "G": "פער סכום — הכפתורים כרגיל",
        }
        for k in "ABCDEFG":
            got = actions(names[k])
            check(f"{k}. {labels[k]}", got == sorted(expected[k]), f"expected {sorted(expected[k])} got {got}")

        # the warning line, scoped to its own row
        warn_g = page.locator("div").filter(has_text=names["G"]).last.locator('[data-ms-warn="amount-mismatch"]')
        check("G2. שורת האזהרה על פער הסכום מוצגת", warn_g.count() >= 1, f"count={warn_g.count()}")
        if warn_g.count():
            check("G3. ...והיא נראית לעין", warn_g.first.is_visible())
            check("G4. ...ונוקבת בסכום שיצא", "1,234" in warn_g.first.inner_text(),
                  warn_g.first.inner_text()[:120])
        warn_c = page.locator("div").filter(has_text=names["C"]).last.locator('[data-ms-warn="amount-mismatch"]')
        check("C2. אין אזהרת פער כשהסכומים תואמים", warn_c.count() == 0, f"count={warn_c.count()}")

        check("Z. עדיין אין שגיאות אחרי כל הבדיקות", errors == [], " | ".join(errors)[:200])
        browser.close()
finally:
    print("\n=== CLEANUP ===")
    ent = [x for x in pending_ids + milestone_ids + contract_ids + job_ids if x]
    if ent:
        requests.delete(rest(f"events?entity_id=in.({','.join(ent)})"), headers=A)
    for jid in job_ids:
        requests.delete(rest(f"pending_documents?job_id=eq.{jid}"), headers=A)
    if pending_ids:
        requests.delete(rest(f"pending_documents?id=in.({','.join(pending_ids)})"), headers=A)
        left = requests.get(rest(f"pending_documents?id=in.({','.join(pending_ids)})&select=id"), headers=A).json()
        check("cleanup: שורות תור נמחקו", len(left) == 0, json.dumps(left))
    if milestone_ids:
        requests.delete(rest(f"contract_milestones?id=in.({','.join(milestone_ids)})"), headers=A)
        left = requests.get(rest(f"contract_milestones?id=in.({','.join(milestone_ids)})&select=id"), headers=A).json()
        check("cleanup: אבני דרך נמחקו", len(left) == 0, json.dumps(left))
    if job_ids:
        requests.delete(rest(f"jobs?id=in.({','.join(job_ids)})"), headers=A)
        left = requests.get(rest(f"jobs?id=in.({','.join(job_ids)})&select=id"), headers=A).json()
        check("cleanup: jobs נמחקו", len(left) == 0, json.dumps(left))
    if contract_ids:
        requests.delete(rest(f"contracts?id=in.({','.join(contract_ids)})"), headers=A)
        left = requests.get(rest(f"contracts?id=in.({','.join(contract_ids)})&select=id"), headers=A).json()
        check("cleanup: חוזים נמחקו", len(left) == 0, json.dumps(left))
    if client_ids:
        requests.delete(rest(f"clients?id=in.({','.join(client_ids)})"), headers=A)
        left = requests.get(rest(f"clients?id=in.({','.join(client_ids)})&select=id"), headers=A).json()
        check("cleanup: לקוחות נמחקו", len(left) == 0, json.dumps(left))
    for u in users:
        requests.delete(f"{U}/auth/v1/admin/users/{u}", headers=A)
        gone = requests.get(f"{U}/auth/v1/admin/users/{u}", headers=A).status_code
        check(f"cleanup: משתמש {u[:8]} נמחק", gone in (403, 404), f"HTTP {gone}")

    print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: " + " | ".join(fails)))
    sys.exit(0 if not fails else 1)
