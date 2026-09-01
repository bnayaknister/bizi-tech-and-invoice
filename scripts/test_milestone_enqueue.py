# -*- coding: utf-8 -*-
"""
POST /api/contracts/milestones/[mid]/enqueue — queue a work order for a
contract milestone (stage 1, 2026-09-01).

WHAT THIS ROUTE IS, AND WHAT IT IS NOT
--------------------------------------
It puts a work order into the approval queue. It does NOT issue anything: the
row lands as 'pending' and only /documents/pending/review reaches Morning. Its
sibling `issue` route is the opposite — it RECORDS a document raised by hand and
issues nothing either. The two must not be confused, which is why they are two
routes (see a5dbdf8, which deleted the mode-switch that conflated them).

TOUCHES MORNING: never. Nothing here approves. Even so this file honours rule 40
and reads TEST_APP_URL — a queued document is one human click away from being
issued, and a test that leaves rows on :3000 is a test that leaves a loaded gun.

  1  a milestone with no job          -> 200, CLEAN job created, milestone linked
  2  the queue row's shape            -> work_order, job_id set, production_id null
  3  milestone.status untouched       -> still 'pending' after queueing
  4  a second enqueue                 -> 409 (the live-row guard)
  5  a job that already carries a doc -> 409, message names the number
  6  an unmapped client               -> 400
  7  amount = 0                       -> 400 (the guard this route adds)
  8  no can_edit_money                -> 403
  9  an existing job_id is REUSED     -> no second job is created
 10  cleanup, verified

Every row created is deleted in finally AND the deletion is verified, in FK
order (events -> pending_documents -> milestones -> jobs -> contracts -> client
-> auth users).
"""
import base64
import json
import os
import sys
import time
import uuid

import requests

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")
with open(ENV_PATH, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

S = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
# rule 40 (TICKETS.md): never hard-code :3000 — an approving flow must be able
# to run against the isolated DRY_RUN server.
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
REPR = {"Prefer": "return=representation"}
REF = S.split("//")[1].split(".")[0]
CN = f"sb-{REF}-auth-token"

fails = []
users = []
contract_ids = []
milestone_ids = []
job_ids = []
pending_ids = []
client_ids = []


def check(label, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + (f"  — {detail}" if detail and not ok else ""))
    if not ok:
        fails.append(label)


def rest(p):
    return f"{S}/rest/v1/{p}"


def ins(table, row):
    r = requests.post(rest(table), headers={**A, **REPR}, json=row)
    if r.status_code >= 300:
        raise RuntimeError(f"{table}: {r.status_code} {r.text[:300]}")
    return r.json()[0]


def make_user(**flags):
    email = f"ztest-{uuid.uuid4().hex[:8]}@example.com"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{S}/auth/v1/admin/users", headers=A,
                        json={"email": email, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers=A, json={"approved": True, **flags})
    tok = requests.post(f"{S}/auth/v1/token?grant_type=password",
                        headers={"apikey": ANON, "Content-Type": "application/json"},
                        json={"email": email, "password": pw}).json()
    val = "base64-" + base64.b64encode(json.dumps(tok).encode()).decode()
    if len(val) <= 3180:
        return {CN: val}
    return {f"{CN}.{i // 3180}": val[i:i + 3180] for i in range(0, len(val), 3180)}


def enqueue(ck, mid):
    return requests.post(f"{APP}/api/contracts/milestones/{mid}/enqueue", cookies=ck, timeout=90)


def milestone(contract_id, name, amount):
    m = ins("contract_milestones", {"contract_id": contract_id, "name": name, "amount": amount})
    milestone_ids.append(m["id"])
    return m


try:
    for _ in range(45):
        try:
            if requests.get(APP, timeout=2).status_code < 500:
                break
        except Exception:
            pass
        time.sleep(1)
    print(f"APP = {APP}\n")

    money = make_user(can_view_money=True, can_edit_money=True, can_view_stages=True, role="owner")
    tech = make_user(can_view_stages=True, can_edit_stages=True, role="tech")

    tag = uuid.uuid4().hex[:8]
    mapped = ins("clients", {"name": f"ZTEST לקוח ממופה {tag}", "normalized_name": f"ztest-mapped-{tag}",
                             "morning_client_id": str(uuid.uuid4())})
    unmapped = ins("clients", {"name": f"ZTEST לקוח לא ממופה {tag}", "normalized_name": f"ztest-unmapped-{tag}"})
    client_ids += [mapped["id"], unmapped["id"]]

    con = ins("contracts", {"name": f"ZTEST חוזה {tag}", "client_id": mapped["id"], "total_amount": 10000})
    con_un = ins("contracts", {"name": f"ZTEST חוזה לא ממופה {tag}", "client_id": unmapped["id"], "total_amount": 5000})
    contract_ids += [con["id"], con_un["id"]]

    # ---------- 1 + 2 + 3: the happy path -----------------------------------
    print("1-3. אבן דרך בלי job")
    m1 = milestone(con["id"], "אבן דרך א", 2500)
    r = enqueue(money, m1["id"])
    body = r.json()
    check("1a. enqueue מחזיר 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    check("1b. status=queued", body.get("status") == "queued", json.dumps(body)[:150])
    new_job_id = body.get("job_id")
    if new_job_id:
        job_ids.append(new_job_id)
    if body.get("id"):
        pending_ids.append(body["id"])

    job = requests.get(rest(f"jobs?id=eq.{new_job_id}&select=*"), headers=A).json()[0]
    check("1c. נוצר job נקי — invoice_biz ריק", job["invoice_biz"] is None, str(job["invoice_biz"]))
    check("1d. ...וגם invoice_tax ריק", job["invoice_tax"] is None, str(job["invoice_tax"]))
    check("1e. ה-job נושא את החוזה", job["contract_id"] == con["id"], str(job["contract_id"]))
    check("1f. ה-job נושא את הלקוח", job["client_id"] == mapped["id"], str(job["client_id"]))
    check("1g. הסכום עבר מאבן הדרך", float(job["amount"]) == 2500.0, str(job["amount"]))

    ms_after = requests.get(rest(f"contract_milestones?id=eq.{m1['id']}&select=job_id,status"), headers=A).json()[0]
    check("1h. אבן הדרך מצביעה ל-job", ms_after["job_id"] == new_job_id, str(ms_after["job_id"]))

    pend = requests.get(rest(f"pending_documents?id=eq.{body['id']}&select=*"), headers=A).json()[0]
    check("2a. שורת תור מסוג work_order", pend["doc_type"] == "work_order", pend["doc_type"])
    check("2b. job_id מוגדר", pend["job_id"] == new_job_id, str(pend["job_id"]))
    check("2c. production_id ריק", pend["production_id"] is None, str(pend["production_id"]))
    check("2d. status=pending", pend["status"] == "pending", pend["status"])
    check("2e. הסכום בשורה", float(pend["amount"]) == 2500.0, str(pend["amount"]))
    check("2f. payload type=100", (pend["payload"] or {}).get("type") == 100, str((pend["payload"] or {}).get("type")))

    check("3. milestone.status לא זז — עדיין pending", ms_after["status"] == "pending", ms_after["status"])

    ev = requests.get(rest(f"events?entity_id=eq.{body['id']}&select=event_type,payload"), headers=A).json()
    check("3b. ההנפקה מתועדת עם via=contract_milestone",
          any((e["payload"] or {}).get("via") == "contract_milestone" for e in ev),
          json.dumps(ev, ensure_ascii=False)[:200])

    # ---------- 4: double enqueue -------------------------------------------
    print("\n4. הנפקה שנייה על אותה אבן דרך")
    r = enqueue(money, m1["id"])
    check("4a. נדחה 409", r.status_code == 409, f"{r.status_code} {r.text[:150]}")
    check("4b. ההודעה מדברת על התור", "כבר קיימת" in (r.json().get("error") or ""),
          (r.json().get("error") or "")[:120])
    n_jobs = requests.get(rest(f"jobs?contract_id=eq.{con['id']}&select=id"), headers=A).json()
    check("4c. לא נוצר job נוסף", len(n_jobs) == 1, f"{len(n_jobs)} jobs")

    # ---------- 5: a job that already carries a document number -------------
    print("\n5. אבן דרך שה-job שלה כבר נושא מסמך")
    m2 = milestone(con["id"], "אבן דרך ב", 3000)
    billed = ins("jobs", {"client_id": mapped["id"], "contract_id": con["id"], "campaign": f"ZTEST billed {tag}",
                          "amount": 3000, "paid": "לא", "invoice_biz": "ZT-40999", "legacy": False})
    job_ids.append(billed["id"])
    requests.patch(rest(f"contract_milestones?id=eq.{m2['id']}"), headers=A, json={"job_id": billed["id"]})
    r = enqueue(money, m2["id"])
    check("5a. נדחה 409", r.status_code == 409, f"{r.status_code} {r.text[:150]}")
    check("5b. ההודעה נוקבת במספר המסמך", "ZT-40999" in (r.json().get("error") or ""),
          (r.json().get("error") or "")[:150])
    q = requests.get(rest(f"pending_documents?job_id=eq.{billed['id']}&select=id"), headers=A).json()
    check("5c. לא נוצרה שורת תור", len(q) == 0, json.dumps(q))

    # ---------- 6: unmapped client ------------------------------------------
    print("\n6. לקוח לא ממופה למורנינג")
    m3 = milestone(con_un["id"], "אבן דרך לא ממופה", 1000)
    r = enqueue(money, m3["id"])
    check("6a. נדחה 400", r.status_code == 400, f"{r.status_code} {r.text[:150]}")
    check("6b. ההודעה מסבירה למה", "ממופה" in (r.json().get("error") or ""), (r.json().get("error") or "")[:120])
    check("6c. לא נוצר job", len(requests.get(rest(f"jobs?contract_id=eq.{con_un['id']}&select=id"),
                                              headers=A).json()) == 0)

    # ---------- 7: zero amount ----------------------------------------------
    print("\n7. אבן דרך בסכום 0")
    m4 = milestone(con["id"], "אבן דרך אפס", 0)
    r = enqueue(money, m4["id"])
    check("7a. נדחה 400", r.status_code == 400, f"{r.status_code} {r.text[:150]}")
    check("7b. ההודעה מבקשת לעדכן סכום", "סכום" in (r.json().get("error") or ""),
          (r.json().get("error") or "")[:120])
    ms4 = requests.get(rest(f"contract_milestones?id=eq.{m4['id']}&select=job_id"), headers=A).json()[0]
    check("7c. לא נוצר job לאבן דרך אפס", ms4["job_id"] is None, str(ms4["job_id"]))

    # ---------- 8: permissions ----------------------------------------------
    print("\n8. הרשאות")
    m5 = milestone(con["id"], "אבן דרך הרשאות", 900)
    r = enqueue(tech, m5["id"])
    check("8a. טכנאי נדחה 403", r.status_code == 403, str(r.status_code))
    r = enqueue({}, m5["id"])
    check("8b. בלי התחברות 401", r.status_code == 401, str(r.status_code))
    ms5 = requests.get(rest(f"contract_milestones?id=eq.{m5['id']}&select=job_id"), headers=A).json()[0]
    check("8c. שום job לא נוצר בניסיונות שנדחו", ms5["job_id"] is None, str(ms5["job_id"]))

    # ---------- 9: an existing CLEAN job is reused ---------------------------
    print("\n9. שימוש חוזר ב-job קיים ונקי")
    m6 = milestone(con["id"], "אבן דרך עם job קיים", 1750)
    clean = ins("jobs", {"client_id": mapped["id"], "contract_id": con["id"], "campaign": f"ZTEST clean {tag}",
                         "amount": 1750, "paid": "לא", "legacy": False})
    job_ids.append(clean["id"])
    requests.patch(rest(f"contract_milestones?id=eq.{m6['id']}"), headers=A, json={"job_id": clean["id"]})
    before = len(requests.get(rest(f"jobs?contract_id=eq.{con['id']}&select=id"), headers=A).json())
    r = enqueue(money, m6["id"])
    body6 = r.json()
    check("9a. enqueue מחזיר 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    check("9b. השתמש ב-job הקיים", body6.get("job_id") == clean["id"], str(body6.get("job_id")))
    if body6.get("id"):
        pending_ids.append(body6["id"])
    after = len(requests.get(rest(f"jobs?contract_id=eq.{con['id']}&select=id"), headers=A).json())
    check("9c. לא נוצר job שני", after == before, f"{before} -> {after}")
    check("9d. אבן הדרך עדיין מצביעה לאותו job",
          requests.get(rest(f"contract_milestones?id=eq.{m6['id']}&select=job_id"),
                       headers=A).json()[0]["job_id"] == clean["id"])
finally:
    print("\n=== CLEANUP ===")
    ent = [x for x in pending_ids + milestone_ids + contract_ids + job_ids if x]
    if ent:
        requests.delete(rest(f"events?entity_id=in.({','.join(ent)})"), headers=A)
    # the queue rows may include ones the route made that we never captured
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
    for uid in users:
        requests.delete(f"{S}/auth/v1/admin/users/{uid}", headers=A)
        gone = requests.get(f"{S}/auth/v1/admin/users/{uid}", headers=A).status_code
        check(f"cleanup: משתמש {uid[:8]} נמחק", gone in (403, 404), f"HTTP {gone}")

    print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: " + " | ".join(fails)))
    sys.exit(0 if not fails else 1)
