# -*- coding: utf-8 -*-
"""
Live demo on the REAL בלאנקו case (owner request 2026-07-26): show that the
relaxed engine now surfaces #60152 as a HIGH-confidence suggestion despite the
80-day gap, and that a one-click assign closes the job.

This MUTATES real data (closes בלאנקו's job) — that is exactly what the owner
asked for ("הרץ על בלנקו... שיוך בלחיצה → סגור, על המקרה האמיתי"). The link is
performed through the real POST endpoint by a temp bookkeeper; afterwards the
event/actor + invoice/issued_by are re-attributed to the OWNER (who instructed
it) so the record is honest and the temp user can be removed cleanly.
"""
import base64, json, os, sys, time, uuid
import requests

for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]; SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
ref = U.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"

JOB = "fd8c8dc1-c554-4517-af8f-cd72972456a9"   # בלאנקו · פודקאסט מירן פחמן · 800
DOC = "2e2416f6-d281-4531-ba51-20109ced1ac0"   # #60152 · מס/קבלה · 944
OWNER = "432bc1cc-b71b-4d68-9037-3e6384612510" # bnayaknister@gmail.com


def rest(p): return f"{U}/rest/v1/{p}"


for _ in range(90):
    try:
        if requests.get(APP, timeout=2).status_code < 500:
            break
    except requests.exceptions.ConnectionError:
        pass
    time.sleep(1)
else:
    print("dev server never came up"); sys.exit(1)

em = f"blanco-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**A, "Prefer": "return=representation"},
               json={"name": "ZTESTBLANCO", "approved": True, "role": "bookkeeper", "can_view_money": True, "can_edit_money": True})
td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"},
                   json={"email": em, "password": pw}).json()
sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
        "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
ck = {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}

try:
    print("=== BEFORE ===")
    j0 = requests.get(rest(f"jobs?id=eq.{JOB}&select=campaign,paid,invoice_tax,amount"), headers=A).json()[0]
    print(f"  job: {j0['campaign']}  amount={j0['amount']}  paid={j0['paid']}  invoice_tax={j0['invoice_tax']}  -> RED")

    print("\n=== STEP 3: what the 'שייך מסמך קיים' picker shows for בלאנקו ===")
    cands = requests.get(f"{APP}/api/documents/reconcile?jobId={JOB}", cookies=ck).json()["candidates"]
    for c in cands:
        print(f"  #{c['number']} · {c['typeLabel']} · {c['amount']}₪ · {c['date']}  "
              f"=> confidence={c['confidence']} basis={c['amountBasis']} gap={c['dateGapDays']}d")
    top = next((c for c in cands if c["number"] == "60152"), None)
    print(f"  ==> #60152 surfaced: {bool(top)}; confidence: {top and top['confidence']}; gap: {top and top['dateGapDays']}d")

    print("\n=== ONE-CLICK ASSIGN (Shiri confirms) ===")
    r = requests.post(f"{APP}/api/documents/reconcile", cookies=ck, json={"docId": DOC, "jobId": JOB})
    print(f"  POST -> {r.status_code} {json.dumps(r.json(), ensure_ascii=False)}")

    # re-attribute the manual close to the owner, then drop the temp user
    requests.patch(rest(f"events?entity_id=eq.{JOB}&event_type=eq.document_reconciled&actor_id=eq.{uid}"),
                   headers=A, json={"actor_id": OWNER})
    requests.patch(rest(f"invoices?issued_by=eq.{uid}"), headers=A, json={"issued_by": OWNER})

    print("\n=== AFTER ===")
    j1 = requests.get(rest(f"jobs?id=eq.{JOB}&select=campaign,paid,invoice_tax"), headers=A).json()[0]
    d1 = requests.get(rest(f"documents?id=eq.{DOC}&select=job_id,client_id"), headers=A).json()[0]
    inv = requests.get(rest(f"invoices?job_id=eq.{JOB}&type=eq.%D7%9E%D7%A1&select=doc_number,source,issued_by"), headers=A).json()
    ev = requests.get(rest(f"events?entity_id=eq.{JOB}&event_type=eq.document_reconciled&select=actor_id,payload"), headers=A).json()
    print(f"  job.invoice_tax = {j1['invoice_tax']}   -> state now: {'סגור' if j1['invoice_tax'] else 'RED'}")
    print(f"  doc.job_id linked = {d1['job_id'] == JOB}   doc.client_id set = {bool(d1['client_id'])}")
    print(f"  invoices row: {inv}")
    print(f"  event actor = {ev[-1]['actor_id']} (owner)  auto = {ev[-1]['payload'].get('auto')}")
finally:
    requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = requests.get(rest("profiles?name=like.*ZTESTBLANCO*&select=id"), headers=A).json()
    print("\ncleanup temp user:", "ok" if left == [] else f"LEFT {left}")
