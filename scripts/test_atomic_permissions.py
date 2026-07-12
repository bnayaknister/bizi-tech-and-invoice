# -*- coding: utf-8 -*-
"""
Mandatory bidirectional acceptance test (spec section 3):
  1. approved user with can_view_money=false → pull jobs → 0 rows
  2. flip can_view_money=true               → pull again → 157 rows
Both directions must hold, or this must stop and get fixed.
"""
import os
import sys
import uuid

import requests

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
ANON_KEY = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

ADMIN_HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

email = f"perm-test-{uuid.uuid4().hex[:8]}@bizi-test.local"
password = f"Test-{uuid.uuid4().hex}!A1"

r = requests.post(
    f"{SUPABASE_URL}/auth/v1/admin/users",
    headers=ADMIN_HEADERS,
    json={"email": email, "password": password, "email_confirm": True},
)
r.raise_for_status()
user_id = r.json()["id"]
print("created test user:", email)

try:
    # the handle_new_user trigger already created a pending profile row
    # (approved=false, role=null) — update it to approved + can_view_money=false
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}",
        headers={**ADMIN_HEADERS, "Prefer": "return=representation"},
        json={"name": "בדיקת הרשאות אטומיות", "approved": True, "can_view_money": False},
    )
    r.raise_for_status()

    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": password},
    )
    r.raise_for_status()
    access_token = r.json()["access_token"]

    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/jobs",
        headers={"apikey": ANON_KEY, "Authorization": f"Bearer {access_token}"},
        params={"select": "*"},
    )
    rows_before = r.json() if r.ok else []
    print(f"DIRECTION 1 — can_view_money=false: status={r.status_code}, rows={len(rows_before)}")
    if r.status_code < 400 and len(rows_before) != 0:
        print("FAIL: expected 0 rows")
        sys.exit(1)
    print("PASS")

    # flip the single permission
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}",
        headers=ADMIN_HEADERS,
        json={"can_view_money": True},
    )
    r.raise_for_status()

    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/jobs",
        headers={"apikey": ANON_KEY, "Authorization": f"Bearer {access_token}"},
        params={"select": "id"},
    )
    rows_after = r.json() if r.ok else []
    print(f"DIRECTION 2 — can_view_money=true: status={r.status_code}, rows={len(rows_after)}")
    if len(rows_after) != 157:
        print(f"FAIL: expected 157 rows, got {len(rows_after)}")
        sys.exit(1)
    print("PASS")

finally:
    requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}", headers=ADMIN_HEADERS)
    print("cleaned up test user")
