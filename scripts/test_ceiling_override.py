# -*- coding: utf-8 -*-
"""
D3 — admin override of PULL_NET_CEILING, on the real document it was written
for (40258, 250,000 net / 295,000 gross, the Yedioth contract's milestone B).

Run:  npx next dev   (in another shell)
      python3 scripts/test_ceiling_override.py

TOUCHES MORNING: never. The override only builds a `pending_documents` row;
the single Morning call in the system lives in issue.ts behind human approval,
and nothing here approves anything.

TOUCHES REAL DATA: yes — 40258 itself, because a synthetic 295K document would
not prove the thing that matters. Every row created is deleted in the finally
block, jobs.invoice_tax is captured and restored, and both are VERIFIED before
this script reports success.

The two checks that carry the whole feature are 7 and 8: after an override has
produced a tax document, a second attempt — WITH a full valid override — is
refused by two independent downstream gates. If those ever go green-to-red,
the override has become a way to bill a client twice for 295,000 ₪.
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
MARK = "ZCEILING"
TARGET_NUMBER = "40258"

failures = []


def check(label, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  — {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(label)


def rest(p):
    return f"{SUPABASE_URL}/rest/v1/{p}"


def b64(b):
    return base64.b64encode(b).decode()


users = []
made_pending = []
job_tax_restore = {}   # job_id -> original invoice_tax


def mkuser(flags):
    em = f"ceiling-{uuid.uuid4().hex[:8]}@bizi-test.local"
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


def tax(cookies, **body):
    return requests.post(f"{APP_URL}/api/documents/tax", cookies=cookies,
                         headers={"Content-Type": "application/json"}, json=body)


def live_tax_rows(doc_morning_id):
    """Any live tax row linked to this parent — the thing gate 387 keys on."""
    rows = requests.get(rest("pending_documents?select=id,doc_type,status,amount,payload"),
                        headers=ADMIN).json()
    out = []
    for r in rows:
        p = r.get("payload") or {}
        if r["doc_type"] in ("tax_invoice", "tax_receipt") and r["status"] in ("pending", "approved", "issued"):
            if doc_morning_id in (p.get("linkedDocumentIds") or []):
                out.append(r)
    return out


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
    # ---- the target, and its openness --------------------------------------
    docs = requests.get(rest(f"documents?select=id,morning_doc_id,morning_doc_number,type,status,amount,source,job_id,updated_at,raw&morning_doc_number=eq.{TARGET_NUMBER}"),
                        headers=ADMIN).json()
    check(f"0a. {TARGET_NUMBER} found", len(docs) == 1, str(len(docs)))
    d = docs[0]
    doc_id, morning_id, job_id = d["id"], d["morning_doc_id"], d["job_id"]
    raw = d["raw"] or {}
    net = raw.get("amountExcludeVat")
    allowed = raw.get("ref") or []
    check("0b. openness still allows a 305", 305 in allowed, f"ref={allowed}")
    check("0c. net is 250,000 and gross 295,000", net == 250000 and d["amount"] == 295000,
          f"net={net} gross={d['amount']}")
    check("0d. has a linked job (gate 429 will pass)", bool(job_id), str(job_id))
    print(f"        pulled at {d['updated_at']}  ·  ref={allowed}")

    # a clean slate: no live tax row on this parent before we start
    check("0e. no live tax document on it yet", len(live_tax_rows(morning_id)) == 0)

    money = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True,
                    "can_manage_users": False})
    boss = mkuser({"role": "owner", "can_view_money": True, "can_edit_money": True,
                   "can_manage_users": True})

    # ---- 1. no override: the ceiling holds, nothing is written --------------
    r = tax(money, documentIds=[doc_id])
    check("1a. refused by the ceiling", r.status_code == 400 and "תקרת" in r.text, f"{r.status_code} {r.text[:120]}")
    check("1b. nothing was written", len(live_tax_rows(morning_id)) == 0)

    # ---- 2. permission: can_edit_money is NOT enough -----------------------
    r = tax(money, documentIds=[doc_id], overCeiling=True, overCeilingReason="ניסיון")
    check("2. non-admin override refused (403)", r.status_code == 403, f"{r.status_code} {r.text[:120]}")

    # ---- 3. reason is mandatory --------------------------------------------
    r = tax(boss, documentIds=[doc_id], overCeiling=True, overCeilingReason="   ")
    check("3. override without a reason refused (400)", r.status_code == 400, f"{r.status_code} {r.text[:120]}")

    # ---- 4. call one: warned, ticketed, and NOTHING written -----------------
    r = tax(boss, documentIds=[doc_id], overCeiling=True, overCeilingReason=f"{MARK} אבן דרך ב")
    b = r.json()
    oc = (b.get("over_ceiling") or {})
    ticket = oc.get("ticket")
    check("4a. first call refused with needs_confirmation (409)",
          r.status_code == 409 and b.get("needs_confirmation") is True, f"{r.status_code} {r.text[:160]}")
    check("4b. it reports the real numbers", oc.get("net") == 250000 and oc.get("ceiling") == 10000,
          json.dumps(oc, ensure_ascii=False)[:160])
    check("4c. a ticket was minted", bool(ticket))
    check("4d. still nothing written", len(live_tax_rows(morning_id)) == 0)

    # ---- 5. the ticket is not forgeable ------------------------------------
    r = tax(boss, documentIds=[doc_id], overCeiling=True, overCeilingReason="x",
            overCeilingTicket="not-a-ticket")
    check("5a. malformed ticket refused", r.status_code == 409, f"{r.status_code} {r.text[:120]}")
    tampered = ticket[:-4] + ("0000" if not ticket.endswith("0000") else "1111")
    r = tax(boss, documentIds=[doc_id], overCeiling=True, overCeilingReason="x",
            overCeilingTicket=tampered)
    check("5b. tampered signature refused", r.status_code == 409, f"{r.status_code} {r.text[:120]}")
    # another admin's ticket must not work for this admin
    r = tax(money, documentIds=[doc_id], overCeiling=True, overCeilingReason="x", overCeilingTicket=ticket)
    check("5c. a ticket does not grant permission (still 403)", r.status_code == 403, str(r.status_code))
    check("5d. nothing written by any forgery attempt", len(live_tax_rows(morning_id)) == 0)

    # ---- 6. call two: the override goes through ----------------------------
    reason = f"{MARK} אבן דרך ב׳ בחוזה ידיעות — סוכם מול הלקוח"
    r = tax(boss, documentIds=[doc_id], overCeiling=True, overCeilingReason=reason,
            overCeilingTicket=ticket)
    b = r.json()
    check("6a. accepted", r.status_code == 200 and b.get("ok"), f"{r.status_code} {r.text[:200]}")
    td = b.get("tax_document") or {}
    if td.get("id"):
        made_pending.append(td["id"])
    check("6b. amount is the proven net, unchanged", td.get("amount") == 250000, str(td.get("amount")))
    payload = td.get("payload") or {}
    inc = payload.get("income") or []
    check("6c. exactly one income line, inherited verbatim",
          len(inc) == 1
          and inc[0]["price"] == 250000
          and inc[0]["quantity"] == 1
          and inc[0]["description"] == (raw["income"][0]["description"]),
          json.dumps(inc, ensure_ascii=False)[:200])
    check("6d. linked to the parent (closes it in Morning)",
          morning_id in (payload.get("linkedDocumentIds") or []),
          json.dumps(payload.get("linkedDocumentIds"), ensure_ascii=False))
    check("6e. the printed remark names the parent",
          TARGET_NUMBER in (payload.get("remarks") or ""), str(payload.get("remarks")))
    row = requests.get(rest(f"pending_documents?id=eq.{td['id']}&select=bundle_job_ids,amount"), headers=ADMIN).json()[0]
    check("6f. stamps the milestone's job on issuance", job_id in (row["bundle_job_ids"] or []),
          json.dumps(row["bundle_job_ids"]))

    # ---- 7. THE HEADLINE: a second override cannot bill it twice -----------
    r2 = tax(boss, documentIds=[doc_id], overCeiling=True, overCeilingReason=reason)
    b2 = r2.json()
    t2 = (b2.get("over_ceiling") or {}).get("ticket")
    if t2:
        r2 = tax(boss, documentIds=[doc_id], overCeiling=True, overCeilingReason=reason,
                 overCeilingTicket=t2)
        b2 = r2.json()
    check("7a. second attempt refused (409) — gate 387, idempotency",
          r2.status_code == 409 and "כבר קיים מסמך מס" in r2.text, f"{r2.status_code} {r2.text[:200]}")
    check("7b. still exactly ONE tax document on this parent",
          len(live_tax_rows(morning_id)) == 1, str(len(live_tax_rows(morning_id))))

    # ---- 8. the SECOND, independent guard: jobs.invoice_tax ----------------
    # Remove the row gate 387 keys on, so only the job gate can stop it. This is
    # the real-world case gate 443 exists for: a tax document raised BY HAND in
    # Morning and stamped onto the job by reconciliation, with no queue row.
    for pid in list(made_pending):
        requests.delete(rest(f"events?entity_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"pending_documents?id=eq.{pid}"), headers=ADMIN)
        made_pending.remove(pid)
    check("8a. queue row removed, gate 387 can no longer fire",
          len(live_tax_rows(morning_id)) == 0)

    before_tax = requests.get(rest(f"jobs?id=eq.{job_id}&select=invoice_tax"), headers=ADMIN).json()[0]["invoice_tax"]
    job_tax_restore[job_id] = before_tax
    requests.patch(rest(f"jobs?id=eq.{job_id}"), headers=ADMIN, json={"invoice_tax": "99999"})

    r3 = tax(boss, documentIds=[doc_id], overCeiling=True, overCeilingReason=reason)
    b3 = r3.json()
    t3 = (b3.get("over_ceiling") or {}).get("ticket")
    if t3:
        r3 = tax(boss, documentIds=[doc_id], overCeiling=True, overCeilingReason=reason,
                 overCeilingTicket=t3)
    check("8b. refused (409) — gate 443, the job already carries a tax document",
          r3.status_code == 409 and "כבר נושאת חשבונית מס" in r3.text, f"{r3.status_code} {r3.text[:200]}")
    check("8c. nothing written by the blocked attempt", len(live_tax_rows(morning_id)) == 0)

    # ---- 9. the audit trail -------------------------------------------------
    evs = requests.get(rest(f"events?entity_id=eq.{doc_id}&event_type=eq.tax_ceiling_overridden&select=actor_id,payload"),
                       headers=ADMIN).json()
    check("9a. every override attempt is evented", len(evs) >= 1, f"{len(evs)} events")
    if evs:
        p = evs[0]["payload"]
        check("9b. the event carries net, ceiling, gross, reason and confirmation",
              p.get("net") == 250000 and p.get("ceiling") == 10000 and p.get("gross") == 295000
              and MARK in (p.get("reason") or "") and p.get("confirmed") is True,
              json.dumps(p, ensure_ascii=False)[:220])
        check("9c. the actor is recorded", bool(evs[0]["actor_id"]))

finally:
    print("\n--- cleanup ---")
    for pid in made_pending:
        requests.delete(rest(f"events?entity_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"pending_documents?id=eq.{pid}"), headers=ADMIN)
    for jid, original in job_tax_restore.items():
        requests.patch(rest(f"jobs?id=eq.{jid}"), headers=ADMIN, json={"invoice_tax": original})
    try:
        requests.delete(rest(f"events?event_type=eq.tax_ceiling_overridden&entity_id=eq.{doc_id}"), headers=ADMIN)
    except Exception:
        pass
    for uid in users:
        requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=ADMIN)
        requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{uid}", headers=ADMIN)

    # verified, never assumed
    left = live_tax_rows(morning_id) if 'morning_id' in dir() else []
    check("cleanup: no tax document left on the parent", len(left) == 0, json.dumps(left)[:160])
    for jid, original in job_tax_restore.items():
        now = requests.get(rest(f"jobs?id=eq.{jid}&select=invoice_tax"), headers=ADMIN).json()[0]["invoice_tax"]
        check(f"cleanup: job {jid[:8]} invoice_tax restored", now == original, f"{now!r} vs {original!r}")
    total = requests.get(rest("pending_documents?select=id"), headers=ADMIN).json()
    check("cleanup: pending_documents back to 35", len(total) == 35, str(len(total)))


print()
if failures:
    print(f"{len(failures)} FAILED: " + " · ".join(failures))
    sys.exit(1)
print("all checks passed")
