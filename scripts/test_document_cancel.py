# -*- coding: utf-8 -*-
"""
E2E for Feature 1 — mark a deal invoice CANCELLED (owner spec).

Requires migration 0043 applied (documents.cancelled_at/by/reason).

Isolated ZTESTCANCEL fixture: a client, a job carrying a deal-invoice number
(invoice_biz) + a mirrored invoices row + the deal-invoice document linked to
the job. Proves:
  1. can_edit_money required (a non-money user 403s)
  2. reason is mandatory (400 without one)
  3. cancel: doc.cancelled_at/reason set; job.invoice_biz cleared (job reopens);
     the mirrored invoices row is deleted; a document_cancelled event is written
  4. a second cancel 409s (already cancelled)
Self-cleaning in FK order.
"""
import base64, json, os, sys, time, uuid
import requests

for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]; SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
ref = U.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"

def rest(p): return f"{U}/rest/v1/{p}"
def ins(t, row):
    r = requests.post(rest(t), headers={**A, "Prefer": "return=representation"}, json=row); r.raise_for_status(); return r.json()[0]
def patch(t, q, row): requests.patch(rest(f"{t}?{q}"), headers=A, json=row)
def dele(t, q): requests.delete(rest(f"{t}?{q}"), headers=A)

passed = fail = 0
def check(name, ok):
    global passed, fail
    print(("  ✓ " if ok else "  ✗ ") + name); passed += ok; fail += (not ok)

for _ in range(90):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("dev server never came up"); sys.exit(1)

def mkuser(name, money):
    em = f"{name}-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    patch("profiles", f"id=eq.{uid}", {"name": name, "approved": True, "role": "bookkeeper" if money else "editor",
          "can_view_money": money, "can_edit_money": money, "can_view_stages": True})
    td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return uid, {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}

money_uid, money_ck = mkuser("ZTESTCANCEL_money", True)
tech_uid, tech_ck = mkuser("ZTESTCANCEL_tech", False)
client = ins("clients", {"name": "ZTESTCANCEL לקוח", "normalized_name": f"ztestcancel{uuid.uuid4().hex[:8]}",
                         "morning_client_id": f"mzc-{uuid.uuid4().hex[:8]}"})
docnum = str(40000000 + int(time.time()) % 1000000)
job = ins("jobs", {"client_id": client["id"], "amount": 1000, "campaign": "ZTESTCANCEL job",
                   "paid": "לא", "invoice_biz": docnum})
mdid = f"mzc-doc-{uuid.uuid4().hex}"
doc = ins("documents", {"morning_doc_id": mdid, "morning_doc_number": docnum, "type": 300, "status": 0,
                        "client_id": client["id"], "job_id": job["id"], "amount": 1000, "source": "pull"})
inv = ins("invoices", {"client_id": client["id"], "job_id": job["id"], "type": "עסקה",
                       "doc_number": docnum, "morning_doc_id": mdid, "amount": 1000, "source": "morning_api"})

try:
    # 1. tech (no money) blocked
    r = requests.post(f"{APP}/api/documents/{doc['id']}/cancel", cookies=tech_ck,
                      headers={"Content-Type": "application/json"}, json={"reason": "x"})
    check("non-money user 403", r.status_code == 403)

    # 2. reason required
    r = requests.post(f"{APP}/api/documents/{doc['id']}/cancel", cookies=money_ck,
                      headers={"Content-Type": "application/json"}, json={"reason": "  "})
    check("empty reason 400", r.status_code == 400)

    # 3. cancel
    r = requests.post(f"{APP}/api/documents/{doc['id']}/cancel", cookies=money_ck,
                      headers={"Content-Type": "application/json"}, json={"reason": "טעות במחיר"})
    check("cancel 200", r.status_code == 200)
    d2 = requests.get(rest(f"documents?id=eq.{doc['id']}&select=cancelled_at,cancelled_by,cancel_reason"), headers=A).json()[0]
    check("doc.cancelled_at set", bool(d2["cancelled_at"]))
    check("doc.cancel_reason = טעות במחיר", d2["cancel_reason"] == "טעות במחיר")
    check("doc.cancelled_by = money user", d2["cancelled_by"] == money_uid)
    j2 = requests.get(rest(f"jobs?id=eq.{job['id']}&select=invoice_biz"), headers=A).json()[0]
    check("job.invoice_biz cleared (reopened)", j2["invoice_biz"] is None)
    invleft = requests.get(rest(f"invoices?morning_doc_id=eq.{mdid}&select=id"), headers=A).json()
    check("mirrored invoices row deleted", invleft == [])
    ev = requests.get(rest(f"events?entity_id=eq.{doc['id']}&event_type=eq.document_cancelled&select=payload"), headers=A).json()
    check("document_cancelled event written", len(ev) >= 1 and ev[0]["payload"].get("reason") == "טעות במחיר")

    # 4. second cancel 409
    r = requests.post(f"{APP}/api/documents/{doc['id']}/cancel", cookies=money_ck,
                      headers={"Content-Type": "application/json"}, json={"reason": "again"})
    check("re-cancel 409", r.status_code == 409)
finally:
    dele("events", f"entity_id=eq.{doc['id']}")
    dele("events", f"entity_id=eq.{job['id']}")
    dele("invoices", f"morning_doc_id=eq.{mdid}")
    dele("documents", f"id=eq.{doc['id']}")
    dele("jobs", f"id=eq.{job['id']}")
    dele("clients", f"id=eq.{client['id']}")
    for uid in (money_uid, tech_uid):
        # events.actor_id references profiles(id) — null it so the auth-user
        # delete can cascade the profile away (else it leaks)
        patch("events", f"actor_id=eq.{uid}", {"actor_id": None})
        requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = requests.get(rest("profiles?name=like.ZTESTCANCEL*&select=id"), headers=A).json()

print(f"\n{passed} passed, {fail} failed · cleanup:", "ok" if left == [] else f"LEFT {left}")
sys.exit(1 if fail else 0)
