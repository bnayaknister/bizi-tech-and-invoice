# -*- coding: utf-8 -*-
"""
Acceptance test for per-field permission on the /shows screen (owner
request 2026-07-17): default_rate is money classification, everything else
on a show is stages-visible.

Audited first (no gap found — this codebase already follows its own
documented rule, EntityDrawer.tsx: "fields the viewer lacks permission for
are never selected server-side — not hidden, not present in the
response"):
  - src/app/shows/page.tsx only SELECTs default_rate from the DB when
    canViewMoney, and separately nulls it in the mapped row too
  - src/lib/entities.ts marks default_rate view:"money" for the show
    entity, so GET /api/entity/show/<id> never includes it either
  - shows/update, shows/merge, the CSV importer, /finance/link,
    /productions — none of them select or return default_rate to a
    stages-only viewer

This test proves it rather than just reading the code:
  1. can_view_stages-only user: GET /shows HTML never contains the show's
     (distinctive) rate value anywhere in the page — not just absent from
     one field, genuinely never sent to the browser
  2. same user: GET /api/entity/show/<id> — response has no `default_rate`
     key at all (not null — ABSENT), and no default_rate field in the
     `fields` metadata array either
  3. can_view_money user: both the /shows HTML and the API response DO
     contain the rate

Runs against the real dev server + a throwaway show and two throwaway
users, all deleted in `finally`.
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

RATE = 78563  # distinctive, unlikely to appear anywhere else on the page
show_id = stages_id = money_id = None

try:
    r = requests.post(rest("shows"), headers={**ADMIN, **REPR},
                       json={"name": "ZTEST rate-permission show", "default_rate": RATE, "active": True,
                             "billing_mode": "per_episode"})
    r.raise_for_status()
    show_id = r.json()[0]["id"]

    # ---- stages-only user ----
    stages_email = f"rate-stages-{uuid.uuid4().hex[:8]}@bizi-test.local"
    stages_password = f"Test-{uuid.uuid4().hex}!A1"
    r = requests.post(f"{SUPABASE_URL}/auth/v1/admin/users", headers=ADMIN,
                       json={"email": stages_email, "password": stages_password, "email_confirm": True})
    r.raise_for_status()
    stages_id = r.json()["id"]
    requests.patch(f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{stages_id}", headers={**ADMIN, **REPR},
                   json={"name": "בדיקת הרשאה - שלבים בלבד", "role": "tech", "approved": True,
                         "can_view_stages": True}).raise_for_status()
    stages_cookie = login_cookie(stages_email, stages_password)

    # ---- money-view user ----
    money_email = f"rate-money-{uuid.uuid4().hex[:8]}@bizi-test.local"
    money_password = f"Test-{uuid.uuid4().hex}!A1"
    r = requests.post(f"{SUPABASE_URL}/auth/v1/admin/users", headers=ADMIN,
                       json={"email": money_email, "password": money_password, "email_confirm": True})
    r.raise_for_status()
    money_id = r.json()["id"]
    requests.patch(f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{money_id}", headers={**ADMIN, **REPR},
                   json={"name": "בדיקת הרשאה - כספים", "role": "bookkeeper", "approved": True,
                         "can_view_money": True}).raise_for_status()
    money_cookie = login_cookie(money_email, money_password)

    # ---- 1/2. stages-only: /shows page + drawer API ----
    r = requests.get(f"{APP_URL}/shows", cookies={cookie_name: stages_cookie})
    check("1. stages-only user can open /shows", r.status_code == 200, f"status={r.status_code}")
    check("1b. rate value never sent to a stages-only browser", str(RATE) not in r.text, "found rate in HTML")
    check("1c. show name IS visible (page isn't just empty/broken)",
          "ZTEST rate-permission show" in r.text, "show name missing from HTML")

    r = requests.get(f"{APP_URL}/api/entity/show/{show_id}", cookies={cookie_name: stages_cookie})
    ok = r.status_code == 200
    body = r.json() if ok else {"error": r.text}
    check("2. stages-only drawer API call succeeds", ok, str(body))
    check("2b. default_rate key ABSENT from entity (not null, absent)",
          ok and "default_rate" not in body.get("entity", {}), str(body.get("entity")))
    check("2c. default_rate ABSENT from the fields metadata too",
          ok and not any(f["key"] == "default_rate" for f in body.get("fields", [])),
          str([f["key"] for f in body.get("fields", [])]))
    check("2d. name field IS present (not an empty/broken response)",
          ok and body.get("entity", {}).get("name") == "ZTEST rate-permission show", str(body.get("entity")))

    # ---- 3. money-view user: both paths show the rate ----
    r = requests.get(f"{APP_URL}/shows", cookies={cookie_name: money_cookie})
    check("3. rate value IS sent to a can_view_money browser", str(RATE) in r.text, "rate missing from HTML")

    r = requests.get(f"{APP_URL}/api/entity/show/{show_id}", cookies={cookie_name: money_cookie})
    ok = r.status_code == 200
    body = r.json() if ok else {"error": r.text}
    check("3b. default_rate present in entity for can_view_money",
          ok and body.get("entity", {}).get("default_rate") == RATE, str(body.get("entity")))

finally:
    if show_id:
        requests.delete(rest("shows"), headers=ADMIN, params={"id": f"eq.{show_id}"})
    # events first (FK-RESTRICT), then the auth user; verify — see the
    # test-data-cleanup-rule memory
    for uid in [i for i in (stages_id, money_id) if i]:
        requests.delete(rest("events"), headers=ADMIN, params={"actor_id": f"eq.{uid}"})
        r = requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{uid}", headers=ADMIN)
        if r.status_code >= 300:
            print("WARNING: user delete failed:", uid, r.status_code)
    print("cleaned up test show and users")

print()
if failures:
    print(f"{len(failures)} FAILURE(S):")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("ALL PASS")
