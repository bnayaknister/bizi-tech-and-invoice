"""
GET /api/calendar/availability — authorisation, input validation, and the
feed-failure path, against a real dev server.

    TEST_APP_URL=http://localhost:3100 python3 scripts/test_availability_route.py

═══ WHAT THIS TOUCHES ═══
The route itself writes NOTHING — no table, no `events` row, no calendar. So
unlike test_calendar_recurring_alert.py this suite needs no snapshot/restore
dance: there is no live data it can damage by being run.

It does create throwaway auth users to get a session, and those are deleted in
`finally`, verified, always — including the profiles row, which is what a bare
admin delete leaves behind.

One case needs the server to have a BROKEN feed URL, which no request can cause
from outside. That case is therefore driven by a second server the caller starts
on :3101 with a bad STUDIO_ICS_URL; if it is not up, the case reports SKIP
rather than passing quietly.
"""
import os
import sys
import json
import base64
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
import requests

ENV = os.path.join(os.path.dirname(__file__), "..", ".env.local")
for line in open(ENV, encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

SUP = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SVC = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3100")
BROKEN_APP = os.environ.get("TEST_BROKEN_APP_URL", "http://localhost:3101")
REF = SUP.split("//")[1].split(".")[0]
ADMIN = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}

ROUTE = "/api/calendar/availability"

fails = []
skips = []
users = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        fails.append(label)


def skip(label, why):
    print(f"SKIP  {label}  [{why}]")
    skips.append(label)


def make_user(role):
    """A confirmed user with the given profiles.role, and its cookie jar."""
    email = f"ztest-avail-{uuid.uuid4().hex[:8]}@example.com"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    u = requests.post(f"{SUP}/auth/v1/admin/users", headers=ADMIN,
                      json={"email": email, "password": pw, "email_confirm": True}).json()
    uid = u["id"]
    users.append(uid)
    requests.patch(f"{SUP}/rest/v1/profiles?id=eq.{uid}", headers=ADMIN,
                   json={"approved": True, "role": role,
                         "can_view_stages": True, "can_edit_stages": True,
                         "can_view_money": True, "can_edit_money": True})
    tok = requests.post(f"{SUP}/auth/v1/token?grant_type=password",
                        headers={"apikey": ANON, "Content-Type": "application/json"},
                        json={"email": email, "password": pw}).json()
    val = "base64-" + base64.b64encode(json.dumps(tok, separators=(",", ":")).encode()).decode()
    name = f"sb-{REF}-auth-token"
    jar = {}
    if len(val) <= 3180:
        jar[name] = val
    else:
        for i, s in enumerate(range(0, len(val), 3180)):
            jar[f"{name}.{i}"] = val[s:s + 3180]
    return uid, jar


def body_of(r):
    try:
        return r.json()
    except Exception:
        return {}


try:
    # server reachable at all?
    try:
        requests.get(f"{APP}{ROUTE}", timeout=10)
    except Exception as e:
        print(f"FAIL  dev server not reachable at {APP} — {e}")
        sys.exit(1)

    print("\n=== 1. no session is rejected ===")
    r = requests.get(f"{APP}{ROUTE}", timeout=30)
    check("anonymous request rejected", r.status_code == 401, f"status={r.status_code}")
    print(f"      status code for anonymous: {r.status_code}")
    b = body_of(r)
    check("anonymous response carries no availability", "free" not in b and "rooms" not in b, str(list(b.keys())))
    check("anonymous response has no-store", r.headers.get("Cache-Control") in (None, "no-store"),
          r.headers.get("Cache-Control", ""))

    print("\n=== 2. a signed-in NON-owner is rejected ===")
    tech_id, tech_jar = make_user("tech")
    r = requests.get(f"{APP}{ROUTE}", cookies=tech_jar, timeout=30)
    check("tech rejected with 403", r.status_code == 403, f"status={r.status_code}")
    print(f"      status code for tech: {r.status_code}")
    b = body_of(r)
    check("tech response carries no availability", "free" not in b, str(list(b.keys())))

    bk_id, bk_jar = make_user("bookkeeper")
    r = requests.get(f"{APP}{ROUTE}", cookies=bk_jar, timeout=30)
    check("bookkeeper rejected with 403", r.status_code == 403, f"status={r.status_code}")

    print("\n=== 3. owner is allowed ===")
    owner_id, owner_jar = make_user("owner")
    r = requests.get(f"{APP}{ROUTE}", cookies=owner_jar, timeout=120)
    check("owner gets 200", r.status_code == 200, f"status={r.status_code} body={r.text[:200]}")
    ok = body_of(r)
    check("Cache-Control is no-store", r.headers.get("Cache-Control") == "no-store",
          r.headers.get("Cache-Control", ""))
    for key in ("fromIsrael", "toIsrael", "step", "fetchedAt", "rooms", "free",
                "unknownRoomBlocks", "roomsRefused", "skipped"):
        check(f"payload has {key}", key in ok, str(list(ok.keys())))
    check("fetchedAt parses as an ISO instant",
          isinstance(ok.get("fetchedAt"), str) and ok["fetchedAt"].endswith("Z"),
          str(ok.get("fetchedAt")))
    check("default step is 30", ok.get("step") == 30, str(ok.get("step")))
    check("three bookable rooms", ok.get("rooms") == ["גבעון גדול", "גבעון", "חשמונאים"],
          str(ok.get("rooms")))
    # the window, checked for real rather than for presence
    d_from = date.fromisoformat(ok["fromIsrael"])
    d_to = date.fromisoformat(ok["toIsrael"])
    check("window spans exactly 56 days inclusive", (d_to - d_from).days == 55,
          f"{ok['fromIsrael']}..{ok['toIsrael']} = {(d_to - d_from).days} days apart")
    israel_today = datetime.now(ZoneInfo("Asia/Jerusalem")).date()
    check("from is NOT today in Israel", d_from != israel_today,
          f"from={d_from} israel_today={israel_today}")
    check("from IS tomorrow in Israel", d_from == israel_today + timedelta(days=1),
          f"from={d_from} israel_today={israel_today}")

    print("\n=== 4. step validation — only 30 and 90 ===")
    for bad in ("45", "0", "-30", "60", "abc", "30.5", "", "9999"):
        r = requests.get(f"{APP}{ROUTE}?step={bad}", cookies=owner_jar, timeout=120)
        b = body_of(r)
        check(f"step={bad!r} -> 400", r.status_code == 400, f"status={r.status_code}")
        check(f"step={bad!r} returns no availability", "free" not in b, str(list(b.keys())))
    for good in ("30", "90"):
        r = requests.get(f"{APP}{ROUTE}?step={good}", cookies=owner_jar, timeout=120)
        check(f"step={good} -> 200", r.status_code == 200, f"status={r.status_code}")
        check(f"step={good} echoed back", body_of(r).get("step") == int(good), str(body_of(r).get("step")))

    print("\n=== 5. step validation runs for a non-owner too, without leaking ===")
    r = requests.get(f"{APP}{ROUTE}?step=45", cookies=tech_jar, timeout=30)
    check("non-owner with a bad step is still 403, not 400",
          r.status_code == 403, f"status={r.status_code}")

    print("\n=== 6. a broken feed URL yields an error and NO data ===")
    try:
        probe = requests.get(f"{BROKEN_APP}{ROUTE}", timeout=10)
        reachable = True
    except Exception:
        reachable = False
    if not reachable:
        skip("broken-feed server", f"nothing listening on {BROKEN_APP}")
    else:
        bowner_jar = owner_jar  # same Supabase project, so the cookie is valid there too
        r = requests.get(f"{BROKEN_APP}{ROUTE}", cookies=bowner_jar, timeout=120)
        b = body_of(r)
        check("broken feed -> 5xx", 500 <= r.status_code < 600, f"status={r.status_code}")
        check("broken feed returns an error field", "error" in b, str(list(b.keys())))
        check("broken feed returns NO free list", "free" not in b, str(list(b.keys())))
        check("broken feed returns NO rooms list", "rooms" not in b, str(list(b.keys())))
        check("broken feed returns no fetchedAt", "fetchedAt" not in b, str(list(b.keys())))
        check("broken feed response is no-store", r.headers.get("Cache-Control") == "no-store",
              r.headers.get("Cache-Control", ""))
        check("the secret ICS url is not echoed", "calendar.google.com" not in r.text
              and "basic.ics" not in r.text, r.text[:200])

finally:
    # ALWAYS, and verified. A bare auth delete leaves the profiles row behind,
    # so profiles goes first and both are re-checked afterwards.
    print("\n=== cleanup ===")
    for uid in users:
        requests.delete(f"{SUP}/rest/v1/profiles?id=eq.{uid}", headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{uid}", headers=ADMIN)
    leftover_profiles, leftover_users = [], []
    for uid in users:
        p = requests.get(f"{SUP}/rest/v1/profiles?id=eq.{uid}&select=id", headers=ADMIN)
        if p.ok and p.json():
            leftover_profiles.append(uid)
        u = requests.get(f"{SUP}/auth/v1/admin/users/{uid}", headers=ADMIN)
        if u.status_code == 200:
            leftover_users.append(uid)
    print(f"      users created: {len(users)}")
    print(f"      profiles left: {len(leftover_profiles)}  auth users left: {len(leftover_users)}")
    if leftover_profiles or leftover_users:
        fails.append("cleanup left rows behind")
        print("FAIL  cleanup left rows behind")
    else:
        print("PASS  cleanup verified — nothing left behind")

print()
if skips:
    print(f"skipped: {len(skips)} — {', '.join(skips)}")
if fails:
    print(f"FAILED {len(fails)}: " + ", ".join(fails))
    sys.exit(1)
print("ALL PASS")
