# -*- coding: utf-8 -*-
"""
Bidirectional acceptance test for the shows money-column guard
(trg_guard_show_money, migration 0008):

  user with can_edit_stages but NOT can_edit_money:
    1a. update aliases        -> allowed (this is the alias-editing workflow)
    1b. update default_rate   -> BLOCKED by trigger
    1c. update client_id      -> BLOCKED by trigger
  flip can_edit_money=true:
    2.  update default_rate   -> allowed

Runs against a throwaway show row; never touches real data.
"""
import os
import sys
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

ADMIN = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

failures = []


def check(label, ok):
    print(("PASS  " if ok else "FAIL  ") + label)
    if not ok:
        failures.append(label)


# throwaway show
r = requests.post(
    f"{SUPABASE_URL}/rest/v1/shows",
    headers={**ADMIN, "Prefer": "return=representation"},
    json={"name": "בדיקת-טריגר-כסף", "active": False, "is_oneoff": True},
)
r.raise_for_status()
show_id = r.json()[0]["id"]

# test user: stages editor without money permissions
email = f"guard-test-{uuid.uuid4().hex[:8]}@bizi-test.local"
password = f"Test-{uuid.uuid4().hex}!A1"
r = requests.post(
    f"{SUPABASE_URL}/auth/v1/admin/users",
    headers=ADMIN,
    json={"email": email, "password": password, "email_confirm": True},
)
r.raise_for_status()
user_id = r.json()["id"]

try:
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}",
        headers=ADMIN,
        json={
            "name": "בדיקת טריגר כסף",
            "approved": True,
            "can_view_stages": True,
            "can_edit_stages": True,
            "can_view_money": False,
            "can_edit_money": False,
        },
    )
    r.raise_for_status()

    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": password},
    )
    r.raise_for_status()
    USER = {
        "apikey": ANON_KEY,
        "Authorization": f"Bearer {r.json()['access_token']}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }

    def user_patch(payload):
        return requests.patch(
            f"{SUPABASE_URL}/rest/v1/shows?id=eq.{show_id}", headers=USER, json=payload
        )

    r = user_patch({"aliases": ["כינוי-בדיקה"]})
    check("1a stages editor CAN edit aliases", r.ok and len(r.json()) == 1)

    r = user_patch({"default_rate": 9999})
    check(f"1b stages editor BLOCKED on default_rate (got {r.status_code})", r.status_code >= 400)

    r = user_patch({"client_id": str(uuid.uuid4())})
    check(f"1c stages editor BLOCKED on client_id (got {r.status_code})", r.status_code >= 400)

    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}",
        headers=ADMIN,
        json={"can_edit_money": True},
    )
    r.raise_for_status()

    r = user_patch({"default_rate": 9999})
    check("2  money editor CAN edit default_rate", r.ok and len(r.json()) == 1)

finally:
    requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}", headers=ADMIN)
    requests.delete(f"{SUPABASE_URL}/rest/v1/shows?id=eq.{show_id}", headers=ADMIN)
    print("cleaned up test user + throwaway show")

if failures:
    print(f"{len(failures)} FAILURES — stop and fix.")
    sys.exit(1)
print("all checks passed, both directions")
