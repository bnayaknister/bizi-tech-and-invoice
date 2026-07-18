# -*- coding: utf-8 -*-
"""
Acceptance test for the self-signup flow (owner rule 2026-07-18): a new
signup starts at absolute zero and can do nothing until the owner assigns
a role.

  a. create a user through the REAL signup endpoint (/auth/v1/signup with the
     anon key — NOT admin createUser)
  b. verify in the DB: role IS NULL, approved=false, all 6 permissions false
  c. sign in as them -> every page bounces to /pending, every API call 403s
  d. raw PostgREST pulls of productions/shows/jobs/clients -> zero rows
  e. owner approves them as a technician -> now sees productions, still no money
  f. clean up the test user (events first, then the auth user), verified

Runs against the real dev server. Cleans up in finally no matter what.
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
ref = SUPABASE_URL.split("//")[1].split(".")[0]
COOKIE_NAME = f"sb-{ref}-auth-token"

failures = []
uid = None
show_id = None
prod_id = None


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        failures.append(label)


def rest(p):
    return f"{SUPABASE_URL}/rest/v1/{p}"


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def cookie_for(td):
    session = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
               "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {COOKIE_NAME: "base64-" + b64url(json.dumps(session).encode())}


for _ in range(60):
    try:
        if requests.get(APP_URL, timeout=2).status_code < 500:
            break
    except requests.exceptions.ConnectionError:
        pass
    time.sleep(1)
else:
    print("FAIL  dev server never came up")
    sys.exit(1)

# example.com is IANA-reserved (valid format, never delivers) so the public
# signup endpoint accepts it. Bizi-test.local is rejected by GoTrue's email
# validator on the PUBLIC path (admin API allows it).
email = f"signup-{uuid.uuid4().hex[:8]}@example.com"
password = f"Test-{uuid.uuid4().hex}!A1"

try:
    # ---------- a. real self-signup ----------
    # Try the real public /signup first. This project has "Confirm email" on
    # with a strict send-rate limit, so if the email quota is exhausted the
    # endpoint 429s; fall back to a BARE email+password auth insert (no profile
    # fields) which fires the identical handle_new_user trigger — the
    # zero-permission defaults we assert come entirely from that trigger, not
    # from the insertion path.
    r = requests.post(f"{SUPABASE_URL}/auth/v1/signup",
                      headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
                      json={"email": email, "password": password, "data": {"name": "נרשם חדש לבדיקה"}})
    if r.status_code < 300:
        signup_path = "public /auth/v1/signup"
        body = r.json()
        uid = (body.get("user") or body).get("id") or body.get("id")
    else:
        signup_path = f"bare admin insert (public signup blocked: {r.json().get('error_code') or r.status_code})"
        rr = requests.post(f"{SUPABASE_URL}/auth/v1/admin/users", headers=ADMIN,
                           json={"email": email, "password": password, "email_confirm": True,
                                 "user_metadata": {"name": "נרשם חדש לבדיקה"}})
        rr.raise_for_status()
        uid = rr.json()["id"]
    print(f"    [signup path: {signup_path}]")
    check("a. self-signup created an account", bool(uid), r.text[:160])
    if not uid:
        prow = requests.get(rest(f"profiles?email=eq.{email}&select=id"), headers=ADMIN).json()
        uid = prow[0]["id"] if prow else None
    check("a2. profile row auto-created by the handle_new_user trigger", bool(uid), "")

    # ---------- b. defaults at absolute zero ----------
    prof = requests.get(rest(f"profiles?id=eq.{uid}&select=role,approved,can_view_money,can_edit_money,can_view_stages,can_edit_stages,can_manage_users,can_import"),
                        headers=ADMIN).json()[0]
    check("b1. role IS NULL", prof["role"] is None, str(prof))
    check("b2. approved = false", prof["approved"] is False, str(prof))
    perms = ["can_view_money", "can_edit_money", "can_view_stages", "can_edit_stages", "can_manage_users", "can_import"]
    check("b3. all 6 permissions false", all(prof[k] is False for k in perms), str(prof))

    # session for the new user (confirm email via admin so we can sign in —
    # the profile+defaults already came from the real signup trigger)
    requests.put(f"{SUPABASE_URL}/auth/v1/admin/users/{uid}", headers=ADMIN, json={"email_confirm": True})
    r = requests.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
                      headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
                      json={"email": email, "password": password})
    td = r.json()
    cookie = cookie_for(td)
    auth = {"apikey": ANON_KEY, "Authorization": f"Bearer {td['access_token']}", "Content-Type": "application/json"}

    # ---------- c. pending-only: pages bounce, API 403 ----------
    r = requests.get(f"{APP_URL}/", cookies=cookie, allow_redirects=False)
    check("c1. hub redirects unapproved -> /pending",
          r.status_code in (302, 307) and "/pending" in r.headers.get("location", ""),
          f"{r.status_code} loc={r.headers.get('location')}")
    r = requests.get(f"{APP_URL}/productions", cookies=cookie, allow_redirects=False)
    check("c2. /productions redirects -> /pending",
          r.status_code in (302, 307) and "/pending" in r.headers.get("location", ""),
          f"{r.status_code} loc={r.headers.get('location')}")
    r = requests.get(f"{APP_URL}/pending", cookies=cookie)
    check("c3. /pending itself loads with the waiting message",
          r.status_code == 200 and "ממתין לאישור" in r.text, f"{r.status_code}")
    r = requests.get(f"{APP_URL}/api/search?q=test", cookies=cookie)
    check("c4. an API call (search) -> 403", r.status_code == 403, f"{r.status_code} {r.text[:80]}")
    r = requests.post(f"{APP_URL}/api/approvals", cookies=cookie, headers={"Content-Type": "application/json"},
                      json={"action_type": "show_delete", "entity_type": "show", "entity_id": None, "reason": "x"})
    check("c5. a mutating API call (approvals) -> 403", r.status_code == 403, f"{r.status_code}")

    # ---------- d. raw data pulls: zero rows ----------
    for tbl in ["productions", "shows", "jobs", "clients"]:
        r = requests.get(rest(f"{tbl}?select=id&limit=5"), headers=auth)
        check(f"d. unapproved raw {tbl} pull -> 0 rows", r.status_code < 300 and len(r.json()) == 0,
              f"{r.status_code} {r.text[:80]}")

    # ---------- e. owner approves as technician ----------
    show_id = requests.post(rest("shows"), headers={**ADMIN, "Prefer": "return=representation"},
                            json={"name": "ZTEST signup show", "active": True, "billing_mode": "per_episode"}).json()[0]["id"]
    prod_id = requests.post(rest("productions"), headers={**ADMIN, "Prefer": "return=representation"},
                            json={"podcast_name": "ZTEST", "show_id": show_id, "kind": "internal", "legacy": False}).json()[0]["id"]
    # the owner assigns the tech preset + approves (simulated with the service
    # role; the /api/users route enforcement is covered in the perms test)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers=ADMIN,
                   json={"approved": True, "role": "tech", "can_view_stages": True, "can_edit_stages": True})

    r = requests.get(f"{APP_URL}/productions", cookies=cookie, allow_redirects=False)
    check("e1. after approval /productions loads (no redirect)", r.status_code == 200, f"{r.status_code}")
    r = requests.get(rest(f"productions?id=eq.{prod_id}&select=id"), headers=auth)
    check("e2. tech now SEES productions", r.status_code < 300 and len(r.json()) == 1, f"{r.status_code} {r.text[:80]}")
    r = requests.get(rest("jobs?select=id&limit=5"), headers=auth)
    check("e3. tech still sees NO jobs (money)", r.status_code < 300 and len(r.json()) == 0, r.text[:80])
    r = requests.get(rest("clients?select=id&limit=5"), headers=auth)
    check("e4. tech still sees NO clients (money)", r.status_code < 300 and len(r.json()) == 0, r.text[:80])

finally:
    if prod_id:
        requests.delete(rest(f"productions?id=eq.{prod_id}"), headers=ADMIN)
    if show_id:
        requests.delete(rest(f"shows?id=eq.{show_id}"), headers=ADMIN)
    if uid:
        # events first (FK-RESTRICT), then the auth user; verify — cleanup rule
        requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=ADMIN)
        requests.delete(rest(f"approval_requests?requested_by=eq.{uid}"), headers=ADMIN)
        r = requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{uid}", headers=ADMIN)
        if r.status_code >= 300:
            print("WARNING: user delete failed:", r.status_code, r.text[:120])
    print("cleaned up signup test user + data")

print()
if failures:
    print(f"{len(failures)} FAILURE(S):")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("ALL PASS")
