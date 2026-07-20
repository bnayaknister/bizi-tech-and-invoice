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
    left = requests.get(rest("pending_documents?select=id"), headers=ADMIN).json()
    check("cleanup: pending_documents empty", left == [], json.dumps(left)[:120])

    print()
    if failures:
        print(f"{len(failures)} FAILED: " + " · ".join(failures))
        sys.exit(1)
    print("all checks passed")
