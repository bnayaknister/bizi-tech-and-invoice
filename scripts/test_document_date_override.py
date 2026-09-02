# -*- coding: utf-8 -*-
"""
The MANUAL document date at approval (owner spec 2026-09-02).

Companion to test_document_date.py, and deliberately split from it: that file
proves the DEFAULT ("no date chosen → today, and the stale payload date never
wins"), this one proves the OVERRIDE and its guards. Its assertion 3 — the
original 57893cc bug — stays unqualified precisely because the override
travels as a separate parameter (issue.ts docDateOverride) and never through
payload.date.

Rule 40: run against a DRY_RUN server only. The URL comes from TEST_APP_URL —
never hard-coded — and the script verifies /api/morning/status reports
dryRun:true with a real cookie BEFORE approving anything. Approvals here reach
the review→issue path; in dry-run nothing is sent to Morning.

Scenarios (the seven from the approved plan, plus format):
  1. valid backdate           → sent.date = chosen, registry document_date = chosen,
                                document_date_overridden event with from/to
  2. future date              → 400, nothing issued
  3. beyond the 14-day window → 400 naming the earliest allowed date
  4. month-cross, no confirm  → 409 needs_backdate_confirmation, row untouched
  5. month-cross + confirm    → issues with the chosen date, event has crossed_month
  6. batch (2 ids) + doc_date → 400, neither row issued
  7. no doc_date              → sent.date = today (the default is untouched)
  8. garbage format           → 400

Self-cleaning in FK order; exit code decided AFTER cleanup (eb0115f).

Run:  TEST_APP_URL=http://localhost:3100 python3 scripts/test_document_date_override.py
"""
import base64
import json
import os
import sys
import time
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests

for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3100")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
ref = U.split("//")[1].split(".")[0]
CN = f"sb-{ref}-auth-token"

TODAY = datetime.now(ZoneInfo("Asia/Jerusalem"))
TODAY_IL = TODAY.strftime("%Y-%m-%d")


def iso(days_back):
    return (TODAY - timedelta(days=days_back)).strftime("%Y-%m-%d")


def rest(p):
    return f"{U}/rest/v1/{p}"


def ins(t, row):
    r = requests.post(rest(t), headers={**A, "Prefer": "return=representation"}, json=row)
    r.raise_for_status()
    return r.json()[0]


def get(t):
    return requests.get(rest(t), headers=A).json()


def patch(t, q, row):
    requests.patch(rest(f"{t}?{q}"), headers=A, json=row)


def dele(t, q):
    requests.delete(rest(f"{t}?{q}"), headers=A)


passed = fail = 0


def check(name, ok, detail=""):
    global passed, fail
    print(("  ✓ " if ok else "  ✗ ") + name + (f"   [{detail}]" if detail and not ok else ""))
    passed += bool(ok)
    fail += (not ok)


for _ in range(60):
    try:
        if requests.get(APP, timeout=2).status_code < 500:
            break
    except requests.exceptions.ConnectionError:
        pass
    time.sleep(1)


def mkuser():
    em = f"ZTESTDOV-{uuid.uuid4().hex[:8]}@bizi-test.local"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    uid_ = requests.post(f"{U}/auth/v1/admin/users", headers=A,
                         json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    patch("profiles", f"id=eq.{uid_}", {"name": "ZTESTDOV", "approved": True, "role": "bookkeeper",
                                        "can_view_money": True, "can_edit_money": True,
                                        "can_view_stages": True, "can_edit_stages": True})
    td = requests.post(f"{U}/auth/v1/token?grant_type=password",
                       headers={"apikey": AN, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return uid_, {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}


uid, ck = mkuser()
cli = ins("clients", {"name": "ZTESTDOV " + uuid.uuid4().hex[:5],
                      "normalized_name": f"ztestdov{uuid.uuid4().hex[:8]}",
                      "morning_client_id": f"mdov-{uuid.uuid4().hex[:8]}"})

mdids = []


def mk_row():
    """A plain work order — no confirmation gate, no payment block — so an
    approve exercises the doc_date path and nothing else."""
    return ins("pending_documents", {
        "doc_type": "work_order", "client_id": cli["id"], "amount": 700, "status": "pending",
        "payload": {"type": 100, "lang": "he", "currency": "ILS", "vatType": 0,
                    # a stale payload date on purpose — the override must beat
                    # the human choice into the payload, never merely join it
                    "date": "2026-06-15",
                    "description": "הזמנת עבודה — ZTESTDOV",
                    "client": {"id": cli["morning_client_id"], "add": False},
                    "income": [{"description": "פרק בדיקה", "quantity": 1, "price": 700,
                                "currency": "ILS", "vatType": 0}]},
    })


def approve(row_ids, **extra):
    return requests.post(f"{APP}/api/documents/pending/review", cookies=ck,
                         headers={"Content-Type": "application/json"},
                         json={"ids": row_ids, "action": "approve", **extra})


def sent_date(row_id):
    ev = get(f"events?entity_id=eq.{row_id}&event_type=eq.morning_call_started"
             f"&select=payload&order=created_at.desc&limit=1")
    return ev[0]["payload"]["sent"].get("date") if ev else None


def row_status(row_id):
    return get(f"pending_documents?id=eq.{row_id}&select=status,morning_doc_id")[0]


try:
    print(f"today (Israel) = {TODAY_IL}  ·  target = {APP}")

    # ---- rule 40 gate: refuse to approve anything on a live server ----------
    st = requests.get(f"{APP}/api/morning/status", cookies=ck, timeout=20)
    dry = st.status_code == 200 and st.json().get("dryRun") is True
    check("0. server is DRY_RUN (rule 40 — verified with a cookie, before any approve)", dry,
          f"{st.status_code}: {st.text[:120]}")
    if not dry:
        raise SystemExit("REFUSING: server is not in dry-run")

    # ---- 1. a valid backdate: yesterday (confirm only if it crosses a month) --
    d1 = iso(1)
    r1 = mk_row()
    extra = {"doc_date": d1}
    if d1[:7] != TODAY_IL[:7]:
        extra["confirm_backdate"] = True  # on the 1st of a month, yesterday crosses
    res = approve([r1["id"]], **extra)
    ok1 = res.status_code == 200 and (res.json().get("results") or [{}])[0].get("ok")
    check("1. valid backdate accepted", ok1, f"{res.status_code}: {res.text[:160]}")
    check("1. sent.date = the CHOSEN date, not today and not the stale payload date",
          sent_date(r1["id"]) == d1, f"sent={sent_date(r1['id'])} wanted={d1}")
    md1 = row_status(r1["id"])["morning_doc_id"]
    if md1:
        mdids.append(md1)
        doc = get(f"documents?morning_doc_id=eq.{md1}&select=document_date")
        check("1. registry document_date = the chosen date (same variable, cannot diverge)",
              doc and doc[0]["document_date"] == d1, str(doc))
    ev = get(f"events?entity_id=eq.{r1['id']}&event_type=eq.document_date_overridden&select=payload")
    check("1. document_date_overridden event with from=today, to=chosen",
          bool(ev) and ev[0]["payload"].get("from") == TODAY_IL and ev[0]["payload"].get("to") == d1,
          json.dumps(ev)[:160])

    # ---- 2. a future date is always refused ---------------------------------
    r2 = mk_row()
    res = approve([r2["id"]], doc_date=(TODAY + timedelta(days=1)).strftime("%Y-%m-%d"))
    check("2. future date → 400", res.status_code == 400, f"{res.status_code}: {res.text[:140]}")
    check("2. ...and the row was not issued", row_status(r2["id"])["status"] == "pending")

    # ---- 3. beyond the 14-day window ----------------------------------------
    res = approve([r2["id"]], doc_date=iso(20), confirm_backdate=True)  # confirm must NOT rescue it
    check("3. 20 days back → 400 even with confirm_backdate", res.status_code == 400,
          f"{res.status_code}: {res.text[:160]}")
    check("3. ...refusal names the earliest allowed date", iso(14) in res.text, res.text[:200])

    # ---- 4+5. month-cross inside the window ---------------------------------
    prev_month_last = (TODAY.replace(day=1) - timedelta(days=1))
    days_back = (TODAY.date() - prev_month_last.date()).days
    if days_back <= 14:
        dcross = prev_month_last.strftime("%Y-%m-%d")
        res = approve([r2["id"]], doc_date=dcross)
        body = res.json()
        check("4. month-cross without confirm → 409 needs_backdate_confirmation",
              res.status_code == 409 and body.get("needs_backdate_confirmation") is True,
              f"{res.status_code}: {res.text[:160]}")
        check("4. ...row untouched by the refusal", row_status(r2["id"])["status"] == "pending")

        res = approve([r2["id"]], doc_date=dcross, confirm_backdate=True)
        ok5 = res.status_code == 200 and (res.json().get("results") or [{}])[0].get("ok")
        check("5. month-cross WITH confirm → issued", ok5, f"{res.status_code}: {res.text[:160]}")
        check("5. sent.date = the crossed-month date", sent_date(r2["id"]) == dcross,
              f"sent={sent_date(r2['id'])} wanted={dcross}")
        md2 = row_status(r2["id"])["morning_doc_id"]
        if md2:
            mdids.append(md2)
        ev = get(f"events?entity_id=eq.{r2['id']}&event_type=eq.document_date_overridden&select=payload")
        check("5. event says crossed_month: true",
              bool(ev) and ev[0]["payload"].get("crossed_month") is True, json.dumps(ev)[:160])
    else:
        # the last day of the previous month is outside the window today, so an
        # in-window month-cross does not exist. Loud skip, never a silent pass.
        print(f"  ⚠ SKIP 4+5: prev-month end is {days_back} days back (> 14) — no in-window month-cross exists today")

    # ---- 6. a batch never accepts a manual date -----------------------------
    b1, b2 = mk_row(), mk_row()
    res = approve([b1["id"], b2["id"]], doc_date=iso(1))
    check("6. two ids + doc_date → 400", res.status_code == 400, f"{res.status_code}: {res.text[:140]}")
    check("6. ...neither row issued",
          row_status(b1["id"])["status"] == "pending" and row_status(b2["id"])["status"] == "pending")

    # ---- 7. no doc_date → the default is exactly what it always was ---------
    res = approve([b1["id"]])
    ok7 = res.status_code == 200 and all(x.get("ok") for x in res.json().get("results") or [{}])
    check("7. approve without doc_date still works", ok7, f"{res.status_code}: {res.text[:160]}")
    check("7. sent.date = TODAY (default untouched)", sent_date(b1["id"]) == TODAY_IL,
          f"sent={sent_date(b1['id'])}")
    md3 = row_status(b1["id"])["morning_doc_id"]
    if md3:
        mdids.append(md3)
    ev = get(f"events?entity_id=eq.{b1['id']}&event_type=eq.document_date_overridden&select=id")
    check("7. no override event when no date was chosen", ev == [], json.dumps(ev)[:120])

    # ---- 8. garbage --------------------------------------------------------
    res = approve([b2["id"]], doc_date="31/08/2026")
    check("8. non-ISO format → 400", res.status_code == 400, f"{res.status_code}")
    res = approve([b2["id"]], doc_date="2026-02-30")
    check("8. impossible calendar date → 400", res.status_code == 400, f"{res.status_code}")

finally:
    for md in mdids:
        dele("invoices", f"morning_doc_id=eq.{md}")
        dele("documents", f"morning_doc_id=eq.{md}")
    pds = get(f"pending_documents?client_id=eq.{cli['id']}&select=id")
    for pd in pds:
        dele("events", f"entity_id=eq.{pd['id']}")
    dele("pending_documents", f"client_id=eq.{cli['id']}")
    dele("clients", f"id=eq.{cli['id']}")
    patch("events", f"actor_id=eq.{uid}", {"actor_id": None})
    requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = get("profiles?name=like.ZTESTDOV*&select=id") + get(f"clients?id=eq.{cli['id']}&select=id")

print(f"\n{passed} passed, {fail} failed · cleanup:", "ok" if left == [] else f"LEFT {left}")
# Exit code decided AFTER cleanup, never inside finally (eb0115f).
sys.exit(1 if fail or left else 0)
