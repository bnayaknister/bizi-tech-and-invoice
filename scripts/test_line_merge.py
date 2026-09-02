# -*- coding: utf-8 -*-
"""
Merging detail lines on a bundled document (owner spec 2026-09-02).

Run:  TEST_APP_URL=http://localhost:3000 python3 scripts/test_line_merge.py

TOUCHES MORNING: never. Only /api/documents/pending/edit, whose single Morning
call (listClients) fires solely on a RECIPIENT change, which no test here sends.
Nothing is approved and nothing is issued.

WHAT IT PROVES. `lines` is a patch map keyed by index and can never change the
line COUNT. `replace_lines` states the final set instead, so five inherited
episode lines can become one — "הפקת חומרים שיווקיים אוגוסט, 3,000 ₪". The
danger it introduces is money: deleting four lines leaves 600 against a 3,000
document. The balance gate (lib/documents/lineBalance.ts) is what makes that
impossible, and test 2 is the one that matters.

Also asserts the OLD path is untouched — a `lines` request behaves exactly as
it did before this feature (test 8).

Self-cleaning in FK order, verified before exit.
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
MARK = "ZTESTMERGE"

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


def line(text, price=600):
    return {"description": text, "quantity": 1, "price": price, "currency": "ILS", "vatType": 0}


def mk(lines_, amount=None, status="pending", doc_type="tax_invoice", mtype=305):
    row = ins("pending_documents", {
        "doc_type": doc_type, "client_id": clients[0], "status": status,
        "amount": amount if amount is not None else sum(l["price"] for l in lines_),
        "payload": {"type": mtype, "lang": "he", "currency": "ILS", "vatType": 0, "date": "2026-09-02",
                    "description": f"חשבונית מס — {MARK}",
                    "client": {"id": "ztest-mid", "name": MARK, "add": False},
                    "income": lines_},
    })
    docs.append(row["id"])
    return row


def edit(jar, **body):
    return requests.post(f"{APP}/api/documents/pending/edit",
                         headers={"Content-Type": "application/json"}, cookies=jar, json=body)


def state(doc_id):
    return get(f"pending_documents?id=eq.{doc_id}&select=amount,payload")[0]


FIVE = lambda: [line(f"הזמנת עבודה — פרק {i}") for i in range(1, 6)]
TITLE = "הפקת חומרים שיווקיים אוגוסט"

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

    cli = ins("clients", {"name": f"{MARK} {uuid.uuid4().hex[:5]}",
                          "normalized_name": f"ztestmerge{uuid.uuid4().hex[:8]}"})
    clients.append(cli["id"])

    # ---- 1. the headline case: 5 -> 1, price corrected -----------------------
    r1 = mk(FIVE())
    res = edit(jar, id=r1["id"], replace_lines=[{"description": TITLE, "price": 3000}],
               amount=3000, description=TITLE)
    check("1. merge 5→1 with the price corrected → 200", res.status_code == 200,
          f"{res.status_code}: {res.text[:200]}")
    s = state(r1["id"])
    check("1a. income is now ONE line", len(s["payload"]["income"]) == 1, str(len(s["payload"]["income"])))
    check("1b. that line carries the whole 3,000", s["payload"]["income"][0]["price"] == 3000,
          str(s["payload"]["income"][0]))
    check("1c. its text is what she typed", s["payload"]["income"][0]["description"] == TITLE)
    check("1d. the amount column is unchanged at 3,000", float(s["amount"]) == 3000.0, str(s["amount"]))
    check("1e. currency/vatType carried over from the replaced row",
          s["payload"]["income"][0]["currency"] == "ILS" and s["payload"]["income"][0]["vatType"] == 0)
    ev = get(f"events?entity_id=eq.{r1['id']}&event_type=eq.document_edited&select=payload")
    check("1f. the audit records BOTH line sets (a deleted line has no other trace)",
          bool(ev) and ev[0]["payload"].get("mode") == "replace_lines"
          and len(ev[0]["payload"].get("income_before") or []) == 5
          and len(ev[0]["payload"].get("income_after") or []) == 1,
          json.dumps(ev)[:220])

    # ---- 2. ★ the one that matters: merge WITHOUT fixing the price ----------
    r2 = mk(FIVE())
    res = edit(jar, id=r2["id"], replace_lines=[{"description": TITLE, "price": 600}], amount=3000)
    check("2. ★ merge 5→1 leaving the price at 600 → 400 (balance gate)",
          res.status_code == 400, f"{res.status_code}: {res.text[:200]}")
    check("2a. the refusal names BOTH numbers", "600" in res.text and "3,000" in res.text, res.text[:220])
    s = state(r2["id"])
    check("2b. nothing was written — still five lines", len(s["payload"]["income"]) == 5)
    check("2c. amount untouched", float(s["amount"]) == 3000.0)

    # ---- 3. partial merge 5 -> 3, sums preserved ----------------------------
    r3 = mk(FIVE())
    res = edit(jar, id=r3["id"], amount=3000, replace_lines=[
        {"description": "אוגוסט א", "price": 1200},
        {"description": "אוגוסט ב", "price": 1200},
        {"description": "אוגוסט ג", "price": 600},
    ])
    check("3. partial merge 5→3 that still sums to 3,000 → 200", res.status_code == 200,
          f"{res.status_code}: {res.text[:200]}")
    s = state(r3["id"])
    check("3a. three lines, summing to the amount",
          len(s["payload"]["income"]) == 3
          and sum(x["price"] for x in s["payload"]["income"]) == 3000)

    # ---- 4. deleting everything ---------------------------------------------
    r4 = mk(FIVE())
    res = edit(jar, id=r4["id"], replace_lines=[], amount=3000)
    check("4. deleting all lines → 400", res.status_code == 400, f"{res.status_code}: {res.text[:160]}")
    check("4a. five lines still there", len(state(r4["id"])["payload"]["income"]) == 5)

    # ---- 5. the mutually-exclusive shapes -----------------------------------
    res = edit(jar, id=r4["id"], lines=[{"index": 0, "description": "x"}],
               replace_lines=[{"description": "y", "price": 3000}], amount=3000)
    check("5. lines + replace_lines together → 400", res.status_code == 400, f"{res.status_code}")
    res = edit(jar, id=r4["id"], replace_lines=[{"description": "y", "price": 3000}])
    check("5a. replace_lines without amount → 400", res.status_code == 400,
          f"{res.status_code}: {res.text[:160]}")

    # ---- 6. bad prices -------------------------------------------------------
    for bad, label in ((-5, "negative"), ("abc", "non-numeric")):
        res = edit(jar, id=r4["id"], amount=3000,
                   replace_lines=[{"description": "x", "price": bad}])
        check(f"6. {label} price → 400", res.status_code == 400, f"{res.status_code}")
    res = edit(jar, id=r4["id"], amount=3000, replace_lines=[{"description": "   ", "price": 3000}])
    check("6a. empty line text → 400", res.status_code == 400, f"{res.status_code}")

    # ---- 7. merge only: refused on a single-line row, and on growth ---------
    solo = mk([line("שורה יחידה", 900)])
    res = edit(jar, id=solo["id"], amount=900,
               replace_lines=[{"description": "א", "price": 500}, {"description": "ב", "price": 400}])
    check("7. splitting a single-line row → 400 (merge only, owner decision)",
          res.status_code == 400, f"{res.status_code}: {res.text[:180]}")
    check("7a. ...and the refusal says so", "פיצול" in res.text, res.text[:180])
    res = edit(jar, id=r4["id"], amount=3000, replace_lines=[
        {"description": f"ל{i}", "price": 500} for i in range(6)
    ])
    check("7b. growing 5→6 → 400", res.status_code == 400, f"{res.status_code}: {res.text[:160]}")

    # ---- 8. ★ BACKWARD COMPATIBILITY: the old `lines` path is untouched -----
    r8 = mk(FIVE())
    res = edit(jar, id=r8["id"], lines=[{"index": 2, "description": "טקסט חדש לשורה 3"}])
    check("8. ★ a plain `lines` text edit still works exactly as before",
          res.status_code == 200, f"{res.status_code}: {res.text[:200]}")
    s = state(r8["id"])
    check("8a. still five lines — the count cannot move on that path",
          len(s["payload"]["income"]) == 5, str(len(s["payload"]["income"])))
    check("8b. only line 2 changed", s["payload"]["income"][2]["description"] == "טקסט חדש לשורה 3")
    check("8c. prices untouched", [x["price"] for x in s["payload"]["income"]] == [600] * 5)
    check("8d. amount untouched", float(s["amount"]) == 3000.0)
    res = edit(jar, id=r8["id"], lines=[{"index": 0, "description": "z"}], amount=999)
    check("8e. amount alongside `lines` is still refused", res.status_code == 400, f"{res.status_code}")

    # ---- 9. the status gate still holds --------------------------------------
    for st, expect in (("approved", 409), ("accrued", 409)):
        g = mk(FIVE(), status=st)
        res = edit(jar, id=g["id"], amount=3000,
                   replace_lines=[{"description": TITLE, "price": 3000}])
        check(f"9. merge on status={st} → {expect}", res.status_code == expect,
              f"{res.status_code}: {res.text[:140]}")

finally:
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
