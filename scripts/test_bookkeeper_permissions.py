# -*- coding: utf-8 -*-
"""
Bookkeeper (שירי) permission preset — owner acceptance test 2026-07-21.
Preset: can_view_money + can_edit_money + can_view_stages + can_import;
NOT can_edit_stages, NOT can_manage_users. She sees productions/shows but
edits nothing there; she marks paid, issues/approves documents, imports,
maps clients.

The owner's six cases:
  1. change a production status -> 403
  2. drag in the kanban -> blocked (same status endpoint -> 403; the UI also
     disables drag when can_edit_stages is false)
  3. edit a show's name / aliases / studio -> 403
  4. view the productions + shows screens (read) -> ok
  5. mark a job paid -> ok
  6. approve a document in the queue -> authorized (a tech is 403 here)

Safe with MORNING_DRY_RUN=false: case 6 approves a doc whose client maps to a
FAKE Morning id, so the issuance is rejected by Morning (no real document);
we assert only that שירי was AUTHORIZED (not 403) and that nothing real was
issued.
"""
import base64, json, os, sys, time, uuid
from datetime import datetime, timezone
import requests

ENV = os.path.join(os.path.dirname(__file__), "..", ".env.local")
if os.path.exists(ENV):
    with open(ENV, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

SUP = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SVC = os.environ["SUPABASE_SERVICE_ROLE_KEY"]; APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
ADMIN = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}
REPR = {**ADMIN, "Prefer": "return=representation"}
ref = SUP.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"
MARK = "ZTESTBK"
failures = []; users = []; show_id = None; prod_id = None; client_id = None; job_id = None; pend_id = None


def check(l, ok, d=""):
    print(("PASS  " if ok else "FAIL  ") + l + (f"  [{d}]" if d and not ok else ""))
    if not ok: failures.append(l)


def rest(p): return f"{SUP}/rest/v1/{p}"
def b64(r): return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags):
    em = f"bk-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"T-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{SUP}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers=REPR, json={"name": MARK, "approved": True, **flags})
    td = requests.post(f"{SUP}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {CN: "base64-" + b64(json.dumps(sess).encode())}


for _ in range(60):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("FAIL dev server never came up"); sys.exit(1)

try:
    # שירי's exact preset
    shiri = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True,
                    "can_view_stages": True, "can_import": True})
    tech = mkuser({"role": "tech", "can_view_stages": True, "can_edit_stages": True})

    client_id = requests.post(rest("clients"), headers=REPR,
                              json={"name": f"{MARK} c", "normalized_name": f"ztb{uuid.uuid4().hex[:6]}",
                                    "morning_client_id": f"ztb-m-{uuid.uuid4().hex[:8]}"}).json()[0]["id"]
    show_id = requests.post(rest("shows"), headers=REPR,
                            json={"name": f"{MARK} show", "aliases": ["a1"], "client_id": client_id,
                                  "billing_mode": "per_episode", "default_studio": "st", "active": True}).json()[0]["id"]
    prod_id = requests.post(rest("productions"), headers=REPR,
                            json={"podcast_name": f"{MARK} p", "show_id": show_id, "client_id": client_id,
                                  "kind": "client", "record_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                                  "status": "בעריכה", "legacy": False}).json()[0]["id"]

    def as_shiri(method, path, **kw):
        return requests.request(method, f"{APP}{path}", cookies=shiri, **kw)

    # 1. status change -> 403
    r = as_shiri("POST", f"/api/productions/{prod_id}", headers={"Content-Type": "application/json"},
                 json={"status": "נערך"})
    check("1. שירי change production status -> 403", r.status_code == 403, f"{r.status_code} {r.text[:100]}")

    # 2. drag == the same status endpoint (UI also disables drag)
    r = as_shiri("POST", f"/api/productions/{prod_id}", headers={"Content-Type": "application/json"},
                 json={"status": "הופץ"})
    check("2. שירי kanban drag (status endpoint) -> 403", r.status_code == 403, str(r.status_code))

    # 3. edit show name / aliases / studio -> 403
    for field, val in (("name", "hacked"), ("aliases", "x,y"), ("default_studio", "z")):
        r = as_shiri("POST", f"/api/entity/show/{show_id}", headers={"Content-Type": "application/json"},
                     json={"patch": {field: val}})
        check(f"3. שירי edit show {field} -> 403", r.status_code == 403, f"{r.status_code} {r.text[:80]}")

    # 4. view productions + shows (read) -> ok
    r = as_shiri("GET", f"/api/entity/production/{prod_id}")
    check("4a. שירי views a production (read)", r.status_code == 200, str(r.status_code))
    r = as_shiri("GET", f"/api/entity/show/{show_id}")
    check("4b. שירי views a show (read)", r.status_code == 200, str(r.status_code))
    r = as_shiri("GET", "/productions")
    check("4c. שירי loads the productions screen", r.status_code == 200, str(r.status_code))

    # 5. mark a job paid -> ok
    job_id = requests.post(rest("jobs"), headers=REPR,
                           json={"client_id": client_id, "campaign": f"{MARK} job", "amount": 100,
                                 "paid": "לא", "date": "2026-07-01", "legacy": False}).json()[0]["id"]
    r = as_shiri("POST", "/api/finance/mark-paid", headers={"Content-Type": "application/json"},
                 json={"job_id": job_id})
    check("5. שירי marks a job paid -> ok", r.status_code == 200, f"{r.status_code} {r.text[:100]}")

    # 6. approve a document in the queue -> authorized (tech is 403)
    pend_id = requests.post(rest("pending_documents"), headers=REPR,
                            json={"doc_type": "work_order", "production_id": prod_id, "client_id": client_id,
                                  "amount": 1, "payload": {"type": 100, "lang": "he", "currency": "ILS", "vatType": 0,
                                  "client": {"id": "ztb-fake", "add": False},
                                  "income": [{"description": "t", "quantity": 1, "price": 1, "currency": "ILS", "vatType": 0}]},
                                  "status": "pending"}).json()[0]["id"]
    r = requests.post(f"{APP}/api/documents/pending/review", cookies=tech,
                      headers={"Content-Type": "application/json"}, json={"ids": [pend_id], "action": "approve"})
    check("6a. a technician CANNOT approve (403)", r.status_code == 403, str(r.status_code))
    r = as_shiri("POST", "/api/documents/pending/review", headers={"Content-Type": "application/json"},
                 json={"ids": [pend_id], "action": "approve"})
    check("6b. שירי is authorized to approve (not 403)", r.status_code != 403, f"{r.status_code} {r.text[:120]}")
    row = requests.get(rest(f"pending_documents?id=eq.{pend_id}&select=status,morning_doc_id"), headers=ADMIN).json()[0]
    check("6c. no real Morning doc was issued (fake client rejected)", row["morning_doc_id"] is None,
          json.dumps(row))

finally:
    print("\n--- cleanup ---")
    if pend_id:
        requests.delete(rest(f"events?entity_id=eq.{pend_id}"), headers=ADMIN)
        requests.delete(rest(f"pending_documents?id=eq.{pend_id}"), headers=ADMIN)
    if job_id:
        requests.delete(rest(f"job_productions?job_id=eq.{job_id}"), headers=ADMIN)
        requests.delete(rest(f"events?entity_id=eq.{job_id}"), headers=ADMIN)
        requests.delete(rest(f"jobs?id=eq.{job_id}"), headers=ADMIN)
    if prod_id:
        requests.delete(rest(f"pending_documents?production_id=eq.{prod_id}"), headers=ADMIN)
        requests.delete(rest(f"events?entity_id=eq.{prod_id}"), headers=ADMIN)
        requests.delete(rest(f"stages?production_id=eq.{prod_id}"), headers=ADMIN)
        requests.delete(rest(f"productions?id=eq.{prod_id}"), headers=ADMIN)
    if show_id:
        requests.delete(rest(f"events?entity_id=eq.{show_id}"), headers=ADMIN)
        requests.delete(rest(f"shows?id=eq.{show_id}"), headers=ADMIN)
    if client_id:
        requests.delete(rest(f"clients?id=eq.{client_id}"), headers=ADMIN)
    for u in users:
        requests.delete(rest(f"events?actor_id=eq.{u}"), headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{u}", headers=ADMIN)
    left = requests.get(rest(f"productions?podcast_name=like.*{MARK}*&select=id"), headers=ADMIN).json()
    check("cleanup: no test productions left", left == [], json.dumps(left)[:80])
    print()
    if failures:
        print(f"{len(failures)} FAILED: " + " · ".join(failures)); sys.exit(1)
    print("all checks passed")
