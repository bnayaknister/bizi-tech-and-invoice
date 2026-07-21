# -*- coding: utf-8 -*-
"""
Acceptance test for the dormant-clients radar alert (owner spec 2026-07-21):
an "active" client (has a show that's active AND actually bills) with no
production in 90+ days. Verifies the exceptions too: an internal
(billing_mode='none') show and an ended (active=false) show must NOT make a
client count as active. Hits the real running dev server.
"""
import os, sys, time, uuid, json
from datetime import datetime, timezone, timedelta
import requests

ENV = os.path.join(os.path.dirname(__file__), "..", ".env.local")
if os.path.exists(ENV):
    with open(ENV, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

SUP = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SVC = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
ADMIN = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}
REPR = {**ADMIN, "Prefer": "return=representation"}
MARK = "ZTESTDORMANT"

failures = []
ids = {"clients": [], "shows": [], "productions": [], "jobs": []}


def check(l, ok, d=""):
    print(("PASS  " if ok else "FAIL  ") + l + (f"  [{d}]" if d and not ok else ""))
    if not ok: failures.append(l)


def rest(p): return f"{SUP}/rest/v1/{p}"


def days_ago(n): return (datetime.now(timezone.utc) - timedelta(days=n)).strftime("%Y-%m-%d")


try:
    # --- client A: real dormant candidate — active billing show, last
    # recording 120 days ago, two paid jobs summing to 8,000 ---
    ca = requests.post(rest("clients"), headers=REPR,
                       json={"name": f"{MARK} A dormant", "normalized_name": f"zda{uuid.uuid4().hex[:6]}"}).json()[0]["id"]
    ids["clients"].append(ca)
    sa = requests.post(rest("shows"), headers=REPR,
                       json={"name": f"{MARK} A show", "client_id": ca, "billing_mode": "per_episode",
                             "active": True, "default_rate": 100}).json()[0]["id"]
    ids["shows"].append(sa)
    pa = requests.post(rest("productions"), headers=REPR,
                       json={"podcast_name": f"{MARK} A show", "show_id": sa, "client_id": ca, "kind": "client",
                             "record_date": days_ago(120), "status": "הופץ", "legacy": False}).json()[0]["id"]
    ids["productions"].append(pa)
    ja = requests.post(rest("jobs"), headers=REPR,
                       json={"client_id": ca, "amount": 8000, "paid": "כן", "date": days_ago(60)}).json()[0]["id"]
    ids["jobs"].append(ja)

    # --- client B: recorded 10 days ago — must NOT appear (not dormant) ---
    cb = requests.post(rest("clients"), headers=REPR,
                       json={"name": f"{MARK} B recent", "normalized_name": f"zdb{uuid.uuid4().hex[:6]}"}).json()[0]["id"]
    ids["clients"].append(cb)
    sb = requests.post(rest("shows"), headers=REPR,
                       json={"name": f"{MARK} B show", "client_id": cb, "billing_mode": "per_episode",
                             "active": True, "default_rate": 100}).json()[0]["id"]
    ids["shows"].append(sb)
    pb = requests.post(rest("productions"), headers=REPR,
                       json={"podcast_name": f"{MARK} B show", "show_id": sb, "client_id": cb, "kind": "client",
                             "record_date": days_ago(10), "status": "הופץ", "legacy": False}).json()[0]["id"]
    ids["productions"].append(pb)

    # --- client C: only an internal (billing_mode='none') active show —
    # must NOT appear even though "active" is true ---
    cc = requests.post(rest("clients"), headers=REPR,
                       json={"name": f"{MARK} C internal", "normalized_name": f"zdc{uuid.uuid4().hex[:6]}"}).json()[0]["id"]
    ids["clients"].append(cc)
    sc = requests.post(rest("shows"), headers=REPR,
                       json={"name": f"{MARK} C show", "client_id": cc, "billing_mode": "none",
                             "active": True}).json()[0]["id"]
    ids["shows"].append(sc)

    # --- client D: only an ended (active=false) show, last recorded 200
    # days ago — must NOT appear (no active show at all) ---
    cd = requests.post(rest("clients"), headers=REPR,
                       json={"name": f"{MARK} D ended", "normalized_name": f"zdd{uuid.uuid4().hex[:6]}"}).json()[0]["id"]
    ids["clients"].append(cd)
    sd = requests.post(rest("shows"), headers=REPR,
                       json={"name": f"{MARK} D show", "client_id": cd, "billing_mode": "per_episode",
                             "active": False, "default_rate": 100}).json()[0]["id"]
    ids["shows"].append(sd)
    pd_ = requests.post(rest("productions"), headers=REPR,
                        json={"podcast_name": f"{MARK} D show", "show_id": sd, "client_id": cd, "kind": "client",
                              "record_date": days_ago(200), "status": "הופץ", "legacy": False}).json()[0]["id"]
    ids["productions"].append(pd_)

    # owner session cookie
    import base64
    ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
    ref = SUP.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"
    em = f"dorm-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{SUP}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers=REPR,
                   json={"name": MARK, "approved": True, "role": "owner", "can_view_stages": True,
                         "can_edit_stages": True, "can_view_money": True, "can_edit_money": True,
                         "can_manage_users": True})
    td = requests.post(f"{SUP}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    cookie = {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}

    for _ in range(60):
        try:
            if requests.get(APP, timeout=2).status_code < 500: break
        except requests.exceptions.ConnectionError: pass
        time.sleep(1)
    else:
        print("FAIL dev server never came up"); sys.exit(1)

    html = requests.get(f"{APP}/radar", cookies=cookie).text
    check("A (dormant, 8,000 revenue) appears", f"{MARK} A dormant" in html)
    check("A's revenue shown (8,000)", "8,000" in html)
    check("A's last-record days-since shown (120)", "120" in html)
    check("B (recorded 10 days ago) does NOT appear", f"{MARK} B recent" not in html)
    check("C (internal-only active show) does NOT appear", f"{MARK} C internal" not in html)
    check("D (only an ended show) does NOT appear", f"{MARK} D ended" not in html)

    requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=ADMIN)
    requests.delete(f"{SUP}/auth/v1/admin/users/{uid}", headers=ADMIN)

finally:
    print("\n--- cleanup ---")
    for jid in ids["jobs"]:
        requests.delete(rest(f"jobs?id=eq.{jid}"), headers=ADMIN)
    for pid in ids["productions"]:
        requests.delete(rest(f"stages?production_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"productions?id=eq.{pid}"), headers=ADMIN)
    for sid in ids["shows"]:
        requests.delete(rest(f"events?entity_id=eq.{sid}"), headers=ADMIN)
        requests.delete(rest(f"shows?id=eq.{sid}"), headers=ADMIN)
    for cid in ids["clients"]:
        requests.delete(rest(f"clients?id=eq.{cid}"), headers=ADMIN)
    left = requests.get(rest(f"clients?name=like.*{MARK}*&select=id"), headers=ADMIN).json()
    check("cleanup: no test clients left", left == [], json.dumps(left)[:80])
    print()
    if failures:
        print(f"{len(failures)} FAILED: " + " · ".join(failures)); sys.exit(1)
    print("all checks passed")
