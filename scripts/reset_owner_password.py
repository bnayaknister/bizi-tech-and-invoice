# -*- coding: utf-8 -*-
"""
Kills the previously-exposed temp password for bnayaknister@gmail.com by
overwriting it with a throwaway random value (never printed or stored),
then triggers Supabase's standard password-recovery email so the owner
sets his own password via a secure link.
"""
import os
import secrets

import requests

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
ANON_KEY = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

ADMIN_HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

EMAIL = "bnayaknister@gmail.com"


def main():
    r = requests.get(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=ADMIN_HEADERS,
        params={"page": "1", "per_page": "200"},
    )
    r.raise_for_status()
    user = next((u for u in r.json().get("users", []) if u["email"] == EMAIL), None)
    if not user:
        raise SystemExit("owner user not found")
    user_id = user["id"]

    # overwrite the exposed password with an unknown, unrecorded value
    throwaway = secrets.token_urlsafe(32)
    r = requests.put(
        f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
        headers=ADMIN_HEADERS,
        json={"password": throwaway},
    )
    r.raise_for_status()
    del throwaway
    print("old exposed password overwritten and discarded (never logged)")

    # trigger the standard recovery email
    r = requests.post(
        f"{SUPABASE_URL}/auth/v1/recover",
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
        json={"email": EMAIL},
    )
    r.raise_for_status()
    print(f"recovery email requested for {EMAIL} — status {r.status_code}")

    # remove the leftover temp-password file from the earlier (fixed) bug
    secret_file = os.path.expanduser("~/bizi-app/.owner-temp-password.txt")
    if os.path.exists(secret_file):
        os.remove(secret_file)
        print("deleted leftover", secret_file)


if __name__ == "__main__":
    main()
