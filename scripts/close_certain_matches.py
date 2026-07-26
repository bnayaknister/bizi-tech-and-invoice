# -*- coding: utf-8 -*-
"""
Step 5 (owner instruction 2026-07-26): close the certain matches now.

Triggers the REAL product pull (POST /api/documents/sync), which runs
autoReconcile and links every certain 1:1 tax match to its red job as a
SYSTEM auto-match (event actor null) — exactly the nightly-cron behavior,
run early. Expected to close פארמה תמר (#60157) and כפיר ארביב (#60169);
בלאנקו (80-day gap) and נטע צמח (3 candidates) are correctly NOT auto-linked.

A temp bookkeeper is only the trigger (can_edit_money) — it is NOT the actor
of the links (those are actor null), and the pull's own bookkeeping event
carries the actor in payload, not actor_id — so deleting the temp user leaves
every reconciliation record intact. Read-only against Morning.
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


def rest(p): return f"{U}/rest/v1/{p}"


def red_jobs():
    rows = requests.get(rest("jobs?select=id,campaign,client_id,invoice_tax,paid&paid=eq.%D7%9B%D7%9F"), headers=A).json()
    return {r["id"]: r for r in rows if not (r["invoice_tax"] and str(r["invoice_tax"]).strip())}


for _ in range(90):
    try:
        if requests.get(APP, timeout=2).status_code < 500:
            break
    except requests.exceptions.ConnectionError:
        pass
    time.sleep(1)
else:
    print("dev server never came up"); sys.exit(1)

# temp bookkeeper (trigger only)
em = f"close-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**A, "Prefer": "return=representation"},
               json={"name": "ZTESTCLOSE trigger", "approved": True, "role": "bookkeeper", "can_view_money": True, "can_edit_money": True})
td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"},
                   json={"email": em, "password": pw}).json()
sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
        "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
ck = {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}

try:
    before = red_jobs()
    print(f"RED jobs before: {len(before)} -> {[j['campaign'] for j in before.values()]}")

    r = requests.post(f"{APP}/api/documents/sync", cookies=ck, timeout=300)
    print("pull summary:", json.dumps(r.json(), ensure_ascii=False))

    after = red_jobs()
    closed = [before[i] for i in before if i not in after]
    print(f"RED jobs after:  {len(after)}")
    print(f"CLOSED this run: {len(closed)}")
    for j in closed:
        job = requests.get(rest(f"jobs?id=eq.{j['id']}&select=invoice_tax"), headers=A).json()[0]
        ev = requests.get(rest(f"events?entity_id=eq.{j['id']}&event_type=eq.document_reconciled&select=actor_id,payload"), headers=A).json()
        print(f"  ✓ {j['campaign']}  -> invoice_tax={job['invoice_tax']}  "
              f"event(actor={ev[-1]['actor_id'] if ev else '?'}, auto={ev[-1]['payload'].get('auto') if ev else '?'})")
finally:
    requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = requests.get(rest("profiles?name=like.*ZTESTCLOSE*&select=id"), headers=A).json()
    print("cleanup temp trigger user:", "ok" if left == [] else f"LEFT {left}")
