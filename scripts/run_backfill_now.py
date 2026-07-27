# -*- coding: utf-8 -*-
"""
Run the client back-fill on production now (owner instruction 2026-07-27):
POST /api/documents/backfill resolves every "לא משויך" doc whose Morning client
is already mapped, then auto-links certain matches. Reports the before/after
breakdown of the unassigned set (billing = real work for Shiri vs noise).
Temp bookkeeper is only the trigger; back-fill/auto events carry no temp actor,
so the user is removed cleanly.
"""
import base64, json, os, sys, time, uuid
from collections import Counter
import requests

for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]; SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
ref = U.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"
TYPE = {10: "הצעה", 100: "הזמנה", 300: "עסקה", 305: "מס", 320: "מס/קבלה", 330: "זיכוי", 400: "קבלה"}
BILLING = {300, 305, 320, 400}
PAYMENT = {320, 400}


def rest(p): return f"{U}/rest/v1/{p}"


def snapshot():
    docs = requests.get(rest("documents?select=type,client_id,job_id,amount"), headers=A).json()
    nc = [d for d in docs if not d["client_id"]]
    return len(nc), Counter(d["type"] for d in nc)


for _ in range(90):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("dev server never came up"); sys.exit(1)

em = f"bf-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**A, "Prefer": "return=representation"}, json={"name": "ZTESTBF", "approved": True, "role": "bookkeeper", "can_view_money": True, "can_edit_money": True})
td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"}, json={"email": em, "password": pw}).json()
sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600, "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
ck = {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}

try:
    n0, _ = snapshot()
    print(f"BEFORE: לא משויך (client_id null) = {n0}")
    resp = requests.post(f"{APP}/api/documents/backfill", cookies=ck, timeout=120).json()
    print(f"backfill: resolved client on {resp.get('backfilled')} docs · auto-linked {resp.get('linked')} to jobs")
    n1, byt = snapshot()
    print(f"AFTER:  לא משויך (client_id null) = {n1}   (dropped {n0 - n1})\n")
    print("Remaining unassigned by type:")
    bill = noise = 0
    for t, c in sorted(byt.items(), key=lambda x: -x[1]):
        cat = "חיוב (Shiri)" if t in BILLING else "רעש"
        if t in BILLING: bill += c
        else: noise += c
        print(f"  {TYPE.get(t, t):8} {c:3}  {cat}")
    print(f"\n  billing docs (real work): {bill}  |  noise (quotes/orders/credits): {noise}")
finally:
    requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = requests.get(rest("profiles?name=like.*ZTESTBF*&select=id"), headers=A).json()
    print("cleanup temp user:", "ok" if left == [] else f"LEFT {left}")
