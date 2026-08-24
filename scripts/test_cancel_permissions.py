# -*- coding: utf-8 -*-
"""
Migration 0062 — cancelling a RECORDED episode requires admin, at the DATABASE
level, not merely in the route (owner 2026-08-25).

Two real authenticated identities, because that is the only way to exercise the
guard: it is written `auth.uid() is not null and not can_manage_users()`, so a
service-role write always passes and would prove nothing.

  technician : can_edit_stages, NOT can_manage_users
  admin      : can_edit_stages + can_manage_users

Every row is synthetic and torn down in `finally`, LIFO, with the deletion
verified. Events are deleted before the auth users they point at (FK RESTRICT).
No real production is ever cancelled.

Run: python3 scripts/test_cancel_permissions.py
"""
import os
import sys
import json
import uuid
import requests

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")
with open(ENV_PATH, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
SERVICE = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
ADMIN_H = {"apikey": SERVICE, "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json"}

passed, failures = 0, []


def check(name, ok, detail=""):
    global passed
    if ok:
        passed += 1
        print("  PASS  " + name)
    else:
        failures.append(name + ((" -- " + detail) if detail else ""))
        print("  FAIL  " + name + (("  -- " + detail) if detail else ""))


users, productions, shows_created, clients_created = [], [], [], []


def make_user(label, can_manage):
    email = "ztestcancel_%s_%s@example.com" % (label, uuid.uuid4().hex[:8])
    pw = "Test-%s!A1" % uuid.uuid4().hex
    r = requests.post(URL + "/auth/v1/admin/users", headers=ADMIN_H,
                      json={"email": email, "password": pw, "email_confirm": True})
    r.raise_for_status()
    uid = r.json()["id"]
    users.append(uid)
    requests.patch(URL + "/rest/v1/profiles?id=eq." + uid, headers=ADMIN_H,
                   json={"name": "ZTEST cancel " + label, "approved": True,
                         "can_view_stages": True, "can_edit_stages": True,
                         "can_view_money": True, "can_edit_money": True,
                         "can_manage_users": can_manage}).raise_for_status()
    r = requests.post(URL + "/auth/v1/token?grant_type=password",
                      headers={"apikey": ANON, "Content-Type": "application/json"},
                      json={"email": email, "password": pw})
    r.raise_for_status()
    return uid, r.json()["access_token"]


def as_user(token):
    return {"apikey": ANON, "Authorization": "Bearer " + token,
            "Content-Type": "application/json", "Prefer": "return=representation"}


def make_production(status):
    """a synthetic episode in the given status, on a synthetic show+client"""
    # normalized_name is NOT NULL with no default — the app fills it, so a
    # direct insert has to as well
    cname = "ZTEST cancel client " + uuid.uuid4().hex[:6]
    r = requests.post(URL + "/rest/v1/clients", headers={**ADMIN_H, "Prefer": "return=representation"},
                      json={"name": cname, "normalized_name": cname.lower()})
    if not r.ok:
        print("  client insert failed:", r.status_code, r.text[:200])
    r.raise_for_status()
    cid = r.json()[0]["id"]
    clients_created.append(cid)
    r = requests.post(URL + "/rest/v1/shows", headers={**ADMIN_H, "Prefer": "return=representation"},
                      json={"name": "ZTEST cancel show " + uuid.uuid4().hex[:6],
                            "client_id": cid, "default_rate": 600})
    r.raise_for_status()
    sid = r.json()[0]["id"]
    shows_created.append(sid)
    r = requests.post(URL + "/rest/v1/productions", headers={**ADMIN_H, "Prefer": "return=representation"},
                      json={"podcast_name": "ZTEST cancel prod", "client_id": cid, "show_id": sid,
                            "kind": "client", "record_date": "2026-08-25", "status": status})
    r.raise_for_status()
    pid = r.json()[0]["id"]
    productions.append(pid)
    return pid


def try_cancel(token, pid):
    r = requests.patch(URL + "/rest/v1/productions?id=eq." + pid, headers=as_user(token),
                       json={"status": "בוטל"})
    return r.status_code, r.text


def main():
    print("\n=== 1. THE TRIGGER IS ATTACHED AND THE LEDGER RECORDS IT ===")
    r = requests.get(URL + "/rest/v1/schema_ledger", headers=ADMIN_H,
                     params={"version": "eq.0062", "select": "version,applied_at,applied_by"})
    rows = r.json()
    check("schema_ledger has '0062'", len(rows) == 1, json.dumps(rows, ensure_ascii=False))
    if rows:
        print("     ", rows[0]["version"], rows[0]["applied_at"][:19], rows[0]["applied_by"])

    tech_id, tech_tok = make_user("tech", False)
    admin_id, admin_tok = make_user("admin", True)
    print("  technician:", tech_id[:8], " admin:", admin_id[:8])

    print("\n=== 2. TECHNICIAN + NOT-YET-RECORDED -> allowed (a scheduling change) ===")
    p_future = make_production("עתיד_להתחיל")
    code, body = try_cancel(tech_tok, p_future)
    st = requests.get(URL + "/rest/v1/productions?id=eq." + p_future, headers=ADMIN_H,
                      params={"select": "status"}).json()[0]["status"]
    check("technician cancels a future episode", code < 400 and st == "בוטל",
          "http=%s status=%s" % (code, st))

    print("\n=== 3. TECHNICIAN + RECORDED -> BLOCKED BY THE DATABASE ===")
    blocked_all = True
    for status in ["הוקלט", "בעריכה", "נערך", "נשלח_ללקוח", "ממתין_לתגובת_לקוח", "הופץ"]:
        pid = make_production(status)
        code, body = try_cancel(tech_tok, pid)
        st = requests.get(URL + "/rest/v1/productions?id=eq." + pid, headers=ADMIN_H,
                          params={"select": "status"}).json()[0]["status"]
        ok = code >= 400 and st == status
        blocked_all = blocked_all and ok
        if not ok:
            print("     %-20s http=%s status_now=%s" % (status, code, st))
        elif status == "הוקלט":
            print("     message:", body[:150])
    check("technician blocked for every recorded status (6/6), row unchanged", blocked_all)

    print("\n=== 4. ADMIN + RECORDED -> allowed ===")
    p_rec = make_production("הוקלט")
    code, body = try_cancel(admin_tok, p_rec)
    st = requests.get(URL + "/rest/v1/productions?id=eq." + p_rec, headers=ADMIN_H,
                      params={"select": "status"}).json()[0]["status"]
    check("admin cancels a recorded episode", code < 400 and st == "בוטל",
          "http=%s status=%s body=%s" % (code, st, body[:120]))

    print("\n=== 5. SERVICE ROLE still passes (auth.uid() is null) ===")
    p_svc = make_production("הוקלט")
    r = requests.patch(URL + "/rest/v1/productions?id=eq." + p_svc,
                       headers={**ADMIN_H, "Prefer": "return=representation"},
                       json={"status": "בוטל"})
    st = requests.get(URL + "/rest/v1/productions?id=eq." + p_svc, headers=ADMIN_H,
                      params={"select": "status"}).json()[0]["status"]
    check("service role cancels a recorded episode (the API route stays authorized)",
          r.status_code < 400 and st == "בוטל", "http=%s status=%s" % (r.status_code, st))

    print("\n=== 6. an ALREADY-cancelled row is not re-guarded ===")
    # old.status = 'בוטל' -> the guard's `old.status is distinct from 'בוטל'`
    # is false, so a technician touching it again is not blocked by THIS rule
    code, body = try_cancel(tech_tok, p_future)
    check("re-cancelling an already-cancelled row is not blocked by 0062", code < 400,
          "http=%s %s" % (code, body[:120]))


try:
    main()
except Exception as e:  # noqa: BLE001
    failures.append("THREW: " + str(e))
    import traceback
    traceback.print_exc()
finally:
    print("\n=== CLEANUP (LIFO) ===")
    for pid in reversed(productions):
        requests.delete(URL + "/rest/v1/events?entity_id=eq." + pid, headers=ADMIN_H)
        requests.delete(URL + "/rest/v1/stages?production_id=eq." + pid, headers=ADMIN_H)
        requests.delete(URL + "/rest/v1/job_productions?production_id=eq." + pid, headers=ADMIN_H)
        requests.delete(URL + "/rest/v1/pending_documents?production_id=eq." + pid, headers=ADMIN_H)
        requests.delete(URL + "/rest/v1/productions?id=eq." + pid, headers=ADMIN_H)
    for sid in reversed(shows_created):
        requests.delete(URL + "/rest/v1/events?entity_id=eq." + sid, headers=ADMIN_H)
        requests.delete(URL + "/rest/v1/shows?id=eq." + sid, headers=ADMIN_H)
    for cid in reversed(clients_created):
        requests.delete(URL + "/rest/v1/jobs?client_id=eq." + cid, headers=ADMIN_H)
        requests.delete(URL + "/rest/v1/events?entity_id=eq." + cid, headers=ADMIN_H)
        requests.delete(URL + "/rest/v1/clients?id=eq." + cid, headers=ADMIN_H)
    # events and approval_requests must go BEFORE the auth user (FK RESTRICT)
    for uid in reversed(users):
        requests.delete(URL + "/rest/v1/events?actor_id=eq." + uid, headers=ADMIN_H)
        requests.delete(URL + "/rest/v1/approval_requests?requested_by=eq." + uid, headers=ADMIN_H)
        requests.delete(URL + "/rest/v1/profiles?id=eq." + uid, headers=ADMIN_H)
        requests.delete(URL + "/auth/v1/admin/users/" + uid, headers=ADMIN_H)

    leaked = 0
    for table, ids, col in (("productions", productions, "id"), ("shows", shows_created, "id"),
                            ("clients", clients_created, "id"), ("profiles", users, "id")):
        if not ids:
            continue
        r = requests.get(URL + "/rest/v1/" + table, headers=ADMIN_H,
                         params={col: "in.(%s)" % ",".join(ids), "select": "id"})
        n = len(r.json()) if r.ok else 0
        if n:
            leaked += n
            print("  LEAKED in %s: %d" % (table, n))
    print("  all test rows deleted, verified" if leaked == 0 else "  *** %d ROWS LEAKED ***" % leaked)

    print("\n=== RESULT ===")
    print("passed: %d, failed: %d" % (passed, len(failures)))
    for f in failures:
        print("  - " + f)

# exit code decided AFTER cleanup, never inside finally (backlog item)
sys.exit(1 if failures or leaked else 0)
