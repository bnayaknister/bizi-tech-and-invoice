# -*- coding: utf-8 -*-
"""
Addition 2 — a mapped client's name propagates to Morning (owner spec
2026-07-21). Safe: uses a throwaway client mapped to a FAKE morning_client_id,
so the confirmed edit hits PUT /clients/{fake} -> Morning 404, mutating
NOTHING real. It proves the two safety-critical guarantees:

  - double confirmation is required (no silent propagation)
  - Morning-first rollback: a failed Morning write leaves local UNCHANGED
    ("כשלון → לא מעודכן באף אחד")

plus permission gating and that a NON-mapped client edits locally with no
Morning involvement. The happy path (both updated) is the same code minus the
error; it is not exercised here because it would rename a real Morning client.
"""
import base64, json, os, sys, time, uuid
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
MARK = "ZTESTPROP"

failures = []; users = []; mapped_id = None; plain_id = None


def check(l, ok, d=""):
    print(("PASS  " if ok else "FAIL  ") + l + (f"  [{d}]" if d and not ok else ""))
    if not ok: failures.append(l)


def rest(p): return f"{SUP}/rest/v1/{p}"
def b64(r): return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags):
    em = f"prop-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
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


def edit_name(cookie, cid, name, confirm=False):
    b = {"patch": {"name": name}}
    if confirm: b["confirm_morning"] = True
    return requests.post(f"{APP}/api/entity/client/{cid}", cookies=cookie,
                         headers={"Content-Type": "application/json"}, json=b)


for _ in range(60):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("FAIL dev server never came up"); sys.exit(1)

try:
    money = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True})
    stages = mkuser({"role": "tech", "can_view_stages": True, "can_edit_stages": True})

    mapped_id = requests.post(rest("clients"), headers=REPR,
                              json={"name": f"{MARK} mapped", "normalized_name": f"ztp{uuid.uuid4().hex[:6]}",
                                    "morning_client_id": f"fake-{uuid.uuid4()}"}).json()[0]["id"]
    plain_id = requests.post(rest("clients"), headers=REPR,
                             json={"name": f"{MARK} plain", "normalized_name": f"ztp{uuid.uuid4().hex[:6]}"}).json()[0]["id"]

    # 1. permission: a stages-only user can't edit a client name (edit:money)
    r = edit_name(stages, mapped_id, f"{MARK} hack")
    check("1. stages-only user can't edit client name", r.status_code == 403, str(r.status_code))

    # 2. double confirmation required
    r = edit_name(money, mapped_id, f"{MARK} newname")
    check("2a. mapped-client name edit needs confirmation (409)",
          r.status_code == 409 and r.json().get("needs_morning_confirmation"), f"{r.status_code} {r.text[:100]}")
    check("2b. the change is shown for review",
          r.json().get("changes", {}).get("name", {}).get("to") == f"{MARK} newname", r.text[:120])
    nm = requests.get(rest(f"clients?id=eq.{mapped_id}&select=name"), headers=ADMIN).json()[0]["name"]
    check("2c. nothing changed locally yet", nm == f"{MARK} mapped", nm)

    # 3. Morning-first rollback: confirm -> PUT to a fake id -> Morning fails
    #    -> 502 and local STILL unchanged
    r = edit_name(money, mapped_id, f"{MARK} newname", confirm=True)
    check("3a. failed Morning write -> 502", r.status_code == 502, f"{r.status_code} {r.text[:120]}")
    nm = requests.get(rest(f"clients?id=eq.{mapped_id}&select=name"), headers=ADMIN).json()[0]["name"]
    check("3b. local UNCHANGED after Morning failure (rollback)", nm == f"{MARK} mapped", nm)
    ev = requests.get(rest(f"clients?id=eq.{mapped_id}&select=name"), headers=ADMIN).json()
    fev = requests.get(rest(f"events?entity_id=eq.{mapped_id}&event_type=eq.client_morning_update_failed&select=id"), headers=ADMIN).json()
    check("3c. the failure is evented", len(fev) >= 1, json.dumps(fev)[:80])

    # 4. a NON-mapped client edits locally with no Morning involvement
    r = edit_name(money, plain_id, f"{MARK} plain2")
    check("4a. non-mapped client edit succeeds directly (no 409)", r.status_code == 200, f"{r.status_code} {r.text[:100]}")
    nm = requests.get(rest(f"clients?id=eq.{plain_id}&select=name"), headers=ADMIN).json()[0]["name"]
    check("4b. its name changed locally", nm == f"{MARK} plain2", nm)

finally:
    print("\n--- cleanup ---")
    for cid in (mapped_id, plain_id):
        if cid:
            requests.delete(rest(f"events?entity_id=eq.{cid}"), headers=ADMIN)
            requests.delete(rest(f"clients?id=eq.{cid}"), headers=ADMIN)
    for uid in users:
        requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{uid}", headers=ADMIN)
    left = requests.get(rest(f"clients?name=like.*{MARK}*&select=id"), headers=ADMIN).json()
    check("cleanup: no test clients left", left == [], json.dumps(left)[:80])
    print()
    if failures:
        print(f"{len(failures)} FAILED: " + " · ".join(failures)); sys.exit(1)
    print("all checks passed")
