# -*- coding: utf-8 -*-
"""
Loads /documents/gaps in a REAL browser and drives the payment approval block
end to end: the row appears, the dialog opens, cancel writes nothing, confirm
links and marks paid, and the row leaves the list.

This is the check the render suite cannot make. renderToString runs no effects
and dispatches no events, so it proves the markup and nothing about whether the
button opens the dialog or the dialog posts — and a client component that
throws after hydration still returns a full 200 SSR body, which is how 80
assertions once passed over a broken page (test_projects_browser.py's header).

Isolated ZTESTBROWSE data: its own client, its own unpaid job, its own receipt
at ₪1,013 — see test_payment_approval.py for why that amount. Deleted in
finally, and the deletion is verified. No real client is touched (rule 44).

Requires: pip install playwright && playwright install chromium

Run (rule 40 — an isolated server, verified, never :3000):
  MORNING_DRY_RUN=true npx next dev -p 3100
  curl -s localhost:3100/api/morning/status        # must say "dryRun": true
  TEST_APP_URL=http://localhost:3100 python3 scripts/test_payment_approval_browser.py
"""
import base64, json, os, sys, time, uuid
from datetime import date, timedelta
import requests
from playwright.sync_api import sync_playwright

for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]; SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3100")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
REPR = {"Prefer": "return=representation"}
ref = U.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"

AMOUNT = 1013
APPROVE_BTN = "אישור — קישור וסימון"
CONFIRM_BTN = "כן, לקשר ולסמן שולם"

failures = []
users = []
created = {"clients": [], "jobs": [], "docs": []}


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail else ""))
    if not ok:
        failures.append(label)


def rest(p): return f"{U}/rest/v1/{p}"


def mkuser(flags):
    em = f"brw-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**A, **REPR}, json={"name": "ZTESTBROWSE", "approved": True, **flags}).raise_for_status()
    td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"}, json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")


def mkclient():
    c = requests.post(rest("clients"), headers={**A, **REPR}, json={
        "name": "ZTESTBROWSE לקוח " + uuid.uuid4().hex[:4],
        "normalized_name": "ztestbrowse" + uuid.uuid4().hex[:6],
        "morning_client_id": "ZTB-" + uuid.uuid4().hex[:8],
    }).json()[0]
    created["clients"].append(c["id"]); return c["id"], c["morning_client_id"]


def mkjob(cid, amount):
    j = requests.post(rest("jobs"), headers={**A, **REPR}, json={
        "client_id": cid, "amount": amount,
        "date": (date.today() - timedelta(days=40)).isoformat(),
        "paid": "לא", "campaign": "ZTESTBROWSE job", "legacy": False, "dismissed": False,
    }).json()[0]
    created["jobs"].append(j["id"]); return j["id"]


def mkdoc(cid, mcid, typ, amount):
    num = "ZB" + uuid.uuid4().hex[:5]
    d = requests.post(rest("documents"), headers={**A, **REPR}, json={
        "morning_doc_id": "ZTB-DOC-" + uuid.uuid4().hex[:10], "morning_doc_number": num,
        "type": typ, "amount": amount, "currency": "ILS",
        "document_date": (date.today() - timedelta(days=5)).isoformat(),
        "source": "pull", "client_id": cid, "morning_client_id": mcid,
    }).json()[0]
    created["docs"].append(d["id"]); return d["id"], num


def job_state(jid):
    return requests.get(rest(f"jobs?id=eq.{jid}&select=paid"), headers=A).json()[0]["paid"]


def doc_job(did):
    return requests.get(rest(f"documents?id=eq.{did}&select=job_id"), headers=A).json()[0]["job_id"]


for _ in range(180):
    try:
        if requests.get(APP, timeout=3).status_code < 500:
            break
    except requests.exceptions.ConnectionError:
        pass
    time.sleep(1)
else:
    print(f"dev server never came up at {APP}"); sys.exit(1)

try:
    money_tok = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True})
    view_tok = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": False})

    # rule 40, step 2 — the status route needs a session, hence after the user
    st = requests.get(f"{APP}/api/morning/status", cookies={CN: money_tok}, timeout=10).json()
    print(f"target: {APP}   dryRun={st.get('dryRun')}")
    if st.get("dryRun") is not True:
        print("⚠️  REFUSING TO RUN: /api/morning/status did not report dryRun=true (rule 40)")
        failures.append("rule 40: dryRun was not true")
        raise SystemExit(1)

    cid, mcid = mkclient()
    jid = mkjob(cid, AMOUNT)
    did, docnum = mkdoc(cid, mcid, 400, AMOUNT)

    with sync_playwright() as p:
        browser = p.chromium.launch()

        def open_gaps(token):
            ctx = browser.new_context(locale="he-IL")
            ctx.add_cookies([{"name": CN, "value": token, "url": APP}])
            page = ctx.new_page()
            errs = []
            page.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
            page.on("console", lambda m: errs.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            page.goto(f"{APP}/documents/gaps", wait_until="networkidle", timeout=60000)
            return ctx, page, errs

        # ---- 1. the block renders for a money user, with the row ----------
        print("\n--- 1. the block renders and shows the row ---")
        ctx, page, errs = open_gaps(money_tok)
        page.wait_for_selector("text=תשלומים לאישור", timeout=30000)
        body = page.inner_text("body")
        check("1a. no page or console errors", errs == [], " · ".join(errs[:3]))
        heading = next((ln for ln in body.split("\n") if "תשלומים לאישור" in ln), "(heading not found)")
        check("1b. heading present with its count", "תשלומים לאישור (1)" in body, heading.strip())
        check("1c. the seeded document number is on screen", docnum in body)
        check("1d. the client is on screen", "ZTESTBROWSE" in body)
        # counted, not just present: the paragraph was rendered TWICE from
        # 21.9 to 22.9 (it sat in both the body and its container) and every
        # `in` assertion here stayed green through it. Found by eye.
        check("1e. the intro text is on screen exactly once",
              body.count("שום דבר לא נכתב לפני אישור") == 1,
              f"appeared {body.count('שום דבר לא נכתב לפני אישור')} times")
        check("1f. the date-gap explanation is on screen", "ההתאמה לא בודקת תאריכים" in body)
        for col in ["סכום המסמך", "תאריך המסמך", "סכום העבודה", "תאריך העבודה", "פער בימים", "בסיס"]:
            check(f"1g. column '{col}'", col in body)
        check("1h. the approve button is present", page.locator(f"button:has-text('{APPROVE_BTN}')").count() == 1)
        check("1i. nothing written by merely loading the screen",
              job_state(jid) == "לא" and doc_job(did) is None)

        # ---- 2. the dialog opens, and cancel writes nothing ---------------
        print("\n--- 2. the dialog opens; cancel writes nothing ---")
        page.locator(f"button:has-text('{APPROVE_BTN}')").first.click()
        page.wait_for_selector("text=לסמן את העבודה כשולמה?", timeout=15000)
        dlg = page.inner_text("body")
        check("2a. dialog title", "לסמן את העבודה כשולמה?" in dlg)
        check("2b. dialog names the document", docnum in dlg)
        check("2c. dialog states the debt drop", "והחוב יירד ב-" in dlg)
        check("2d. dialog states it is irreversible", "אין ביטול מהמסך" in dlg)
        check("2e. confirm button present", page.locator(f"button:has-text('{CONFIRM_BTN}')").count() == 1)
        page.locator("button:has-text('ביטול')").first.click()
        page.wait_for_selector("text=לסמן את העבודה כשולמה?", state="detached", timeout=15000)
        check("2f. cancel closed the dialog", "לסמן את העבודה כשולמה?" not in page.inner_text("body"))
        check("2g. cancel wrote NOTHING", job_state(jid) == "לא" and doc_job(did) is None)

        # ---- 3. confirm links and marks paid ------------------------------
        print("\n--- 3. confirm links and marks paid ---")
        page.locator(f"button:has-text('{APPROVE_BTN}')").first.click()
        page.wait_for_selector("text=לסמן את העבודה כשולמה?", timeout=15000)
        page.locator(f"button:has-text('{CONFIRM_BTN}')").first.click()
        page.wait_for_selector(f"text={docnum}", state="detached", timeout=30000)
        check("3a. the row left the list", docnum not in page.inner_text("body"))
        check("3b. job paid=כן", job_state(jid) == "כן", job_state(jid))
        check("3c. document linked to the job", doc_job(did) == jid)
        check("3d. still no page/console errors", errs == [], " · ".join(errs[:3]))
        # Owner decision 2026-09-22: with nothing left to approve the block
        # VANISHES, exactly as gap1/gap2/gap3 do — heading and all. It must not
        # leave a "nothing here" sentence stacked above the global card.
        after = page.inner_text("body")
        check("3e. the whole block is gone — heading included", "תשלומים לאישור" not in after)
        check("3f. and it left no empty sentence behind", "אין כרגע תשלומים" not in after)
        ctx.close()

        # ---- 4. a view-only user sees the list and no button --------------
        print("\n--- 4. view-only: list yes, button no ---")
        # a fresh pair, so there is something for the view-only user to see
        cid2, mcid2 = mkclient()
        jid2 = mkjob(cid2, AMOUNT)
        did2, docnum2 = mkdoc(cid2, mcid2, 400, AMOUNT)
        ctx2, page2, errs2 = open_gaps(view_tok)
        page2.wait_for_selector("text=תשלומים לאישור", timeout=30000)
        b2 = page2.inner_text("body")
        check("4a. no page or console errors", errs2 == [], " · ".join(errs2[:3]))
        check("4b. the row IS visible", docnum2 in b2)
        check("4c. the approve button is NOT rendered",
              page2.locator(f"button:has-text('{APPROVE_BTN}')").count() == 0)
        check("4d. nothing written", job_state(jid2) == "לא" and doc_job(did2) is None)
        ctx2.close()

        browser.close()

finally:
    print("\n--- cleanup ---")
    for j in created["jobs"]:
        requests.delete(rest(f"invoices?job_id=eq.{j}"), headers=A)
        requests.delete(rest(f"events?entity_id=eq.{j}"), headers=A)
    for d in created["docs"]:
        requests.delete(rest(f"documents?id=eq.{d}"), headers=A)
    for j in created["jobs"]:
        requests.delete(rest(f"jobs?id=eq.{j}"), headers=A)
    for c in created["clients"]:
        requests.delete(rest(f"clients?id=eq.{c}"), headers=A)
    for u in users:
        requests.delete(rest(f"events?actor_id=eq.{u}"), headers=A)
        requests.delete(f"{U}/auth/v1/admin/users/{u}", headers=A)
    leftc = requests.get(rest("clients?normalized_name=like.ztestbrowse*&select=id"), headers=A).json()
    leftp = requests.get(rest("profiles?name=like.*ZTESTBROWSE*&select=id"), headers=A).json()
    check("cleanup: no ZTESTBROWSE clients left", leftc == [], json.dumps(leftc)[:120])
    check("cleanup: no ZTESTBROWSE profiles left", leftp == [], json.dumps(leftp)[:120])

print()
if failures:
    print(f"{len(failures)} FAILED: " + " · ".join(failures)); sys.exit(1)
print("all checks passed")
