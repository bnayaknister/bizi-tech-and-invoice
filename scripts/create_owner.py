# -*- coding: utf-8 -*-
"""
Creates the real owner account (bnayaknister@gmail.com), locked as the
first admin: role=owner, approved=true, all 6 permission flags true.

Secrets policy: passwords/tokens are NEVER printed to stdout. If a fresh
password must be generated, it's written to a 600-permission file and
only the file path is printed.
"""
import os
import secrets
import stat
import sys

import requests

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

ADMIN_HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

EMAIL = "bnayaknister@gmail.com"
SECRET_FILE = os.path.expanduser("~/bizi-app/.owner-temp-password.txt")


def write_secret_file(value):
    fd = os.open(SECRET_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "w") as f:
        f.write(value + "\n")


def main():
    temp_password = "Bz-" + secrets.token_urlsafe(16)

    r = requests.get(
        f"{SUPABASE_URL}/auth/v1/admin/users",
        headers=ADMIN_HEADERS,
        params={"page": "1", "per_page": "200"},
    )
    r.raise_for_status()
    existing = next((u for u in r.json().get("users", []) if u["email"] == EMAIL), None)

    if existing:
        user_id = existing["id"]
        print("owner auth user already exists:", user_id)
    else:
        r = requests.post(
            f"{SUPABASE_URL}/auth/v1/admin/users",
            headers=ADMIN_HEADERS,
            json={"email": EMAIL, "password": temp_password, "email_confirm": True},
        )
        r.raise_for_status()
        user_id = r.json()["id"]
        write_secret_file(temp_password)
        print("created owner auth user:", user_id)
        print(f"temp password written to {SECRET_FILE} (chmod 600) — not printed")

    payload = {
        "id": user_id,
        "email": EMAIL,
        "name": "Bnayahu Knister",
        "role": "owner",
        "approved": True,
        "can_view_money": True,
        "can_edit_money": True,
        "can_view_stages": True,
        "can_edit_stages": True,
        "can_manage_users": True,
        "can_import": True,
    }
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/profiles?on_conflict=id",
        headers={**ADMIN_HEADERS, "Prefer": "resolution=merge-duplicates,return=representation"},
        json=payload,
    )
    if not r.ok:
        print("ERROR upserting profile:", r.status_code, r.text[:500], file=sys.stderr)
        r.raise_for_status()
    print("owner profile set: id=", user_id, "role=owner approved=true all-permissions=true")


if __name__ == "__main__":
    main()
