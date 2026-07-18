# -*- coding: utf-8 -*-
"""
Acceptance tests for the permission-model upgrade (migration 0021):
  approval queue for destructive actions, hermetic money compartmentalization,
  bookkeeper read-only-on-stages, and self-permission-change lockout.

The 7 owner scenarios:
  1. technician tries to delete a show -> a pending request is created, nothing deleted
  2. technician sends DELETE straight to the API -> 403
  3. admin approves the request -> the show is actually deleted
  4. admin rejects a request -> nothing happens to the entity, logged to events
  5. bookkeeper tries to change a production's status -> 403
  6. bookkeeper marks a job paid -> succeeds
  7. technician tries to change their own permissions -> 403

Plus the money-compartmentalization audit: a technician pulling the
endpoints gets NO money field (default_rate / amounts / client rows).

Runs against the real dev server + throwaway users/rows, all cleaned up.
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
COOKIE_NAME = f"sb-{ref}-auth-token"

failures = []
created_users = []
created_shows = []
created_prods = []
created_jobs = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        failures.append(label)


def rest(p):
    return f"{SUPABASE_URL}/rest/v1/{p}"


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def make_user(name, flags):
    email = f"perm-{uuid.uuid4().hex[:8]}@bizi-test.local"
    password = f"Test-{uuid.uuid4().hex}!A1"
    r = requests.post(f"{SUPABASE_URL}/auth/v1/admin/users", headers=ADMIN,
                      json={"email": email, "password": password, "email_confirm": True})
    r.raise_for_status()
    uid = r.json()["id"]
    created_users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**ADMIN, **REPR},
                   json={"name": name, "approved": True, **flags}).raise_for_status()
    r = requests.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
                      headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
                      json={"email": email, "password": password})
    r.raise_for_status()
    td = r.json()
    session = {"access_token": td["access_token"], "token_type": "bearer",
               "expires_in": 3600, "expires_at": int(time.time()) + 3600,
               "refresh_token": td["refresh_token"], "user": td["user"]}
    return {
        "id": uid,
        "token": td["access_token"],
        "cookie": {COOKIE_NAME: "base64-" + b64url(json.dumps(session).encode())},
        "auth": {"apikey": ANON_KEY, "Authorization": f"Bearer {td['access_token']}", "Content-Type": "application/json"},
    }


def make_show(name, active=True):
    r = requests.post(rest("shows"), headers={**ADMIN, **REPR},
                      json={"name": name, "active": active, "billing_mode": "per_episode", "default_rate": 4321})
    r.raise_for_status()
    sid = r.json()[0]["id"]
    created_shows.append(sid)
    return sid


# wait for dev server
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

try:
    tech = make_user("בדיקה טכנאי", {"role": "tech", "can_view_stages": True, "can_edit_stages": True})
    admin_u = make_user("בדיקה אדמין", {"role": "owner", "can_view_stages": True, "can_edit_stages": True,
                                        "can_view_money": True, "can_edit_money": True,
                                        "can_manage_users": True, "can_import": True})
    book = make_user("בדיקה חשבונאית", {"role": "bookkeeper", "can_view_stages": True,
                                        "can_view_money": True, "can_edit_money": True})

    # ---------- 1. tech requests show delete -> pending, nothing deleted ----------
    show1 = make_show("ZTEST למחיקה 1")
    r = requests.post(f"{APP_URL}/api/approvals", cookies=tech["cookie"], headers={"Content-Type": "application/json"},
                      json={"action_type": "show_delete", "entity_type": "show", "entity_id": show1,
                            "reason": "התוכנית הוקמה בטעות"})
    ok = r.status_code == 200
    check("1. tech delete-request accepted", ok, r.text)
    req1 = r.json().get("id") if ok else None
    still = requests.get(rest(f"shows?id=eq.{show1}&select=id"), headers=ADMIN).json()
    check("1b. show NOT deleted (still exists)", len(still) == 1, str(still))
    pend = requests.get(rest(f"approval_requests?id=eq.{req1}&select=status"), headers=ADMIN).json()
    check("1c. request is pending", pend and pend[0]["status"] == "pending", str(pend))

    # ---------- 2. tech direct DELETE -> 403 ----------
    r = requests.delete(f"{APP_URL}/api/shows/{show1}", cookies=tech["cookie"])
    check("2. tech direct DELETE /api/shows -> 403", r.status_code == 403, f"status={r.status_code}")
    # and raw PostgREST delete removes 0 rows (RLS shows_delete = can_manage_users)
    requests.delete(rest(f"shows?id=eq.{show1}"), headers=tech["auth"])
    still = requests.get(rest(f"shows?id=eq.{show1}&select=id"), headers=ADMIN).json()
    check("2b. raw PostgREST delete by tech removes nothing", len(still) == 1, str(still))

    # ---------- 3. admin approves -> deleted ----------
    r = requests.post(f"{APP_URL}/api/approvals/{req1}/review", cookies=admin_u["cookie"],
                      headers={"Content-Type": "application/json"}, json={"decision": "approve"})
    check("3. admin approve accepted", r.status_code == 200, r.text)
    gone = requests.get(rest(f"shows?id=eq.{show1}&select=id"), headers=ADMIN).json()
    check("3b. show actually deleted after approval", len(gone) == 0, str(gone))
    st = requests.get(rest(f"approval_requests?id=eq.{req1}&select=status,reviewed_by"), headers=ADMIN).json()
    check("3c. request marked approved + reviewer stamped",
          st and st[0]["status"] == "approved" and st[0]["reviewed_by"] == admin_u["id"], str(st))

    # ---------- 4. admin rejects -> nothing happens, logged ----------
    show2 = make_show("ZTEST למחיקה 2")
    r = requests.post(f"{APP_URL}/api/approvals", cookies=tech["cookie"], headers={"Content-Type": "application/json"},
                      json={"action_type": "show_delete", "entity_type": "show", "entity_id": show2,
                            "reason": "רק בדיקה"})
    req2 = r.json().get("id")
    r = requests.post(f"{APP_URL}/api/approvals/{req2}/review", cookies=admin_u["cookie"],
                      headers={"Content-Type": "application/json"}, json={"decision": "reject", "note": "לא למחוק"})
    check("4. admin reject accepted", r.status_code == 200, r.text)
    still = requests.get(rest(f"shows?id=eq.{show2}&select=id"), headers=ADMIN).json()
    check("4b. show still exists after reject", len(still) == 1, str(still))
    st = requests.get(rest(f"approval_requests?id=eq.{req2}&select=status"), headers=ADMIN).json()
    check("4c. request marked rejected", st and st[0]["status"] == "rejected", str(st))
    ev = requests.get(rest("events?event_type=eq.approval_rejected&order=created_at.desc&limit=1&select=payload"),
                      headers=ADMIN).json()
    check("4d. rejection logged to events", bool(ev) and ev[0]["payload"].get("request_id") == req2, str(ev))

    # ---------- 5. bookkeeper changes production status -> 403 ----------
    show3 = make_show("ZTEST הפקה לבדיקה")
    r = requests.post(rest("productions"), headers={**ADMIN, **REPR},
                      json={"podcast_name": "ZTEST", "show_id": show3, "kind": "internal", "legacy": False})
    prod = r.json()[0]["id"]
    created_prods.append(prod)
    r = requests.post(f"{APP_URL}/api/productions/{prod}", cookies=book["cookie"],
                      headers={"Content-Type": "application/json"}, json={"status": "בהקלטה"})
    check("5. bookkeeper change production status -> 403", r.status_code == 403, f"status={r.status_code} {r.text}")

    # ---------- 6. bookkeeper marks a job paid -> success ----------
    r = requests.post(rest("jobs"), headers={**ADMIN, **REPR},
                      json={"campaign": "ZTEST job", "amount": 1000, "paid": "לא", "legacy": False})
    job = r.json()[0]["id"]
    created_jobs.append(job)
    r = requests.patch(rest(f"jobs?id=eq.{job}"), headers={**book["auth"], **REPR}, json={"paid": "כן"})
    ok = r.status_code < 300 and r.json() and r.json()[0]["paid"] == "כן"
    check("6. bookkeeper marks job paid -> success", ok, f"status={r.status_code} {r.text}")

    # ---------- 7. tech changes own permissions -> 403 ----------
    r = requests.post(f"{APP_URL}/api/users/{tech['id']}", cookies=tech["cookie"],
                      headers={"Content-Type": "application/json"}, json={"patch": {"can_view_money": True}})
    check("7. tech change own permissions -> 403", r.status_code == 403, f"status={r.status_code} {r.text}")
    # and an admin changing THEIR OWN permissions is also blocked
    r = requests.post(f"{APP_URL}/api/users/{admin_u['id']}", cookies=admin_u["cookie"],
                      headers={"Content-Type": "application/json"}, json={"patch": {"can_import": False}})
    check("7b. admin change own permissions -> 403 too", r.status_code == 403, f"status={r.status_code}")

    # ---------- money compartmentalization audit (tech = no money field) ----------
    show4 = make_show("ZTEST כסף")
    # default_rate SELECT is revoked from authenticated -> tech query is denied
    r = requests.get(rest(f"shows?id=eq.{show4}&select=id,name,default_rate"), headers=tech["auth"])
    check("M1. tech selecting shows.default_rate is denied (not returned)",
          r.status_code >= 400 or all("default_rate" not in row for row in (r.json() if r.status_code < 300 else [])),
          f"status={r.status_code} {r.text[:120]}")
    # non-money columns still work for the tech
    r = requests.get(rest(f"shows?id=eq.{show4}&select=id,name,aliases"), headers=tech["auth"])
    check("M2. tech CAN still read non-money show columns", r.status_code < 300 and len(r.json()) == 1, r.text[:120])
    # clients: zero rows to a tech
    r = requests.get(rest("clients?select=id,name&limit=5"), headers=tech["auth"])
    check("M3. tech gets ZERO client rows", r.status_code < 300 and len(r.json()) == 0, f"{r.status_code} {r.text[:120]}")
    # jobs / contracts / invoices / milestones: zero rows to a tech
    for tbl in ["jobs", "contracts", "invoices", "contract_milestones"]:
        r = requests.get(rest(f"{tbl}?select=id&limit=5"), headers=tech["auth"])
        check(f"M4.{tbl}: tech gets zero rows", r.status_code < 300 and len(r.json()) == 0,
              f"{r.status_code} {r.text[:120]}")
    # a money user (admin) CAN read the rate through the app's server path is
    # implicit; here confirm the admin session (service not used) sees clients
    r = requests.get(rest("clients?select=id&limit=1"), headers=admin_u["auth"])
    check("M5. money user still sees clients", r.status_code < 300, f"{r.status_code}")

finally:
    if created_prods:
        requests.delete(rest(f"productions?id=in.({','.join(created_prods)})"), headers=ADMIN)
    if created_jobs:
        requests.delete(rest(f"jobs?id=in.({','.join(created_jobs)})"), headers=ADMIN)
    if created_shows:
        requests.delete(rest(f"shows?id=in.({','.join(created_shows)})"), headers=ADMIN)
    # approval_requests reference profiles(requested_by) -> delete them before users
    if created_users:
        requests.delete(rest(f"approval_requests?requested_by=in.({','.join(created_users)})"), headers=ADMIN)
        for uid in created_users:
            requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{uid}", headers=ADMIN)
    print("cleaned up test users, shows, productions, jobs, requests")

print()
if failures:
    print(f"{len(failures)} FAILURE(S):")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("ALL PASS")
