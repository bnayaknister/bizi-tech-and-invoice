# -*- coding: utf-8 -*-
"""
E2E for the reconciliation bridge (owner spec 2026-07-26, steps A/B).

Creates isolated ZTESTRECON data — a client, a RED job (paid, no tax
invoice), and a matching unlinked tax document in the registry — then:

  - the gaps screen renders for a money user and surfaces the pairing
  - a NON-money user is blocked (screen redirects, assign route 403s)
  - a money user's one-click assign links the doc to the job IN LOCKSTEP:
      documents.job_id + client_id set, jobs.invoice_tax set (RED→סגור),
      an invoices registry row mirrored, a document_reconciled event written
  - a second assign of the same (now linked) doc is refused

Everything ZTESTRECON is deleted in finally (FK order:
invoices → events → documents → jobs → client → users). Mutates nothing
real: it never runs a Morning pull, so no real job is ever auto-linked.
"""
import base64
import json
import os
import sys
import time
import uuid
from datetime import date, timedelta

import requests

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")
if os.path.exists(ENV_PATH):
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
ANON_KEY = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP_URL = os.environ.get("TEST_APP_URL", "http://localhost:3000")
ADMIN = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"}
REPR = {"Prefer": "return=representation"}
ref = SUPABASE_URL.split("//")[1].split(".")[0]
CN = f"sb-{ref}-auth-token"

failures = []
users = []
DOC_NUMBER = "ZT90001"
MORNING_DOC_ID = "ZT-DOC-" + uuid.uuid4().hex[:10]
MORNING_CLIENT_ID = "ZT-MC-" + uuid.uuid4().hex[:8]
client_id = None
job_id = None
doc_id = None


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail else ""))
    if not ok:
        failures.append(label)


def rest(p):
    return f"{SUPABASE_URL}/rest/v1/{p}"


def b64(r):
    return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(name, flags):
    em = f"recon-{uuid.uuid4().hex[:8]}@bizi-test.local"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{SUPABASE_URL}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**ADMIN, **REPR},
                   json={"name": name, "approved": True, **flags}).raise_for_status()
    td = requests.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {CN: "base64-" + b64(json.dumps(sess).encode())}


for _ in range(90):
    try:
        if requests.get(APP_URL, timeout=2).status_code < 500:
            break
    except requests.exceptions.ConnectionError:
        pass
    time.sleep(1)
else:
    print("FAIL dev server never came up")
    sys.exit(1)

try:
    money = mkuser("ZTESTRECON money", {"role": "bookkeeper", "can_view_money": True, "can_edit_money": True, "can_view_stages": True})
    stages = mkuser("ZTESTRECON stages", {"role": "tech", "can_view_stages": True, "can_edit_stages": True})

    d5 = (date.today() - timedelta(days=5)).isoformat()

    client_id = requests.post(rest("clients"), headers={**ADMIN, **REPR}, json={
        "name": "ZTESTRECON לקוח", "normalized_name": "ztestrecon", "morning_client_id": MORNING_CLIENT_ID,
    }).json()[0]["id"]

    job_id = requests.post(rest("jobs"), headers={**ADMIN, **REPR}, json={
        "client_id": client_id, "amount": 1000, "date": d5, "paid": "כן",
        "campaign": "ZTESTRECON job", "legacy": False,
    }).json()[0]["id"]

    doc_id = requests.post(rest("documents"), headers={**ADMIN, **REPR}, json={
        "morning_doc_id": MORNING_DOC_ID, "morning_doc_number": DOC_NUMBER, "type": 305,
        "amount": 1180, "currency": "ILS", "document_date": d5, "source": "pull",
        "client_id": client_id, "morning_client_id": MORNING_CLIENT_ID,
        "morning_client_name": "ZTESTRECON לקוח",
    }).json()[0]["id"]

    # 1. gaps screen renders + surfaces the pairing for a money user
    html = requests.get(f"{APP_URL}/documents/gaps", cookies=money).text
    check("1a. gaps screen renders", "פערים לטיפול" in html)
    check("1b. engine surfaces the pairing (doc number shown)", DOC_NUMBER in html,
          "doc not surfaced as a candidate")

    # 2. non-money user is blocked
    html_s = requests.get(f"{APP_URL}/documents/gaps", cookies=stages, allow_redirects=False)
    check("2a. gaps screen blocks a non-money user", html_s.status_code in (302, 307) or "פערים לטיפול" not in html_s.text,
          f"status={html_s.status_code}")
    r403 = requests.post(f"{APP_URL}/api/documents/reconcile", cookies=stages,
                         json={"docId": doc_id, "jobId": job_id})
    check("2b. assign route 403s a non-money user", r403.status_code == 403, f"status={r403.status_code}")

    # verify nothing linked yet by the blocked attempt
    d0 = requests.get(rest(f"documents?id=eq.{doc_id}&select=job_id"), headers=ADMIN).json()[0]
    check("2c. blocked attempt linked nothing", d0["job_id"] is None, str(d0["job_id"]))

    # 3. money user's one-click assign
    r = requests.post(f"{APP_URL}/api/documents/reconcile", cookies=money,
                      json={"docId": doc_id, "jobId": job_id})
    body = r.json()
    check("3. assign succeeds", r.status_code == 200 and body.get("ok"), r.text[:200])
    check("3b. reports RED→closed", body.get("state") == "red-closed", json.dumps(body))

    doc = requests.get(rest(f"documents?id=eq.{doc_id}&select=job_id,client_id"), headers=ADMIN).json()[0]
    check("4a. document now linked to the job", doc["job_id"] == job_id, str(doc["job_id"]))
    check("4b. document keeps its client", doc["client_id"] == client_id)

    job = requests.get(rest(f"jobs?id=eq.{job_id}&select=invoice_tax"), headers=ADMIN).json()[0]
    check("5. job's tax invoice flag set (RED→סגור)", job["invoice_tax"] == DOC_NUMBER, str(job["invoice_tax"]))

    inv = requests.get(rest(f"invoices?morning_doc_id=eq.{MORNING_DOC_ID}&select=type,job_id,amount"), headers=ADMIN).json()
    check("6. invoices registry row mirrored", len(inv) == 1 and inv[0]["type"] == "מס" and inv[0]["job_id"] == job_id,
          json.dumps(inv, ensure_ascii=False)[:160])

    ev = requests.get(rest(f"events?entity_id=eq.{job_id}&event_type=eq.document_reconciled&select=actor_id,payload"),
                      headers=ADMIN).json()
    check("7a. document_reconciled event written", len(ev) == 1, str(len(ev)))
    if ev:
        check("7b. event records it was a manual (not auto) link", ev[0]["payload"].get("auto") is False,
              json.dumps(ev[0]["payload"], ensure_ascii=False)[:160])

    # 8. re-assigning the same doc is refused
    r2 = requests.post(f"{APP_URL}/api/documents/reconcile", cookies=money,
                       json={"docId": doc_id, "jobId": job_id})
    check("8. second assign of a linked doc refused", r2.status_code == 400, f"status={r2.status_code}")

finally:
    print("\n--- cleanup (all ZTESTRECON data) ---")
    if job_id:
        requests.delete(rest(f"invoices?job_id=eq.{job_id}"), headers=ADMIN)
        requests.delete(rest(f"events?entity_id=eq.{job_id}"), headers=ADMIN)
    if doc_id:
        requests.delete(rest(f"documents?id=eq.{doc_id}"), headers=ADMIN)
    if job_id:
        requests.delete(rest(f"jobs?id=eq.{job_id}"), headers=ADMIN)
    if client_id:
        requests.delete(rest(f"clients?id=eq.{client_id}"), headers=ADMIN)
    for uid in users:
        requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=ADMIN)
        requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{uid}", headers=ADMIN)

    left_u = requests.get(rest("profiles?name=like.*ZTESTRECON*&select=id"), headers=ADMIN).json()
    left_c = requests.get(rest("clients?normalized_name=eq.ztestrecon&select=id"), headers=ADMIN).json()
    left_d = requests.get(rest(f"documents?morning_doc_id=eq.{MORNING_DOC_ID}&select=id"), headers=ADMIN).json()
    check("cleanup: users removed", left_u == [], json.dumps(left_u)[:120])
    check("cleanup: client removed", left_c == [], json.dumps(left_c)[:120])
    check("cleanup: document removed", left_d == [], json.dumps(left_d)[:120])


print()
if failures:
    print(f"{len(failures)} FAILED: " + " · ".join(failures))
    sys.exit(1)
print("all checks passed")
