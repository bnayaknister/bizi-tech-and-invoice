# -*- coding: utf-8 -*-
"""
E2E for the document-DATE fix (owner bug 2026-07-29): a Morning document's date
must be the ISSUANCE date (today, Israel TZ), never the recording/job date.
Also verifies the retry path on a status=failed row.

DRY_RUN server only (issuance short-circuits — NO real Morning call). Run against
:3100 launched with MORNING_DRY_RUN=true.

Proves:
  1. enqueue: a work order for a production recorded a month ago carries
     payload.date = TODAY (Israel), not the record_date
  2. issue (DRY_RUN): the morning_call_started event's sent.date = TODAY, and the
     registry documents.document_date = TODAY
  3. retry: a status=failed row can be re-issued via the review 'approve' path
     (the "נסה שוב" button) and lands issued
Self-cleaning in FK order.
"""
import base64, json, os, sys, time, uuid
from datetime import datetime
from zoneinfo import ZoneInfo
import requests

for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]; SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3100")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
ref = U.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"
TODAY_IL = datetime.now(ZoneInfo("Asia/Jerusalem")).strftime("%Y-%m-%d")

def rest(p): return f"{U}/rest/v1/{p}"
def ins(t, row):
    r = requests.post(rest(t), headers={**A, "Prefer": "return=representation"}, json=row); r.raise_for_status(); return r.json()[0]
def get(t): return requests.get(rest(t), headers=A).json()
def patch(t, q, row): requests.patch(rest(f"{t}?{q}"), headers=A, json=row)
def dele(t, q): requests.delete(rest(f"{t}?{q}"), headers=A)

passed = fail = 0
def check(name, ok):
    global passed, fail
    print(("  ✓ " if ok else "  ✗ ") + name); passed += ok; fail += (not ok)

# confirm dry-run server
for _ in range(60):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)

def mkuser():
    em = f"ZTESTDATE-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    patch("profiles", f"id=eq.{uid}", {"name": "ZTESTDATE", "approved": True, "role": "bookkeeper",
          "can_view_money": True, "can_edit_money": True, "can_view_stages": True, "can_edit_stages": True})
    td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return uid, {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}

uid, ck = mkuser()
cli = ins("clients", {"name": "ZTESTDATE " + uuid.uuid4().hex[:5], "normalized_name": f"ztestdate{uuid.uuid4().hex[:8]}",
                      "morning_client_id": f"mzd-{uuid.uuid4().hex[:8]}", "billing_cadence": "per_episode"})
show = ins("shows", {"name": "ZTESTDATE show " + uuid.uuid4().hex[:5], "client_id": cli["id"], "billing_mode": "per_episode", "default_rate": 900})

prod_id = None
mdids = []
failed_id = None
try:
    print(f"today (Israel) = {TODAY_IL}")
    # 1. production recorded a MONTH ago → work order enqueued
    r = requests.post(f"{APP}/api/productions", cookies=ck, headers={"Content-Type": "application/json"},
                      json={"show_id": show["id"], "record_date": "2026-06-15"})
    prod_id = r.json().get("id")
    wo = get(f"pending_documents?production_id=eq.{prod_id}&doc_type=eq.work_order&select=id,payload,status")[0]
    check("1 enqueued work order date = TODAY, not record_date",
          wo["payload"].get("date") == TODAY_IL and wo["payload"].get("date") != "2026-06-15")
    check("1 record_date still in the line description",
          "2026-06-15" in (wo["payload"].get("description") or ""))

    # 2. approve (DRY_RUN → no real Morning call) → sent.date + registry date = TODAY
    ap = requests.post(f"{APP}/api/documents/pending/review", cookies=ck, headers={"Content-Type": "application/json"},
                       json={"ids": [wo["id"]], "action": "approve"})
    check("2 approve 200 dry_run", ap.status_code == 200 and ap.json().get("dry_run") is True)
    md = get(f"pending_documents?id=eq.{wo['id']}&select=morning_doc_id,status")[0]
    if md["morning_doc_id"]: mdids.append(md["morning_doc_id"])
    ev = get(f"events?entity_id=eq.{wo['id']}&event_type=eq.morning_call_started&select=payload&order=created_at.desc&limit=1")
    check("2 morning_call_started sent.date = TODAY", ev and ev[0]["payload"]["sent"].get("date") == TODAY_IL)
    if md["morning_doc_id"]:
        doc = get(f"documents?morning_doc_id=eq.{md['morning_doc_id']}&select=document_date")
        check("2 registry document_date = TODAY", doc and doc[0]["document_date"] == TODAY_IL)

    # 3. retry path: a status=failed row re-issues via the review approve ("נסה שוב")
    failed = ins("pending_documents", {
        "doc_type": "deal_invoice", "client_id": cli["id"], "amount": 900, "status": "failed",
        "attempts": 1, "last_error": "התאריך שנבחר עתידי או מוקדם מדי לסוג מסמך זה",
        "payload": {"type": 300, "lang": "he", "currency": "ILS", "vatType": 0, "date": "2026-06-15",
                    "description": "חשבון עסקה — ישן", "client": {"id": cli["morning_client_id"], "add": False},
                    "income": [{"description": "פרק 2026-06-15", "quantity": 1, "price": 900, "currency": "ILS", "vatType": 0}]},
    })
    failed_id = failed["id"]
    ap2 = requests.post(f"{APP}/api/documents/pending/review", cookies=ck, headers={"Content-Type": "application/json"},
                        json={"ids": [failed_id], "action": "approve"})
    ok2 = ap2.status_code == 200 and (ap2.json().get("results") or [{}])[0].get("ok")
    check("3 retry a failed row → issues (review accepts status=failed)", ok2)
    after = get(f"pending_documents?id=eq.{failed_id}&select=status,morning_doc_id")[0]
    check("3 failed row now issued", after["status"] == "issued")
    if after["morning_doc_id"]: mdids.append(after["morning_doc_id"])
    ev2 = get(f"events?entity_id=eq.{failed_id}&event_type=eq.morning_call_started&select=payload&order=created_at.desc&limit=1")
    check("3 retry re-stamped date = TODAY (not the stale 2026-06-15)",
          ev2 and ev2[0]["payload"]["sent"].get("date") == TODAY_IL)

finally:
    for md in mdids:
        dele("invoices", f"morning_doc_id=eq.{md}")
        dele("documents", f"morning_doc_id=eq.{md}")
    jobs = get(f"jobs?client_id=eq.{cli['id']}&select=id")
    for j in jobs:
        dele("job_productions", f"job_id=eq.{j['id']}")
        dele("events", f"entity_id=eq.{j['id']}")
    dele("jobs", f"client_id=eq.{cli['id']}")
    pds = get(f"pending_documents?client_id=eq.{cli['id']}&select=id")
    for pd in pds:
        dele("events", f"entity_id=eq.{pd['id']}")
    dele("pending_documents", f"client_id=eq.{cli['id']}")
    if prod_id:
        dele("events", f"entity_id=eq.{prod_id}")
        dele("productions", f"id=eq.{prod_id}")
    dele("shows", f"id=eq.{show['id']}")
    dele("clients", f"id=eq.{cli['id']}")
    patch("events", f"actor_id=eq.{uid}", {"actor_id": None})
    requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = get("profiles?name=like.ZTESTDATE*&select=id")

print(f"\n{passed} passed, {fail} failed · cleanup:", "ok" if left == [] else f"LEFT {left}")
sys.exit(1 if fail else 0)
