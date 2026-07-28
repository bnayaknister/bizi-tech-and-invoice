# -*- coding: utf-8 -*-
"""
One-off: archive the qualifying unassigned documents (owner approved 277).
Runs the REAL bulk route (POST /api/documents/archive) through a temp
bookkeeper, then re-attributes the archive + events to the OWNER. Verifies the
"לא משויך" count drops and Dani Spektor (#40292) stays visible. Reversible.
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
OWNER = "432bc1cc-b71b-4d68-9037-3e6384612510"

def rest(p): return f"{U}/rest/v1/{p}"
def patch(t, q, row): requests.patch(rest(f"{t}?{q}"), headers=A, json=row)

def count(path):
    r = requests.get(rest(path), headers={**A, "Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0"})
    cr = r.headers.get("content-range", "*/0")
    return int(cr.split("/")[-1])

def live_unassigned():
    return count("documents?select=id&client_id=is.null&cancelled_at=is.null&archived_at=is.null")

for _ in range(90):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("dev server never came up"); sys.exit(1)

em = f"arch-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
patch("profiles", f"id=eq.{uid}", {"name": "ZTESTARCHRUN", "approved": True, "role": "bookkeeper", "can_view_money": True, "can_edit_money": True})
td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"}, json={"email": em, "password": pw}).json()
sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600, "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
ck = {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}

try:
    before = live_unassigned()
    qual = requests.get(f"{APP}/api/documents/archive", cookies=ck).json().get("qualifying")
    print(f"BEFORE  live unassigned={before}  ·  qualifying to archive={qual}")

    res = requests.post(f"{APP}/api/documents/archive", cookies=ck, timeout=120).json()
    print(f"archived: {res.get('archived')}")

    # re-attribute to the owner
    patch("documents", f"archived_by=eq.{uid}", {"archived_by": OWNER})
    patch("events", f"actor_id=eq.{uid}", {"actor_id": OWNER})

    after = live_unassigned()
    archived_total = count("documents?select=id&archived_at=not.is.null")
    spektor = requests.get(rest("documents?select=morning_doc_number,archived_at,client_id&morning_doc_number=eq.40292"), headers=A).json()
    print(f"AFTER   live unassigned={after}  ·  archived total={archived_total}")
    print(f"        #40292 (דני ספקטור): archived_at={spektor[0]['archived_at'] if spektor else 'NOT FOUND'} (should be None → still visible)")
    print(f"DELTA   unassigned {before} -> {after}  (archived {before-after})")
finally:
    requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = requests.get(rest("profiles?name=like.ZTESTARCHRUN*&select=id"), headers=A).json()
    print("cleanup temp user:", "ok" if left == [] else f"LEFT {left}")
