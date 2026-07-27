# -*- coding: utf-8 -*-
"""
One-off historical full pull + re-reconcile (owner instruction 2026-07-27).

Runs the REAL code path against a running dev server:
  1. POST /api/documents/sync {full:true} — unbounded pull of every Morning
     document (no date window). This also runs backfill + autoReconcile at its
     tail, so auto-matching re-runs over the newly-arrived old documents.
  2. POST /api/finance/reconcile-payments — the payment engine, so any now-
     present receipt/מס-קבלה marks its unpaid job paid.

A temp bookkeeper is only the trigger; events + invoice rows are re-attributed
to the OWNER afterwards and the temp user is removed (test-data-cleanup-rule).
Reports registry counts + debt before/after.
"""
import base64, json, os, sys, time, uuid
from collections import Counter
from datetime import date, datetime
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


def reg_stats():
    docs = requests.get(rest("documents?select=type,client_id,job_id"), headers=A).json()
    by_type = Counter(d["type"] for d in docs)
    unmatched = sum(1 for d in docs if not d.get("client_id"))
    linked = sum(1 for d in docs if d.get("job_id"))
    return len(docs), by_type, unmatched, linked


def debt_and_red():
    jobs = requests.get(rest("jobs?select=amount,paid,due_date,dismissed"), headers=A).json()
    today = date.today()
    unpaid = [j for j in jobs if j["paid"] == "לא" and not j.get("dismissed") and j["amount"] is not None]
    def od(d):
        try: return (today - datetime.fromisoformat(str(d)[:10]).date()).days
        except Exception: return None
    debt = sum(float(j["amount"]) for j in unpaid)
    red = [j for j in unpaid if j["due_date"] and od(j["due_date"]) and od(j["due_date"]) > 60]
    return debt, len(unpaid), sum(float(j["amount"]) for j in red), len(red)


for _ in range(120):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("dev server never came up"); sys.exit(1)

em = f"fullpull-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**A, "Prefer": "return=representation"},
               json={"name": "ZTESTFULLPULL", "approved": True, "role": "bookkeeper", "can_view_money": True, "can_edit_money": True})
td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"},
                   json={"email": em, "password": pw}).json()
sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
        "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
ck = {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}

try:
    n0, t0, um0, lk0 = reg_stats()
    d0, u0, r0, rc0 = debt_and_red()
    print(f"BEFORE  registry docs={n0}  unmatched={um0}  job-linked={lk0}")
    print(f"        debt={d0:,.0f} ({u0} unpaid) · VU-red(>60d)={r0:,.0f} ({rc0} jobs)")

    print("\n[1] full historical pull  POST /api/documents/sync {full:true} …")
    pull = requests.post(f"{APP}/api/documents/sync", cookies=ck,
                         headers={"Content-Type": "application/json"},
                         json={"full": True}, timeout=600).json()
    print("    summary:", json.dumps(pull, ensure_ascii=False))

    print("\n[3] payment engine  POST /api/finance/reconcile-payments …")
    pay = requests.post(f"{APP}/api/finance/reconcile-payments", cookies=ck, timeout=300).json()
    print(f"    marked {pay.get('paid')} jobs paid")
    for it in pay.get("items", []):
        print(f"      ✓ {it['amount']}₪ <- receipt #{it['docNumber']}")

    # re-attribute anything the temp user created, then report after-state
    requests.patch(rest(f"events?actor_id=eq.{uid}"), headers=A, json={"actor_id": OWNER})
    requests.patch(rest(f"invoices?issued_by=eq.{uid}"), headers=A, json={"issued_by": OWNER})

    n1, t1, um1, lk1 = reg_stats()
    d1, u1, r1, rc1 = debt_and_red()
    print(f"\nAFTER   registry docs={n1}  unmatched={um1}  job-linked={lk1}")
    print(f"        debt={d1:,.0f} ({u1} unpaid) · VU-red(>60d)={r1:,.0f} ({rc1} jobs)")
    print(f"\nDELTA   docs +{n1-n0}   job-linked +{lk1-lk0}   unmatched {um0}->{um1}")
    print(f"        debt {d0-d1:+,.0f}   VU-red {r0-r1:+,.0f} ({rc0-rc1:+d} jobs)")
    print("        registry by type (after):", dict(sorted(t1.items())))
finally:
    requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = requests.get(rest("profiles?name=like.*ZTESTFULLPULL*&select=id"), headers=A).json()
    print("cleanup temp user:", "ok" if left == [] else f"LEFT {left}")
