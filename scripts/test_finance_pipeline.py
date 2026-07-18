# -*- coding: utf-8 -*-
"""
Acceptance test for the finance pipeline screen (migration 0023).

  Part A — the summary math on REAL data (read-only): the tab derivation and
  totals match the owner's verification: 51 jobs, 39,500 ₪ debt, 8 overdue
  60+ (8,900 ₪), 5 missing-tax-invoice (5,650 ₪).

  Part B — the two-path issuance + the "paid opens" loop, on a THROWAWAY job
  (never touches the real 51):
    - issue a business invoice via Morning (dry-run) -> job gets invoice_biz,
      an invoices row lands with source='morning_api', state -> blue
    - mark the job paid -> no tax invoice yet -> state RED, needs_tax=True
    - issue the tax invoice MANUALLY -> invoices row source='manual',
      job.invoice_tax set, state -> closed
    - a technician (no can_edit_money) can't issue or mark paid -> 403

Cleans up every throwaway row + user in finally (events first — cleanup rule).
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

failures = []
users = []
client_id = None
job_id = None
inv_ids = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        failures.append(label)


def rest(p):
    return f"{SUPABASE_URL}/rest/v1/{p}"


def b64(r):
    return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags):
    em = f"fin-{uuid.uuid4().hex[:8]}@bizi-test.local"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{SUPABASE_URL}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**ADMIN, **REPR},
                   json={"name": "בדיקת כספים", "approved": True, **flags}).raise_for_status()
    td = requests.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {CN: "base64-" + b64(json.dumps(sess).encode())}


def deriv(paid, biz, tax):
    def present(v):
        return v is not None and str(v).strip() != ""
    if paid == "כן":
        return "closed" if present(tax) else "red"
    if paid == "ללא חיוב":
        return "closed"
    return "blue" if present(biz) else "purple"


for _ in range(60):
    try:
        if requests.get(APP_URL, timeout=2).status_code < 500:
            break
    except requests.exceptions.ConnectionError:
        pass
    time.sleep(1)
else:
    print("FAIL dev server never came up"); sys.exit(1)

try:
    # ---------- Part A: summary math on real data ----------
    jobs = requests.get(rest("jobs?select=amount,invoice_biz,invoice_tax,paid,due_date"), headers=ADMIN).json()
    total = len(jobs)
    debt = sum((j["amount"] or 0) for j in jobs if j["paid"] == "לא")
    red = [j for j in jobs if deriv(j["paid"], j["invoice_biz"], j["invoice_tax"]) == "red"]
    red_sum = sum((j["amount"] or 0) for j in red)
    now = time.time()
    od60 = [j for j in jobs if j["paid"] == "לא" and j["due_date"] and
            (time.mktime(time.strptime(j["due_date"], "%Y-%m-%d")) - now) / 86400 < -60]
    od60_sum = sum((j["amount"] or 0) for j in od60)
    check("A1. 51 jobs total", total == 51, str(total))
    check("A2. debt to collect = 39,500", round(debt) == 39500, str(debt))
    check("A3. missing-tax tab = 5 jobs", len(red) == 5, str(len(red)))
    check("A4. missing-tax sum = 5,650", round(red_sum) == 5650, str(red_sum))
    check("A5. overdue 60+ = 8 jobs", len(od60) == 8, str(len(od60)))
    check("A6. overdue 60+ sum = 8,900", round(od60_sum) == 8900, str(od60_sum))

    # ---------- Part B: throwaway job pipeline ----------
    money = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True, "can_view_stages": True})
    tech = mkuser({"role": "tech", "can_view_stages": True, "can_edit_stages": True})

    client_id = requests.post(rest("clients"), headers={**ADMIN, **REPR},
                              json={"name": "ZTEST fin client", "normalized_name": f"ztestfin{uuid.uuid4().hex[:6]}",
                                    "billing_mode": "per_episode", "payment_terms": "net_30"}).json()[0]["id"]
    job_id = requests.post(rest("jobs"), headers={**ADMIN, **REPR},
                           json={"client_id": client_id, "campaign": "ZTEST job", "amount": 2000,
                                 "paid": "לא", "date": "2026-07-01", "legacy": False}).json()[0]["id"]

    # tech cannot issue or mark paid
    r = requests.post(f"{APP_URL}/api/finance/issue", cookies=tech, headers={"Content-Type": "application/json"},
                      json={"job_id": job_id, "type": "עסקה", "mode": "morning"})
    check("B0. technician issue -> 403", r.status_code == 403, f"{r.status_code}")
    r = requests.post(f"{APP_URL}/api/finance/mark-paid", cookies=tech, headers={"Content-Type": "application/json"},
                      json={"job_id": job_id})
    check("B0b. technician mark-paid -> 403", r.status_code == 403, f"{r.status_code}")

    # issue business invoice via Morning (dry run)
    r = requests.post(f"{APP_URL}/api/finance/issue", cookies=money, headers={"Content-Type": "application/json"},
                      json={"job_id": job_id, "type": "עסקה", "mode": "morning"})
    ok = r.status_code == 200
    d = r.json() if ok else {}
    check("B1. issue עסקה via Morning accepted", ok, r.text[:120])
    check("B2. dry_run flag true", d.get("dry_run") is True, str(d))
    check("B3. state -> blue (awaiting payment)", d.get("state") == "blue", str(d))
    jrow = requests.get(rest(f"jobs?id=eq.{job_id}&select=invoice_biz,invoice_tax,paid"), headers=ADMIN).json()[0]
    check("B4. job.invoice_biz set", bool(jrow["invoice_biz"]), str(jrow))
    inv = requests.get(rest(f"invoices?job_id=eq.{job_id}&select=id,type,source"), headers=ADMIN).json()
    inv_ids += [i["id"] for i in inv]
    check("B5. invoices row source=morning_api", any(i["type"] == "עסקה" and i["source"] == "morning_api" for i in inv), str(inv))

    # mark paid -> no tax invoice yet -> RED + needs_tax
    r = requests.post(f"{APP_URL}/api/finance/mark-paid", cookies=money, headers={"Content-Type": "application/json"},
                      json={"job_id": job_id})
    ok = r.status_code == 200
    d = r.json() if ok else {}
    check("B6. mark paid accepted", ok, r.text[:120])
    check("B7. 'paid opens' -> state RED, needs_tax True", d.get("state") == "red" and d.get("needs_tax") is True, str(d))

    # issue tax invoice MANUALLY -> closed
    r = requests.post(f"{APP_URL}/api/finance/issue", cookies=money, headers={"Content-Type": "application/json"},
                      json={"job_id": job_id, "type": "מס", "mode": "manual", "doc_number": "TAX-9001",
                            "issued_at": "2026-07-10", "amount": 2000})
    ok = r.status_code == 200
    d = r.json() if ok else {}
    check("B8. issue מס manually accepted", ok, r.text[:120])
    check("B9. state -> closed", d.get("state") == "closed", str(d))
    inv = requests.get(rest(f"invoices?job_id=eq.{job_id}&select=id,type,source,doc_number"), headers=ADMIN).json()
    inv_ids = [i["id"] for i in inv]
    check("B10. tax invoice recorded source=manual", any(i["type"] == "מס" and i["source"] == "manual" for i in inv), str(inv))
    jrow = requests.get(rest(f"jobs?id=eq.{job_id}&select=invoice_tax,paid"), headers=ADMIN).json()[0]
    check("B11. job now paid=כן + invoice_tax set", jrow["paid"] == "כן" and bool(jrow["invoice_tax"]), str(jrow))

finally:
    if inv_ids:
        requests.delete(rest(f"invoices?id=in.({','.join(inv_ids)})"), headers=ADMIN)
    if job_id:
        requests.delete(rest(f"invoices?job_id=eq.{job_id}"), headers=ADMIN)
        requests.delete(rest(f"jobs?id=eq.{job_id}"), headers=ADMIN)
    if client_id:
        requests.delete(rest(f"clients?id=eq.{client_id}"), headers=ADMIN)
    if users:
        idl = ",".join(users)
        requests.delete(rest(f"events?actor_id=in.({idl})"), headers=ADMIN)
        for uid in users:
            rr = requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{uid}", headers=ADMIN)
            if rr.status_code >= 300:
                print("WARNING: user delete failed", uid, rr.status_code)
    print("cleaned up finance test data + users")

print()
if failures:
    print(f"{len(failures)} FAILURE(S):")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("ALL PASS")
