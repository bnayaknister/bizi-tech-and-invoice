# -*- coding: utf-8 -*-
"""
Acceptance test for production cancellation (owner spec 2026-07-21).
Requires migration 0028. Issues NO Morning document — it drives the
enqueue-only sync and inserts an 'issued' queue row directly, so it is safe
with MORNING_DRY_RUN=false.

Covers the owner's four scenarios:
  1. production with a PENDING work order -> cancel -> the queue item is
     cancelled, the production is 'בוטל', nothing reached Morning
  2. production with an ISSUED work order -> cancel without confirm returns
     409 needs_confirmation; with confirm it cancels, leaves the Morning doc,
     and the radar's cancelled-with-document alert fires
  3. a sync whose ICS STILL contains the cancelled event does NOT recreate it
  4. a technician (can_edit_stages, not money) can cancel; all evented
"""
import base64, json, os, sys, time, uuid
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

SUP = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SVC = os.environ["SUPABASE_SERVICE_ROLE_KEY"]; APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
ADMIN = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}
REPR = {**ADMIN, "Prefer": "return=representation"}
ref = SUP.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"
MARK = "ZTESTCANCEL"

failures = []; users = []; show_ids = []; production_ids = []; pending_ids = []
client_id = None


def check(l, ok, d=""):
    print(("PASS  " if ok else "FAIL  ") + l + (f"  [{d}]" if d and not ok else ""))
    if not ok: failures.append(l)


def rest(p): return f"{SUP}/rest/v1/{p}"
def b64(r): return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags):
    em = f"cancel-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{SUP}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers=REPR, json={"name": f"{MARK}", "approved": True, **flags})
    td = requests.post(f"{SUP}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {CN: "base64-" + b64(json.dumps(sess).encode())}


def make_ics(uid, summary, start):
    st = start.strftime("%Y%m%dT%H%M%SZ"); en = (start + timedelta(hours=1)).strftime("%Y%m%dT%H%M%SZ")
    return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//z//EN\r\nBEGIN:VEVENT\r\n"
            f"UID:{uid}\r\nDTSTAMP:{st}\r\nDTSTART:{st}\r\nDTEND:{en}\r\nSUMMARY:{summary}\r\n"
            "LOCATION:ZT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")


for _ in range(60):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("FAIL dev server never came up"); sys.exit(1)

try:
    tech = mkuser({"role": "tech", "can_view_stages": True, "can_edit_stages": True})
    client_id = requests.post(rest("clients"), headers=REPR,
                              json={"name": f"{MARK} client", "normalized_name": f"ztc{uuid.uuid4().hex[:6]}",
                                    "morning_client_id": f"ztc-m-{uuid.uuid4().hex[:8]}"}).json()[0]["id"]
    alias = f"{MARK} SHOW"
    show = requests.post(rest("shows"), headers=REPR,
                         json={"name": alias, "aliases": [alias], "client_id": client_id,
                               "billing_mode": "per_episode", "default_rate": 1, "active": True}).json()[0]["id"]
    show_ids.append(show)
    start = datetime.now(timezone.utc).replace(microsecond=0)

    # scenario 1: production with a pending work order
    uid1 = f"ztc-{uuid.uuid4().hex[:10]}"; ics1 = make_ics(uid1, alias, start)
    r = requests.post(f"{APP}/api/calendar/sync", cookies=tech, headers={"Content-Type": "application/json"}, json={"icsText": ics1})
    check("0. sync created + queued", r.json().get("queuedWorkOrders") == 1, r.text[:150])
    p1 = requests.get(rest(f"productions?calendar_uid=eq.{uid1}&select=id"), headers=ADMIN).json()[0]["id"]
    production_ids.append(p1)
    wo1 = requests.get(rest(f"pending_documents?production_id=eq.{p1}&select=id,status"), headers=ADMIN).json()
    pending_ids += [d["id"] for d in wo1]
    check("0b. one pending work order", len(wo1) == 1 and wo1[0]["status"] == "pending")

    r = requests.post(f"{APP}/api/productions/{p1}/cancel", cookies=tech,
                      headers={"Content-Type": "application/json"}, json={"reason": "הלקוח ביטל בבוקר"})
    check("1a. technician cancel succeeded (200)", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
    prow = requests.get(rest(f"productions?id=eq.{p1}&select=status,cancel_reason,cancelled_by"), headers=ADMIN).json()[0]
    check("1b. production is בוטל with reason", prow["status"] == "בוטל" and prow["cancel_reason"] == "הלקוח ביטל בבוקר",
          json.dumps(prow, ensure_ascii=False))
    wrow = requests.get(rest(f"pending_documents?id=eq.{wo1[0]['id']}&select=status"), headers=ADMIN).json()[0]
    check("1c. the pending work order is cancelled (nothing to Morning)", wrow["status"] == "cancelled", wrow["status"])

    # scenario 3: re-sync with the SAME event still present -> not recreated
    r = requests.post(f"{APP}/api/calendar/sync", cookies=tech, headers={"Content-Type": "application/json"}, json={"icsText": ics1})
    again = requests.get(rest(f"productions?calendar_uid=eq.{uid1}&select=id"), headers=ADMIN).json()
    check("3. cancelled event is skipped by the sync (not recreated)", len(again) == 1, f"count={len(again)}")

    # scenario 2: production with an ISSUED work order
    uid2 = f"ztc-{uuid.uuid4().hex[:10]}"; ics2 = make_ics(uid2, alias, start)
    requests.post(f"{APP}/api/calendar/sync", cookies=tech, headers={"Content-Type": "application/json"}, json={"icsText": ics2})
    p2 = requests.get(rest(f"productions?calendar_uid=eq.{uid2}&select=id"), headers=ADMIN).json()[0]["id"]
    production_ids.append(p2)
    # force its queued work order to 'issued' with a fake Morning id (no real call)
    wo2 = requests.get(rest(f"pending_documents?production_id=eq.{p2}&select=id"), headers=ADMIN).json()[0]["id"]
    pending_ids.append(wo2)
    requests.patch(rest(f"pending_documents?id=eq.{wo2}"), headers=REPR,
                   json={"status": "issued", "morning_doc_id": f"dry-{uuid.uuid4()}", "morning_doc_number": "70123"})

    r = requests.post(f"{APP}/api/productions/{p2}/cancel", cookies=tech,
                      headers={"Content-Type": "application/json"}, json={"reason": "בוטל"})
    check("2a. cancel with an issued doc -> 409 needs_confirmation", r.status_code == 409 and r.json().get("needs_confirmation"),
          f"{r.status_code} {r.text[:120]}")
    check("2b. warning names the issued doc number", "70123" in r.text, r.text[:150])
    still = requests.get(rest(f"productions?id=eq.{p2}&select=status"), headers=ADMIN).json()[0]["status"]
    check("2c. not cancelled until confirmed", still != "בוטל", still)

    r = requests.post(f"{APP}/api/productions/{p2}/cancel", cookies=tech,
                      headers={"Content-Type": "application/json"}, json={"reason": "בוטל", "confirm": True})
    check("2d. confirmed cancel succeeds", r.status_code == 200 and r.json().get("flagged_documents") == 1, r.text[:150])
    wrow2 = requests.get(rest(f"pending_documents?id=eq.{wo2}&select=status,morning_doc_id"), headers=ADMIN).json()[0]
    check("2e. the issued doc is LEFT in Morning (untouched)", wrow2["status"] == "issued" and wrow2["morning_doc_id"],
          json.dumps(wrow2))
    # radar surfaces it
    money = mkuser({"role": "bookkeeper", "can_view_money": True})
    html = requests.get(f"{APP}/radar", cookies=money).text
    check("2f. radar flags the cancelled production with its document", "לסגור במורנינג" in html)

    # scenario 4: everything evented
    ev = requests.get(rest(f"events?entity_id=eq.{p2}&event_type=eq.production_cancelled&select=actor_id,payload"), headers=ADMIN).json()
    check("4. cancellation is evented with actor + reason", len(ev) == 1 and ev[0]["actor_id"] and ev[0]["payload"].get("reason"),
          json.dumps(ev, ensure_ascii=False)[:150])

finally:
    print("\n--- cleanup ---")
    for pd in pending_ids:
        requests.delete(rest(f"events?entity_id=eq.{pd}"), headers=ADMIN)
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
        requests.delete(rest(f"events?entity_id=eq.{client_id}"), headers=ADMIN)
        requests.delete(rest(f"clients?id=eq.{client_id}"), headers=ADMIN)
    for uid in users:
        requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{uid}", headers=ADMIN)
    left = requests.get(rest(f"productions?podcast_name=like.*{MARK}*&select=id"), headers=ADMIN).json()
    check("cleanup: no test productions left", left == [], json.dumps(left)[:80])
    print()
    if failures:
        print(f"{len(failures)} FAILED: " + " · ".join(failures)); sys.exit(1)
    print("all checks passed")
