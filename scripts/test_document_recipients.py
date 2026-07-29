# -*- coding: utf-8 -*-
"""
E2E for document recipient selection + send log (owner spec 2026-07-29).

DRY_RUN server only (issuance short-circuits — NO real Morning document/email).
The live-client-email read hits Morning GET /clients/{id} with a FAKE id, which
fails fast and exercises the graceful-degrade path. Run against :3100 launched
with MORNING_DRY_RUN=true.

Proves (owner correction 2026-07-29 — defaults are the CLIENT's emails, our
accountant address is only an optional extra, never a default):
  1. app_settings.accountant_email still seeded/kept by 0048
  2. recipients endpoint: defaults are client emails only; the accountant address
     is RETURNED as an option but NOT in defaultSelected; a fake client (no live
     emails) yields empty defaults and clientFetchFailed, never blocking
  3. single approve with explicit recipients -> capped+deduped to 3, injected into
     the Morning request's client.emails, stored in pending_documents.sent_to +
     documents.sent_to, and a document_sent audit event
  4. work order approved with no recipients -> sent to NOBODY (sent_to = []), no
     document_sent event
  5. deal invoice, no recipients, no client emails -> nobody (accountant NOT
     defaulted): sent_to = []
Self-cleaning in FK order.
"""
import base64, json, os, sys, time, uuid
import requests

for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]; SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3100")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
ref = U.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"
ACCT = "billing@bi-zi.co.il"

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

for _ in range(60):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)

def mkuser():
    em = f"ZTESTRCP-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    patch("profiles", f"id=eq.{uid}", {"name": "ZTESTRCP", "approved": True, "role": "bookkeeper",
          "can_view_money": True, "can_edit_money": True, "can_view_stages": True, "can_edit_stages": True})
    td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return uid, {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}

uid, ck = mkuser()
cli = ins("clients", {"name": "ZTESTRCP " + uuid.uuid4().hex[:5], "normalized_name": f"ztestrcp{uuid.uuid4().hex[:8]}",
                      "morning_client_id": f"mzr-{uuid.uuid4().hex[:8]}", "billing_cadence": "per_episode"})
show = ins("shows", {"name": "ZTESTRCP show " + uuid.uuid4().hex[:5], "client_id": cli["id"], "billing_mode": "per_episode", "default_rate": 700})

def mkprod(date):
    return requests.post(f"{APP}/api/productions", cookies=ck, headers={"Content-Type": "application/json"},
                         json={"show_id": show["id"], "record_date": date}).json().get("id")
def wo_of(pid):
    return get(f"pending_documents?production_id=eq.{pid}&doc_type=eq.work_order&select=id,status")[0]
def approve(ids, extra):
    return requests.post(f"{APP}/api/documents/pending/review", cookies=ck, headers={"Content-Type": "application/json"},
                         json={"ids": ids, "action": "approve", **extra})
def sent_of(pdid):
    return get(f"pending_documents?id=eq.{pdid}&select=sent_to,morning_doc_id")[0]
def call_sent(pdid):
    ev = get(f"events?entity_id=eq.{pdid}&event_type=eq.morning_call_started&select=payload&order=created_at.desc&limit=1")
    return (ev[0]["payload"]["sent"] if ev else {})

prod_ids = []
mdids = []
try:
    # 1. accountant seeded
    aset = get("app_settings?id=eq.true&select=accountant_email")
    check("1 app_settings.accountant_email = billing@bi-zi.co.il", aset and aset[0]["accountant_email"] == ACCT)

    # 2. recipients endpoint defaults (fake morning client -> fetch fails, degrades)
    p1 = mkprod("2026-07-25"); prod_ids.append(p1)
    wo1 = wo_of(p1)
    rc = requests.get(f"{APP}/api/documents/pending/{wo1['id']}/recipients", cookies=ck).json()
    check("2 work_order default = nobody", rc.get("defaultSelected") == [] and rc.get("docType") == "work_order")
    check("2 accountant returned as an OPTION + clientFetchFailed reported",
          rc.get("accountantEmail") == ACCT and rc.get("clientFetchFailed") is True)

    # deal invoice: approve production -> deal_invoice enqueued -> default = client
    # emails only. Fake client has no live emails, so default is empty AND the
    # accountant is offered but NOT pre-selected (the core of the correction).
    requests.post(f"{APP}/api/productions/{p1}", cookies=ck, headers={"Content-Type": "application/json"},
                  json={"status": 'אושר_ע"י_לקוח'})
    di = get(f"pending_documents?production_id=eq.{p1}&doc_type=eq.deal_invoice&select=id")[0]
    rc2 = requests.get(f"{APP}/api/documents/pending/{di['id']}/recipients", cookies=ck).json()
    check("2 deal_invoice default = client emails only (empty for fake client)", rc2.get("defaultSelected") == [])
    check("2 accountant offered but NOT defaulted", rc2.get("accountantEmail") == ACCT and ACCT not in (rc2.get("defaultSelected") or []))

    # 3. single approve work order with explicit recipients -> cap 3 + dedup + inject + log
    dupey = ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "A@x.com"]  # 5 with a dup -> 3
    r = approve([wo1["id"]], {"recipients": dupey})
    check("3 approve 200 dry_run", r.status_code == 200 and r.json().get("dry_run") is True)
    sent = call_sent(wo1["id"])
    check("3 client.emails injected, capped+deduped to 3", sent.get("client", {}).get("emails") == ["a@x.com", "b@x.com", "c@x.com"])
    row = sent_of(wo1["id"])
    if row["morning_doc_id"]: mdids.append(row["morning_doc_id"])
    check("3 pending_documents.sent_to = the 3", row["sent_to"] == ["a@x.com", "b@x.com", "c@x.com"])
    doc = get(f"documents?morning_doc_id=eq.{row['morning_doc_id']}&select=sent_to")
    check("3 documents.sent_to mirrored", doc and doc[0]["sent_to"] == ["a@x.com", "b@x.com", "c@x.com"])
    ds = get(f"events?entity_id=eq.{wo1['id']}&event_type=eq.document_sent&select=payload")
    check("3 document_sent event with 3 recipients", ds and ds[0]["payload"]["recipients"] == ["a@x.com", "b@x.com", "c@x.com"])

    # 4. work order approved with NO recipients -> nobody, no send event
    p2 = mkprod("2026-07-26"); prod_ids.append(p2)
    wo2 = wo_of(p2)
    approve([wo2["id"]], {})  # no recipients -> default work_order = []
    row2 = sent_of(wo2["id"])
    if row2["morning_doc_id"]: mdids.append(row2["morning_doc_id"])
    sent2 = call_sent(wo2["id"])
    check("4 work order sent_to = [] (nobody)", row2["sent_to"] == [])
    check("4 client.emails empty in the request", sent2.get("client", {}).get("emails") == [])
    ds2 = get(f"events?entity_id=eq.{wo2['id']}&event_type=eq.document_sent&select=id")
    check("4 no document_sent event", ds2 == [])

    # 5. deal invoice approved with NO recipients and no client emails -> nobody
    #    (accountant is NOT a default). sent_to = [].
    approve([di["id"]], {})
    rowdi = sent_of(di["id"])
    if rowdi["morning_doc_id"]: mdids.append(rowdi["morning_doc_id"])
    check("5 deal invoice default sent_to = [] (accountant not defaulted)", rowdi["sent_to"] == [])

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
    for pid in prod_ids:
        dele("events", f"entity_id=eq.{pid}")
        dele("productions", f"id=eq.{pid}")
    dele("shows", f"id=eq.{show['id']}")
    dele("clients", f"id=eq.{cli['id']}")
    patch("events", f"actor_id=eq.{uid}", {"actor_id": None})
    requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = get("profiles?name=like.ZTESTRCP*&select=id")
    print(f"\n{passed} passed, {fail} failed · cleanup:", "ok" if left == [] else f"LEFT {left}")
    sys.exit(1 if fail else 0)
