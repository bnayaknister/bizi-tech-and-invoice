# -*- coding: utf-8 -*-
"""
Radar wiring for the billing pipeline (owner spec 2026-07-20). Issues NO
Morning document — it drives the sync (which only ENQUEUES) and inserts a
backdated queue row directly, so it is safe with MORNING_DRY_RUN=false.

Proves:
  1. a CLIENT production whose client is unmapped gets billing_block_reason
     set (the 🟡), and the radar surfaces "הפקת לקוח חסומה לחיוב"
  2. an INTERNAL production gets NO block reason (correct silence, not a flag)
  3. a queue row pending > 72h surfaces the red radar alert; > 24h the yellow

Radar assertions read the rendered /radar page as a money user (the same
computeRadar the screen uses). Cleans up everything in finally.
"""
import base64
import json
import os
import sys
import time
import uuid
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

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
ANON_KEY = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP_URL = os.environ.get("TEST_APP_URL", "http://localhost:3000")
ADMIN = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"}
REPR = {"Prefer": "return=representation"}
ref = SUPABASE_URL.split("//")[1].split(".")[0]
CN = f"sb-{ref}-auth-token"
MARK = "ZTESTRADAR"

failures = []
users, show_ids, production_ids, pending_ids = [], [], [], []
client_id = None


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        failures.append(label)


def rest(p):
    return f"{SUPABASE_URL}/rest/v1/{p}"


def b64(r):
    return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags):
    em = f"radar-{uuid.uuid4().hex[:8]}@bizi-test.local"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{SUPABASE_URL}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**ADMIN, **REPR},
                   json={"name": f"{MARK} user", "approved": True, **flags}).raise_for_status()
    td = requests.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {CN: "base64-" + b64(json.dumps(sess).encode())}


def make_ics(uid, summary, start_utc):
    stamp = start_utc.strftime("%Y%m%dT%H%M%SZ")
    end = (start_utc + timedelta(hours=1)).strftime("%Y%m%dT%H%M%SZ")
    return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//ztest//EN\r\nBEGIN:VEVENT\r\n"
            f"UID:{uid}\r\nDTSTAMP:{stamp}\r\nDTSTART:{stamp}\r\nDTEND:{end}\r\n"
            f"SUMMARY:{summary}\r\nLOCATION:ZTEST\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")


def radar_html(cookies):
    return requests.get(f"{APP_URL}/radar", cookies=cookies).text


for _ in range(60):
    try:
        if requests.get(APP_URL, timeout=2).status_code < 500:
            break
    except requests.exceptions.ConnectionError:
        pass
    time.sleep(1)
else:
    print("FAIL dev server never came up")
    sys.exit(1)

try:
    money = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True,
                    "can_view_stages": True, "can_edit_stages": True})

    # UNMAPPED client + a per_episode show -> sync derives kind=client
    client_id = requests.post(rest("clients"), headers={**ADMIN, **REPR},
                              json={"name": f"{MARK} unmapped client",
                                    "normalized_name": f"ztestradar{uuid.uuid4().hex[:6]}"}).json()[0]["id"]
    alias_c = f"{MARK} CLIENT SHOW"
    show_c = requests.post(rest("shows"), headers={**ADMIN, **REPR},
                           json={"name": alias_c, "aliases": [alias_c], "client_id": client_id,
                                 "billing_mode": "per_episode", "default_rate": 1200, "active": True}).json()[0]["id"]
    show_ids.append(show_c)
    alias_i = f"{MARK} INTERNAL SHOW"
    show_i = requests.post(rest("shows"), headers={**ADMIN, **REPR},
                           json={"name": alias_i, "aliases": [alias_i], "client_id": None,
                                 "billing_mode": "none", "active": True}).json()[0]["id"]
    show_ids.append(show_i)

    start = datetime.now(timezone.utc).replace(microsecond=0)

    # 1. client production, unmapped client -> applicable block -> flag
    uid_c = f"ztest-{uuid.uuid4().hex[:10]}"
    requests.post(f"{APP_URL}/api/calendar/sync", cookies=money, headers={"Content-Type": "application/json"},
                  json={"icsText": make_ics(uid_c, alias_c, start)})
    pc = requests.get(rest(f"productions?calendar_uid=eq.{uid_c}&select=id,billing_block_reason"), headers=ADMIN).json()
    if pc:
        production_ids.append(pc[0]["id"])
        check("1a. unmapped-client production carries a block reason",
              bool(pc[0]["billing_block_reason"]), str(pc[0]["billing_block_reason"]))
        check("1b. reason mentions the mapping gap", "מורנינג" in (pc[0]["billing_block_reason"] or ""),
              str(pc[0]["billing_block_reason"]))

    # 2. internal production -> NOT applicable -> no flag
    uid_i = f"ztest-{uuid.uuid4().hex[:10]}"
    requests.post(f"{APP_URL}/api/calendar/sync", cookies=money, headers={"Content-Type": "application/json"},
                  json={"icsText": make_ics(uid_i, alias_i, start)})
    pi = requests.get(rest(f"productions?calendar_uid=eq.{uid_i}&select=id,billing_block_reason"), headers=ADMIN).json()
    if pi:
        production_ids.append(pi[0]["id"])
        check("2. internal production has NO block reason", pi[0]["billing_block_reason"] is None,
              str(pi[0]["billing_block_reason"]))

    # radar surfaces the blocked client production
    html = radar_html(money)
    check("1c. radar shows 'הפקת לקוח חסומה לחיוב'", "הפקת לקוח חסומה לחיוב" in html)

    # 3. queue aging — insert backdated pending rows directly (no issuance)
    old73 = (datetime.now(timezone.utc) - timedelta(hours=73)).isoformat()
    old30 = (datetime.now(timezone.utc) - timedelta(hours=30)).isoformat()
    for created, amt in ((old73, 100), (old30, 200)):
        row = requests.post(rest("pending_documents"), headers={**ADMIN, **REPR},
                            json={"doc_type": "work_order", "client_id": client_id, "amount": amt,
                                  "payload": {"type": 100}, "status": "pending", "created_at": created}).json()
        pending_ids.append(row[0]["id"])

    html = radar_html(money)
    check("3a. radar shows the >72h red alert", "מעל 72 שעות" in html, "")
    check("3b. radar shows the >24h yellow alert", "מעל 24 שעות" in html, "")

    # 4. cancelled-after-work-order: the client production (pc) gets an ISSUED
    #    work order, then is calendar_removed. Inserting an issued row directly
    #    is not a Morning call — safe with DRY_RUN off.
    if pc:
        wo = requests.post(rest("pending_documents"), headers={**ADMIN, **REPR},
                          json={"doc_type": "work_order", "production_id": pc[0]["id"], "client_id": client_id,
                                "amount": 1200, "payload": {"type": 100}, "status": "issued",
                                "morning_doc_id": f"dry-{uuid.uuid4()}", "morning_doc_number": "55123"}).json()
        pending_ids.append(wo[0]["id"])
        requests.patch(rest(f"productions?id=eq.{pc[0]['id']}"), headers={**ADMIN, **REPR},
                       json={"calendar_removed": True})
        html = radar_html(money)
        check("4. radar flags cancelled production with an issued work order",
              "לסגור במורנינג" in html, "")

finally:
    print("\n--- cleanup ---")
    for pd in pending_ids:
        requests.delete(rest(f"pending_documents?id=eq.{pd}"), headers=ADMIN)
    for pid in production_ids:
        requests.delete(rest(f"pending_documents?production_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"events?entity_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"job_productions?production_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"stages?production_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"productions?id=eq.{pid}"), headers=ADMIN)
    for sid in show_ids:
        requests.delete(rest(f"events?entity_id=eq.{sid}"), headers=ADMIN)
        requests.delete(rest(f"shows?id=eq.{sid}"), headers=ADMIN)
    if client_id:
        requests.delete(rest(f"pending_documents?client_id=eq.{client_id}"), headers=ADMIN)
        requests.delete(rest(f"events?entity_id=eq.{client_id}"), headers=ADMIN)
        requests.delete(rest(f"clients?id=eq.{client_id}"), headers=ADMIN)
    for uid in users:
        requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=ADMIN)
        requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{uid}", headers=ADMIN)

    left_p = requests.get(rest(f"productions?podcast_name=like.*{MARK}*&select=id"), headers=ADMIN).json()
    left_pd = requests.get(rest("pending_documents?select=id"), headers=ADMIN).json()
    check("cleanup: no test productions left", left_p == [], json.dumps(left_p)[:120])
    check("cleanup: pending_documents empty", left_pd == [], json.dumps(left_pd)[:120])

    print()
    if failures:
        print(f"{len(failures)} FAILED: " + " · ".join(failures))
        sys.exit(1)
    print("all checks passed")
