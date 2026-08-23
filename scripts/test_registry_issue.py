# -*- coding: utf-8 -*-
"""
E2E for Feature 2 — issue work order / deal invoice from the documents screen.

MUST run against a dev server started with MORNING_DRY_RUN=true (issuance goes
through the real approval→issue path but Morning is never called — a synthetic
'dry-' document is minted). Never run this against a DRY_RUN=false server: it
would create REAL documents in the owner's books.

Proves:
  1. can_edit_money required (tech 403)
  2. only work_order / deal_invoice allowed here (tax_invoice 400)
  3. unmapped client → 400 (iron rule: no issuance without a Morning mapping)
  4. enqueue deal invoice → pending_documents row (production_id null, job_id,
     payload.type=300); double-queue same job+type → 409
  5. approve in DRY_RUN → issued; documents + invoices rows written;
     job.invoice_biz set (finance state moved) — the new issue.ts behavior
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

def mkclient(mapped):
    return ins("clients", {"name": "ZTESTISSUE " + ("mapped" if mapped else "unmapped"),
                           "normalized_name": f"ztestissue{uuid.uuid4().hex[:8]}",
                           "morning_client_id": f"mzi-{uuid.uuid4().hex[:8]}" if mapped else None})

money_uid, money_ck = mkuser("ZTESTISSUE_money", True)
tech_uid, tech_ck = mkuser("ZTESTISSUE_tech", False)
cli = mkclient(True); cli_un = mkclient(False)
job = ins("jobs", {"client_id": cli["id"], "amount": 1500, "campaign": "ZTESTISSUE job", "paid": "לא"})
job_un = ins("jobs", {"client_id": cli_un["id"], "amount": 900, "campaign": "ZTESTISSUE unmapped", "paid": "לא"})

def enqueue(ck, doc_type, job_id, **extra):
    return requests.post(f"{APP}/api/documents/enqueue", cookies=ck, headers={"Content-Type": "application/json"},
                         json={"docType": doc_type, "jobId": job_id, **extra})

pending_ids = []
try:
    # 1. permission
    check("tech 403", enqueue(tech_ck, "deal_invoice", job["id"]).status_code == 403)
    # 2. type guard
    check("tax_invoice rejected 400", enqueue(money_ck, "tax_invoice", job["id"]).status_code == 400)
    # 3. unmapped client
    r = enqueue(money_ck, "deal_invoice", job_un["id"])
    check("unmapped client 400", r.status_code == 400 and "ממופה" in r.json().get("error", ""))
    # 4. enqueue deal invoice
    r = enqueue(money_ck, "deal_invoice", job["id"])
    check("enqueue deal invoice 200", r.status_code == 200 and r.json().get("status") == "queued")
    pid = r.json().get("id"); pending_ids.append(pid)
    row = requests.get(rest(f"pending_documents?id=eq.{pid}&select=doc_type,production_id,job_id,client_id,amount,payload,status"), headers=A).json()[0]
    check("pending row: production_id null, job set, type 300",
          row["production_id"] is None and row["job_id"] == job["id"] and row["payload"]["type"] == 300 and row["amount"] == 1500)
    # double-queue
    check("double-queue 409", enqueue(money_ck, "deal_invoice", job["id"]).status_code == 409)
    # work order allowed alongside
    r = enqueue(money_ck, "work_order", job["id"])
    check("work_order enqueue 200", r.status_code == 200)
    pending_ids.append(r.json().get("id"))

    # 5. approve the deal invoice (DRY_RUN) → issued + job flag moved
    r = requests.post(f"{APP}/api/documents/pending/review", cookies=money_ck, headers={"Content-Type": "application/json"},
                      json={"ids": [pid], "action": "approve"})
    body = r.json()
    check("approve 200 + dry_run", r.status_code == 200 and body.get("dry_run") is True and body["results"][0]["ok"])
    issued = requests.get(rest(f"pending_documents?id=eq.{pid}&select=status,morning_doc_id"), headers=A).json()[0]
    mdid = issued["morning_doc_id"]
    check("pending issued + dry- id", issued["status"] == "issued" and str(mdid).startswith("dry-"))
    doc = requests.get(rest(f"documents?morning_doc_id=eq.{mdid}&select=type,job_id,source"), headers=A).json()
    check("registry doc written (type 300, job linked, source app)",
          len(doc) == 1 and doc[0]["type"] == 300 and doc[0]["job_id"] == job["id"] and doc[0]["source"] == "app")
    inv = requests.get(rest(f"invoices?morning_doc_id=eq.{mdid}&select=type,job_id"), headers=A).json()
    check("invoices row written (עסקה)", len(inv) == 1 and inv[0]["type"] == "עסקה")
    # A DRY RUN LEAVES THE JOB ALONE (2026-08-22). It used to stamp invoice_biz
    # with the synthetic number — a bare six-digit figure with no `dry-` marker
    # on it, written onto a real job. documents/invoices still get their rows
    # because those carry the dry- morning_doc_id and are recognisable; a job
    # column is not. Real issuance (DRY_RUN=false) stamps as it always did.
    j2 = requests.get(rest(f"jobs?id=eq.{job['id']}&select=invoice_biz"), headers=A).json()[0]
    check("dry run did NOT stamp job.invoice_biz", j2["invoice_biz"] in (None, ""))
    ev = requests.get(rest(f"events?entity_id=eq.{pid}&event_type=eq.dry_run_jobs_stamp_skipped&select=payload"),
                      headers=A).json()
    check("the skip is evented (auditable, not silent)",
          len(ev) == 1 and job["id"] in (ev[0]["payload"].get("job_ids") or []))
finally:
    for pid in pending_ids:
        dele("events", f"entity_id=eq.{pid}")
    # documents/invoices from the dry issuance
    docs = requests.get(rest(f"documents?job_id=eq.{job['id']}&select=id,morning_doc_id"), headers=A).json()
    for d in docs:
        dele("invoices", f"morning_doc_id=eq.{d['morning_doc_id']}")
        dele("documents", f"id=eq.{d['id']}")
    dele("invoices", f"job_id=eq.{job['id']}")
    dele("pending_documents", f"job_id=eq.{job['id']}")
    dele("events", f"entity_id=eq.{job['id']}")
    dele("jobs", f"id=eq.{job['id']}")
    dele("jobs", f"id=eq.{job_un['id']}")
    dele("clients", f"id=eq.{cli['id']}")
    dele("clients", f"id=eq.{cli_un['id']}")
    for uid in (money_uid, tech_uid):
        patch("events", f"actor_id=eq.{uid}", {"actor_id": None})
        requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = requests.get(rest("profiles?name=like.ZTESTISSUE*&select=id"), headers=A).json()

print(f"\n{passed} passed, {fail} failed · cleanup:", "ok" if left == [] else f"LEFT {left}")
sys.exit(1 if fail else 0)
