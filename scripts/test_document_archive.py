# -*- coding: utf-8 -*-
"""
E2E for the document archive feature (owner spec). Requires migration 0045.
No Morning calls. Proves, on an ISOLATED doc:
  1. can_edit_money required (tech 403) on both manual + bulk-count endpoints
  2. manual archive → archived_at/by/reason set + event; restore → cleared + event
  3. GET /api/documents/archive returns a qualifying count (>=1, our fresh doc)
Self-cleaning. (The real bulk POST on the 277 is exercised by run_archive_now.py
with before/after verification, since it is a global operation.)
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

money_uid, money_ck = mkuser("ZTESTARCH_money", True)
tech_uid, tech_ck = mkuser("ZTESTARCH_tech", False)
# an isolated unassigned doc that qualifies: unmapped morning client, old, no job
mdid = f"mza-{uuid.uuid4().hex}"
doc = ins("documents", {"morning_doc_id": mdid, "morning_doc_number": str(90000000 + int(time.time()) % 1000000),
                        "type": 300, "status": 1, "client_id": None, "job_id": None,
                        "morning_client_id": f"ZTESTARCH-unmapped-{uuid.uuid4().hex[:8]}",
                        "morning_client_name": "ZTESTARCH ghost", "amount": 500, "document_date": "2024-01-01", "source": "pull"})

def arch(ck, action):
    return requests.post(f"{APP}/api/documents/{doc['id']}/archive", cookies=ck,
                         headers={"Content-Type": "application/json"}, json={"action": action})

try:
    check("tech manual 403", arch(tech_ck, "archive").status_code == 403)
    check("tech bulk-count 403", requests.get(f"{APP}/api/documents/archive", cookies=tech_ck).status_code == 403)

    check("archive 200", arch(money_ck, "archive").status_code == 200)
    d = requests.get(rest(f"documents?id=eq.{doc['id']}&select=archived_at,archived_by,archive_reason"), headers=A).json()[0]
    check("archived_at/by/reason set", bool(d["archived_at"]) and d["archived_by"] == money_uid and bool(d["archive_reason"]))
    ev = requests.get(rest(f"events?entity_id=eq.{doc['id']}&event_type=eq.document_archived&select=id"), headers=A).json()
    check("archive event", len(ev) >= 1)

    check("restore 200", arch(money_ck, "restore").status_code == 200)
    d = requests.get(rest(f"documents?id=eq.{doc['id']}&select=archived_at"), headers=A).json()[0]
    check("archived_at cleared", d["archived_at"] is None)
    ev = requests.get(rest(f"events?entity_id=eq.{doc['id']}&event_type=eq.document_restored&select=id"), headers=A).json()
    check("restore event", len(ev) >= 1)

    gc = requests.get(f"{APP}/api/documents/archive", cookies=money_ck)
    check("bulk count returns our fresh qualifying doc", gc.status_code == 200 and gc.json().get("qualifying", 0) >= 1)
finally:
    dele("events", f"entity_id=eq.{doc['id']}")
    dele("documents", f"id=eq.{doc['id']}")
    for uid in (money_uid, tech_uid):
        patch("events", f"actor_id=eq.{uid}", {"actor_id": None})
        patch("documents", f"archived_by=eq.{uid}", {"archived_by": None})
        requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = requests.get(rest("profiles?name=like.ZTESTARCH*&select=id"), headers=A).json()

print(f"\n{passed} passed, {fail} failed · cleanup:", "ok" if left == [] else f"LEFT {left}")
sys.exit(1 if fail else 0)
