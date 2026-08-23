# -*- coding: utf-8 -*-
"""
E2E for full manual "שייך ל-job" search (owner spec 2026-07-27): when the engine
can't auto-match a document (billed to the GUEST while the job is under the
CLIENT), the bookkeeper searches ALL jobs by any field and assigns herself.

Isolated ZTESTCINEMA data (client "סינמטק", production guest "ליעד הרמן", a job,
and a מס-קבלה whose amount matches nothing → no auto suggestion). Covers:
  1. document with NO auto suggestion (GET reconcile → empty)
  2. free-text search finds the job by client / guest / amount
  3. mismatched amount does NOT block the assignment (the warning is UI-only)
  4. assigning a מס-קבלה flips the job to paid
Cleaned up in finally.
"""
import base64, json, os, sys, time, uuid
from datetime import date, timedelta
import requests

for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]; SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
REPR = {"Prefer": "return=representation"}
ref = U.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"

failures = []; users = []
st = {"client": None, "prod": None, "job": None, "doc": None, "mdoc": None}


def check(l, ok, d=""):
    print(("PASS  " if ok else "FAIL  ") + l + (f"  [{d}]" if d else "")); failures.append(l) if not ok else None


def rest(p): return f"{U}/rest/v1/{p}"
def b64(r): return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags):
    em = f"man-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**A, **REPR}, json={"name": "ZTESTCINEMA u", "approved": True, **flags}).raise_for_status()
    td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"}, json={"email": em, "password": pw}).json()
    s = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600, "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {CN: "base64-" + b64(json.dumps(s).encode())}


for _ in range(90):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("dev server never came up"); sys.exit(1)

try:
    money = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True, "can_view_stages": True})
    stages = mkuser({"role": "tech", "can_view_stages": True, "can_edit_stages": True})

    st["client"] = requests.post(rest("clients"), headers={**A, **REPR}, json={"name": "ZTESTCINEMA סינמטק", "normalized_name": "ztestcinema" + uuid.uuid4().hex[:5], "morning_client_id": "ZC-" + uuid.uuid4().hex[:8]}).json()[0]["id"]
    st["prod"] = requests.post(rest("productions"), headers={**A, **REPR}, json={"podcast_name": "ZTESTCINEMA שואו", "guest": "ליעד הרמן ZTESTCINEMA", "client_id": st["client"]}).json()[0]["id"]
    st["job"] = requests.post(rest("jobs"), headers={**A, **REPR}, json={"client_id": st["client"], "amount": 1500, "date": (date.today() - timedelta(days=40)).isoformat(), "paid": "לא", "invoice_biz": "ZC-BIZ", "campaign": "ZTESTCINEMA קמפיין", "legacy": False}).json()[0]["id"]
    requests.post(rest("job_productions"), headers={**A, **REPR}, json={"job_id": st["job"], "production_id": st["prod"]}).raise_for_status()
    st["mdoc"] = "ZC-DOC-" + uuid.uuid4().hex[:10]
    st["doc"] = requests.post(rest("documents"), headers={**A, **REPR}, json={"morning_doc_id": st["mdoc"], "morning_doc_number": "ZC60178", "type": 320, "amount": 1237, "currency": "ILS", "document_date": (date.today() - timedelta(days=3)).isoformat(), "source": "pull", "client_id": None, "morning_client_id": "ZC-UNMAPPED-" + uuid.uuid4().hex[:6], "morning_client_name": "ליעד הרמן ZTESTCINEMA"}).json()[0]["id"]

    # 1. no auto suggestion (unmapped client + amount 1237 matches nothing)
    sug = requests.get(f"{APP}/api/documents/reconcile?docId={st['doc']}", cookies=money).json().get("candidates", [])
    check("1. document has NO auto suggestion", sug == [], f"{len(sug)} sugg")

    # 2. free-text search finds the job by client / guest / amount
    def search(q):
        return [j["id"] for j in requests.get(f"{APP}/api/finance/jobs-search?q={requests.utils.quote(q)}", cookies=money).json().get("jobs", [])]
    check("2a. search by client 'סינמטק' finds the job", st["job"] in search("ZTESTCINEMA סינמטק"))
    check("2b. search by GUEST 'ליעד הרמן' finds the job", st["job"] in search("ליעד הרמן ZTESTCINEMA"))
    check("2c. search by amount '1500' finds the job", st["job"] in search("1500"))
    check("2d. jobs-search 403s a non-money user", requests.get(f"{APP}/api/finance/jobs-search?q=ZTESTCINEMA", cookies=stages).status_code == 403)

    # 3 + 4. assign despite amount mismatch (1237 doc vs 1500 job) → paid
    r = requests.post(f"{APP}/api/documents/reconcile", cookies=money, json={"docId": st["doc"], "jobId": st["job"]})
    check("3. mismatched-amount assignment NOT blocked", r.status_code == 200 and r.json().get("ok"), r.text[:150])
    j = requests.get(rest(f"jobs?id=eq.{st['job']}&select=paid,invoice_tax"), headers=A).json()[0]
    check("4a. מס-קבלה assign flipped job to paid", j["paid"] == "כן", str(j["paid"]))
    check("4b. invoice_tax set from the doc", j["invoice_tax"] == "ZC60178", str(j["invoice_tax"]))
    d = requests.get(rest(f"documents?id=eq.{st['doc']}&select=job_id,client_id"), headers=A).json()[0]
    check("4c. doc linked + got the job's client", d["job_id"] == st["job"] and d["client_id"] == st["client"])
    ev = requests.get(rest(f"events?entity_id=eq.{st['job']}&event_type=eq.document_reconciled&select=actor_id,payload"), headers=A).json()
    check("4d. manual assignment evented (who + doc)", len(ev) == 1 and ev[0]["actor_id"] == users[0] and ev[0]["payload"].get("auto") is False, str(len(ev)))

finally:
    print("\n--- cleanup ---")
    if st["job"]:
        requests.delete(rest(f"invoices?job_id=eq.{st['job']}"), headers=A)
        requests.delete(rest(f"events?entity_id=eq.{st['job']}"), headers=A)
        requests.delete(rest(f"job_productions?job_id=eq.{st['job']}"), headers=A)
    if st["doc"]: requests.delete(rest(f"documents?id=eq.{st['doc']}"), headers=A)
    if st["job"]: requests.delete(rest(f"jobs?id=eq.{st['job']}"), headers=A)
    if st["prod"]:
        requests.delete(rest(f"stages?production_id=eq.{st['prod']}"), headers=A)
        requests.delete(rest(f"productions?id=eq.{st['prod']}"), headers=A)
    if st["client"]: requests.delete(rest(f"clients?id=eq.{st['client']}"), headers=A)
    for uid in users:
        requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=A)
        requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = requests.get(rest("clients?normalized_name=like.ztestcinema*&select=id"), headers=A).json()
    check("cleanup: test data removed", left == [], json.dumps(left)[:120])

print()
if failures: print(f"{len(failures)} FAILED: " + " · ".join(failures)); sys.exit(1)
print("all checks passed")
