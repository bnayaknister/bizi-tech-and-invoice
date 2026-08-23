# -*- coding: utf-8 -*-
"""
"ערוך לפני אישור" — editing a queued document before approval (owner spec).
Issues NO Morning document: it inserts a pending row directly and edits it
through the API, so it is safe with MORNING_DRY_RUN=false.

Proves:
  1. amount + description edit rewrites BOTH the amount column and the stored
     payload (income[0].price/description + top-level description) in lockstep
  2. a negative amount is refused
  3. an issued row is frozen (409)
  4. a stages-only user can't edit (403)
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
MARK = "ZTESTEDIT"

failures = []
users, pending_ids = [], []
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
    em = f"edit-{uuid.uuid4().hex[:8]}@bizi-test.local"
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


def make_row(status="pending"):
    payload = {"type": 100, "lang": "he", "currency": "ILS", "vatType": 0, "description": "old desc",
               "client": {"id": "x", "add": False},
               "income": [{"description": "old desc", "quantity": 1, "price": 100, "currency": "ILS", "vatType": 0}]}
    row = {"doc_type": "work_order", "client_id": client_id, "amount": 100, "payload": payload, "status": status}
    if status == "issued":
        row["morning_doc_id"] = f"dry-{uuid.uuid4()}"
    r = requests.post(rest("pending_documents"), headers={**ADMIN, **REPR}, json=row).json()[0]
    pending_ids.append(r["id"])
    return r["id"]


def make_bundle_row(n=3, status="pending"):
    """A bundled deal invoice: one income line per episode.

    Built directly rather than through createDealInvoiceBundle because no
    multi-job bundle exists in the account (verified 2026-08-20: all five rows
    carrying bundle_job_ids hold exactly one job), and the endpoint under test
    only ever reads the payload — it does not care how the row got there.
    Touches Morning never: nothing here is approved or issued.
    """
    income = [
        {"description": f"{MARK} line {i}", "quantity": 1, "price": 100 + i,
         "currency": "ILS", "vatType": 0}
        for i in range(n)
    ]
    payload = {"type": 300, "lang": "he", "currency": "ILS", "vatType": 0,
               "description": f"{MARK} bundle title",
               "client": {"id": "x", "add": False},
               "income": income}
    total = sum(l["price"] for l in income)
    row = {"doc_type": "deal_invoice", "client_id": client_id, "amount": total,
           "payload": payload, "status": status}
    if status == "issued":
        row["morning_doc_id"] = f"dry-{uuid.uuid4()}"
    r = requests.post(rest("pending_documents"), headers={**ADMIN, **REPR}, json=row).json()[0]
    pending_ids.append(r["id"])
    return r["id"]


def edit(cookies, **body):
    return requests.post(f"{APP_URL}/api/documents/pending/edit", cookies=cookies,
                         headers={"Content-Type": "application/json"}, json=body)


def payload_of(pid):
    return requests.get(rest(f"pending_documents?id=eq.{pid}&select=amount,payload"),
                        headers=ADMIN).json()[0]


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
    money = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True})
    tech = mkuser({"role": "tech", "can_view_stages": True, "can_edit_stages": True})
    client_id = requests.post(rest("clients"), headers={**ADMIN, **REPR},
                              json={"name": f"{MARK} client",
                                    "normalized_name": f"ztestedit{uuid.uuid4().hex[:6]}"}).json()[0]["id"]

    pid = make_row("pending")

    # 4. permissions
    r = requests.post(f"{APP_URL}/api/documents/pending/edit", cookies=tech,
                      headers={"Content-Type": "application/json"},
                      json={"id": pid, "amount": 500})
    check("4. stages-only user can't edit", r.status_code == 403, str(r.status_code))

    # 2. negative amount refused
    r = requests.post(f"{APP_URL}/api/documents/pending/edit", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"id": pid, "amount": -5})
    check("2. negative amount refused", r.status_code == 400, str(r.status_code))

    # 1. valid edit
    r = requests.post(f"{APP_URL}/api/documents/pending/edit", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"id": pid, "amount": 777, "description": "תיאור חדש"})
    check("1a. edit accepted", r.status_code == 200 and r.json().get("ok"), r.text[:150])
    row = requests.get(rest(f"pending_documents?id=eq.{pid}&select=amount,payload"), headers=ADMIN).json()[0]
    check("1b. amount column updated", float(row["amount"]) == 777.0, str(row["amount"]))
    check("1c. payload income price updated", row["payload"]["income"][0]["price"] == 777,
          str(row["payload"]["income"][0]["price"]))
    check("1d. payload description updated (both places)",
          row["payload"]["description"] == "תיאור חדש" and row["payload"]["income"][0]["description"] == "תיאור חדש",
          json.dumps(row["payload"], ensure_ascii=False)[:160])

    # 3. issued row frozen
    iid = make_row("issued")
    r = requests.post(f"{APP_URL}/api/documents/pending/edit", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"id": iid, "amount": 900})
    check("3. issued row can't be edited (409)", r.status_code == 409, str(r.status_code))

    # ---- multi-line editing (2026-08-20) ---------------------------------
    bid = make_bundle_row(3)
    before = payload_of(bid)["payload"]

    # 5. the headline case: edit the SECOND line of a three-line bundle
    r = edit(money, id=bid, lines=[{"index": 1, "description": "פרק שני מתוקן"}])
    check("5a. multi-line edit accepted", r.status_code == 200 and r.json().get("ok"), r.text[:150])
    after = payload_of(bid)
    inc = after["payload"]["income"]
    check("5b. line 1 updated", inc[1]["description"] == "פרק שני מתוקן", inc[1]["description"])
    check("5c. lines 0 and 2 untouched",
          inc[0] == before["income"][0] and inc[2] == before["income"][2],
          json.dumps([inc[0], inc[2]], ensure_ascii=False)[:160])
    check("5d. edited line kept its price/quantity",
          inc[1]["price"] == before["income"][1]["price"] and inc[1]["quantity"] == before["income"][1]["quantity"],
          json.dumps(inc[1], ensure_ascii=False))

    # 6. the document title does NOT move with a line edit
    check("6. document description unchanged",
          after["payload"]["description"] == before["description"],
          f'{before["description"]!r} -> {after["payload"]["description"]!r}')

    # 7. the amount column is not touched by a line edit
    check("7. amount column unchanged", float(after["amount"]) == float(303),
          str(after["amount"]))

    # 8. money is locked in multi-line mode
    r = edit(money, id=bid, amount=999, lines=[{"index": 0, "description": "x"}])
    check("8. lines + amount refused (400)", r.status_code == 400, r.text[:120])

    # 9. lines + description refused (both write income[0])
    r = edit(money, id=bid, description="y", lines=[{"index": 0, "description": "x"}])
    check("9. lines + description refused (400)", r.status_code == 400, r.text[:120])

    # 10. index validation
    r = edit(money, id=bid, lines=[{"index": 7, "description": "x"}])
    check("10a. index out of range refused (400)", r.status_code == 400, r.text[:120])
    r = edit(money, id=bid, lines=[{"index": 0, "description": "   "}])
    check("10b. empty line description refused (400)", r.status_code == 400, r.text[:120])
    r = edit(money, id=bid, lines=[{"index": 0, "description": "a"}, {"index": 0, "description": "b"}])
    check("10c. duplicate index refused (400)", r.status_code == 400, r.text[:120])

    # 10d. a rejected batch must leave the row EXACTLY as it was — the whole
    # point of validating everything before writing anything
    check("10d. refused batches wrote nothing", payload_of(bid)["payload"] == after["payload"],
          "payload moved after a refused request")

    # 11. one line means the old path — the title must keep moving with it
    r = edit(money, id=pid, lines=[{"index": 0, "description": "x"}])
    check("11. lines on a single-line document refused (400)", r.status_code == 400, r.text[:120])

    # 12. the freeze and the permission gate hold on the new branch too
    bfrozen = make_bundle_row(2, "issued")
    r = edit(money, id=bfrozen, lines=[{"index": 1, "description": "x"}])
    check("12a. issued row can't be line-edited (409)", r.status_code == 409, str(r.status_code))
    r = edit(tech, id=bid, lines=[{"index": 1, "description": "x"}])
    check("12b. stages-only user can't line-edit (403)", r.status_code == 403, str(r.status_code))

    # 13. REGRESSION: the single-line path is byte-for-byte what it was
    sid = make_row("pending")
    r = edit(money, id=sid, amount=555, description="רגרסיה")
    check("13a. single-line edit still accepted", r.status_code == 200, r.text[:120])
    srow = payload_of(sid)
    check("13b. single-line still updates amount + income[0].price + BOTH descriptions",
          float(srow["amount"]) == 555.0
          and srow["payload"]["income"][0]["price"] == 555
          and srow["payload"]["description"] == "רגרסיה"
          and srow["payload"]["income"][0]["description"] == "רגרסיה",
          json.dumps(srow["payload"], ensure_ascii=False)[:200])

    # 14. the audit trail records the line edit, per line
    evs = requests.get(
        rest(f"events?entity_id=eq.{bid}&event_type=eq.document_edited&select=payload"),
        headers=ADMIN).json()
    line_evs = [e for e in evs if (e["payload"] or {}).get("mode") == "lines"]
    check("14. document_edited event carries per-line before/after",
          len(line_evs) == 1
          and line_evs[0]["payload"]["lines"] == [
              {"index": 1, "before": f"{MARK} line 1", "after": "פרק שני מתוקן"}],
          json.dumps(line_evs, ensure_ascii=False)[:220])

finally:
    print("\n--- cleanup ---")
    for pd in pending_ids:
        requests.delete(rest(f"events?entity_id=eq.{pd}"), headers=ADMIN)
        requests.delete(rest(f"pending_documents?id=eq.{pd}"), headers=ADMIN)
    if client_id:
        requests.delete(rest(f"clients?id=eq.{client_id}"), headers=ADMIN)
    for uid in users:
        requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=ADMIN)
        requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{uid}", headers=ADMIN)
    # Only the rows THIS script created. The original assertion demanded the
    # whole table be empty, which was true when it was written and is not now
    # (35 real rows on 2026-08-20) — it would report a false failure on every
    # run and teach the reader to ignore the cleanup line, which is the one
    # line that must never be ignored.
    left = []
    if pending_ids:
        left = requests.get(
            rest("pending_documents?select=id&id=in.(" + ",".join(pending_ids) + ")"),
            headers=ADMIN).json()
    check("cleanup: every row this script created is gone", left == [], json.dumps(left)[:120])


print()
if failures:
    print(f"{len(failures)} FAILED: " + " · ".join(failures))
    sys.exit(1)
print("all checks passed")
