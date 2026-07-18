# -*- coding: utf-8 -*-
"""
Acceptance test for the /settings calendar-sync toggle (owner-only,
app_settings.calendar_sync_enabled):

  1. a technician (can_edit_stages=true, role='tech') -> POST toggle -> 403
     (RLS app_settings_update is is_owner()-only; the route's role check
     just turns that into a clean error)
  2. a fresh owner user -> POST toggle -> 200, DB actually flips
  3. flip it back -> 200, DB actually flips back

Runs against the real dev server + the real singleton app_settings row
(there's only one, id=true) — captures its current value first and
restores it in `finally`, regardless of pass/fail, so this never leaves
the real flag in a different state than it found it.
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

r = requests.get(rest("app_settings"), headers=ADMIN, params={"select": "calendar_sync_enabled", "id": "eq.true"})
original_value = r.json()[0]["calendar_sync_enabled"]
print("captured original calendar_sync_enabled:", original_value)

tech_id = owner_id = None

try:
    # ---- tech: 403 ----
    tech_email = f"toggle-tech-{uuid.uuid4().hex[:8]}@bizi-test.local"
    tech_password = f"Test-{uuid.uuid4().hex}!A1"
    r = requests.post(f"{SUPABASE_URL}/auth/v1/admin/users", headers=ADMIN,
                       json={"email": tech_email, "password": tech_password, "email_confirm": True})
    r.raise_for_status()
    tech_id = r.json()["id"]
    requests.patch(f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{tech_id}", headers={**ADMIN, **REPR},
                   json={"name": "בדיקת מתג", "role": "tech", "approved": True, "can_edit_stages": True}).raise_for_status()
    tech_cookie = login_cookie(tech_email, tech_password)

    r = requests.post(f"{APP_URL}/api/settings/calendar-sync", cookies={cookie_name: tech_cookie},
                       headers={"Content-Type": "application/json"}, json={"enabled": not original_value})
    check("1. technician toggle rejected (403)", r.status_code == 403, f"status={r.status_code} body={r.text}")

    r = requests.get(rest("app_settings"), headers=ADMIN, params={"select": "calendar_sync_enabled", "id": "eq.true"})
    check("1b. flag untouched by the rejected attempt", r.json()[0]["calendar_sync_enabled"] == original_value, str(r.json()))

    # ---- owner: flip, then flip back ----
    owner_email = f"toggle-owner-{uuid.uuid4().hex[:8]}@bizi-test.local"
    owner_password = f"Test-{uuid.uuid4().hex}!A1"
    r = requests.post(f"{SUPABASE_URL}/auth/v1/admin/users", headers=ADMIN,
                       json={"email": owner_email, "password": owner_password, "email_confirm": True})
    r.raise_for_status()
    owner_id = r.json()["id"]
    requests.patch(f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{owner_id}", headers={**ADMIN, **REPR},
                   json={"name": "בדיקת מתג - בעלים", "role": "owner", "approved": True,
                         "can_view_stages": True, "can_edit_stages": True}).raise_for_status()
    owner_cookie = login_cookie(owner_email, owner_password)

    flipped = not original_value
    r = requests.post(f"{APP_URL}/api/settings/calendar-sync", cookies={cookie_name: owner_cookie},
                       headers={"Content-Type": "application/json"}, json={"enabled": flipped})
    ok = r.status_code == 200
    check("2. owner toggle accepted", ok, r.text)
    check("2b. response reflects new value", ok and r.json().get("calendar_sync_enabled") == flipped, r.text)

    r = requests.get(rest("app_settings"), headers=ADMIN, params={"select": "calendar_sync_enabled", "id": "eq.true"})
    check("2c. DB actually flipped", r.json()[0]["calendar_sync_enabled"] == flipped, str(r.json()))

    r = requests.get(rest("events"), headers=ADMIN,
                      params={"select": "event_type,payload", "entity_type": "eq.app_settings",
                              "event_type": "eq.calendar_sync_toggled", "order": "created_at.desc", "limit": "1"})
    ev = r.json()
    check("2d. toggle logged to events", bool(ev) and ev[0]["payload"].get("enabled") == flipped, str(ev))

    r = requests.post(f"{APP_URL}/api/settings/calendar-sync", cookies={cookie_name: owner_cookie},
                       headers={"Content-Type": "application/json"}, json={"enabled": original_value})
    check("3. flipped back successfully", r.status_code == 200, r.text)
    r = requests.get(rest("app_settings"), headers=ADMIN, params={"select": "calendar_sync_enabled", "id": "eq.true"})
    check("3b. DB restored to original value", r.json()[0]["calendar_sync_enabled"] == original_value, str(r.json()))

finally:
    # belt-and-suspenders: force the flag back to its original value no
    # matter what happened above, then remove the two throwaway users
    requests.patch(rest("app_settings"), headers=ADMIN, params={"id": "eq.true"},
                    json={"calendar_sync_enabled": original_value})
    # delete each user's events first (events.actor_id is FK-RESTRICT — the
    # toggle route logs calendar_sync_toggled) or the auth delete silently
    # fails; see the test-data-cleanup-rule memory
    for uid in [i for i in (tech_id, owner_id) if i]:
        requests.delete(rest("events"), headers=ADMIN, params={"actor_id": f"eq.{uid}"})
        r = requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{uid}", headers=ADMIN)
        if r.status_code >= 300:
            print("WARNING: user delete failed:", uid, r.status_code)
    print("cleaned up test users and restored calendar_sync_enabled to", original_value)

print()
if failures:
    print(f"{len(failures)} FAILURE(S):")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("ALL PASS")
