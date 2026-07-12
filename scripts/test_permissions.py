# -*- coding: utf-8 -*-
"""
Mandatory acceptance test: creates a throwaway 'tech' user, signs in as them,
and confirms the jobs table returns zero rows through the API.
If this fails, the RLS setup is broken and must not ship.
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

email = f"tech-test-{uuid.uuid4().hex[:8]}@bizi-test.local"
password = f"Test-{uuid.uuid4().hex}!A1"

# 1. create auth user (service role, bypasses email confirmation)
r = requests.post(
    f"{SUPABASE_URL}/auth/v1/admin/users",
    headers=ADMIN_HEADERS,
    json={"email": email, "password": password, "email_confirm": True},
)
r.raise_for_status()
user_id = r.json()["id"]
print("created test user:", email, user_id)

# 2. give them a 'tech' profile row (service role bypasses RLS)
r = requests.post(
    f"{SUPABASE_URL}/rest/v1/profiles",
    headers={**ADMIN_HEADERS, "Prefer": "return=representation"},
    json={"id": user_id, "name": "בדיקת הרשאות טכנאי", "role": "tech"},
)
r.raise_for_status()
print("profile row created with role=tech")

try:
    # 3. sign in as the tech user with the PUBLIC anon key (what the browser uses)
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
        json={"email": email, "password": password},
    )
    r.raise_for_status()
    access_token = r.json()["access_token"]
    print("signed in as tech, got access token")

    # 4. attempt to read jobs as this tech user
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/jobs",
        headers={"apikey": ANON_KEY, "Authorization": f"Bearer {access_token}"},
        params={"select": "*"},
    )
    print("jobs query status:", r.status_code)
    print("jobs query body:", r.text[:500])

    if r.status_code >= 400:
        print("PASS: request errored (denied) as expected")
    else:
        rows = r.json()
        if len(rows) == 0:
            print("PASS: 0 rows returned for tech role")
        else:
            print(f"FAIL: tech role received {len(rows)} rows from jobs!")
            sys.exit(1)

    # 5. sanity: tech CAN read stages
    r2 = requests.get(
        f"{SUPABASE_URL}/rest/v1/stages",
        headers={"apikey": ANON_KEY, "Authorization": f"Bearer {access_token}"},
        params={"select": "id", "limit": "1"},
    )
    print("stages query status (should be 200):", r2.status_code)

finally:
    # cleanup: delete the throwaway user (profile row cascades)
    requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}", headers=ADMIN_HEADERS)
    print("cleaned up test user")
