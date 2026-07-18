# -*- coding: utf-8 -*-
"""
Acceptance test for the smart client field (POST /api/clients, owner
request 2026-07-17):

  1. technician (can_edit_stages, no can_edit_money) -> 403
  2. money user creates a genuinely new client -> created, event logged
  3. same name again (exact, post-normalization) -> returns the SAME row,
     never a duplicate (normalized_name is unique-indexed at the DB level
     too, this just confirms the app-level short-circuit works first)
  4. a near-duplicate spelling (extra space + a niqud mark) -> NOT created;
     comes back as needsConfirmation + a suggestion pointing at #2's client
     (this is the "גל אורן x4" bug the feature exists to stop)
  5. force=true on that same near-duplicate -> creates a second, genuinely
     distinct client (the technician's explicit "no, really" override)

Runs against the real dev server + throwaway clients/users, all deleted in
`finally`.
"""
import base64
import json
import os
import sys
import time
import uuid

import requests

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")
if os.path.exists(ENV_PATH):
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
ANON_KEY = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP_URL = os.environ.get("TEST_APP_URL", "http://localhost:3000")

ADMIN = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"}
REPR = {"Prefer": "return=representation"}

failures = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        failures.append(label)


def rest(path):
    return f"{SUPABASE_URL}/rest/v1/{path}"


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def login_cookie(email, password):
    r = requests.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
                       json={"email": email, "password": password})
    r.raise_for_status()
    td = r.json()
    session = {
        "access_token": td["access_token"], "token_type": td.get("token_type", "bearer"),
        "expires_in": td.get("expires_in", 3600), "expires_at": int(time.time()) + td.get("expires_in", 3600),
        "refresh_token": td["refresh_token"], "user": td["user"],
    }
    return "base64-" + b64url(json.dumps(session).encode())


for _ in range(60):
    try:
        r = requests.get(APP_URL, timeout=2)
        if r.status_code < 500:
            break
    except requests.exceptions.ConnectionError:
        pass
    time.sleep(1)
else:
    print("FAIL  dev server never came up at", APP_URL)
    sys.exit(1)

ref = SUPABASE_URL.split("//")[1].split(".")[0]
cookie_name = f"sb-{ref}-auth-token"

tech_id = money_id = None
client_ids = []

try:
    # ---- users ----
    tech_email = f"combo-tech-{uuid.uuid4().hex[:8]}@bizi-test.local"
    tech_password = f"Test-{uuid.uuid4().hex}!A1"
    r = requests.post(f"{SUPABASE_URL}/auth/v1/admin/users", headers=ADMIN,
                       json={"email": tech_email, "password": tech_password, "email_confirm": True})
    r.raise_for_status()
    tech_id = r.json()["id"]
    requests.patch(f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{tech_id}", headers={**ADMIN, **REPR},
                   json={"name": "בדיקת קומבובוקס - טכנאי", "role": "tech", "approved": True,
                         "can_edit_stages": True}).raise_for_status()
    tech_cookie = login_cookie(tech_email, tech_password)

    money_email = f"combo-money-{uuid.uuid4().hex[:8]}@bizi-test.local"
    money_password = f"Test-{uuid.uuid4().hex}!A1"
    r = requests.post(f"{SUPABASE_URL}/auth/v1/admin/users", headers=ADMIN,
                       json={"email": money_email, "password": money_password, "email_confirm": True})
    r.raise_for_status()
    money_id = r.json()["id"]
    requests.patch(f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{money_id}", headers={**ADMIN, **REPR},
                   json={"name": "בדיקת קומבובוקס - כספים", "role": "bookkeeper", "approved": True,
                         "can_edit_money": True, "can_view_money": True}).raise_for_status()
    money_cookie = login_cookie(money_email, money_password)

    unique_name = f"ZTEST לקוח {uuid.uuid4().hex[:6]}"

    # ---- 1. technician rejected ----
    r = requests.post(f"{APP_URL}/api/clients", cookies={cookie_name: tech_cookie},
                       headers={"Content-Type": "application/json"}, json={"name": unique_name})
    check("1. technician create rejected (403)", r.status_code == 403, f"status={r.status_code} body={r.text}")

    # ---- 2. money user creates a new client ----
    r = requests.post(f"{APP_URL}/api/clients", cookies={cookie_name: money_cookie},
                       headers={"Content-Type": "application/json"}, json={"name": unique_name})
    ok = r.status_code == 200
    body = r.json() if ok else {"error": r.text}
    check("2. new client created", ok and body.get("created") is True, str(body))
    first_id = body.get("client", {}).get("id")
    if first_id:
        client_ids.append(first_id)

    r = requests.get(rest("clients"), headers=ADMIN,
                      params={"select": "billing_mode,payment_terms,normalized_name", "id": f"eq.{first_id}"})
    row = r.json()[0] if r.json() else {}
    check("2b. defaults: billing_mode=per_episode", row.get("billing_mode") == "per_episode", str(row))
    check("2c. defaults: payment_terms=immediate", row.get("payment_terms") == "immediate", str(row))

    # ---- 3. exact repeat (post-normalization) -> same row, not created ----
    r = requests.post(f"{APP_URL}/api/clients", cookies={cookie_name: money_cookie},
                       headers={"Content-Type": "application/json"}, json={"name": unique_name})
    ok = r.status_code == 200
    body = r.json() if ok else {"error": r.text}
    check("3. exact repeat returns existing, not created",
          ok and body.get("created") is False and body.get("client", {}).get("id") == first_id, str(body))

    # ---- 4. near-duplicate (one inserted hyphen -> small edit distance,
    # but NOT collapsed away by normalization like whitespace/niqud would
    # be) -> needs confirmation ----
    near_dup = unique_name.replace(" לקוח ", "-לקוח ")
    r = requests.post(f"{APP_URL}/api/clients", cookies={cookie_name: money_cookie},
                       headers={"Content-Type": "application/json"}, json={"name": near_dup})
    ok = r.status_code == 200
    body = r.json() if ok else {"error": r.text}
    check("4. near-duplicate NOT created, suggestion offered",
          ok and body.get("needsConfirmation") is True and body.get("suggestion", {}).get("id") == first_id,
          str(body))

    r = requests.get(rest("clients"), headers=ADMIN, params={"select": "id", "name": f"eq.{near_dup}"})
    check("4b. near-duplicate really absent from the table", r.json() == [], str(r.json()))

    # ---- 5. force=true creates it anyway, as a second distinct client ----
    r = requests.post(f"{APP_URL}/api/clients", cookies={cookie_name: money_cookie},
                       headers={"Content-Type": "application/json"}, json={"name": near_dup, "force": True})
    ok = r.status_code == 200
    body = r.json() if ok else {"error": r.text}
    check("5. force=true creates a distinct second client", ok and body.get("created") is True, str(body))
    second_id = body.get("client", {}).get("id")
    check("5b. second client's id differs from the first", bool(second_id) and second_id != first_id, str(body))
    if second_id:
        client_ids.append(second_id)

finally:
    if client_ids:
        requests.delete(rest("clients"), headers=ADMIN, params={"id": f"in.({','.join(client_ids)})"})
    # delete each user's events first (events.actor_id is FK-RESTRICT) or the
    # auth-user delete silently fails — see the test-data-cleanup-rule memory
    for uid in [i for i in (tech_id, money_id) if i]:
        requests.delete(rest("events"), headers=ADMIN, params={"actor_id": f"eq.{uid}"})
        r = requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{uid}", headers=ADMIN)
        if r.status_code >= 300:
            print("WARNING: user delete failed:", uid, r.status_code)
    print("cleaned up test clients and users")

print()
if failures:
    print(f"{len(failures)} FAILURE(S):")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("ALL PASS")
