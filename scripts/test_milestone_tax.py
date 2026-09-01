# -*- coding: utf-8 -*-
"""
Stage 2 — a deal invoice or a tax document straight from a contract milestone.

  POST /api/contracts/milestones/[mid]/deal-invoice
  POST /api/contracts/milestones/[mid]/tax

Both are built ON a parent, never on the milestone's own amount — which is why
neither goes through milestones/[mid]/enqueue. The deal invoice in particular
must carry linkedDocumentIds so it CLOSES its work order in Morning (owner
requirement), and buildDocumentPayload behind the enqueue path never emits
them.

TOUCHES MORNING: never. Nothing here approves. Honours rule 40 all the same and
reads TEST_APP_URL — a queued document is one human click from being issued.

═══ WHY THIS FILE SEEDS ITS PARENTS BY HAND ═══
A tax document may only be built on a parent that REALLY exists in Morning.
taxFromParent enforces three things (taxFromParent.ts, "every parent must
really exist in Morning"): status='issued', a morning_doc_id, and — the one
that matters here — a morning_doc_id that does NOT start with "dry-".

A dry-run issuance mints exactly such a "dry-" id. So a work order approved
through the UI on the isolated DRY_RUN server can never father a tax document,
and the natural end-to-end path cannot be driven in the environment rule 40
requires. That is not a bug: it is the guard doing its job.

So the parents here are INSERTED directly as status='issued' with a synthetic
morning_doc_id — a plain uuid, deliberately NOT "dry-" prefixed and deliberately
NOT the id of any real Morning document. Consequences, both intended:
  * the unique index on morning_doc_id is never contended
  * no real document is touched, linked, or closed
  * `documents` holds no row for these ids, so the builder reports
    parentOpennessUnknown=true — documented as a warning, not a failure

  1  deal invoice on a milestone with an issued work order -> 200, LINKS it  ⭐
  2  a second deal invoice                                 -> 409
  3  deal invoice on a job already carrying invoice_biz    -> 409
  4  tax with BOTH parents issued -> links the 300, not the 100   ⭐
  5  tax with only a work order   -> links the 100
  6  tax while the work order is still 'pending'           -> 400
  7  a second tax document                                 -> 409 (idempotency)
  8  tax on a job already carrying invoice_tax             -> 409 (taxedJobs)
  9  permissions: technician 403, anonymous 401; no work order -> 400
 10  cleanup, verified

Every row is deleted in finally AND the deletion verified, FK order first.

═══ WHAT THIS FILE CAN NEVER PROVE ═══
Three things stay unverified no matter how green this run is, because they live
on the far side of a real Morning call. Written down so the next reader does not
mistake a passing suite for a proven chain:

  1. That Morning ACCEPTS linkedDocumentIds and actually closes the parent.
     Everything here asserts the field is on the outgoing payload; whether the
     order flips to closed is observable only after a real issuance and the
     nightly pull that follows it. The whole business reason for the deal
     invoice — "חשבון העסקה סוגר את ההזמנה" — is on that far side.
  2. That `linkType` is not required for 300 -> 320. bundle.ts records 100 ->
     300 as verified live on 2026-08-02; the tax step carries an explicit
     "UNVERIFIED" note (taxFromParent.ts) and is the first thing to try if a
     real call fails.
  3. That nothing differs between a seeded parent and one issued for real. The
     parents below are inserted directly with a synthetic morning_doc_id, so
     the dry-run -> real transition itself is never exercised.

The first live issuance of stage 2 should therefore be a SMALL milestone — icr
spotlight at 8,000 ₪ is the candidate, not either half of מכירת ביפו at 150K/250K.
"""
import base64
import json
import os
import sys
import time
import uuid

import requests

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")
with open(ENV_PATH, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

S = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
# rule 40 (TICKETS.md): never hard-code :3000
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
REPR = {"Prefer": "return=representation"}
REF = S.split("//")[1].split(".")[0]
CN = f"sb-{REF}-auth-token"

fails = []
users = []
contract_ids = []
milestone_ids = []
job_ids = []
pending_ids = []
client_ids = []


def check(label, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + (f"  — {detail}" if detail and not ok else ""))
    if not ok:
        fails.append(label)


def rest(p):
    return f"{S}/rest/v1/{p}"


def ins(table, row):
    r = requests.post(rest(table), headers={**A, **REPR}, json=row)
    if r.status_code >= 300:
        raise RuntimeError(f"{table}: {r.status_code} {r.text[:300]}")
    return r.json()[0]


def make_user(**flags):
    email = f"ztest-{uuid.uuid4().hex[:8]}@example.com"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{S}/auth/v1/admin/users", headers=A,
                        json={"email": email, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers=A, json={"approved": True, **flags})
    tok = requests.post(f"{S}/auth/v1/token?grant_type=password",
                        headers={"apikey": ANON, "Content-Type": "application/json"},
                        json={"email": email, "password": pw}).json()
    val = "base64-" + base64.b64encode(json.dumps(tok).encode()).decode()
    if len(val) <= 3180:
        return {CN: val}
    return {f"{CN}.{i // 3180}": val[i:i + 3180] for i in range(0, len(val), 3180)}


def enqueue(ck, mid):
    return requests.post(f"{APP}/api/contracts/milestones/{mid}/enqueue", cookies=ck, timeout=90)


def deal_invoice(ck, mid):
    return requests.post(f"{APP}/api/contracts/milestones/{mid}/deal-invoice", cookies=ck, timeout=90)


def tax(ck, mid):
    return requests.post(f"{APP}/api/contracts/milestones/{mid}/tax", cookies=ck, timeout=90)


def seed_parent(job_id, client_id, morning_client_id, doc_type, amount, number, status="issued"):
    """A parent as it looks AFTER a real issuance. See the header for why the
    morning_doc_id is synthetic and why it must not start with 'dry-'."""
    mid_ = None if status != "issued" else str(uuid.uuid4())
    payload = {
        "type": 100 if doc_type == "work_order" else 300,
        "lang": "he", "currency": "ILS", "vatType": 0,
        "description": f"ZTEST {doc_type} {number}",
        "client": {"id": morning_client_id, "add": False},
        "income": [{"description": f"ZTEST {doc_type}", "quantity": 1, "price": amount,
                    "currency": "ILS", "vatType": 0}],
    }
    row = ins("pending_documents", {
        "doc_type": doc_type, "status": status, "job_id": job_id, "production_id": None,
        "client_id": client_id, "amount": amount, "payload": payload,
        **({"morning_doc_id": mid_, "morning_doc_number": number} if status == "issued" else {}),
    })
    pending_ids.append(row["id"])
    return row


try:
    for _ in range(45):
        try:
            if requests.get(APP, timeout=2).status_code < 500:
                break
        except Exception:
            pass
        time.sleep(1)
    print(f"APP = {APP}\n")

    money = make_user(can_view_money=True, can_edit_money=True, can_view_stages=True, role="owner")
    tech = make_user(can_view_stages=True, can_edit_stages=True, role="tech")

    tag = uuid.uuid4().hex[:8]
    mcid = str(uuid.uuid4())
    cli = ins("clients", {"name": f"ZTEST לקוח {tag}", "normalized_name": f"ztest-tax-{tag}",
                          "morning_client_id": mcid})
    client_ids.append(cli["id"])
    con = ins("contracts", {"name": f"ZTEST חוזה {tag}", "client_id": cli["id"], "total_amount": 50000})
    contract_ids.append(con["id"])

    def milestone(name, amount):
        m = ins("contract_milestones", {"contract_id": con["id"], "name": name, "amount": amount})
        milestone_ids.append(m["id"])
        return m

    def job(name, amount, **extra):
        j = ins("jobs", {"client_id": cli["id"], "contract_id": con["id"],
                         "campaign": f"ZTEST {name} {tag}", "amount": amount, "paid": "לא",
                         "legacy": False, **extra})
        job_ids.append(j["id"])
        return j

    def link(m, j):
        requests.patch(rest(f"contract_milestones?id=eq.{m['id']}"), headers=A, json={"job_id": j["id"]})

    # ---------- 1: deal invoice on a milestone with an issued work order ----
    # The assertion that matters is 1f: the payload carries linkedDocumentIds
    # pointing at the order. That field is the entire business reason for this
    # route existing rather than reusing enqueue.
    print("1. חשבון עסקה על אבן דרך עם הזמנת עבודה מונפקת")
    m1, j1 = milestone("א", 2000), job("a", 2000)
    link(m1, j1)
    wo1 = seed_parent(j1["id"], cli["id"], mcid, "work_order", 2000, f"ZT-100-{tag}")
    r = deal_invoice(money, m1["id"])
    b = r.json()
    check("1a. 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    check("1b. queued", b.get("status") == "queued", json.dumps(b)[:150])
    check("1c. התשובה נוקבת בהזמנה שנסגרת", b.get("closes_doc_number") == f"ZT-100-{tag}",
          str(b.get("closes_doc_number")))
    if b.get("id"):
        pending_ids.append(b["id"])
        row = requests.get(rest(f"pending_documents?id=eq.{b['id']}&select=*"), headers=A).json()[0]
        check("1d. doc_type=deal_invoice", row["doc_type"] == "deal_invoice", row["doc_type"])
        check("1e. payload type=300", (row["payload"] or {}).get("type") == 300,
              str((row["payload"] or {}).get("type")))
        linked = (row["payload"] or {}).get("linkedDocumentIds") or []
        check("1f. linkedDocumentIds סוגר את ההזמנה  ⭐", linked == [wo1["morning_doc_id"]],
              f"{linked} vs order={wo1['morning_doc_id']}")
        check("1g. remarks נוקב במספר ההזמנה",
              f"ZT-100-{tag}" in ((row["payload"] or {}).get("remarks") or ""),
              str((row["payload"] or {}).get("remarks"))[:120])
        # convert anchors through bundle_job_ids, not job_id — same shape as tax
        check("1h. bundle_job_ids נושא את ה-job", j1["id"] in (row["bundle_job_ids"] or []),
              json.dumps(row["bundle_job_ids"]))
        check("1i. הסכום הוא של ההזמנה", float(row["amount"]) == 2000.0, str(row["amount"]))
        ev = requests.get(rest(f"events?entity_id=eq.{b['id']}&select=payload"), headers=A).json()
        check("1j. ההנפקה מתועדת עם via=contract_milestone_deal_invoice",
              any((e["payload"] or {}).get("via") == "contract_milestone_deal_invoice" for e in ev),
              json.dumps(ev, ensure_ascii=False)[:220])

    # ---------- 2: a second one ---------------------------------------------
    print("\n2. חשבון עסקה שני")
    r = deal_invoice(money, m1["id"])
    check("2a. 409", r.status_code == 409, f"{r.status_code} {r.text[:150]}")
    check("2b. ההודעה על מסמך קיים", "כבר קיים" in (r.json().get("error") or ""),
          (r.json().get("error") or "")[:120])

    # ---------- 3: job already carrying invoice_biz --------------------------
    # Refused by the library's own billable-job gate (bundle.ts), not by
    # anything this route adds.
    print("\n3. חשבון עסקה על job שכבר נושא invoice_biz")
    m3, j3 = milestone("ג", 1500), job("c", 1500, invoice_biz=f"ZT-4{tag[:4]}")
    link(m3, j3)
    seed_parent(j3["id"], cli["id"], mcid, "work_order", 1500, f"ZT-100C-{tag}")
    r = deal_invoice(money, m3["id"])
    check("3a. 409", r.status_code == 409, f"{r.status_code} {r.text[:200]}")
    check("3b. לא נוצרה שורת 300",
          len(requests.get(rest(f"pending_documents?doc_type=eq.deal_invoice&bundle_job_ids=cs.{{{j3['id']}}}&select=id"),
                           headers=A).json()) == 0)

    # ---------- 4: BOTH parents -> the 300 wins  ⭐ --------------------------
    print("\n4. מס כששני האבות מונפקים — ה-300 מנצח")
    m4, j4 = milestone("ד", 3000), job("d", 3000)
    link(m4, j4)
    wo4 = seed_parent(j4["id"], cli["id"], mcid, "work_order", 3000, f"ZT-100D-{tag}")
    di4 = seed_parent(j4["id"], cli["id"], mcid, "deal_invoice", 3000, f"ZT-300D-{tag}")
    r = tax(money, m4["id"])
    b = r.json()
    check("4a. 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("4b. האב הוא ה-300", b.get("parent_doc_number") == f"ZT-300D-{tag}",
          str(b.get("parent_doc_number")))
    if b.get("id"):
        pending_ids.append(b["id"])
        row = requests.get(rest(f"pending_documents?id=eq.{b['id']}&select=*"), headers=A).json()[0]
        linked = (row["payload"] or {}).get("linkedDocumentIds") or []
        check("4c. linkedDocumentIds מצביע ל-300", linked == [di4["morning_doc_id"]],
              f"{linked} vs 300={di4['morning_doc_id']} 100={wo4['morning_doc_id']}")
        check("4d. ולא ל-100", wo4["morning_doc_id"] not in linked, json.dumps(linked))
        check("4e. doc_type=tax_invoice (305 ברירת מחדל)", row["doc_type"] == "tax_invoice",
              row["doc_type"])
        check("4f. bundle_job_ids נושא את ה-job", j4["id"] in (row["bundle_job_ids"] or []),
              json.dumps(row["bundle_job_ids"]))
        ev = requests.get(rest(f"events?entity_id=eq.{b['id']}&select=payload"), headers=A).json()
        check("4g. הבחירה מתועדת",
              any((e["payload"] or {}).get("parent_choice") == "deal_invoice_over_work_order" for e in ev),
              json.dumps(ev, ensure_ascii=False)[:200])

    # ---------- 5: only a work order ----------------------------------------
    print("\n5. מס כשיש רק הזמנת עבודה")
    m5, j5 = milestone("ה", 1200), job("e", 1200)
    link(m5, j5)
    wo5 = seed_parent(j5["id"], cli["id"], mcid, "work_order", 1200, f"ZT-100E-{tag}")
    r = tax(money, m5["id"])
    b = r.json()
    check("5a. 200", r.status_code == 200, f"{r.status_code} {r.text[:250]}")
    check("5b. האב הוא ה-100", b.get("parent_doc_number") == f"ZT-100E-{tag}",
          str(b.get("parent_doc_number")))
    if b.get("id"):
        pending_ids.append(b["id"])
        row = requests.get(rest(f"pending_documents?id=eq.{b['id']}&select=payload"), headers=A).json()[0]
        check("5c. linkedDocumentIds מצביע ל-100",
              ((row["payload"] or {}).get("linkedDocumentIds") or []) == [wo5["morning_doc_id"]],
              json.dumps((row["payload"] or {}).get("linkedDocumentIds")))

    # ---------- 6: parent still pending -------------------------------------
    print("\n6. מס כשההזמנה עדיין pending")
    m6, j6 = milestone("ו", 800), job("f", 800)
    link(m6, j6)
    seed_parent(j6["id"], cli["id"], mcid, "work_order", 800, None, status="pending")
    r = tax(money, m6["id"])
    check("6a. 400", r.status_code == 400, f"{r.status_code} {r.text[:200]}")
    check("6b. ההודעה מסבירה שאין מסמך מקור מונפק",
          "מונפק" in (r.json().get("error") or ""), (r.json().get("error") or "")[:160])
    check("6c. לא נוצרה שורת מס",
          len(requests.get(rest(f"pending_documents?bundle_job_ids=cs.{{{j6['id']}}}&select=id"),
                           headers=A).json()) == 0)

    # ---------- 7: a second tax document ------------------------------------
    print("\n7. מס שני על אותה אבן דרך")
    r = tax(money, m5["id"])
    check("7a. 409", r.status_code == 409, f"{r.status_code} {r.text[:200]}")
    check("7b. ההודעה על מסמך קיים", "כבר קיים" in (r.json().get("error") or ""),
          (r.json().get("error") or "")[:150])

    # ---------- 8: job already carrying invoice_tax -------------------------
    print("\n8. מס על job שכבר נושא invoice_tax")
    m8, j8 = milestone("ח", 900), job("h", 900, invoice_tax=f"ZT-5{tag[:4]}")
    link(m8, j8)
    seed_parent(j8["id"], cli["id"], mcid, "work_order", 900, f"ZT-100H-{tag}")
    r = tax(money, m8["id"])
    check("8a. 409", r.status_code == 409, f"{r.status_code} {r.text[:200]}")
    check("8b. ההודעה נוקבת במספר החשבונית", "ZT-5" in (r.json().get("error") or ""),
          (r.json().get("error") or "")[:180])

    # ---------- 9: permissions + docType allow-list -------------------------
    print("\n9. הרשאות ורשימת היתר")
    m9, j9 = milestone("ט", 700), job("i", 700)
    link(m9, j9)
    seed_parent(j9["id"], cli["id"], mcid, "work_order", 700, f"ZT-100I-{tag}")
    check("9a. טכנאי deal-invoice 403", deal_invoice(tech, m9["id"]).status_code == 403)
    check("9b. טכנאי tax 403", tax(tech, m9["id"]).status_code == 403)
    check("9c. אנונימי deal-invoice 401", deal_invoice({}, m9["id"]).status_code == 401)
    check("9d. אנונימי tax 401", tax({}, m9["id"]).status_code == 401)

    # a milestone with no work order at all: there is nothing to close, and the
    # message has to say that rather than talk about a missing parent id
    m10 = milestone("י", 650)
    r = deal_invoice(money, m10["id"])
    check("9e. אבן דרך בלי job — 400", r.status_code == 400, f"{r.status_code} {r.text[:150]}")
    check("9f. ההודעה נוקבת בשם אבן הדרך", "'י'" in (r.json().get("error") or ""),
          (r.json().get("error") or "")[:150])

    m11, j11 = milestone("יא", 550), job("k", 550)
    link(m11, j11)  # a job, but no work order on it
    r = deal_invoice(money, m11["id"])
    check("9g. job בלי הזמנה מונפקת — 400", r.status_code == 400, f"{r.status_code} {r.text[:150]}")
    check("9h. ההודעה מסבירה שההזמנה היא הבסיס",
          "הזמנה" in (r.json().get("error") or ""), (r.json().get("error") or "")[:180])

    # stage 1's route still answers with no body at all
    m12 = milestone("יב", 450)
    r = enqueue(money, m12["id"])
    check("9i. enqueue בלי body עדיין עובד", r.status_code == 200, f"{r.status_code} {r.text[:150]}")
    if r.status_code == 200:
        b = r.json()
        if b.get("id"):
            pending_ids.append(b["id"])
        if b.get("job_id"):
            job_ids.append(b["job_id"])
        row = requests.get(rest(f"pending_documents?id=eq.{b['id']}&select=doc_type"), headers=A).json()[0]
        check("9j. ...ומייצר work_order", row["doc_type"] == "work_order", row["doc_type"])
finally:
    print("\n=== CLEANUP ===")
    ent = [x for x in pending_ids + milestone_ids + contract_ids + job_ids if x]
    if ent:
        requests.delete(rest(f"events?entity_id=in.({','.join(ent)})"), headers=A)
    for jid in job_ids:
        requests.delete(rest(f"pending_documents?job_id=eq.{jid}"), headers=A)
    if pending_ids:
        requests.delete(rest(f"pending_documents?id=in.({','.join(pending_ids)})"), headers=A)
        left = requests.get(rest(f"pending_documents?id=in.({','.join(pending_ids)})&select=id"), headers=A).json()
        check("cleanup: שורות תור נמחקו", len(left) == 0, json.dumps(left))
    if milestone_ids:
        requests.delete(rest(f"contract_milestones?id=in.({','.join(milestone_ids)})"), headers=A)
        left = requests.get(rest(f"contract_milestones?id=in.({','.join(milestone_ids)})&select=id"), headers=A).json()
        check("cleanup: אבני דרך נמחקו", len(left) == 0, json.dumps(left))
    if job_ids:
        requests.delete(rest(f"jobs?id=in.({','.join(job_ids)})"), headers=A)
        left = requests.get(rest(f"jobs?id=in.({','.join(job_ids)})&select=id"), headers=A).json()
        check("cleanup: jobs נמחקו", len(left) == 0, json.dumps(left))
    if contract_ids:
        requests.delete(rest(f"contracts?id=in.({','.join(contract_ids)})"), headers=A)
        left = requests.get(rest(f"contracts?id=in.({','.join(contract_ids)})&select=id"), headers=A).json()
        check("cleanup: חוזים נמחקו", len(left) == 0, json.dumps(left))
    if client_ids:
        requests.delete(rest(f"clients?id=in.({','.join(client_ids)})"), headers=A)
        left = requests.get(rest(f"clients?id=in.({','.join(client_ids)})&select=id"), headers=A).json()
        check("cleanup: לקוחות נמחקו", len(left) == 0, json.dumps(left))
    for uid in users:
        requests.delete(f"{S}/auth/v1/admin/users/{uid}", headers=A)
        gone = requests.get(f"{S}/auth/v1/admin/users/{uid}", headers=A).status_code
        check(f"cleanup: משתמש {uid[:8]} נמחק", gone in (403, 404), f"HTTP {gone}")

    print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: " + " | ".join(fails)))
    sys.exit(0 if not fails else 1)
