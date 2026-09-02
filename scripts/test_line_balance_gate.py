# -*- coding: utf-8 -*-
"""
The balance gate in the REVIEW route — the hole, closed (2026-09-02).

Run:  TEST_APP_URL=http://localhost:3000 python3 scripts/test_line_balance_gate.py

Rule 40: approves documents, so it refuses to run unless /api/morning/status
reports dryRun:true, verified with a cookie first. In dry-run nothing is sent
to Morning.

SEPARATE FROM test_line_merge.py ON PURPOSE. That file tests the FEATURE (the
edit form can merge lines). This one tests the INVARIANT, and it stands on its
own: until today nothing compared Sigma(income) against pending_documents.amount
anywhere, so a 305 whose lines summed to 600 while the column said 3,000 would
have issued silently. On a tax document that is unrecoverable.

The rows here are planted UNBALANCED DIRECTLY IN THE DATABASE, bypassing the
edit route entirely — because the point is that the wall holds against any
path, not only the one with a form in front of it. A gate only the editor
enforces is not a gate (the lesson rule 40 already records).
"""
import base64
import json
import os
import sys
import uuid

import requests

ROOT = os.path.join(os.path.dirname(__file__), "..")
for line in open(os.path.join(ROOT, ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

SUP = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SVC = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
REF = SUP.split("//")[1].split(".")[0]
ADMIN = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}
MARK = "ZTESTBAL"

fails = []
docs, clients, users = [], [], []


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


def line(text, price):
    return {"description": text, "quantity": 1, "price": price, "currency": "ILS", "vatType": 0}


def plant(doc_type, mtype, lines_, amount):
    """Straight into the table — no route, no validation."""
    row = ins("pending_documents", {
        "doc_type": doc_type, "client_id": clients[0], "status": "pending", "amount": amount,
        "payload": {"type": mtype, "lang": "he", "currency": "ILS", "vatType": 0, "date": "2026-09-02",
                    "description": f"{MARK} — planted",
                    "client": {"id": "ztest-mid", "name": MARK, "add": False},
                    "income": lines_},
    })
    docs.append(row["id"])
    return row


uid = None
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
    check("0. server is DRY_RUN (rule 40, verified before any approve)", dry,
          f"{st.status_code}: {st.text[:120]}")
    if not dry:
        raise SystemExit("REFUSING: server is not in dry-run")

    cli = ins("clients", {"name": f"{MARK} {uuid.uuid4().hex[:5]}",
                          "normalized_name": f"ztestbal{uuid.uuid4().hex[:8]}",
                          "morning_client_id": f"mbal-{uuid.uuid4().hex[:8]}"})
    clients.append(cli["id"])

    def approve(row_id, **extra):
        return requests.post(f"{APP}/api/documents/pending/review", cookies=jar,
                             headers={"Content-Type": "application/json"},
                             json={"ids": [row_id], "action": "approve", **extra})

    def status_of(row_id):
        return get(f"pending_documents?id=eq.{row_id}&select=status,morning_doc_id")[0]

    # ---- 1. ★ the hole: a 305 whose lines do not add up ---------------------
    bad305 = plant("tax_invoice", 305, [line("שורה אחת", 600)], 3000)
    res = approve(bad305["id"], confirmed=True, tax_variant="tax_invoice")
    check("1. ★ a 305 summing to 600 against a 3,000 column is REFUSED",
          res.status_code == 400, f"{res.status_code}: {res.text[:220]}")
    check("1a. the refusal names both figures", "600" in res.text and "3,000" in res.text, res.text[:220])
    after = status_of(bad305["id"])
    check("1b. it was NOT issued", after["status"] == "pending" and not after["morning_doc_id"], str(after))

    # ---- 2. the same document, balanced, goes through -----------------------
    ok305 = plant("tax_invoice", 305, [line("שורה אחת", 3000)], 3000)
    res = approve(ok305["id"], confirmed=True, tax_variant="tax_invoice")
    ok = res.status_code == 200 and (res.json().get("results") or [{}])[0].get("ok")
    check("2. the balanced twin issues normally", ok, f"{res.status_code}: {res.text[:200]}")

    # ---- 3. the gate is not tax-only: a work order too ----------------------
    bad100 = plant("work_order", 100, [line("א", 500), line("ב", 500)], 3000)
    res = approve(bad100["id"])
    check("3. an unbalanced WORK ORDER is refused too (the gate is per-document, not per-type)",
          res.status_code == 400, f"{res.status_code}: {res.text[:200]}")
    check("3a. ...and it stayed pending", status_of(bad100["id"])["status"] == "pending")

    # ---- 4. a deal invoice, the other untyped path --------------------------
    bad300 = plant("deal_invoice", 300, [line("א", 100)], 900)
    res = approve(bad300["id"])
    check("4. an unbalanced deal invoice is refused", res.status_code == 400, f"{res.status_code}")

    # ---- 5. rounding must not trip it ---------------------------------------
    round_ok = plant("work_order", 100, [line("א", 333.33), line("ב", 333.33), line("ג", 333.34)], 1000)
    res = approve(round_ok["id"])
    ok = res.status_code == 200 and (res.json().get("results") or [{}])[0].get("ok")
    check("5. 333.33+333.33+333.34 = 1000 passes (epsilon, not exact float equality)",
          ok, f"{res.status_code}: {res.text[:200]}")

    # ---- 6. quantity is part of the sum -------------------------------------
    qty = plant("work_order", 100,
                [{"description": "שלוש יחידות", "quantity": 3, "price": 400, "currency": "ILS", "vatType": 0}],
                1200)
    res = approve(qty["id"])
    ok = res.status_code == 200 and (res.json().get("results") or [{}])[0].get("ok")
    check("6. 3 × 400 = 1,200 passes — quantity counts", ok, f"{res.status_code}: {res.text[:200]}")

finally:
    mdids = []
    for d in docs:
        row = get(f"pending_documents?id=eq.{d}&select=morning_doc_id")
        if row and row[0].get("morning_doc_id"):
            mdids.append(row[0]["morning_doc_id"])
    for md in mdids:
        requests.delete(f"{SUP}/rest/v1/invoices?morning_doc_id=eq.{md}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/documents?morning_doc_id=eq.{md}", headers=ADMIN)
    for d in docs:
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{d}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/pending_documents?id=eq.{d}", headers=ADMIN)
    for c in clients:
        requests.delete(f"{SUP}/rest/v1/clients?id=eq.{c}", headers=ADMIN)
    for u_ in users:
        requests.delete(f"{SUP}/rest/v1/events?actor_id=eq.{u_}", headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{u_}", headers=ADMIN)
    left_d = get(f"pending_documents?id=in.({','.join(docs)})&select=id") if docs else []
    left_c = get(f"clients?id=in.({','.join(clients)})&select=id") if clients else []
    left_u = get(f"profiles?id=in.({','.join(users)})&select=id") if users else []
    print(f"\nCLEANUP: docs left={len(left_d)}  clients left={len(left_c)}  profiles left={len(left_u)}")
    if left_d or left_c or left_u:
        print("!! TEST DATA NOT FULLY REMOVED !!")
        sys.exit(2)

print("\n" + ("ALL CHECKS PASSED" if not fails else f"FAILURES ({len(fails)}): {fails}"))
sys.exit(1 if fails else 0)
