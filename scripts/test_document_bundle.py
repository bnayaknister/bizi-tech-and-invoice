# -*- coding: utf-8 -*-
"""
E2E for Feature 3 — bundle several jobs into ONE deal invoice.

Requires migration 0044 (bundle_job_ids) AND a dev server started with
MORNING_DRY_RUN=true (issuance goes through the real approval→issue path but
Morning is never called). Never run against a DRY_RUN=false server.

Proves:
  1. can_edit_money required (tech 403); < 2 jobs 400
  2. mixed Morning client refused (400)
  3. bundle 3 same-client jobs → one pending deal invoice: job_id null,
     bundle_job_ids = the 3, amount = sum, payload has 3 income lines
  4. re-bundle same jobs → 409 (already claimed by a live pending)
  5. approve in DRY_RUN → the jobs are NOT stamped (2026-08-22); documents row
     carries bundle_job_ids (job_id null); one invoices row (עסקה)
  6. mark one bundled job paid → all 3 paid (cascade via shared invoice_biz)
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

def mkuser(name, money):
    em = f"{name}-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    patch("profiles", f"id=eq.{uid}", {"name": name, "approved": True, "role": "bookkeeper" if money else "editor",
          "can_view_money": money, "can_edit_money": money, "can_view_stages": True})
    td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return uid, {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}

def mkclient():
    return ins("clients", {"name": "ZTESTBUNDLE " + uuid.uuid4().hex[:5],
                           "normalized_name": f"ztestbundle{uuid.uuid4().hex[:8]}",
                           "morning_client_id": f"mzb-{uuid.uuid4().hex[:8]}"})
def mkjob(cli, amt):
    return ins("jobs", {"client_id": cli["id"], "amount": amt, "campaign": f"ZTESTBUNDLE ep {amt}", "paid": "לא"})

money_uid, money_ck = mkuser("ZTESTBUNDLE_money", True)
tech_uid, tech_ck = mkuser("ZTESTBUNDLE_tech", False)
cliA = mkclient(); cliB = mkclient()
j1, j2, j3 = mkjob(cliA, 500), mkjob(cliA, 700), mkjob(cliA, 900)
jB = mkjob(cliB, 300)
trio = [j1["id"], j2["id"], j3["id"]]

def bundle(ck, ids):
    return requests.post(f"{APP}/api/documents/bundle", cookies=ck, headers={"Content-Type": "application/json"}, json={"jobIds": ids})

pid = None
mdid = None
try:
    check("tech 403", bundle(tech_ck, trio).status_code == 403)
    check("<2 jobs 400", bundle(money_ck, [j1["id"]]).status_code == 400)
    r = bundle(money_ck, [j1["id"], jB["id"]])
    check("mixed client 400", r.status_code == 400 and "מורנינג" in r.json().get("error", ""))

    r = bundle(money_ck, trio)
    check("bundle 3 → 200", r.status_code == 200 and r.json().get("jobs") == 3 and r.json().get("amount") == 2100)
    pid = r.json().get("id")
    row = requests.get(rest(f"pending_documents?id=eq.{pid}&select=doc_type,job_id,bundle_job_ids,amount,payload"), headers=A).json()[0]
    check("pending: deal, job_id null, 3 bundled, 3 lines, total 2100",
          row["doc_type"] == "deal_invoice" and row["job_id"] is None and
          sorted(row["bundle_job_ids"]) == sorted(trio) and len(row["payload"]["income"]) == 3 and row["amount"] == 2100)

    check("re-bundle 409", bundle(money_ck, trio).status_code == 409)

    # approve (DRY_RUN)
    r = requests.post(f"{APP}/api/documents/pending/review", cookies=money_ck, headers={"Content-Type": "application/json"},
                      json={"ids": [pid], "action": "approve"})
    body = r.json()
    check("approve 200 dry_run", r.status_code == 200 and body.get("dry_run") is True and body["results"][0]["ok"])
    # A dry run no longer stamps jobs (2026-08-22) — see test_registry_issue.py.
    # The bundle's SHAPE is still proven below from the documents/invoices rows,
    # which a dry run does write.
    jrows = requests.get(rest(f"jobs?id=in.({','.join(trio)})&select=id,invoice_biz,paid"), headers=A).json()
    check("dry run did NOT stamp the bundled jobs",
          all(j["invoice_biz"] in (None, "") for j in jrows))
    pend = requests.get(rest(f"pending_documents?id=eq.{pid}&select=morning_doc_id"), headers=A).json()[0]
    mdid = pend["morning_doc_id"]
    doc = requests.get(rest(f"documents?morning_doc_id=eq.{mdid}&select=job_id,bundle_job_ids,type"), headers=A).json()[0]
    check("registry doc: job_id null, 3 bundled, type 300",
          doc["job_id"] is None and sorted(doc["bundle_job_ids"] or []) == sorted(trio) and doc["type"] == 300)
    inv = requests.get(rest(f"invoices?morning_doc_id=eq.{mdid}&select=type,job_id"), headers=A).json()
    check("one invoices row (עסקה, job_id null)", len(inv) == 1 and inv[0]["type"] == "עסקה" and inv[0]["job_id"] is None)

    # mark ONE paid → cascade to all.
    # The cascade keys off a SHARED invoice_biz, which real issuance writes and a
    # dry run deliberately does not. So the precondition is stated here rather
    # than inherited from a synthetic issuance — the subject under test is the
    # cascade, and it should not depend on what dry-run mode happens to stamp.
    biz = f"ZTESTBUNDLE-{mdid[-8:]}"
    patch("jobs", f"id=in.({','.join(trio)})", {"invoice_biz": biz})
    r = requests.post(f"{APP}/api/finance/mark-paid", cookies=money_ck, headers={"Content-Type": "application/json"},
                      json={"job_id": j1["id"]})
    check("mark-paid cascaded=2", r.status_code == 200 and r.json().get("cascaded") == 2)
    paidrows = requests.get(rest(f"jobs?id=in.({','.join(trio)})&select=paid"), headers=A).json()
    check("all 3 jobs paid", all(j["paid"] == "כן" for j in paidrows))
finally:
    if mdid:
        dele("invoices", f"morning_doc_id=eq.{mdid}")
        dele("documents", f"morning_doc_id=eq.{mdid}")
    if pid:
        dele("events", f"entity_id=eq.{pid}")
        dele("pending_documents", f"id=eq.{pid}")
    for jid in trio + [jB["id"]]:
        dele("events", f"entity_id=eq.{jid}")
        dele("jobs", f"id=eq.{jid}")
    dele("clients", f"id=eq.{cliA['id']}")
    dele("clients", f"id=eq.{cliB['id']}")
    for uid in (money_uid, tech_uid):
        patch("events", f"actor_id=eq.{uid}", {"actor_id": None})
        requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = requests.get(rest("profiles?name=like.ZTESTBUNDLE*&select=id"), headers=A).json()

print(f"\n{passed} passed, {fail} failed · cleanup:", "ok" if left == [] else f"LEFT {left}")
sys.exit(1 if fail else 0)
