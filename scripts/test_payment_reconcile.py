# -*- coding: utf-8 -*-
"""
E2E for payment reconciliation (owner spec 2026-07-27, group A): a payment
document (מס/קבלה 320 / קבלה 400) linked to an UNPAID job proves the money
came in → flips paid to כן, in lockstep with the link. Isolated ZTESTPAY data,
driven through the real specific-pair endpoint (/api/documents/reconcile), so
it never touches real jobs. Cleaned up in finally.

Proves:
  1. a מס/קבלה (320) linked to an unpaid job → paid=כן AND invoice_tax set
     (320 is both a receipt and a tax invoice) → state closed
  2. a job_marked_paid event is written (radar payment-timing reads it)
  3. a bare קבלה (400) → paid=כן but NO invoice row and NO invoice_tax
"""
import base64, json, os, sys, time, uuid
from datetime import date, timedelta
import requests

for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]; SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
REPR = {"Prefer": "return=representation"}
ref = U.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"

failures = []
users = []
created = {"clients": [], "jobs": [], "docs": [], "morning_ids": []}


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail else ""))
    if not ok:
        failures.append(label)


def rest(p): return f"{U}/rest/v1/{p}"


def b64(r): return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags):
    em = f"pay-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**A, **REPR}, json={"name": "ZTESTPAY", "approved": True, **flags}).raise_for_status()
    td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"}, json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600, "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {CN: "base64-" + b64(json.dumps(sess).encode())}


def mkclient():
    cid = requests.post(rest("clients"), headers={**A, **REPR}, json={"name": "ZTESTPAY לקוח " + uuid.uuid4().hex[:4], "normalized_name": "ztestpay" + uuid.uuid4().hex[:6], "morning_client_id": "ZTP-" + uuid.uuid4().hex[:8]}).json()[0]
    created["clients"].append(cid["id"]); return cid["id"], cid["morning_client_id"]


def mkjob(cid, amount, biz=None):
    j = requests.post(rest("jobs"), headers={**A, **REPR}, json={"client_id": cid, "amount": amount, "date": (date.today() - timedelta(days=60)).isoformat(), "paid": "לא", "invoice_biz": biz, "campaign": "ZTESTPAY job", "legacy": False}).json()[0]
    created["jobs"].append(j["id"]); return j["id"]


def mkdoc(cid, mcid, typ, amount):
    mdoc = "ZTP-DOC-" + uuid.uuid4().hex[:10]; created["morning_ids"].append(mdoc)
    d = requests.post(rest("documents"), headers={**A, **REPR}, json={"morning_doc_id": mdoc, "morning_doc_number": "ZP" + uuid.uuid4().hex[:5], "type": typ, "amount": amount, "currency": "ILS", "document_date": (date.today() - timedelta(days=5)).isoformat(), "source": "pull", "client_id": cid, "morning_client_id": mcid}).json()[0]
    created["docs"].append(d["id"]); return d["id"], d["morning_doc_number"]


for _ in range(90):
    try:
        if requests.get(APP, timeout=2).status_code < 500:
            break
    except requests.exceptions.ConnectionError:
        pass
    time.sleep(1)
else:
    print("dev server never came up"); sys.exit(1)

try:
    money = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True, "can_view_stages": True})

    # 1. מס/קבלה (320) → unpaid job → paid + invoice_tax
    cid, mcid = mkclient()
    job = mkjob(cid, 1000, biz="ZP-BIZ-1")  # blue: has deal invoice, unpaid
    doc, docnum = mkdoc(cid, mcid, 320, 1180)  # מס/קבלה 1180 = 1000*1.18
    r = requests.post(f"{APP}/api/documents/reconcile", cookies=money, json={"docId": doc, "jobId": job})
    check("1a. reconcile 320→unpaid job ok", r.status_code == 200 and r.json().get("ok"), r.text[:160])
    check("1b. state reported 'paid'", r.json().get("state") == "paid", json.dumps(r.json()))
    jrow = requests.get(rest(f"jobs?id=eq.{job}&select=paid,invoice_tax"), headers=A).json()[0]
    check("2a. job flipped paid=כן", jrow["paid"] == "כן", str(jrow["paid"]))
    check("2b. invoice_tax set (320 is a tax invoice too)", jrow["invoice_tax"] == docnum, str(jrow["invoice_tax"]))
    drow = requests.get(rest(f"documents?id=eq.{doc}&select=job_id"), headers=A).json()[0]
    check("2c. document linked", drow["job_id"] == job)
    evp = requests.get(rest(f"events?entity_id=eq.{job}&event_type=eq.job_marked_paid&select=payload"), headers=A).json()
    check("3. job_marked_paid event written (radar timing)", len(evp) == 1 and evp[0]["payload"].get("via") == "reconcile", str(len(evp)))
    inv = requests.get(rest(f"invoices?morning_doc_id=eq.{created['morning_ids'][-1]}&select=type"), headers=A).json()
    check("3b. invoices row mirrored as מס", len(inv) == 1 and inv[0]["type"] == "מס", json.dumps(inv, ensure_ascii=False))

    # 2. bare קבלה (400) → paid only, no invoice_tax, no invoices row
    cid2, mcid2 = mkclient()
    job2 = mkjob(cid2, 500, biz="ZP-BIZ-2")
    doc2, docnum2 = mkdoc(cid2, mcid2, 400, 590)  # קבלה 590 = 500*1.18
    r2 = requests.post(f"{APP}/api/documents/reconcile", cookies=money, json={"docId": doc2, "jobId": job2})
    check("4a. reconcile 400→unpaid job ok", r2.status_code == 200 and r2.json().get("state") == "paid", r2.text[:160])
    j2 = requests.get(rest(f"jobs?id=eq.{job2}&select=paid,invoice_tax"), headers=A).json()[0]
    check("4b. paid=כן", j2["paid"] == "כן", str(j2["paid"]))
    check("4c. NO invoice_tax (a קבלה is not a tax invoice)", not j2["invoice_tax"], str(j2["invoice_tax"]))
    inv2 = requests.get(rest(f"invoices?morning_doc_id=eq.{created['morning_ids'][-1]}&select=id"), headers=A).json()
    check("4d. NO invoices row for a bare receipt", inv2 == [], json.dumps(inv2))

finally:
    print("\n--- cleanup ---")
    for jid in created["jobs"]:
        requests.delete(rest(f"invoices?job_id=eq.{jid}"), headers=A)
        requests.delete(rest(f"events?entity_id=eq.{jid}"), headers=A)
    for did in created["docs"]:
        requests.delete(rest(f"documents?id=eq.{did}"), headers=A)
    for jid in created["jobs"]:
        requests.delete(rest(f"jobs?id=eq.{jid}"), headers=A)
    for cid in created["clients"]:
        requests.delete(rest(f"clients?id=eq.{cid}"), headers=A)
    for uid in users:
        requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=A)
        requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = requests.get(rest("clients?normalized_name=like.ztestpay*&select=id"), headers=A).json()
    check("cleanup: test clients removed", left == [], json.dumps(left)[:120])
    print()
    if failures:
        print(f"{len(failures)} FAILED: " + " · ".join(failures)); sys.exit(1)
    print("all checks passed")
