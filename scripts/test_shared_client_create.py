# -*- coding: utf-8 -*-
"""
E2E for the shared "צור לקוח במורנינג" component's backend (unified create
route) — the brand-new (no client_id) mode used by the ClientPicker.

MUST run with MORNING_DRY_RUN=true (create returns a synthetic id, no real
Morning client). Proves:
  1. brand-new create: confirm=false → no dup; confirm=true → creates OUR client
     + Morning id + maps + returns the new client_id (one-click create+map+select)
  2. an existing client of ours with the same name is reported and REUSED (no
     duplicate our-client created)
  3. map_to_morning_id adopts an existing Morning client (no new record)
  4. tech (no can_edit_money) is refused
Self-cleaning.
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

TAG = "ZTESTSCC" + uuid.uuid4().hex[:6]
money_uid, money_ck = mkuser("ZTESTSCC_money", True)
tech_uid, tech_ck = mkuser("ZTESTSCC_tech", False)
created_client_ids = []

def create(ck, payload):
    return requests.post(f"{APP}/api/morning/clients/create", cookies=ck, headers={"Content-Type": "application/json"}, json=payload)

try:
    # 1. brand-new create (no client_id)
    fresh = f"{TAG} fresh"
    r = create(money_ck, {"name": fresh, "confirm": False})
    b = r.json()
    check("brand-new step1: no dup", r.status_code == 200 and b.get("needs_confirmation") and b.get("duplicate") is None and b.get("existing_client") is None)
    r = create(money_ck, {"name": fresh, "confirm": True})
    b = r.json()
    ok = r.status_code == 200 and b.get("ok") and b.get("client_id") and str(b.get("morning_client_id", "")).startswith("dry-client-")
    check("brand-new step2: created client + dry morning id", ok)
    if b.get("client_id"):
        created_client_ids.append(b["client_id"])
        row = requests.get(rest(f"clients?id=eq.{b['client_id']}&select=name,morning_client_id"), headers=A).json()[0]
        check("our client created + mapped", row["name"] == fresh and str(row["morning_client_id"]).startswith("dry-client-"))

    # 2. existing our-client is reported + reused (no duplicate)
    dupname = f"{TAG} dup"
    existing = ins("clients", {"name": dupname, "normalized_name": dupname.lower().replace(" ", "")})
    created_client_ids.append(existing["id"])
    r = create(money_ck, {"name": dupname, "confirm": False})
    b = r.json()
    check("existing our-client reported", b.get("existing_client") and b["existing_client"]["id"] == existing["id"] and b["existing_client"]["mapped"] is False)
    r = create(money_ck, {"name": dupname, "confirm": True})
    b = r.json()
    check("reused existing client (no new row)", r.status_code == 200 and b.get("client_id") == existing["id"])
    same_name = requests.get(rest(f"clients?normalized_name=eq.{dupname.lower().replace(' ','')}&select=id"), headers=A).json()
    check("no duplicate our-client", len(same_name) == 1)

    # 3. adopt an existing Morning id (map_to_morning_id, no create)
    adoptid = f"ADOPT-{uuid.uuid4().hex[:8]}"
    r = create(money_ck, {"name": f"{TAG} adopt", "confirm": True, "map_to_morning_id": adoptid})
    b = r.json()
    check("adopt maps to given morning id", r.status_code == 200 and b.get("morning_client_id") == adoptid)
    if b.get("client_id"):
        created_client_ids.append(b["client_id"])

    # 4. tech refused
    check("tech create 403", create(tech_ck, {"name": f"{TAG} x", "confirm": False}).status_code == 403)
finally:
    for cid in created_client_ids:
        dele("events", f"entity_id=eq.{cid}")
        dele("clients", f"id=eq.{cid}")
    # sweep any stragglers created by brand-new/adopt paths
    for c in requests.get(rest(f"clients?name=like.{TAG}*&select=id"), headers=A).json():
        dele("events", f"entity_id=eq.{c['id']}")
        dele("clients", f"id=eq.{c['id']}")
    for uid in (money_uid, tech_uid):
        patch("events", f"actor_id=eq.{uid}", {"actor_id": None})
        requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = requests.get(rest("profiles?name=like.ZTESTSCC*&select=id"), headers=A).json()

print(f"\n{passed} passed, {fail} failed · cleanup:", "ok" if left == [] else f"LEFT {left}")
sys.exit(1 if fail else 0)
