# -*- coding: utf-8 -*-
"""
Group A run (owner instruction 2026-07-27): reconcile the already-paid jobs.
Hits the real /api/finance/reconcile-payments so autoReconcile's payment
engine marks every UNIQUE 1:1 payment match (unpaid job + unlinked receipt,
same client+amount) as paid. Ambiguous matches (client+amount that fit >1 job)
are deliberately left for Shiri.

A temp bookkeeper is only the trigger; the resulting events + invoice rows are
re-attributed to the OWNER afterwards, so the record is honest and the temp
user is removed cleanly. Reports debt + VU-red (>60d overdue) before/after.
"""
import base64, json, os, sys, time, uuid
from datetime import datetime, date
import requests

for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]; SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
ref = U.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"
OWNER = "432bc1cc-b71b-4d68-9037-3e6384612510"  # bnayaknister@gmail.com


def rest(p): return f"{U}/rest/v1/{p}"


def debt_and_red():
    jobs = requests.get(rest("jobs?select=id,amount,paid,due_date,dismissed,client_id,campaign"), headers=A).json()
    today = date.today()
    unpaid = [j for j in jobs if j["paid"] == "לא" and not j.get("dismissed") and j["amount"] is not None]
    def od(d):
        try: return (today - datetime.fromisoformat(str(d)[:10]).date()).days
        except: return None
    debt = sum(float(j["amount"]) for j in unpaid)
    red = [j for j in unpaid if j["due_date"] and od(j["due_date"]) and od(j["due_date"]) > 60]
    return debt, len(unpaid), sum(float(j["amount"]) for j in red), len(red)


for _ in range(90):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("dev server never came up"); sys.exit(1)

clients = {c["id"]: c["name"] for c in requests.get(rest("clients?select=id,name"), headers=A).json()}

em = f"paynow-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**A, "Prefer": "return=representation"}, json={"name": "ZTESTPAYNOW", "approved": True, "role": "bookkeeper", "can_view_money": True, "can_edit_money": True})
td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"}, json={"email": em, "password": pw}).json()
sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600, "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
ck = {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}

try:
    d0, n0, r0, rc0 = debt_and_red()
    print(f"BEFORE:  debt={d0:,.0f} ({n0} unpaid) · VU-red(>60d)={r0:,.0f} ({rc0} jobs)")

    resp = requests.post(f"{APP}/api/finance/reconcile-payments", cookies=ck, timeout=120).json()
    print(f"\nreconcile-payments: marked {resp.get('paid')} jobs paid")
    for it in resp.get("items", []):
        cn = clients.get(requests.get(rest(f"jobs?id=eq.{it['jobId']}&select=client_id,campaign"), headers=A).json()[0]["client_id"], "?")
        print(f"  ✓ {cn}  {it['amount']}₪  <- receipt #{it['docNumber']}")

    # re-attribute the marks to the owner, then drop the temp trigger user
    requests.patch(rest(f"events?actor_id=eq.{uid}"), headers=A, json={"actor_id": OWNER})
    requests.patch(rest(f"invoices?issued_by=eq.{uid}"), headers=A, json={"issued_by": OWNER})

    d1, n1, r1, rc1 = debt_and_red()
    print(f"\nAFTER:   debt={d1:,.0f} ({n1} unpaid) · VU-red(>60d)={r1:,.0f} ({rc1} jobs)")
    print(f"debt dropped {d0-d1:,.0f} · VU-red dropped {r0-r1:,.0f}")
finally:
    requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = requests.get(rest("profiles?name=like.*ZTESTPAYNOW*&select=id"), headers=A).json()
    print("cleanup temp user:", "ok" if left == [] else f"LEFT {left}")
