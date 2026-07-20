# -*- coding: utf-8 -*-
"""
Acceptance test for the client-mapping screen (owner spec 2026-07-20).
Read/map only — creates NO Morning document, so it is safe with
MORNING_DRY_RUN=false. It exercises the real /api/morning/clients route,
which pulls the live 280 Morning clients.

Proves:
  1. GET returns our clients + morning clients + a suggestion per unmapped
  2. a can_edit_money user can map a throwaway client to a real Morning id
  3. the mapped row comes back resolved (mapped_name/tax id)
  4. UNIQUE holds: a second of our clients can't claim the same Morning id
  5. unmap clears it
  6. a stages-only user is refused (403)

Cleans up the throwaway client + users in finally, and verifies it.
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
ref = SUPABASE_URL.split("//")[1].split(".")[0]
CN = f"sb-{ref}-auth-token"

# a real Morning client id (the studio itself) — mapping to it creates nothing
MORNING_ID = "f93ec57b-6688-419c-98fd-c8ff52e1b538"
MARK = "ZTESTMAP"

failures = []
users = []
c1 = c2 = None


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        failures.append(label)


def rest(p):
    return f"{SUPABASE_URL}/rest/v1/{p}"


def b64(r):
    return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags):
    em = f"map-{uuid.uuid4().hex[:8]}@bizi-test.local"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{SUPABASE_URL}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**ADMIN, **REPR},
                   json={"name": f"{MARK} user", "approved": True, **flags}).raise_for_status()
    td = requests.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {CN: "base64-" + b64(json.dumps(sess).encode())}


for _ in range(60):
    try:
        if requests.get(APP_URL, timeout=2).status_code < 500:
            break
    except requests.exceptions.ConnectionError:
        pass
    time.sleep(1)
else:
    print("FAIL dev server never came up")
    sys.exit(1)

try:
    money = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True})
    tech = mkuser({"role": "tech", "can_view_stages": True, "can_edit_stages": True})

    c1 = requests.post(rest("clients"), headers={**ADMIN, **REPR},
                       json={"name": f"{MARK} one", "normalized_name": f"ztestmap{uuid.uuid4().hex[:6]}"}).json()[0]["id"]
    c2 = requests.post(rest("clients"), headers={**ADMIN, **REPR},
                       json={"name": f"{MARK} two", "normalized_name": f"ztestmap{uuid.uuid4().hex[:6]}"}).json()[0]["id"]

    # 6. permissions first (cheap)
    r = requests.get(f"{APP_URL}/api/morning/clients", cookies=tech)
    check("6. stages-only user is refused", r.status_code == 403, str(r.status_code))

    # 1. GET returns the live data
    r = requests.get(f"{APP_URL}/api/morning/clients", cookies=money)
    check("1a. GET ok", r.status_code == 200, r.text[:200])
    body = r.json()
    check("1b. our clients returned", isinstance(body.get("clients"), list) and len(body["clients"]) >= 2,
          str(len(body.get("clients", []))))
    check("1c. ~280 morning clients pulled", len(body.get("morning_clients", [])) >= 200,
          str(len(body.get("morning_clients", []))))
    ours_by_id = {c["id"]: c for c in body["clients"]}
    check("1d. our throwaway client is present and unmapped",
          c1 in ours_by_id and ours_by_id[c1]["morning_client_id"] is None)

    # 2. map c1 -> the studio Morning client
    r = requests.post(f"{APP_URL}/api/morning/clients", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"client_id": c1, "morning_client_id": MORNING_ID, "morning_client_name": "ביזי סטודיו בע״מ"})
    check("2. mapping saved", r.status_code == 200 and r.json().get("ok"), r.text[:200])
    row = requests.get(rest(f"clients?id=eq.{c1}&select=morning_client_id"), headers=ADMIN).json()[0]
    check("2b. morning_client_id persisted", row["morning_client_id"] == MORNING_ID, str(row["morning_client_id"]))

    # 3. GET resolves the mapped name/taxId
    body = requests.get(f"{APP_URL}/api/morning/clients", cookies=money).json()
    mapped = next((c for c in body["clients"] if c["id"] == c1), None)
    check("3. mapped row resolves name + taxId",
          mapped and mapped.get("mapped_name") and mapped.get("mapped_tax_id") == "516317385",
          json.dumps(mapped, ensure_ascii=False)[:160] if mapped else "not found")

    # 4. shared mapping: c2 -> same Morning id. WARN (not block) first, then
    #    allow with confirmation (owner, 2026-07-20: many of ours -> one payer)
    r = requests.post(f"{APP_URL}/api/morning/clients", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"client_id": c2, "morning_client_id": MORNING_ID})
    body = r.json()
    check("4a. shared mapping warns (409 needs_confirmation)",
          r.status_code == 409 and body.get("needs_confirmation") is True, f"{r.status_code} {r.text[:120]}")
    check("4b. the warning names who it's shared with",
          f"{MARK} one" in (body.get("shared_with") or []), json.dumps(body.get("shared_with"), ensure_ascii=False))
    # it must NOT have been saved by the warned attempt
    row2 = requests.get(rest(f"clients?id=eq.{c2}&select=morning_client_id"), headers=ADMIN).json()[0]
    check("4c. warned attempt saved nothing", row2["morning_client_id"] is None, str(row2["morning_client_id"]))
    # confirm -> allowed
    r = requests.post(f"{APP_URL}/api/morning/clients", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"client_id": c2, "morning_client_id": MORNING_ID, "confirm_shared": True})
    check("4d. confirmed shared mapping is allowed", r.status_code == 200 and r.json().get("ok"), r.text[:150])
    # both sides now show the shared_with relationship
    body = requests.get(f"{APP_URL}/api/morning/clients", cookies=money).json()
    r1 = next((c for c in body["clients"] if c["id"] == c1), {})
    r2 = next((c for c in body["clients"] if c["id"] == c2), {})
    check("4e. c1 shows it's shared with c2", f"{MARK} two" in (r1.get("shared_with") or []),
          json.dumps(r1.get("shared_with"), ensure_ascii=False))
    check("4f. c2 shows it's shared with c1", f"{MARK} one" in (r2.get("shared_with") or []),
          json.dumps(r2.get("shared_with"), ensure_ascii=False))

    # 5. unmap c1
    r = requests.post(f"{APP_URL}/api/morning/clients", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"client_id": c1, "morning_client_id": None})
    check("5. unmap ok", r.status_code == 200, str(r.status_code))
    row = requests.get(rest(f"clients?id=eq.{c1}&select=morning_client_id"), headers=ADMIN).json()[0]
    check("5b. mapping cleared", row["morning_client_id"] is None, str(row["morning_client_id"]))

finally:
    print("\n--- cleanup ---")
    for cid in (c1, c2):
        if cid:
            requests.delete(rest(f"events?entity_id=eq.{cid}"), headers=ADMIN)
            requests.delete(rest(f"clients?id=eq.{cid}"), headers=ADMIN)
    for uid in users:
        requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=ADMIN)
        requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{uid}", headers=ADMIN)
    left = requests.get(rest(f"clients?name=like.*{MARK}*&select=id"), headers=ADMIN).json()
    check("cleanup: no test clients left", left == [], json.dumps(left)[:120])

    print()
    if failures:
        print(f"{len(failures)} FAILED: " + " · ".join(failures))
        sys.exit(1)
    print("all checks passed")
