# -*- coding: utf-8 -*-
"""
The document TITLE on a multi-line queue row (owner spec 2026-09-02).

Run:  TEST_APP_URL=http://localhost:3000 python3 scripts/test_edit_title_multiline.py

TOUCHES MORNING: never. This exercises /api/documents/pending/edit only, which
calls Morning exactly once — listClients(), and only when a RECIPIENT change is
sent. No test here sends one, so no request leaves the building. Nothing is
approved and nothing is issued, so rule 40's issuing hazard is not on this path;
the dry-run server is still the right place to run it.

THE BUG UNDER TEST. Until today the description branch mirrored the new title
into income[0] unconditionally. On a bundled 320 — whose lines are inherited
verbatim from the consolidated work order — that overwrote the FIRST EPISODE's
line with the document heading and deleted it from the printed page, silently,
while the amount column still counted it. A tax document cannot be corrected
after issuance, only credited.

Test 2 is the one that matters: it asserts every income line survives a title
edit. It FAILS against the pre-fix route (verified by git stash).

Self-cleaning in FK order, in `finally`, verified before exit.
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

MARK = "ZTESTTITLE"
fails = []
users, docs, clients = [], [], []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"   [{detail}]" if detail and not ok else ""))
    if not ok:
        fails.append(label)


def ins(table, body):
    r = requests.post(f"{SUP}/rest/v1/{table}", headers={**ADMIN, "Prefer": "return=representation"}, json=body)
    r.raise_for_status()
    return r.json()[0]


def get(path):
    r = requests.get(f"{SUP}/rest/v1/{path}", headers=ADMIN)
    r.raise_for_status()
    return r.json()


def line(text, price=600):
    return {"description": text, "quantity": 1, "price": price, "currency": "ILS", "vatType": 0}


def make_row(client_id, lines, description, status="pending", amount=None):
    # a row may not claim status='issued' without a Morning id — CHECK 23514 on
    # pending_documents, and a correct invariant: 'issued' means the document
    # exists over there. The test satisfies it rather than working around it.
    issued_ids = ({"morning_doc_id": f"ztest-{uuid.uuid4().hex[:10]}",
                   "morning_doc_number": "ZTEST-0000"} if status == "issued" else {})
    payload = {
        "type": 305,
        "lang": "he",
        "currency": "ILS",
        "vatType": 0,
        "date": "2026-09-02",
        "description": description,
        "client": {"id": "ztest-morning-id", "name": MARK, "add": False},
        "income": lines,
    }
    row = ins("pending_documents", {
        "doc_type": "tax_invoice",
        "production_id": None,
        "job_id": None,
        "client_id": client_id,
        "amount": amount if amount is not None else sum(l["price"] for l in lines),
        "payload": payload,
        "status": status,
        **issued_ids,
    })
    docs.append(row["id"])
    return row


def edit(jar, **body):
    return requests.post(f"{APP}/api/documents/pending/edit",
                         headers={"Content-Type": "application/json"}, cookies=jar, json=body)


def payload_of(doc_id):
    return get(f"pending_documents?id=eq.{doc_id}&select=payload,amount")[0]


uid = None
try:
    # ---- dry-run gate (rule 40): refuse to run against an issuing server -----
    st = requests.get(f"{APP}/api/morning/status", timeout=20)
    print(f"/api/morning/status -> {st.status_code} {st.text[:120]}")

    # ---- a money editor -----------------------------------------------------
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
    cname = f"sb-{REF}-auth-token"
    jar = ({cname: val} if len(val) <= 3180
           else {f"{cname}.{i}": val[s:s + 3180] for i, s in enumerate(range(0, len(val), 3180))})

    cli = ins("clients", {"name": f"{MARK} {uuid.uuid4().hex[:5]}",
                          "normalized_name": f"ztesttitle{uuid.uuid4().hex[:8]}"})
    clients.append(cli["id"])

    # a real field is required or the "no change" gate answers before the row is
    # ever looked up, and a 400 would prove nothing about the cookie
    probe = edit(jar, id="00000000-0000-0000-0000-000000000000", description="probe")
    check("0. cookie authenticates (404, not 401/403)", probe.status_code == 404,
          f"got {probe.status_code}: {probe.text[:120]}")

    # =========================================================================
    # 1-3. THE CENTRAL CASE: a title edit on a 5-line bundle
    # =========================================================================
    FIVE = [line(f"הזמנת עבודה — דעה לא פופולרית · אורח {i} · 0{i}.08.26") for i in range(1, 6)]
    ORIGINALS = [l["description"] for l in FIVE]
    row = make_row(cli["id"], FIVE, "חשבונית מס — ברק הרשקוביץ")
    TITLE = "הפקת חומרים שיווקיים אוגוסט"

    res = edit(jar, id=row["id"], description=TITLE)
    check("1. title edit on a multi-line row is accepted", res.status_code == 200,
          f"got {res.status_code}: {res.text[:160]}")

    after = payload_of(row["id"])
    check("2. payload.description is the new title", after["payload"].get("description") == TITLE,
          repr(after["payload"].get("description")))

    got = [l.get("description") for l in after["payload"].get("income", [])]
    check("3. ★ ALL FIVE income lines survive verbatim (the bug being fixed)",
          got == ORIGINALS, f"expected {ORIGINALS}\n           got      {got}")
    check("4. line 0 specifically was NOT overwritten by the title",
          got and got[0] == ORIGINALS[0] and got[0] != TITLE, repr(got[0] if got else None))
    check("5. prices untouched", [l.get("price") for l in after["payload"]["income"]] == [600] * 5)
    check("6. the amount column did not move", float(after["amount"]) == 3000.0, str(after["amount"]))

    # =========================================================================
    # 7-9. Single-line: the OLD behaviour must be intact
    # =========================================================================
    one = make_row(cli["id"], [line("חשבונית מס — פרק בודד")], "חשבונית מס — לקוח")
    res = edit(jar, id=one["id"], description="כותרת חדשה לשורה בודדת")
    check("7. single-line title edit still accepted", res.status_code == 200, res.text[:140])
    a1 = payload_of(one["id"])
    check("8. single-line: payload.description updated",
          a1["payload"]["description"] == "כותרת חדשה לשורה בודדת")
    check("9. single-line: income[0] STILL mirrors the title (unchanged behaviour)",
          a1["payload"]["income"][0]["description"] == "כותרת חדשה לשורה בודדת",
          repr(a1["payload"]["income"][0]["description"]))

    # =========================================================================
    # 10-13. Title + lines in ONE request — disjoint, atomic
    # =========================================================================
    both = make_row(cli["id"], [line("שורה א"), line("שורה ב"), line("שורה ג")], "חשבונית מס — לקוח")
    res = edit(jar, id=both["id"], description="כותרת משותפת",
               lines=[{"index": 1, "description": "שורה ב מתוקנת"}])
    check("10. title + lines in one request is accepted", res.status_code == 200,
          f"got {res.status_code}: {res.text[:160]}")
    a2 = payload_of(both["id"])
    check("11. ...title applied", a2["payload"]["description"] == "כותרת משותפת")
    d2 = [l["description"] for l in a2["payload"]["income"]]
    check("12. ...only the named line changed", d2 == ["שורה א", "שורה ב מתוקנת", "שורה ג"], str(d2))
    check("13. ...line 0 untouched by the title", d2[0] == "שורה א", d2[0])

    # =========================================================================
    # 14-16. The money rule is UNCHANGED
    # =========================================================================
    m = make_row(cli["id"], [line("שורה א"), line("שורה ב")], "חשבונית מס — לקוח")
    res = edit(jar, id=m["id"], amount=999, lines=[{"index": 0, "description": "x"}])
    check("14. amount + lines still refused (400)", res.status_code == 400, f"got {res.status_code}")
    res = edit(jar, id=m["id"], lines=[{"index": 0, "description": "x"}])
    check("15. lines alone still work", res.status_code == 200, res.text[:120])
    check("16. amount column unmoved after a line edit", float(payload_of(m["id"])["amount"]) == 1200.0)

    # `lines` on a single-line row is still refused — now by the income-length
    # gate rather than the removed parse-time guard
    res = edit(jar, id=one["id"], lines=[{"index": 0, "description": "x"}])
    check("17. lines on a single-line row still refused (400)", res.status_code == 400,
          f"got {res.status_code}: {res.text[:140]}")

    # =========================================================================
    # 17a-17f. amount ALONE on a bundle — the second half of the same bug.
    # Until 2026-09-02 only `amount` + `lines` was refused, so `{id, amount}` on
    # a 5-line bundle wrote income[0].price and left the other four, making the
    # payload sum disagree with the amount column.
    # =========================================================================
    bundle = make_row(cli["id"], [line(f"שורה {i}") for i in range(1, 6)], "חשבונית מס — לקוח")
    before_lines = [l["description"] for l in payload_of(bundle["id"])["payload"]["income"]]
    res = edit(jar, id=bundle["id"], amount=9999)
    check("17a. ★ amount ALONE on a multi-line row is refused (400)", res.status_code == 400,
          f"got {res.status_code}: {res.text[:200]}")
    check("17b. ...the refusal says the bundle's amount is derived",
          "נגזר מהעבודות שאוגדו" in res.text, res.text[:200])
    st = payload_of(bundle["id"])
    check("17c. ...the amount column did not move", float(st["amount"]) == 3000.0, str(st["amount"]))
    check("17d. ...no price was written into income[0]",
          [l["price"] for l in st["payload"]["income"]] == [600] * 5,
          str([l["price"] for l in st["payload"]["income"]]))
    check("17e. ...and no line text was touched",
          [l["description"] for l in st["payload"]["income"]] == before_lines)

    # the single-line path must stay editable — there the amount and the one
    # line are the same money, and that is the whole point of the field
    solo = make_row(cli["id"], [line("שורה יחידה", price=800)], "חשבונית מס — לקוח")
    res = edit(jar, id=solo["id"], amount=850)
    check("17f. amount on a SINGLE-line row still accepted (200)", res.status_code == 200,
          f"got {res.status_code}: {res.text[:160]}")
    s2 = payload_of(solo["id"])
    check("17g. ...column and income[0].price both moved, in lockstep",
          float(s2["amount"]) == 850.0 and float(s2["payload"]["income"][0]["price"]) == 850.0,
          f"amount={s2['amount']} price={s2['payload']['income'][0]['price']}")

    # =========================================================================
    # 18-21. The pending/failed gate
    # =========================================================================
    for st_name, expect in (("approved", 409), ("issued", 409), ("accrued", 409), ("failed", 200)):
        g = make_row(cli["id"], [line("שורה א"), line("שורה ב")], "חשבונית מס — לקוח", status=st_name)
        res = edit(jar, id=g["id"], description=f"כותרת {st_name}")
        check(f"{'18' if st_name=='approved' else '19' if st_name=='issued' else '20' if st_name=='accrued' else '21'}. "
              f"status={st_name} -> {expect}", res.status_code == expect,
              f"got {res.status_code}: {res.text[:120]}")
        if expect == 409:
            still = payload_of(g["id"])["payload"]["description"]
            check(f"    ...and status={st_name} row was not modified", still == "חשבונית מס — לקוח", repr(still))

    # 22. empty title refused
    res = edit(jar, id=row["id"], description="   ")
    check("22. empty title refused (400)", res.status_code == 400, f"got {res.status_code}")

finally:
    for d in docs:
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{d}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/pending_documents?id=eq.{d}", headers=ADMIN)
    for c in clients:
        requests.delete(f"{SUP}/rest/v1/clients?id=eq.{c}", headers=ADMIN)
    for u_ in users:
        requests.delete(f"{SUP}/rest/v1/events?actor_id=eq.{u_}", headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{u_}", headers=ADMIN)

    left_docs = get(f"pending_documents?id=in.({','.join(docs)})&select=id") if docs else []
    left_cli = get(f"clients?id=in.({','.join(clients)})&select=id") if clients else []
    left_usr = get(f"profiles?id=in.({','.join(users)})&select=id") if users else []
    print(f"\nCLEANUP: pending_documents left={len(left_docs)}  clients left={len(left_cli)}  profiles left={len(left_usr)}")
    if left_docs or left_cli or left_usr:
        print("!! TEST DATA NOT FULLY REMOVED !!")
        sys.exit(2)

print("\n" + ("ALL CHECKS PASSED" if not fails else f"FAILURES ({len(fails)}): {fails}"))
sys.exit(1 if fails else 0)
