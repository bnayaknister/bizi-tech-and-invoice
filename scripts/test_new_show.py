# -*- coding: utf-8 -*-
"""Acceptance test for '+ תוכנית חדשה' (create show). Drives the real Next API
with a constructed @supabase/ssr cookie session. Cleans up every test row."""
import os, sys, json, base64, uuid
import requests

ENV = os.path.join(os.path.dirname(__file__), "..", ".env.local")
for line in open(ENV, encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

SUP = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SVC = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
REF = SUP.split("//")[1].split(".")[0]
ADMIN = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}
MARK = "ZTESTSHOW"

fails = []
users, shows = [], []
def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok: fails.append(label)

def make_user(stages, money):
    email = f"ztest-{uuid.uuid4().hex[:8]}@example.com"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    u = requests.post(f"{SUP}/auth/v1/admin/users", headers=ADMIN,
                      json={"email": email, "password": pw, "email_confirm": True}).json()
    uid = u["id"]; users.append(uid)
    requests.patch(f"{SUP}/rest/v1/profiles?id=eq.{uid}", headers=ADMIN,
                   json={"approved": True, "can_view_stages": True, "can_edit_stages": stages,
                         "can_view_money": money, "can_edit_money": money, "role": "owner" if money else "tech"})
    tok = requests.post(f"{SUP}/auth/v1/token?grant_type=password",
                        headers={"apikey": ANON, "Content-Type": "application/json"},
                        json={"email": email, "password": pw}).json()
    # build the ssr cookie from the session
    val = "base64-" + base64.b64encode(json.dumps(tok, separators=(",", ":")).encode()).decode()
    name = f"sb-{REF}-auth-token"
    jar = {}
    if len(val) <= 3180:
        jar[name] = val
    else:
        for i, s in enumerate(range(0, len(val), 3180)):
            jar[f"{name}.{i}"] = val[s:s+3180]
    return jar

def create(jar, **body):
    return requests.post(f"{APP}/api/shows", headers={"Content-Type": "application/json"}, cookies=jar, json=body)

try:
    owner = make_user(stages=True, money=True)
    # sanity: does the cookie authenticate at all?
    probe = create(owner, name="")  # missing name -> 400 if authed, 401 if cookie bad
    check("0. cookie authenticates (400 not 401)", probe.status_code == 400, f"got {probe.status_code}: {probe.text[:120]}")

    # need a client for test 1
    cli = requests.post(f"{SUP}/rest/v1/clients", headers={**ADMIN, "Prefer": "return=representation"},
                        json={"name": f"{MARK} client", "normalized_name": f"{MARK.lower()} client"}).json()[0]

    # 1. create with client + rate
    r1 = create(owner, name=f"{MARK} alpha", aliases=[f"{MARK}-alias-a"], client_id=cli["id"],
                billing_mode="per_episode", default_rate=1500)
    ok1 = r1.status_code == 200 and r1.json().get("ok")
    if ok1: shows.append(r1.json()["show"]["id"])
    check("1. create with client+rate → saved", ok1, f"{r1.status_code}: {r1.text[:150]}")
    # verify rate persisted (service role)
    if ok1:
        sid = r1.json()["show"]["id"]
        row = requests.get(f"{SUP}/rest/v1/shows?select=default_rate,client_id,billing_mode,active&id=eq.{sid}", headers=ADMIN).json()[0]
        check("1b. rate + client + active persisted", row["default_rate"] == 1500 and row["client_id"] == cli["id"] and row["active"], str(row))

    # 2. duplicate alias blocked
    r2 = create(owner, name=f"{MARK} beta", aliases=[f"{MARK}-alias-a"], client_id=cli["id"], billing_mode="per_episode")
    check("2. duplicate alias blocked (409)", r2.status_code == 409 and r2.json().get("code") == "duplicate", f"{r2.status_code}: {r2.text[:150]}")

    # 3. no client → needs internal confirmation, then creates
    r3a = create(owner, name=f"{MARK} gamma", aliases=[])
    check("3a. no client → needs_internal_confirmation (409)", r3a.status_code == 409 and r3a.json().get("code") == "needs_internal_confirmation", f"{r3a.status_code}: {r3a.text[:120]}")
    r3b = create(owner, name=f"{MARK} gamma", aliases=[], internal_confirmed=True)
    ok3 = r3b.status_code == 200
    if ok3:
        sid = r3b.json()["show"]["id"]; shows.append(sid)
        row = requests.get(f"{SUP}/rest/v1/shows?select=billing_mode,client_id&id=eq.{sid}", headers=ADMIN).json()[0]
        check("3b. internal created with billing_mode=none, no client", row["billing_mode"] == "none" and row["client_id"] is None, str(row))
    else:
        check("3b. internal created", False, f"{r3b.status_code}: {r3b.text[:120]}")

    # 4. calendar sync would recognize the new alias: it reads shows.name + shows.aliases
    if ok1:
        sid = shows[0]
        row = requests.get(f"{SUP}/rest/v1/shows?select=aliases&id=eq.{sid}", headers=ADMIN).json()[0]
        check("4. new alias stored where calendar sync matches (shows.aliases)", f"{MARK}-alias-a" in (row["aliases"] or []), str(row))

    # 5. technician (stages only) cannot set money fields
    tech = make_user(stages=True, money=False)
    r5 = create(tech, name=f"{MARK} tech-show", aliases=[], client_id=cli["id"], billing_mode="per_episode",
                default_rate=999, internal_confirmed=True)
    ok5 = r5.status_code == 200
    if ok5:
        sid = r5.json()["show"]["id"]; shows.append(sid)
        row = requests.get(f"{SUP}/rest/v1/shows?select=client_id,default_rate,billing_mode&id=eq.{sid}", headers=ADMIN).json()[0]
        # tech's money inputs must be ignored: no client, no rate, billing none
        check("5. tech creates WITHOUT money fields (client/rate ignored)",
              row["client_id"] is None and row["default_rate"] is None and row["billing_mode"] == "none", str(row))
    else:
        check("5. tech create", False, f"{r5.status_code}: {r5.text[:120]}")

finally:
    print("\n--- cleanup ---")
    for sid in shows:
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{sid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/shows?id=eq.{sid}", headers=ADMIN)
    requests.delete(f"{SUP}/rest/v1/clients?name=eq.{MARK} client", headers=ADMIN)
    for uid in users:
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{uid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/profiles?id=eq.{uid}", headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{uid}", headers=ADMIN)
    left = requests.get(f"{SUP}/rest/v1/shows?select=id&name=like.{MARK}*", headers=ADMIN).json()
    check("cleanup: no test shows left", len(left) == 0, str(left))

print(("\nALL PASSED" if not fails else f"\n{len(fails)} FAILED: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
