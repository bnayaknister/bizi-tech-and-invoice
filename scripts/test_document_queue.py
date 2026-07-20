# -*- coding: utf-8 -*-
"""
Acceptance test for the document approval queue + Morning chain
(migration 0025, owner spec 2026-07-19). Runs entirely in MORNING_DRY_RUN,
so no document is ever created in Morning.

What it proves, end to end, through the REAL endpoints:
  1. schema   — pending_documents, clients.morning_client_id,
                productions.billing_block_reason all exist
  2. gate     — an ineligible production queues NOTHING and gets a readable
                billing_block_reason (the 🟡)
  3. 06:00    — the calendar sync path (fake ICS) queues a work order and
                does NOT issue it
  4. dedupe   — re-running the sync does not queue a second work order
                (the partial unique index in 0025)
  5. approval — bulk-approving a non-tax document issues it in dry-run and
                stamps morning_doc_id / status='issued'
  6. tax      — "create tax invoice" only QUEUES; approving without
                confirmed:true is refused with 412; with it, the document
                issues as 320 and lands in the invoices registry
  7. reject   — a rejection without a reason is refused
  8. perms    — a stages-only user can neither see nor approve the queue

Cleans up every throwaway row + user in finally (events and pending_documents
first — FK/cleanup rule), and verifies the cleanup actually emptied.
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

failures = []
users = []
client_id = None
show_ids = []
production_ids = []
pending_ids = []
invoice_ids = []
job_ids = []

MARK = "ZTESTDOC"


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        failures.append(label)


def rest(p):
    return f"{SUPABASE_URL}/rest/v1/{p}"


def b64(r):
    return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags, name="doc queue test"):
    em = f"doc-{uuid.uuid4().hex[:8]}@bizi-test.local"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{SUPABASE_URL}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**ADMIN, **REPR},
                   json={"name": name, "approved": True, **flags}).raise_for_status()
    td = requests.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {CN: "base64-" + b64(json.dumps(sess).encode())}


def israel_today():
    # the sync's window is "today in Israel"; +3 in summer, close enough for
    # a same-day fixture either side of midnight UTC
    return (datetime.now(timezone.utc) + timedelta(hours=3)).strftime("%Y-%m-%d")


def make_ics(uid, summary, start_utc, location="ZTEST STUDIO"):
    stamp = start_utc.strftime("%Y%m%dT%H%M%SZ")
    end = (start_utc + timedelta(hours=1)).strftime("%Y%m%dT%H%M%SZ")
    return (
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//ztest//EN\r\n"
        "BEGIN:VEVENT\r\n"
        f"UID:{uid}\r\nDTSTAMP:{stamp}\r\nDTSTART:{stamp}\r\nDTEND:{end}\r\n"
        f"SUMMARY:{summary}\r\nLOCATION:{location}\r\n"
        "END:VEVENT\r\nEND:VCALENDAR\r\n"
    )


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
    # ---------- 1. schema ----------
    r = requests.get(rest("pending_documents?select=id&limit=1"), headers=ADMIN)
    check("1a. pending_documents exists", r.status_code == 200, r.text[:120])
    r = requests.get(rest("clients?select=morning_client_id&limit=1"), headers=ADMIN)
    check("1b. clients.morning_client_id exists", r.status_code == 200, r.text[:120])
    r = requests.get(rest("productions?select=billing_block_reason&limit=1"), headers=ADMIN)
    check("1c. productions.billing_block_reason exists", r.status_code == 200, r.text[:120])

    money = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True,
                    "can_view_stages": True, "can_edit_stages": True}, "ZTESTDOC bookkeeper")
    tech = mkuser({"role": "tech", "can_view_stages": True, "can_edit_stages": True}, "ZTESTDOC tech")

    # ---------- fixtures ----------
    client_id = requests.post(rest("clients"), headers={**ADMIN, **REPR},
                              json={"name": f"{MARK} client",
                                    "normalized_name": f"ztestdoc{uuid.uuid4().hex[:6]}",
                                    "morning_client_id": f"ztest-morning-{uuid.uuid4().hex[:8]}"}).json()[0]["id"]

    alias_ok = f"{MARK} SHOW OK"
    show_ok = requests.post(rest("shows"), headers={**ADMIN, **REPR},
                            json={"name": alias_ok, "aliases": [alias_ok], "client_id": client_id,
                                  "billing_mode": "per_episode", "default_rate": 1500,
                                  "active": True}).json()[0]["id"]
    show_ids.append(show_ok)

    alias_bad = f"{MARK} SHOW INTERNAL"
    show_bad = requests.post(rest("shows"), headers={**ADMIN, **REPR},
                             json={"name": alias_bad, "aliases": [alias_bad], "client_id": None,
                                   "billing_mode": "none", "default_rate": None,
                                   "active": True}).json()[0]["id"]
    show_ids.append(show_bad)

    today = israel_today()
    start = datetime.now(timezone.utc).replace(microsecond=0)

    # ---------- 3. the 06:00 path: fake ICS -> work order QUEUED ----------
    uid_ok = f"ztest-{uuid.uuid4().hex[:10]}"
    ics = make_ics(uid_ok, alias_ok, start)
    r = requests.post(f"{APP_URL}/api/calendar/sync", cookies=money,
                      headers={"Content-Type": "application/json"}, json={"icsText": ics})
    body = r.json()
    check("3a. sync created the production", body.get("created") == 1, r.text[:200])
    check("3b. sync queued one work order", body.get("queuedWorkOrders") == 1, r.text[:200])

    prod = requests.get(rest(f"productions?calendar_uid=eq.{uid_ok}&select=id,kind,billing_block_reason"),
                        headers=ADMIN).json()
    check("3c. production exists and is kind=client", len(prod) == 1 and prod[0]["kind"] == "client",
          json.dumps(prod)[:200])
    if prod:
        production_ids.append(prod[0]["id"])
        check("3d. no block reason on an eligible production", prod[0]["billing_block_reason"] is None,
              str(prod[0]["billing_block_reason"]))

    pend = requests.get(rest(f"pending_documents?production_id=eq.{production_ids[0]}&select=*"), headers=ADMIN).json()
    check("3e. exactly one pending work order", len(pend) == 1 and pend[0]["doc_type"] == "work_order",
          json.dumps(pend)[:200])
    if pend:
        pending_ids.append(pend[0]["id"])
        check("3f. it is PENDING, not issued", pend[0]["status"] == "pending", pend[0]["status"])
        check("3g. nothing was sent to Morning", pend[0]["morning_doc_id"] is None, str(pend[0]["morning_doc_id"]))
        check("3h. amount came from the show rate", float(pend[0]["amount"]) == 1500.0, str(pend[0]["amount"]))
        check("3i. payload type is 100 (הזמנה)", pend[0]["payload"].get("type") == 100,
              str(pend[0]["payload"].get("type")))
        check("3j. payload client.add is false", pend[0]["payload"]["client"].get("add") is False,
              json.dumps(pend[0]["payload"].get("client"))[:120])

    # ---------- 4. dedupe: re-run the same sync ----------
    r2 = requests.post(f"{APP_URL}/api/calendar/sync", cookies=money,
                       headers={"Content-Type": "application/json"}, json={"icsText": ics})
    pend2 = requests.get(rest(f"pending_documents?production_id=eq.{production_ids[0]}&select=id"), headers=ADMIN).json()
    check("4. re-running the sync did not double-queue", len(pend2) == 1, json.dumps(r2.json())[:200])

    # ---------- 2. the gate: ineligible production queues nothing ----------
    uid_bad = f"ztest-{uuid.uuid4().hex[:10]}"
    ics_bad = make_ics(uid_bad, alias_bad, start)
    r = requests.post(f"{APP_URL}/api/calendar/sync", cookies=money,
                      headers={"Content-Type": "application/json"}, json={"icsText": ics_bad})
    bad_body = r.json()
    prod_bad = requests.get(rest(f"productions?calendar_uid=eq.{uid_bad}&select=id,billing_block_reason"),
                            headers=ADMIN).json()
    if prod_bad:
        production_ids.append(prod_bad[0]["id"])
        pb = requests.get(rest(f"pending_documents?production_id=eq.{prod_bad[0]['id']}&select=id"),
                          headers=ADMIN).json()
        check("2a. internal show queued NOTHING", len(pb) == 0, json.dumps(pb)[:120])
        # internal is "not applicable", not a problem — it must NOT carry a
        # billing_block_reason (that flag is only for client productions that
        # should bill but can't; see the radar wiring)
        check("2b. internal show carries NO block reason (not a problem)",
              prod_bad[0]["billing_block_reason"] is None, str(prod_bad[0]["billing_block_reason"]))
        check("2c. sync counted it as blocked", bad_body.get("blockedWorkOrders") == 1, json.dumps(bad_body)[:200])

    # ---------- 8. permissions ----------
    r = requests.get(f"{APP_URL}/api/documents/pending", cookies=tech)
    check("8a. stages-only user cannot read the queue", r.status_code == 403, str(r.status_code))
    r = requests.post(f"{APP_URL}/api/documents/pending/review", cookies=tech,
                      headers={"Content-Type": "application/json"},
                      json={"ids": [pending_ids[0]], "action": "approve"})
    check("8b. stages-only user cannot approve", r.status_code == 403, str(r.status_code))

    # ---------- 7. reject needs a reason ----------
    r = requests.post(f"{APP_URL}/api/documents/pending/review", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"ids": [pending_ids[0]], "action": "reject", "reason": "   "})
    check("7. rejection without a reason is refused", r.status_code == 400, str(r.status_code))

    # ---------- 5. approve the work order (dry-run issuance) ----------
    r = requests.post(f"{APP_URL}/api/documents/pending/review", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"ids": [pending_ids[0]], "action": "approve"})
    ab = r.json()
    check("5a. approval succeeded", r.status_code == 200 and ab.get("ok") is True, r.text[:250])
    check("5b. it ran in DRY_RUN", ab.get("dry_run") is True, json.dumps(ab)[:200])
    row = requests.get(rest(f"pending_documents?id=eq.{pending_ids[0]}&select=*"), headers=ADMIN).json()[0]
    check("5c. status is issued", row["status"] == "issued", row["status"])
    check("5d. morning_doc_id stamped and marked dry", bool(row["morning_doc_id"]) and
          row["morning_doc_id"].startswith("dry-"), str(row["morning_doc_id"]))
    check("5e. approver recorded", row["approved_by"] is not None, str(row["approved_by"]))

    # a work order is NOT an invoice — it must not appear in the registry
    inv = requests.get(rest(f"invoices?morning_doc_id=eq.{row['morning_doc_id']}&select=id"), headers=ADMIN).json()
    check("5f. work order did not create an invoices row", len(inv) == 0, json.dumps(inv)[:120])

    # ---------- 6. tax document: queue, then double confirmation ----------
    r = requests.post(f"{APP_URL}/api/documents/tax-invoice", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"production_id": production_ids[0], "amount": 1500})
    tb = r.json()
    check("6a. 'create tax invoice' only QUEUED", r.status_code == 200 and tb.get("pending_document_id"),
          r.text[:200])
    tax_id = tb.get("pending_document_id")
    if tax_id:
        pending_ids.append(tax_id)
        trow = requests.get(rest(f"pending_documents?id=eq.{tax_id}&select=*"), headers=ADMIN).json()[0]
        check("6b. queued as tax_receipt, still pending", trow["doc_type"] == "tax_receipt" and
              trow["status"] == "pending", f"{trow['doc_type']}/{trow['status']}")
        check("6c. nothing issued yet", trow["morning_doc_id"] is None, str(trow["morning_doc_id"]))

        # one click is not enough
        r = requests.post(f"{APP_URL}/api/documents/pending/review", cookies=money,
                          headers={"Content-Type": "application/json"},
                          json={"ids": [tax_id], "action": "approve"})
        check("6d. approving a tax doc without confirmation -> 412", r.status_code == 412, str(r.status_code))
        check("6e. and it is still not issued",
              requests.get(rest(f"pending_documents?id=eq.{tax_id}&select=status"),
                           headers=ADMIN).json()[0]["status"] == "pending")

        # a repeated id is one document, not two — it must not be treated
        # as a bulk request, and must still demand its own confirmation
        r = requests.post(f"{APP_URL}/api/documents/pending/review", cookies=money,
                          headers={"Content-Type": "application/json"},
                          json={"ids": [tax_id, tax_id], "action": "approve"})
        check("6f1. a duplicated id still demands confirmation", r.status_code == 412, str(r.status_code))

        # a genuine bulk attempt over TWO distinct tax documents is refused.
        # second production, so there is a real second tax document.
        uid_ok2 = f"ztest-{uuid.uuid4().hex[:10]}"
        requests.post(f"{APP_URL}/api/calendar/sync", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"icsText": make_ics(uid_ok2, alias_ok, start)})
        p2 = requests.get(rest(f"productions?calendar_uid=eq.{uid_ok2}&select=id"), headers=ADMIN).json()
        if p2:
            production_ids.append(p2[0]["id"])
            r = requests.post(f"{APP_URL}/api/documents/tax-invoice", cookies=money,
                              headers={"Content-Type": "application/json"},
                              json={"production_id": p2[0]["id"], "amount": 1500})
            tax_id2 = r.json().get("pending_document_id")
            if tax_id2:
                pending_ids.append(tax_id2)
                r = requests.post(f"{APP_URL}/api/documents/pending/review", cookies=money,
                                  headers={"Content-Type": "application/json"},
                                  json={"ids": [tax_id, tax_id2], "action": "approve", "confirmed": True})
                check("6f2. bulk approval of two tax documents is refused", r.status_code == 400,
                      f"{r.status_code} {r.text[:120]}")
                still = requests.get(rest(f"pending_documents?id=in.({tax_id},{tax_id2})&select=status"),
                                     headers=ADMIN).json()
                check("6f3. neither was issued by the refused bulk",
                      all(s["status"] == "pending" for s in still), json.dumps(still)[:150])

        # with the confirmation -> issued
        r = requests.post(f"{APP_URL}/api/documents/pending/review", cookies=money,
                          headers={"Content-Type": "application/json"},
                          json={"ids": [tax_id], "action": "approve", "confirmed": True,
                                "tax_variant": "tax_receipt"})
        check("6g. confirmed approval issued it", r.status_code == 200 and r.json().get("ok") is True, r.text[:250])
        trow = requests.get(rest(f"pending_documents?id=eq.{tax_id}&select=*"), headers=ADMIN).json()[0]
        check("6h. status issued + doc id", trow["status"] == "issued" and bool(trow["morning_doc_id"]),
              json.dumps(trow)[:150])
        check("6i. payload type is 320", trow["payload"].get("type") == 320, str(trow["payload"].get("type")))

        inv = requests.get(rest(f"invoices?morning_doc_id=eq.{trow['morning_doc_id']}&select=id,type,source"),
                           headers=ADMIN).json()
        check("6j. tax document landed in the invoices registry", len(inv) == 1 and inv[0]["source"] == "morning_api",
              json.dumps(inv)[:150])
        for i in inv:
            invoice_ids.append(i["id"])

        # a second tax document for the same production is blocked
        r = requests.post(f"{APP_URL}/api/documents/tax-invoice", cookies=money,
                          headers={"Content-Type": "application/json"},
                          json={"production_id": production_ids[0], "amount": 1500})
        check("6k. a duplicate tax document is refused", r.status_code == 409, str(r.status_code))

finally:
    print("\n--- cleanup ---")
    # order matters: children before parents, events last-referenced first
    for pid in production_ids:
        requests.delete(rest(f"pending_documents?production_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"events?entity_id=eq.{pid}"), headers=ADMIN)
    for pd in pending_ids:
        requests.delete(rest(f"events?entity_id=eq.{pd}"), headers=ADMIN)
        requests.delete(rest(f"pending_documents?id=eq.{pd}"), headers=ADMIN)
    for iid in invoice_ids:
        requests.delete(rest(f"invoices?id=eq.{iid}"), headers=ADMIN)
    if client_id:
        requests.delete(rest(f"invoices?client_id=eq.{client_id}"), headers=ADMIN)
        jobs = requests.get(rest(f"jobs?client_id=eq.{client_id}&select=id"), headers=ADMIN).json()
        for j in jobs if isinstance(jobs, list) else []:
            requests.delete(rest(f"job_productions?job_id=eq.{j['id']}"), headers=ADMIN)
            requests.delete(rest(f"events?entity_id=eq.{j['id']}"), headers=ADMIN)
            requests.delete(rest(f"jobs?id=eq.{j['id']}"), headers=ADMIN)
    for pid in production_ids:
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
        requests.delete(rest(f"approval_requests?requested_by=eq.{uid}"), headers=ADMIN)
        requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{uid}", headers=ADMIN)

    # verify the cleanup actually emptied — a test that leaks is a bug
    leftover_p = requests.get(rest(f"productions?podcast_name=like.*{MARK}*&select=id"), headers=ADMIN).json()
    leftover_s = requests.get(rest(f"shows?name=like.*{MARK}*&select=id"), headers=ADMIN).json()
    leftover_c = requests.get(rest(f"clients?name=like.*{MARK}*&select=id"), headers=ADMIN).json()
    leftover_d = requests.get(rest("pending_documents?select=id"), headers=ADMIN).json()
    check("cleanup: no test productions left", leftover_p == [], json.dumps(leftover_p)[:120])
    check("cleanup: no test shows left", leftover_s == [], json.dumps(leftover_s)[:120])
    check("cleanup: no test clients left", leftover_c == [], json.dumps(leftover_c)[:120])
    check("cleanup: pending_documents is empty", leftover_d == [], json.dumps(leftover_d)[:120])

    print()
    if failures:
        print(f"{len(failures)} FAILED: " + " · ".join(failures))
        sys.exit(1)
    print("all checks passed")
