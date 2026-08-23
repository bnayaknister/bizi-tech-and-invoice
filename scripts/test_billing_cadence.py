# -*- coding: utf-8 -*-
"""
E2E for consolidated billing by client rhythm (owner spec 2026-07-28).

Requires migration 0046 (billing_cadence + accrued/consolidated statuses +
recast unique index) AND a dev server started with MORNING_DRY_RUN=true
(issuance goes through the real approval→issue path but Morning is never
called). Never run against a DRY_RUN=false server.

Covers the owner's 8 acceptance cases:
  1. per_episode client → normal flow, NOT accrued (work order queued; approval
     enqueues a deal invoice)
  2. monthly client → episodes accrue (work order 'accrued'); approval enqueues
     NO deal invoice; jobs exist, unbilled
  3. 06:00 repeat on an accrued production → no duplicate (recast unique index)
  4. accrued item is NOT flagged blocked (billing_block_reason null)
  5. old accrued row is visible to the separate aging signal (status=accrued,
     40 days old)
  6. "פדה" → one consolidated work order + one consolidated deal invoice into
     the queue; source rows → 'consolidated'
  7. mark the consolidated deal invoice paid → every bundled job paid (cascade)
  8. changing cadence does NOT touch existing accrued/consolidated rows
  + permissions: tech cannot redeem / toggle; the "הוצא עכשיו" release works
Self-cleaning in FK order.
"""
import base64, json, os, sys, time, uuid
import requests

for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]; SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
ref = U.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"

def rest(p): return f"{U}/rest/v1/{p}"
def ins(t, row):
    r = requests.post(rest(t), headers={**A, "Prefer": "return=representation"}, json=row); r.raise_for_status(); return r.json()[0]
def ins_raw(t, row):
    return requests.post(rest(t), headers={**A, "Prefer": "return=representation"}, json=row)
def get(t): return requests.get(rest(t), headers=A).json()
def patch(t, q, row): requests.patch(rest(f"{t}?{q}"), headers=A, json=row)
def dele(t, q): requests.delete(rest(f"{t}?{q}"), headers=A)

passed = fail = 0
def check(name, ok):
    global passed, fail
    print(("  ✓ " if ok else "  ✗ ") + name); passed += ok; fail += (not ok)

for _ in range(90):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("dev server never came up"); sys.exit(1)

def mkuser(name, money, stages):
    em = f"{name}-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    patch("profiles", f"id=eq.{uid}", {"name": name, "approved": True, "role": "bookkeeper" if money else "editor",
          "can_view_money": money, "can_edit_money": money, "can_view_stages": True, "can_edit_stages": stages})
    td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return uid, {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}

def mkclient(cadence, every_n=None):
    row = {"name": "ZTESTCAD " + uuid.uuid4().hex[:5],
           "normalized_name": f"ztestcad{uuid.uuid4().hex[:8]}",
           "morning_client_id": f"mzc-{uuid.uuid4().hex[:8]}",
           "billing_cadence": cadence}
    if every_n is not None: row["billing_every_n"] = every_n
    return ins("clients", row)

def mkshow(cli):
    return ins("shows", {"name": "ZTESTCAD show " + uuid.uuid4().hex[:5],
                         "client_id": cli["id"], "billing_mode": "per_episode", "default_rate": 1500})

def mkprod(ck, show, date):
    return requests.post(f"{APP}/api/productions", cookies=ck, headers={"Content-Type": "application/json"},
                         json={"show_id": show["id"], "record_date": date})

def approve(ck, pid):
    return requests.post(f"{APP}/api/productions/{pid}", cookies=ck, headers={"Content-Type": "application/json"},
                         json={"status": 'אושר_ע"י_לקוח'})

money_uid, money_ck = mkuser("ZTESTCAD_money", True, True)
tech_uid, tech_ck = mkuser("ZTESTCAD_tech", False, True)

cliPer = mkclient("per_episode")
cliMon = mkclient("monthly")
showPer = mkshow(cliPer)
showMon = mkshow(cliMon)

prod_ids = []
mdids = []
try:
    # ---- case 1: per_episode is unaffected -------------------------------
    r = mkprod(money_ck, showPer, "2026-07-10")
    p1 = r.json().get("id"); prod_ids.append(p1)
    check("1 per_episode work order queued (not accrued)", r.json().get("work_order") == "queued")
    ra = approve(money_ck, p1)
    check("1 per_episode approval enqueues deal invoice", ra.json().get("document_queued") == "queued")
    di = get(f"pending_documents?production_id=eq.{p1}&doc_type=eq.deal_invoice&select=status")
    check("1 per_episode deal invoice row exists", len(di) == 1)

    # ---- case 2: monthly accrues ----------------------------------------
    r = mkprod(money_ck, showMon, "2026-07-11")
    m1 = r.json().get("id"); prod_ids.append(m1)
    check("2 monthly work order ACCRUED", r.json().get("work_order") == "accrued")
    r = mkprod(money_ck, showMon, "2026-07-12")
    m2 = r.json().get("id"); prod_ids.append(m2)
    check("2 monthly 2nd work order ACCRUED", r.json().get("work_order") == "accrued")
    for mid in (m1, m2):
        ra = approve(money_ck, mid)
        check(f"2 monthly approval does NOT enqueue deal invoice ({mid[:8]})", ra.json().get("document_queued") == "accrued")
    acc = get(f"pending_documents?client_id=eq.{cliMon['id']}&doc_type=eq.work_order&status=eq.accrued&select=id,production_id")
    check("2 two accrued work orders for the client", len(acc) == 2)
    dimon = get(f"pending_documents?client_id=eq.{cliMon['id']}&doc_type=eq.deal_invoice&select=id")
    check("2 NO deal invoice queued for monthly client", len(dimon) == 0)
    jobs = get(f"jobs?client_id=eq.{cliMon['id']}&select=id,invoice_biz")
    check("2 jobs created by trigger, unbilled", len(jobs) == 2 and all(j["invoice_biz"] is None for j in jobs))

    # ---- case 3: idempotency — the recast unique index covers 'accrued' --
    dup = ins_raw("pending_documents", {"doc_type": "work_order", "production_id": m1,
                  "client_id": cliMon["id"], "amount": 1500, "payload": {}, "status": "accrued"})
    check("3 duplicate accrued work order rejected by unique index", dup.status_code in (409, 400, 500) and dup.status_code != 201)

    # ---- case 4: accrued != blocked -------------------------------------
    pr = get(f"productions?id=eq.{m1}&select=billing_block_reason")
    check("4 accrued production not flagged blocked", pr[0]["billing_block_reason"] is None)

    # ---- case 5: aging — backdate one accrued row 40 days ---------------
    old = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 40 * 86400))
    patch("pending_documents", f"production_id=eq.{m1}&doc_type=eq.work_order", {"created_at": old})
    ripe = get(f"pending_documents?client_id=eq.{cliMon['id']}&status=eq.accrued&created_at=lt.{time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(time.time()-30*86400))}&select=id")
    check("5 old accrued row visible to the 30d aging signal", len(ripe) == 1)

    # ---- permission: tech cannot redeem / toggle -----------------------
    rt = requests.post(f"{APP}/api/documents/redeem", cookies=tech_ck, headers={"Content-Type": "application/json"}, json={"clientId": cliMon["id"]})
    check("perm tech redeem 403", rt.status_code == 403)
    accid0 = acc[0]["id"]
    rt = requests.post(f"{APP}/api/documents/pending/accrue", cookies=tech_ck, headers={"Content-Type": "application/json"}, json={"id": accid0, "accrue": False})
    check("perm tech accrue-toggle 403", rt.status_code == 403)

    # ---- case 6: redeem -------------------------------------------------
    rr = requests.post(f"{APP}/api/documents/redeem", cookies=money_ck, headers={"Content-Type": "application/json"}, json={"clientId": cliMon["id"]})
    rj = rr.json()
    check("6 redeem 200", rr.status_code == 200 and rj.get("ok"))
    check("6 consolidated work order, 2 lines", rj.get("work_order", {}).get("lines") == 2)
    wo = get(f"pending_documents?id=eq.{rj['work_order']['id']}&select=doc_type,production_id,status,payload")
    check("6 work order bundle: type work_order, prod null, pending, 2 income lines",
          wo[0]["doc_type"] == "work_order" and wo[0]["production_id"] is None and wo[0]["status"] == "pending"
          and len(wo[0]["payload"]["income"]) == 2)
    src = get(f"pending_documents?client_id=eq.{cliMon['id']}&doc_type=eq.work_order&status=eq.consolidated&select=id,consolidated_into")
    check("6 source rows folded to 'consolidated' pointing at the bundle",
          len(src) == 2 and all(s["consolidated_into"] == rj["work_order"]["id"] for s in src))
    # ---- case 7: approve consolidated deal invoice -> mark paid cascade --
    # מושבת זמנית — redeem צומצם ליצירת הזמנה בלבד (שלב 2 סעיף 2).
    # חשבון העסקה יחזור בסעיף 3 דרך "צור על סמך", ואז יש לשכתב
    # את הבדיקה כך שתאמת יצירה על סמך ההזמנה ולא מ-redeem.
    # כל מה שבתוך הבלוק הזה תלוי ב-rj["deal_invoice"], שכבר לא קיים בתשובה.
    SKIP_CASE_7 = True
    if not SKIP_CASE_7:
        di_id = rj["deal_invoice"]["id"]
        dib = get(f"pending_documents?id=eq.{di_id}&select=doc_type,bundle_job_ids")
        check("6 deal invoice bundle carries 2 job ids", dib[0]["doc_type"] == "deal_invoice" and len(dib[0]["bundle_job_ids"]) == 2)

        ap = requests.post(f"{APP}/api/documents/pending/review", cookies=money_ck, headers={"Content-Type": "application/json"},
                           json={"ids": [di_id], "action": "approve"})
        check("7 approve consolidated deal invoice 200 (dry run)", ap.status_code == 200 and ap.json().get("dry_run") is True)
        md = get(f"pending_documents?id=eq.{di_id}&select=morning_doc_id")
        if md and md[0]["morning_doc_id"]: mdids.append(md[0]["morning_doc_id"])
        jrows = get(f"jobs?client_id=eq.{cliMon['id']}&select=id,invoice_biz")
        # a dry run no longer stamps jobs (2026-08-22, issue.ts) — the shared
        # invoice_biz the cascade needs is declared here instead of inherited
        # from a synthetic issuance
        check("7 dry run did not stamp the jobs", all(j["invoice_biz"] in (None, "") for j in jrows))
        patch("jobs", f"client_id=eq.{cliMon['id']}", {"invoice_biz": f"ZTESTCAD-{di_id[-8:]}"})
        jrows = get(f"jobs?client_id=eq.{cliMon['id']}&select=id,invoice_biz")
        rp = requests.post(f"{APP}/api/finance/mark-paid", cookies=money_ck, headers={"Content-Type": "application/json"}, json={"job_id": jrows[0]["id"]})
        check("7 mark-paid cascaded to the other job", rp.status_code == 200 and rp.json().get("cascaded") == 1)
        paid = get(f"jobs?client_id=eq.{cliMon['id']}&select=paid")
        check("7 both jobs paid", all(j["paid"] == "כן" for j in paid))
    else:
        print("SKIP: case 7 (consolidated deal invoice) — see comment above")

    # ---- case 8: cadence change doesn't touch existing accrued/consolidated
    patch("clients", f"id=eq.{cliMon['id']}", {"billing_cadence": "per_episode"})
    still = get(f"pending_documents?client_id=eq.{cliMon['id']}&doc_type=eq.work_order&status=eq.consolidated&select=id")
    check("8 cadence change left the consolidated rows intact", len(still) == 2)

    # ---- release toggle: "הוצא עכשיו" on a fresh accrued row -----------
    patch("clients", f"id=eq.{cliMon['id']}", {"billing_cadence": "monthly"})
    r = mkprod(money_ck, showMon, "2026-07-20")
    m3 = r.json().get("id"); prod_ids.append(m3)
    acc3 = get(f"pending_documents?production_id=eq.{m3}&doc_type=eq.work_order&select=id,status")
    rel = requests.post(f"{APP}/api/documents/pending/accrue", cookies=money_ck, headers={"Content-Type": "application/json"},
                        json={"id": acc3[0]["id"], "accrue": False})
    check("release 'הוצא עכשיו' flips accrued → pending", rel.status_code == 200 and rel.json().get("status") == "pending")

finally:
    # documents/invoices from the issued bundle
    for md in mdids:
        dele("invoices", f"morning_doc_id=eq.{md}")
        dele("documents", f"morning_doc_id=eq.{md}")
    # jobs + their links + events
    jobs = get(f"jobs?client_id=in.({cliPer['id']},{cliMon['id']})&select=id")
    for j in jobs:
        dele("job_productions", f"job_id=eq.{j['id']}")
        dele("events", f"entity_id=eq.{j['id']}")
    dele("jobs", f"client_id=in.({cliPer['id']},{cliMon['id']})")
    # pending documents (accrued/consolidated/bundles/per-episode) + their events
    pds = get(f"pending_documents?client_id=in.({cliPer['id']},{cliMon['id']})&select=id")
    for pd in pds:
        dele("events", f"entity_id=eq.{pd['id']}")
    dele("pending_documents", f"client_id=in.({cliPer['id']},{cliMon['id']})")
    # productions (cascades stages + any remaining pending_documents) + events
    for pid in prod_ids:
        dele("events", f"entity_id=eq.{pid}")
        dele("productions", f"id=eq.{pid}")
    # client-level events (billing_redeemed)
    for cid in (cliPer["id"], cliMon["id"]):
        dele("events", f"entity_id=eq.{cid}")
    dele("shows", f"id=eq.{showPer['id']}")
    dele("shows", f"id=eq.{showMon['id']}")
    dele("clients", f"id=eq.{cliPer['id']}")
    dele("clients", f"id=eq.{cliMon['id']}")
    for uid in (money_uid, tech_uid):
        patch("events", f"actor_id=eq.{uid}", {"actor_id": None})
        requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = get("profiles?name=like.ZTESTCAD*&select=id")

print(f"\n{passed} passed, {fail} failed · cleanup:", "ok" if left == [] else f"LEFT {left}")
sys.exit(1 if fail else 0)
