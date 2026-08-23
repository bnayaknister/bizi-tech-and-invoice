# -*- coding: utf-8 -*-
"""
The three cadence alerts on the radar — bundle_full / accrued_ripe /
month_closed_unredeemed. They had no coverage at all, and they are what tells
the bookkeeper there is money waiting to be billed.

Builds its own clients and accrued rows rather than reading the live ones:
חתונמיות is 4/6 today and 5/6 next week, so any assertion anchored to it
expires. Nothing here depends on production data — an accrued work order needs
only a client and a created_at, and the monthly month-key falls back to
created_at when there is no production (alerts.ts), so no productions or jobs
are created.

Every assertion is a DELTA against the radar as it stands before seeding: the
counts are global, real clients contribute to them, and a fixed expected number
would fail the moment the owner redeems someone.

The five seeded clients, and what each one proves:

  A  every_n=2, 2 rows, BOTH 40 days old   -> bundle_full. Full wins over
                                              stalled: the disjointness the
                                              if/else is there to guarantee.
  B  every_n=3, rows at 40 and 5 days      -> NOTHING. The 2026-08-23 fix: a
                                              bundle still receiving episodes
                                              is not stalled, however old its
                                              first episode is.
  C  every_n=3, 2 rows, BOTH 40 days old   -> accrued_ripe. Nothing new has
                                              arrived; this one really stopped.
  D  monthly, 1 row created LAST month     -> month_closed_unredeemed.
  E  monthly, 1 row created today          -> NOTHING (the control).

The accrued_ripe delta is what distinguishes the fixed code from the old code:
A, B and C all hold a 40-day-old row, so `rows.some(age >= 30)` counted B and C
(A is full, so the if/else excludes it) and the delta would be 2. Measuring the
NEWEST row counts C alone -> 1.

MUST run against a dev server (any MORNING_DRY_RUN — nothing is issued).
Cleans up and verifies in finally.
"""
import base64, json, os, re, sys, time, uuid
from datetime import datetime, timedelta, timezone

import requests

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")
if os.path.exists(ENV_PATH):
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

S = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]; SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
ADMIN = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
REPR = {"Prefer": "return=representation"}
ref = S.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"

MARK = "ZTESTCAD"
STALL_DAYS = 30  # mirrors alerts.ts; the seeds sit well clear of it on both sides

fails = []; users = []; client_ids = []; pending_ids = []


def check(l, ok, d=""):
    print(("PASS  " if ok else "FAIL  ") + l + (f"  [{d}]" if d and not ok else ""))
    if not ok: fails.append(l)


def rest(p): return f"{S}/rest/v1/{p}"


def ins(table, row):
    r = requests.post(rest(table), headers={**ADMIN, **REPR}, json=row)
    if r.status_code >= 300:
        raise RuntimeError(f"{table}: {r.status_code} {r.text[:300]}")
    return r.json()[0]


def mkuser():
    em = f"cad-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{S}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**ADMIN, **REPR},
                   json={"name": MARK, "approved": True, "role": "bookkeeper",
                         "can_view_money": True, "can_edit_money": True, "can_view_stages": True}).raise_for_status()
    td = requests.post(f"{S}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}


# ---- reading the radar ----------------------------------------------------
# computeRadar runs inside the server component; there is no API route, so the
# assertions read the rendered page — the same approach as test_radar_billing.py
# and test_contracts_panel.py. An alert with count 0 is filtered out of the list
# entirely (alerts.ts), so an absent title legitimately means zero.
TITLES = {
    "bundle_full": "אגד מלא וממתין לפדיון",
    "accrued_ripe": "אגד חלקי שתקוע 30+ יום ולא יתמלא",
    "month_closed_unredeemed": "חודש נסגר ולא נפדה",
}


def radar_counts(cookies):
    html = requests.get(f"{APP}/radar", cookies=cookies).text
    out = {}
    for key, title in TITLES.items():
        i = html.find(title)
        if i < 0:
            out[key] = 0
            continue
        m = re.search(r'min-w-8 text-center">(\d+)<', html[i:i + 900])
        out[key] = int(m.group(1)) if m else None
    return out


def days_ago(n):
    return (datetime.now(timezone.utc) - timedelta(days=n)).isoformat()


def last_month_iso():
    """A timestamp inside the PREVIOUS Israel month. Computed from the Israel
    date, not UTC: at 01:00 on the 1st the two disagree, and that hour is
    exactly what the monthly rule turns on."""
    il = datetime.now(timezone.utc) + timedelta(hours=3)  # Asia/Jerusalem, no DST edge worth modelling here
    first_of_this_month = il.replace(day=1, hour=12, minute=0, second=0, microsecond=0)
    return (first_of_this_month - timedelta(days=5)).replace(tzinfo=timezone.utc).isoformat()


def mkclient(cadence, every_n, label):
    c = ins("clients", {"name": f"{MARK} {label}",
                        "normalized_name": f"ztestcad{uuid.uuid4().hex[:8]}",
                        "billing_cadence": cadence, "billing_every_n": every_n})
    client_ids.append(c["id"])
    return c["id"]


def accrue(client_id, created_at):
    p = ins("pending_documents", {"doc_type": "work_order", "status": "accrued",
                                  "client_id": client_id, "amount": 600,
                                  "created_at": created_at, "payload": {"type": 100}})
    pending_ids.append(p["id"])
    return p["id"]


for _ in range(60):
    try:
        if requests.get(APP, timeout=10).status_code < 500: break
    except (requests.exceptions.ConnectionError, requests.exceptions.ReadTimeout): pass
    time.sleep(1)
else:
    print("FAIL dev server never came up"); sys.exit(1)

try:
    money = mkuser()

    base = radar_counts(money)
    check("0. the three cadence alerts are readable from /radar",
          all(v is not None for v in base.values()), str(base))
    print(f"      baseline: {base}")

    # ---- A: every_n FULL, and every row old ------------------------------
    a = mkclient("every_n", 2, "A full")
    accrue(a, days_ago(40)); accrue(a, days_ago(40))
    # ---- B: every_n partial, still receiving (the bug that was fixed) -----
    b = mkclient("every_n", 3, "B filling")
    accrue(b, days_ago(40)); accrue(b, days_ago(5))
    # ---- C: every_n partial, nothing new for 40 days ----------------------
    c = mkclient("every_n", 3, "C stalled")
    accrue(c, days_ago(40)); accrue(c, days_ago(40))
    # ---- D: monthly, an episode from a month that already closed ---------
    d = mkclient("monthly", None, "D closed month")
    accrue(d, last_month_iso())
    # ---- E: monthly, this month (the control) ----------------------------
    e = mkclient("monthly", None, "E current month")
    accrue(e, days_ago(1))

    after = radar_counts(money)
    print(f"      after seeding: {after}")
    delta = {k: after[k] - base[k] for k in base}

    check("1. bundle_full +1 — an every_n bundle that reached N",
          delta["bundle_full"] == 1, f"delta={delta['bundle_full']} ({base['bundle_full']}->{after['bundle_full']})")

    check("2. THE FIX — accrued_ripe +1, not +2. Only the bundle with nothing new "
          "counts; the one still receiving episodes does not, however old its first is",
          delta["accrued_ripe"] == 1,
          f"delta={delta['accrued_ripe']} ({base['accrued_ripe']}->{after['accrued_ripe']}) "
          f"— 2 means the oldest-row rule is back")

    check("3. month_closed_unredeemed +1 — a monthly client with an episode from a closed month",
          delta["month_closed_unredeemed"] == 1,
          f"delta={delta['month_closed_unredeemed']} ({base['month_closed_unredeemed']}->{after['month_closed_unredeemed']})")

    # ---- 4. disjointness --------------------------------------------------
    # Client A is every_n, full, and every one of its rows is 40 days old — it
    # satisfies the stalled test on its own. The if/else must give it to
    # bundle_full ONLY. If it were counted twice the ripe delta would be 2, so
    # checks 2 and 4 fail together on a double-count and 2 alone on a
    # regression of the rule — the two are distinguishable.
    check("4. no every_n client is counted in two cards at once (full excludes stalled)",
          delta["bundle_full"] == 1 and delta["accrued_ripe"] == 1, str(delta))

    # ---- 5. the monthly control -------------------------------------------
    # E holds an episode from the CURRENT month, so it must contribute nothing.
    # Covered arithmetically by check 3 (a delta of 2 would mean E counted too),
    # asserted separately so a failure names the cause.
    check("5. a monthly client whose episodes are all from the current month stays silent",
          delta["month_closed_unredeemed"] == 1, str(delta))

    # ---- 6. the alerts vanish when the queue empties ----------------------
    # Redemption is what these cards ask for. Emptying the accrued rows stands in
    # for it: the three counts must return to exactly the baseline, which also
    # proves nothing seeded here leaked into another card.
    for pid in pending_ids:
        requests.delete(rest(f"pending_documents?id=eq.{pid}"), headers=ADMIN)
    pending_ids.clear()
    back = radar_counts(money)
    check("6. all three return to the baseline once nothing is accrued",
          back == base, f"{back} vs {base}")

finally:
    for pid in pending_ids:
        requests.delete(rest(f"events?entity_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"pending_documents?id=eq.{pid}"), headers=ADMIN)
    for cid in client_ids:
        # nothing else was created against these clients, but delete defensively
        # in FK order anyway — a stray row here blocks the client delete silently
        requests.delete(rest(f"pending_documents?client_id=eq.{cid}"), headers=ADMIN)
        r = requests.delete(rest(f"clients?id=eq.{cid}"), headers={**ADMIN, **REPR})
        if r.status_code >= 300: print("WARNING client delete", cid, r.status_code, r.text[:120])
    for uid in users:
        requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=ADMIN)
        requests.delete(f"{S}/auth/v1/admin/users/{uid}", headers=ADMIN)

    leftovers = []
    if client_ids and requests.get(rest(f"clients?id=in.({','.join(client_ids)})&select=id"), headers=ADMIN).json():
        leftovers.append("clients")
    if users and requests.get(rest(f"profiles?id=in.({','.join(users)})&select=id"), headers=ADMIN).json():
        leftovers.append("profiles")
    stray = requests.get(rest(f"pending_documents?client_id=in.({','.join(client_ids)})&select=id"), headers=ADMIN).json() if client_ids else []
    if stray:
        leftovers.append("pending_documents")
    check("CLEANUP. no test rows left behind", not leftovers, ", ".join(leftovers))

print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: " + " | ".join(fails)))
sys.exit(1 if fails else 0)
