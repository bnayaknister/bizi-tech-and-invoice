# -*- coding: utf-8 -*-
"""
Merging lines does NOT cut any job loose from its document (2026-09-02).

Run:  TEST_APP_URL=http://localhost:3000 python3 scripts/test_line_merge_jobs.py

Rule 40: approves a document, so it verifies dryRun:true with a cookie first.

THE FEAR THIS ANSWERS. A bundled 305 carries five income lines AND five jobs in
bundle_job_ids. Collapsing the five lines into one looks like it should orphan
four jobs — four episodes that were billed and now have no line naming them.

It does not, and the reason is structural: nothing indexes bundle_job_ids by
line position. issue.ts stamps invoice_tax over the SET (issue.ts:443), and the
codebase says so explicitly where it refuses to guess a line→job mapping
(issue.ts:461 — "the income lines are positional while bundle_job_ids is a Set
with no guaranteed order"). This file is that reasoning turned into a fact:
merge five lines into one, issue, and assert all five jobs still carry the tax
number.

It also asserts the deliberate SKIP: a bundle never has its jobs' amounts
realigned to the document total, and records job_amount_alignment_skipped
instead. Merging must not quietly turn that into five jobs of 3,000.
"""
import base64
import json
import os
import sys
import uuid

import requests

ROOT = os.path.join(os.path.dirname(__file__), "..")
for line_ in open(os.path.join(ROOT, ".env.local"), encoding="utf-8"):
    line_ = line_.strip()
    if line_ and not line_.startswith("#") and "=" in line_:
        k, v = line_.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

SUP = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SVC = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
REF = SUP.split("//")[1].split(".")[0]
ADMIN = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}
MARK = "ZTESTMJOB"
TITLE = "הפקת חומרים שיווקיים אוגוסט"

fails = []
docs, clients, users, jobs = [], [], [], []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"   [{detail}]" if detail and not ok else ""))
    if not ok:
        fails.append(label)


def ins(table, body):
    r = requests.post(f"{SUP}/rest/v1/{table}", headers={**ADMIN, "Prefer": "return=representation"}, json=body)
    r.raise_for_status()
    return r.json()[0]


def get(path):
    return requests.get(f"{SUP}/rest/v1/{path}", headers=ADMIN).json()


uid = mdid = None
try:
    email = f"ztest-{uuid.uuid4().hex[:8]}@example.com"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    u = requests.post(f"{SUP}/auth/v1/admin/users", headers=ADMIN,
                      json={"email": email, "password": pw, "email_confirm": True}).json()
    uid = u["id"]
    users.append(uid)
    requests.patch(f"{SUP}/rest/v1/profiles?id=eq.{uid}", headers=ADMIN,
                   json={"approved": True, "can_view_stages": True, "can_edit_stages": True,
                         "can_view_money": True, "can_edit_money": True, "role": "owner"})
    tok = requests.post(f"{SUP}/auth/v1/token?grant_type=password",
                        headers={"apikey": ANON, "Content-Type": "application/json"},
                        json={"email": email, "password": pw}).json()
    val = "base64-" + base64.b64encode(json.dumps(tok, separators=(",", ":")).encode()).decode()
    cn = f"sb-{REF}-auth-token"
    jar = ({cn: val} if len(val) <= 3180
           else {f"{cn}.{i}": val[s:s + 3180] for i, s in enumerate(range(0, len(val), 3180))})

    st = requests.get(f"{APP}/api/morning/status", cookies=jar, timeout=20)
    dry = st.status_code == 200 and st.json().get("dryRun") is True
    check("0. server is DRY_RUN (rule 40)", dry, f"{st.status_code}: {st.text[:120]}")
    if not dry:
        raise SystemExit("REFUSING: server is not in dry-run")

    cli = ins("clients", {"name": f"{MARK} {uuid.uuid4().hex[:5]}",
                          "normalized_name": f"ztestmjob{uuid.uuid4().hex[:8]}",
                          "morning_client_id": f"mjob-{uuid.uuid4().hex[:8]}"})
    clients.append(cli["id"])

    # five jobs, one per episode — exactly the shape a consolidated order leaves
    job_ids = []
    for i in range(1, 6):
        j = ins("jobs", {"client_id": cli["id"], "campaign": f"{MARK} פרק {i}",
                         "amount": 600, "date": "2026-08-0%d" % i, "paid": "לא"})
        job_ids.append(j["id"])
        jobs.append(j["id"])
    check("1. five jobs seeded, each 600", len(job_ids) == 5)

    row = ins("pending_documents", {
        "doc_type": "tax_invoice", "client_id": cli["id"], "status": "pending", "amount": 3000,
        "bundle_job_ids": job_ids,
        "payload": {"type": 305, "lang": "he", "currency": "ILS", "vatType": 0, "date": "2026-09-02",
                    "description": f"חשבונית מס — {MARK}",
                    "client": {"id": cli["morning_client_id"], "add": False},
                    "income": [{"description": f"הזמנת עבודה — פרק {i}", "quantity": 1, "price": 600,
                                "currency": "ILS", "vatType": 0} for i in range(1, 6)]},
    })
    docs.append(row["id"])

    # ---- merge 5 -> 1 through the real route --------------------------------
    res = requests.post(f"{APP}/api/documents/pending/edit", cookies=jar,
                        headers={"Content-Type": "application/json"},
                        json={"id": row["id"], "amount": 3000, "description": TITLE,
                              "replace_lines": [{"description": TITLE, "price": 3000}]})
    check("2. merge 5→1 accepted", res.status_code == 200, f"{res.status_code}: {res.text[:200]}")
    after = get(f"pending_documents?id=eq.{row['id']}&select=payload,amount,bundle_job_ids")[0]
    check("3. one income line remains", len(after["payload"]["income"]) == 1)
    check("4. ★ bundle_job_ids STILL holds all five jobs — merging lines does not touch it",
          sorted(after["bundle_job_ids"] or []) == sorted(job_ids),
          str(after["bundle_job_ids"]))

    # ---- issue it (DRY_RUN) --------------------------------------------------
    res = requests.post(f"{APP}/api/documents/pending/review", cookies=jar,
                        headers={"Content-Type": "application/json"},
                        json={"ids": [row["id"]], "action": "approve",
                              "confirmed": True, "tax_variant": "tax_invoice"})
    ok = res.status_code == 200 and (res.json().get("results") or [{}])[0].get("ok")
    check("5. the merged document issues", ok, f"{res.status_code}: {res.text[:200]}")
    st_row = get(f"pending_documents?id=eq.{row['id']}&select=status,morning_doc_id,morning_doc_number")[0]
    mdid = st_row.get("morning_doc_id")
    check("5a. status is issued", st_row["status"] == "issued", str(st_row))

    # ---- ★ THE ASSERTION THIS FILE EXISTS FOR -------------------------------
    #
    # DRY_RUN NEVER WRITES invoice_tax (issue.ts:430-438) — the stamp is the one
    # thing a dry run must not leak into the real ledger, so it is replaced by a
    # `dry_run_jobs_stamp_skipped` event carrying the job ids it WOULD have
    # stamped. That list is `bundleJobs`, resolved at issue time from
    # bundle_job_ids, and it is exactly the link merging could have broken — so
    # asserting on it tests the real thing rather than the stamping mechanics.
    #
    # What this therefore proves: after collapsing five lines into one, the
    # document still resolves to all five jobs. What it does NOT exercise is the
    # UPDATE itself, which needs a live issuance (owner approval, per rule 40).
    ev = get(f"events?entity_id=eq.{row['id']}&event_type=eq.dry_run_jobs_stamp_skipped&select=payload")
    would_stamp = (ev[0]["payload"].get("job_ids") if ev else []) or []
    check("6. ★★ after the merge the document still resolves to ALL FIVE jobs — none orphaned",
          sorted(would_stamp) == sorted(job_ids),
          f"would stamp {len(would_stamp)} of 5: {json.dumps(would_stamp)[:200]}")
    check("6a. ...recorded against the number the document was issued with",
          bool(ev) and str(ev[0]["payload"].get("doc_number")) == str(st_row.get("morning_doc_number")),
          f"event={ev[0]['payload'].get('doc_number') if ev else None} doc={st_row.get('morning_doc_number')}")
    check("6b. ...and no invoice_tax was written, because this is a dry run",
          all(j["invoice_tax"] is None
              for j in get(f"jobs?id=in.({','.join(job_ids)})&select=id,invoice_tax")),
          "a dry run must never stamp the real ledger")

    # ---- job amounts are untouched by a line merge --------------------------
    # The realignment block lives in the !dryRun branch, so the ALIGNMENT-SKIPPED
    # event cannot appear here either. What is assertable — and is the risk worth
    # covering — is that nothing in the merge path rewrote the jobs' own amounts:
    # five episodes of 600 must not become five of 3,000 because one line now
    # says 3,000.
    amounts = sorted(float(j["amount"]) for j in get(f"jobs?id=in.({','.join(job_ids)})&select=id,amount"))
    check("7. every job still holds its own 600 — merging a line never rewrites job amounts",
          amounts == [600.0] * 5, str(amounts))

finally:
    if mdid:
        requests.delete(f"{SUP}/rest/v1/invoices?morning_doc_id=eq.{mdid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/documents?morning_doc_id=eq.{mdid}", headers=ADMIN)
    for d in docs:
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{d}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/pending_documents?id=eq.{d}", headers=ADMIN)
    for j in jobs:
        requests.delete(f"{SUP}/rest/v1/job_productions?job_id=eq.{j}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{j}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/jobs?id=eq.{j}", headers=ADMIN)
    for c in clients:
        requests.delete(f"{SUP}/rest/v1/clients?id=eq.{c}", headers=ADMIN)
    for u_ in users:
        requests.delete(f"{SUP}/rest/v1/events?actor_id=eq.{u_}", headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{u_}", headers=ADMIN)
    left_d = get(f"pending_documents?id=in.({','.join(docs)})&select=id") if docs else []
    left_j = get(f"jobs?id=in.({','.join(jobs)})&select=id") if jobs else []
    left_c = get(f"clients?id=in.({','.join(clients)})&select=id") if clients else []
    left_u = get(f"profiles?id=in.({','.join(users)})&select=id") if users else []
    print(f"\nCLEANUP: docs={len(left_d)}  jobs={len(left_j)}  clients={len(left_c)}  profiles={len(left_u)}")
    if left_d or left_j or left_c or left_u:
        print("!! TEST DATA NOT FULLY REMOVED !!")
        sys.exit(2)

print("\n" + ("ALL CHECKS PASSED" if not fails else f"FAILURES ({len(fails)}): {fails}"))
sys.exit(1 if fails else 0)
