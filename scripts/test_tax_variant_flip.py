# -*- coding: utf-8 -*-
"""
The 305 -> 320 variant flip, over HTTP, on BOTH parent kinds (pull + pending).

Run:  python3 scripts/test_tax_variant_flip.py     (dev server must be up)

WHY THIS TEST EXISTS (production failure on 40291, fixed in 9c131d4): the flip
in /api/documents/pending/review used to read the parent's type and number from
pending_documents. A parent that came from the daily pull has no queue row, so
every flip on a pull-sourced tax document died with a 409 — silently, and with
advice ("cancel and recreate") that would have failed at the same line. The
only coverage was test_document_queue.py 6g, whose parent IS a queue row: the
half that worked covered for the half that didn't.

VALIDITY CRITERION: this test FAILS on the code before 9c131d4. Scenario P's
flip approval would return 409 there (the old lookup finds no queue row for a
pull parent), failing P4/P5/P6/P7. A test that passes on the broken code tests
nothing. Scenario Q passes on both versions — it is here so the two parent
kinds are asserted side by side, never again one covering for the other.

THE INVARIANT ENFORCED (owner, 2026-08-12): every parent reaches a `documents`
row carrying `type` and `morning_doc_number` — NOT "every parent reaches a
queue row". Checked three ways:
  • a live read-only scan of every issued queue row against `documents`
  • scenario P: the parent exists ONLY in documents (no queue row) — flip works
  • scenario Q: an app-issued parent sits in BOTH tables (as issue.ts
    write-through guarantees) — flip still works, unchanged

⚠️ MORNING SAFETY. Morning is live in this environment (MORNING_DRY_RUN=false
in production). This script may only run against a server in dry-run, and it
PROVES that before any approval: it approves a seeded row whose status is
'rejected' — the review loop refuses it BEFORE any Morning call, but the
route's final response still carries dry_run/env. If dry_run is not exactly
true, the script REFUSES to run. Belt: every approve response is re-checked
for dry_run=true and every issued child must carry a "dry-" morning_doc_id.

The flip is verified by RESULT, never by absence of error (it sits behind the
412 confirmation gate; a request that never reaches it would "pass" silently):
  1. the 412 fires first without confirmed:true — proves the gate is upstream
  2. row state after approve: doc_type, payload.type=320, remarks rebuilt in
     Morning's words, description relabeled
  3. a tax_variant_switched event exists (from=tax_invoice, to=tax_receipt),
     and no tax_variant_switch_refused event does

Row accounting is INDEPENDENT of the script's own bookkeeping: total row
counts of every touched table are taken before anything is seeded and must be
identical after cleanup. Every seeded/created row is deleted in finally and
each deletion is verified. NOTE: the count check compares whole tables, so a
concurrent writer (the 05:00 pull cron, the 06:00 calendar sync) can fail it
falsely — run this test away from those windows.
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
CN = f"sb-{ref}-auth-token"

MARK = "ZTESTFLIP"
NET, VAT, GROSS = 1000.0, 180.0, 1180.0  # one line, 18% — gross is what the payment must match

# remark wording is asserted byte-for-byte against Morning's own vocabulary;
# a flip that "succeeded" into the wrong words is the original bug in new form
REMARK_305 = "חשבונית מס עבור חשבון עסקה"
REMARK_320 = "חשבונית מס / קבלה עבור חשבון עסקה"
LABEL_320 = "חשבונית מס / קבלה — "

failures = []
users = []
client_id = None
job_ids = []
seeded_doc_ids = []        # documents rows this script inserted
child_ids = []             # pending tax children the tax route created
child_morning_ids = []     # their dry- morning ids after issuance (write-through rows)
parent_pending_id = None   # scenario Q's seeded queue row
probe_id = None            # the dry-run probe row

# profiles is counted too: it is created by TRIGGER (trg_handle_new_user, on
# auth.users insert), not by this script — exactly the kind of row an
# insert-ledger would miss. auth.users itself is not REST-countable; its
# deletion is asserted by the admin API response instead.
COUNTED_TABLES = ["documents", "pending_documents", "invoices", "jobs", "clients", "events", "profiles"]


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        failures.append(label)


def rest(p):
    return f"{SUPABASE_URL}/rest/v1/{p}"


def count(table):
    """Independent row count — the server's exact count, not this script's ledger."""
    r = requests.get(rest(f"{table}?select=id"),
                     headers={**ADMIN, "Prefer": "count=exact", "Range": "0-0"})
    return int(r.headers["Content-Range"].split("/")[1])


def mkuser(flags, name):
    em = f"flip-{uuid.uuid4().hex[:8]}@bizi-test.local"
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
    return {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}


def israel_today():
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) + timedelta(hours=3)).strftime("%Y-%m-%d")


def pulled_raw(morning_doc_id, number, morning_client_id):
    """A full pull-shaped raw: ref INCLUDING 320, income proving net arithmetically."""
    return {
        "id": morning_doc_id,
        "number": number,
        "type": 300,
        "status": 0,
        "ref": [200, 305, 320, 400],
        "client": {"id": morning_client_id, "name": f"{MARK} client"},
        "income": [{
            "description": f"{MARK} test line",
            "quantity": 1,
            "price": NET,           # net per unit — what the mapper must pick
            "vat": VAT,
            "vatRate": 0.18,
            "vatType": 0,
            "currency": "ILS",
            "amount": NET,
            "amountTotal": GROSS,   # price*qty + vat — layer-1 proof
            "currencyRate": 1,
            "itemId": "",
            "catalogNum": "",
        }],
        "amount": GROSS,
        "amountExcludeVat": NET,    # layer-2 proof: Morning's own net
        "vat": VAT,
        "vatType": 0,
        "currency": "ILS",
    }


def insert(table, row):
    r = requests.post(rest(table), headers={**ADMIN, **REPR}, json=row)
    r.raise_for_status()
    return r.json()[0]["id"]


def approve_flip(cookies, child_id):
    """The call under test: confirmed approve with the 320 flip + payment=gross."""
    return requests.post(f"{APP_URL}/api/documents/pending/review", cookies=cookies,
                         headers={"Content-Type": "application/json"},
                         json={"ids": [child_id], "action": "approve", "confirmed": True,
                               "tax_variant": "tax_receipt", "recipients": [],
                               "payment": [{"type": 4, "amount": GROSS, "price": GROSS,
                                            "date": israel_today()}]})


def verify_flip(tag, child_id, parent_number):
    """The flip is proven by RESULT: row state + the switched event, both required."""
    row = requests.get(rest(f"pending_documents?id=eq.{child_id}&select=*"), headers=ADMIN).json()[0]
    check(f"{tag}. doc_type flipped to tax_receipt", row["doc_type"] == "tax_receipt", row["doc_type"])
    check(f"{tag}. payload.type is 320", row["payload"].get("type") == 320, str(row["payload"].get("type")))
    check(f"{tag}. remarks rebuilt in Morning's words",
          row["payload"].get("remarks") == f"{REMARK_320} {parent_number}",
          str(row["payload"].get("remarks")))
    check(f"{tag}. description relabeled to the 320 label",
          str(row["payload"].get("description") or "").startswith(LABEL_320),
          str(row["payload"].get("description")))
    check(f"{tag}. issued in DRY-RUN (morning id is synthetic)",
          row["status"] == "issued" and str(row["morning_doc_id"] or "").startswith("dry-"),
          f"{row['status']}/{row['morning_doc_id']}")
    ev = requests.get(rest(f"events?entity_id=eq.{child_id}&event_type=eq.tax_variant_switched&select=payload"),
                      headers=ADMIN).json()
    check(f"{tag}. tax_variant_switched event proves the flip RAN",
          len(ev) == 1 and ev[0]["payload"].get("from") == "tax_invoice"
          and ev[0]["payload"].get("to") == "tax_receipt", json.dumps(ev)[:200])
    refused = requests.get(rest(f"events?entity_id=eq.{child_id}&event_type=eq.tax_variant_switch_refused&select=id"),
                           headers=ADMIN).json()
    check(f"{tag}. and no refusal event exists", refused == [], json.dumps(refused)[:120])
    return row


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

# ---------- independent baseline, before ANY seeding ----------
baseline = {t: count(t) for t in COUNTED_TABLES}
print("baseline counts:", json.dumps(baseline))

try:
    money = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True,
                    "can_view_stages": True, "can_edit_stages": True}, f"{MARK} bookkeeper")

    # ---------- 0. THE DRY-RUN GATE — refuse to run unless proven ----------
    # A rejected row is refused by the approve loop BEFORE any Morning call,
    # but the route's final response still reports dry_run/env. This is the
    # only zero-risk way to read the RUNNING server's brake (reject responses
    # don't carry it; .env.local on disk is not what the server may be running).
    probe_id = insert("pending_documents", {
        "doc_type": "work_order", "status": "rejected", "amount": 1,
        # pending_doc_reject_has_reason: a rejected row must carry its reason
        "reject_reason": f"{MARK} dry-run probe",
        "payload": {"type": 100, "lang": "he", "currency": "ILS", "vatType": 0,
                    "description": f"{MARK} dry-run probe",
                    "client": {"id": "probe", "add": False},
                    "income": [{"description": "probe", "quantity": 1, "price": 1,
                                "currency": "ILS", "vatType": 0}]},
    })
    r = requests.post(f"{APP_URL}/api/documents/pending/review", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"ids": [probe_id], "action": "approve"})
    probe = r.json() if r.status_code == 200 else {}
    if probe.get("dry_run") is not True:
        check("0. server is provably in MORNING_DRY_RUN", False,
              f"status={r.status_code} dry_run={probe.get('dry_run')} env={probe.get('env')}")
        print("REFUSING TO RUN: dry-run could not be verified — Morning is (or may be) live.")
        sys.exit(1)
    check("0. server is provably in MORNING_DRY_RUN", True)
    check("0b. the probe itself was refused (status was rejected)",
          probe.get("ok") is False, json.dumps(probe)[:200])

    # ---------- 1. the live invariant, read-only ----------
    # every issued queue row with a real Morning id reaches a documents row
    # carrying type and morning_doc_number — what the flip now depends on
    issued = requests.get(rest("pending_documents?status=eq.issued&select=morning_doc_id,morning_doc_number"),
                          headers=ADMIN).json()
    mids = [p["morning_doc_id"] for p in issued
            if p.get("morning_doc_id") and not p["morning_doc_id"].startswith("dry-")]
    holes = []
    if mids:
        q = ",".join(f'"{m}"' for m in mids)
        docs = requests.get(rest(f"documents?morning_doc_id=in.({q})&select=morning_doc_id,type,morning_doc_number"),
                            headers=ADMIN).json()
        by_id = {d["morning_doc_id"]: d for d in docs}
        holes = [m for m in mids
                 if m not in by_id or by_id[m].get("type") is None
                 or not str(by_id[m].get("morning_doc_number") or "").strip()]
    check("1. invariant: every issued parent reaches documents with type+number",
          holes == [], json.dumps(holes)[:200])

    # ---------- shared fixtures ----------
    morning_client_id = f"ztest-morning-{uuid.uuid4().hex[:8]}"
    client_id = insert("clients", {"name": f"{MARK} client",
                                   "normalized_name": f"ztestflip{uuid.uuid4().hex[:6]}",
                                   "morning_client_id": morning_client_id})

    # ================= scenario P: PULL parent (no queue row) =================
    # This is the scenario that FAILS on the pre-9c131d4 code: the flip's old
    # lookup searched pending_documents for this parent and found nothing.
    print("\n--- P: pull parent — exists ONLY in documents ---")
    job_p = insert("jobs", {"client_id": client_id, "campaign": f"{MARK} P", "amount": NET,
                            "date": israel_today()})
    job_ids.append(job_p)
    p_mid = str(uuid.uuid4())
    p_num = f"99{uuid.uuid4().int % 10000:04d}"
    doc_p = insert("documents", {
        "morning_doc_id": p_mid, "morning_doc_number": p_num, "type": 300, "status": 0,
        "source": "pull", "client_id": client_id, "job_id": job_p,
        "amount": GROSS,  # gross — exactly what the pull stores
        "document_date": israel_today(), "raw": pulled_raw(p_mid, p_num, morning_client_id),
    })
    seeded_doc_ids.append(doc_p)
    none_in_queue = requests.get(rest(f"pending_documents?morning_doc_id=eq.{p_mid}&select=id"),
                                 headers=ADMIN).json()
    check("P1. the parent has NO queue row (the failing precondition)", none_in_queue == [])

    r = requests.post(f"{APP_URL}/api/documents/tax", cookies=money,
                      headers={"Content-Type": "application/json"}, json={"documentIds": [doc_p]})
    tb = r.json() if r.status_code == 200 else {}
    check("P2. tax route built a child from the pulled parent",
          r.status_code == 200 and bool(tb.get("tax_document", {}).get("id")), r.text[:250])
    child_p = tb.get("tax_document", {}).get("id")
    if child_p:
        child_ids.append(child_p)
        row = requests.get(rest(f"pending_documents?id=eq.{child_p}&select=*"), headers=ADMIN).json()[0]
        check("P3. child queued as 305 with the 305 remark",
              row["doc_type"] == "tax_invoice" and row["payload"].get("remarks") == f"{REMARK_305} {p_num}",
              json.dumps({"doc_type": row["doc_type"], "remarks": row["payload"].get("remarks")}, ensure_ascii=False)[:200])
        check("P3b. child amount is the NET, not documents.amount",
              float(row["amount"]) == NET, str(row["amount"]))

        # the 412 gate is upstream of the flip — prove we are behind it, so a
        # confirmed:true that failed to arrive can never fake a green run
        r = requests.post(f"{APP_URL}/api/documents/pending/review", cookies=money,
                          headers={"Content-Type": "application/json"},
                          json={"ids": [child_p], "action": "approve", "tax_variant": "tax_receipt"})
        check("P4. without confirmed -> 412 (the gate the flip hides behind)",
              r.status_code == 412, str(r.status_code))

        r = approve_flip(money, child_p)
        body = r.json() if r.status_code == 200 else {}
        check("P5. confirmed flip approval returned 200/ok — 409 HERE = the old bug",
              r.status_code == 200 and body.get("ok") is True, f"{r.status_code} {r.text[:250]}")
        check("P6. response re-confirms dry_run", body.get("dry_run") is True, json.dumps(body)[:150])
        issued_row = verify_flip("P7", child_p, p_num)
        child_morning_ids.append(issued_row["morning_doc_id"])
        job = requests.get(rest(f"jobs?id=eq.{job_p}&select=invoice_tax"), headers=ADMIN).json()[0]
        check("P8. the job was stamped with the issued 320", bool(job["invoice_tax"]), str(job))

    # ================= scenario Q: PENDING parent (both tables) ===============
    # The proven path — must keep working IDENTICALLY. The parent sits in both
    # tables under one morning_doc_id, exactly as issue.ts write-through leaves
    # an app-issued document (the invariant's second half).
    print("\n--- Q: pending parent — in BOTH tables, as issue.ts guarantees ---")
    job_q = insert("jobs", {"client_id": client_id, "campaign": f"{MARK} Q", "amount": NET,
                            "date": israel_today()})
    job_ids.append(job_q)
    q_mid = str(uuid.uuid4())
    q_num = f"98{uuid.uuid4().int % 10000:04d}"
    parent_pending_id = insert("pending_documents", {
        "doc_type": "deal_invoice", "status": "issued", "client_id": client_id,
        "amount": NET, "morning_doc_id": q_mid, "morning_doc_number": q_num, "job_id": job_q,
        "payload": {"type": 300, "lang": "he", "currency": "ILS", "vatType": 0,
                    "description": f"{MARK} Q parent",
                    "client": {"id": morning_client_id, "name": f"{MARK} client", "add": False},
                    "income": [{"description": f"{MARK} test line", "quantity": 1, "price": NET,
                                "currency": "ILS", "vatType": 0}]},
    })
    doc_q = insert("documents", {
        "morning_doc_id": q_mid, "morning_doc_number": q_num, "type": 300, "status": 0,
        "source": "app", "client_id": client_id, "job_id": job_q,
        "amount": GROSS, "document_date": israel_today(),
        "raw": pulled_raw(q_mid, q_num, morning_client_id),
    })
    seeded_doc_ids.append(doc_q)

    r = requests.post(f"{APP_URL}/api/documents/tax", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"sourceIds": [parent_pending_id]})
    tb = r.json() if r.status_code == 200 else {}
    check("Q2. tax route built a child from the pending parent",
          r.status_code == 200 and bool(tb.get("tax_document", {}).get("id")), r.text[:250])
    child_q = tb.get("tax_document", {}).get("id")
    if child_q:
        child_ids.append(child_q)
        r = approve_flip(money, child_q)
        body = r.json() if r.status_code == 200 else {}
        check("Q5. confirmed flip approval returned 200/ok (must not regress)",
              r.status_code == 200 and body.get("ok") is True, f"{r.status_code} {r.text[:250]}")
        check("Q6. response re-confirms dry_run", body.get("dry_run") is True, json.dumps(body)[:150])
        issued_row = verify_flip("Q7", child_q, q_num)
        child_morning_ids.append(issued_row["morning_doc_id"])

finally:
    print("\n--- cleanup (every deletion verified) ---")

    def purge(label, table, filt):
        requests.delete(rest(f"{table}?{filt}"), headers=ADMIN)
        left = requests.get(rest(f"{table}?{filt}&select=id"), headers=ADMIN).json()
        check(f"cleanup: {label}", left == [], json.dumps(left)[:150])

    # children first (FK + the cleanup iron rule: events before their entities)
    for cid in child_ids + ([probe_id] if probe_id else []):
        purge(f"events of pending {cid[:8]}", "events", f"entity_id=eq.{cid}")
        purge(f"pending row {cid[:8]}", "pending_documents", f"id=eq.{cid}")
    # the dry- write-through rows the issuance created in documents + invoices
    for mid in child_morning_ids:
        purge(f"write-through doc {mid[:12]}", "documents", f"morning_doc_id=eq.{mid}")
        purge(f"invoices row {mid[:12]}", "invoices", f"morning_doc_id=eq.{mid}")
    if parent_pending_id:
        purge("events of Q parent", "events", f"entity_id=eq.{parent_pending_id}")
        purge("Q parent pending row", "pending_documents", f"id=eq.{parent_pending_id}")
    for did in seeded_doc_ids:
        purge(f"seeded documents row {did[:8]}", "documents", f"id=eq.{did}")
    if client_id:
        purge("stray invoices of the client", "invoices", f"client_id=eq.{client_id}")
    for jid in job_ids:
        purge(f"events of job {jid[:8]}", "events", f"entity_id=eq.{jid}")
        purge(f"job {jid[:8]}", "jobs", f"id=eq.{jid}")
    if client_id:
        purge("events of the client", "events", f"entity_id=eq.{client_id}")
        purge("the client", "clients", f"id=eq.{client_id}")
    for uid in users:
        purge(f"events by user {uid[:8]}", "events", f"actor_id=eq.{uid}")
        purge(f"approval_requests by user {uid[:8]}", "approval_requests", f"requested_by=eq.{uid}")
        # the profiles row was created by TRIGGER on the auth insert — delete
        # and verify it like everything else, then the auth user itself
        purge(f"profile of user {uid[:8]}", "profiles", f"id=eq.{uid}")
        rd = requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{uid}", headers=ADMIN)
        check(f"cleanup: auth user {uid[:8]} deleted", rd.status_code < 300, f"{rd.status_code} {rd.text[:120]}")

    # ---------- independent counts: after MUST equal before ----------
    after = {t: count(t) for t in COUNTED_TABLES}
    print("final counts:   ", json.dumps(after))
    for t in COUNTED_TABLES:
        check(f"counts: {t} back to baseline ({baseline.get(t)})", after[t] == baseline.get(t),
              f"before={baseline.get(t)} after={after[t]}")

    print()
    if failures:
        print(f"{len(failures)} FAILED: " + " · ".join(failures))
        sys.exit(1)
    print("all checks passed")
