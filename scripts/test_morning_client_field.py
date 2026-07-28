# -*- coding: utf-8 -*-
"""
E2E for Feature 5 — map / create a Morning client from the show card.

MUST run against a dev server with MORNING_DRY_RUN=true: the create path calls
createMorningClient, which in dry-run returns a synthetic id and creates NO real
Morning client. (The Morning client LIST read is real either way.) Never run
against DRY_RUN=false — it would create a real client in the owner's books.

Proves:
  1. GET /api/clients/[id]/morning: can_edit_money only (tech 403); returns the
     current mapping (null) + the real Morning client list
  2. map to an id + unmap (POST /api/morning/clients)
  3. create: confirm=false → needs_confirmation (no duplicate) → confirm=true →
     synthetic dry id mapped to our client
  4. creating on an already-mapped client → 409
  5. create with a name that matches a real Morning client → duplicate reported
  6. tech cannot create (403)
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

def mkclient(tag):
    return ins("clients", {"name": tag, "normalized_name": tag.lower().replace(" ", "")})

TAG = "ZTESTMC" + uuid.uuid4().hex[:6]
money_uid, money_ck = mkuser("ZTESTMC_money", True)
tech_uid, tech_ck = mkuser("ZTESTMC_tech", False)
c1 = mkclient(f"{TAG} one")
c2 = mkclient(f"{TAG} two")

def get_morning(ck, cid): return requests.get(f"{APP}/api/clients/{cid}/morning", cookies=ck)
def do_map(ck, cid, mid, name=None, confirm_shared=False):
    return requests.post(f"{APP}/api/morning/clients", cookies=ck, headers={"Content-Type": "application/json"},
                         json={"client_id": cid, "morning_client_id": mid, "morning_client_name": name, "confirm_shared": confirm_shared})
def do_create(ck, cid, name, confirm):
    return requests.post(f"{APP}/api/morning/clients/create", cookies=ck, headers={"Content-Type": "application/json"},
                         json={"client_id": cid, "name": name, "confirm": confirm})

try:
    # 1. GET mapping info
    r = get_morning(money_ck, c1["id"])
    check("GET morning 200", r.status_code == 200)
    body = r.json()
    real_morning = body.get("morning_clients", [])
    check("current null + morning list present", body.get("current") is None and isinstance(real_morning, list) and len(real_morning) > 0)
    check("tech GET 403", get_morning(tech_ck, c1["id"]).status_code == 403)

    # 2. map to a (fake) id + unmap
    fake = f"ZTESTMCFAKE-{uuid.uuid4().hex[:8]}"
    check("map 200", do_map(money_ck, c1["id"], fake, "fake").status_code == 200)
    check("current reflects map", get_morning(money_ck, c1["id"]).json()["current"]["id"] == fake)
    check("unmap 200", do_map(money_ck, c1["id"], None).status_code == 200)
    check("current null after unmap", get_morning(money_ck, c1["id"]).json()["current"] is None)

    # 3. create (double-confirm, no duplicate)
    r = do_create(money_ck, c1["id"], f"{TAG} brandnew", False)
    check("create step1 needs_confirmation, no dup", r.status_code == 200 and r.json().get("needs_confirmation") and r.json().get("duplicate") is None)
    r = do_create(money_ck, c1["id"], f"{TAG} brandnew", True)
    b = r.json()
    check("create step2 → dry id mapped", r.status_code == 200 and b.get("ok") and str(b.get("morning_client_id", "")).startswith("dry-client-") and b.get("dryRun") is True)
    row = requests.get(rest(f"clients?id=eq.{c1['id']}&select=morning_client_id"), headers=A).json()[0]
    check("client now mapped to dry id", str(row["morning_client_id"]).startswith("dry-client-"))

    # 4. already mapped
    check("create on mapped client 409", do_create(money_ck, c1["id"], "x", True).status_code == 409)

    # 5. duplicate detection against a real Morning name
    real_name = real_morning[0]["name"]
    r = do_create(money_ck, c2["id"], real_name, False)
    check("duplicate reported for existing Morning name", r.status_code == 200 and r.json().get("duplicate") is not None)

    # 6. tech create blocked
    check("tech create 403", do_create(tech_ck, c2["id"], f"{TAG} x", False).status_code == 403)
finally:
    dele("events", f"entity_id=eq.{c1['id']}")
    dele("events", f"entity_id=eq.{c2['id']}")
    dele("clients", f"id=eq.{c1['id']}")
    dele("clients", f"id=eq.{c2['id']}")
    for uid in (money_uid, tech_uid):
        patch("events", f"actor_id=eq.{uid}", {"actor_id": None})
        requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = requests.get(rest("profiles?name=like.ZTESTMC*&select=id"), headers=A).json()
    print(f"\n{passed} passed, {fail} failed · cleanup:", "ok" if left == [] else f"LEFT {left}")
    sys.exit(1 if fail else 0)
