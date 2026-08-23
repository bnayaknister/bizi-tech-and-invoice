# -*- coding: utf-8 -*-
"""
Addition 2 — a mapped client's name propagates to Morning (owner spec
2026-07-21). Safe: uses a throwaway client mapped to a FAKE morning_client_id,
so the confirmed edit hits PUT /clients/{fake} -> Morning 404, mutating
NOTHING real. It proves the two safety-critical guarantees:

  - double confirmation is required (no silent propagation)
  - a failed Morning write is REPORTED, not obeyed: local is saved and the
    caller gets 502 + partial:true (owner 2026-08-23, reversing the earlier
    Morning-first rule "כשלון → לא מעודכן באף אחד")

REQUIRES MORNING_DRY_RUN=false. The whole point of section 3 is a Morning call
that FAILS, and in dry-run updateClient returns success without making one
(morning/client.ts) — so the failure branch becomes unreachable and 3a/3b/3c
report a failure that is really just the wrong environment. The check below
refuses to run rather than lie about it.

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
    # ReadTimeout too: a cold dev server accepts the connection and then spends
    # seconds compiling, which a ConnectionError-only loop reads as a crash
    try:
        if requests.get(APP, timeout=10).status_code < 500: break
    except (requests.exceptions.ConnectionError, requests.exceptions.ReadTimeout): pass
    time.sleep(1)
else:
    print("FAIL dev server never came up"); sys.exit(1)

# The environment gate. Section 3 needs a Morning call that FAILS; in dry-run
# updateClient returns success without calling anything, so the branch under
# test cannot be reached and the run would report three failures that say
# nothing about the code. Mirrors test_tax_variant_flip.py, which refuses the
# opposite way (it demands dry-run because it issues documents).
if os.environ.get("MORNING_DRY_RUN", "true") != "false":
    print("SKIP  this test drives a REAL failing Morning call and needs the dev "
          "server started with MORNING_DRY_RUN=false.")
    print("      (safe: the client is mapped to a fake morning id, so the PUT "
          "404s and mutates nothing real)")
    sys.exit(2)

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

    # 3. A failed Morning write is REPORTED, not obeyed (policy reversed by the
    #    owner 2026-08-23). This section used to assert the opposite — "local
    #    UNCHANGED after Morning failure (rollback)" — because the rule until
    #    then was Morning-first, both-or-neither. Local is now the source of
    #    truth and Morning a sync target, so the edit is saved and the caller is
    #    told the two are out of step: 502 + partial:true.
    r = edit_name(money, mapped_id, f"{MARK} newname", confirm=True)
    # The env check at the top reads THIS process's environment; the server may
    # have been started with a different flag. A 200 here is that mismatch's
    # signature — in dry-run updateClient succeeds without calling Morning, so
    # the failure branch never runs. Say so instead of logging three failures
    # that would each be blamed on the code.
    if r.status_code == 200 and not (r.json() or {}).get("partial"):
        print("SKIP  the dev server is in DRY_RUN — the Morning call succeeded without "
              "being made, so the failure branch under test is unreachable.")
        print("      restart it with MORNING_DRY_RUN=false and re-run.")
        raise SystemExit(2)
    check("3a. a real Morning failure -> 502", r.status_code == 502, f"{r.status_code} {r.text[:120]}")
    body = r.json() if r.status_code == 502 else {}
    check("3a2. the response is marked partial (saved here, not in Morning)",
          body.get("partial") is True and body.get("ok") is False, r.text[:160])
    check("3a3. it returns the SAVED row so the screen can show the new value",
          (body.get("entity") or {}).get("name") == f"{MARK} newname", r.text[:160])
    nm = requests.get(rest(f"clients?id=eq.{mapped_id}&select=name"), headers=ADMIN).json()[0]["name"]
    check("3b. local IS saved despite the Morning failure (no rollback)",
          nm == f"{MARK} newname", nm)
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
