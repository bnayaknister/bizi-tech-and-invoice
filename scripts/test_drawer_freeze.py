# -*- coding: utf-8 -*-
"""
Backlog: the drawer's freeze is unified with the board flow — it captures
reason / who / when instead of a bare boolean (owner 2026-07-21). No
migration. Issues nothing.

The drawer now routes the on_hold toggle through /api/productions/[id]
{hold:{on,reason}} (same endpoint the board uses) and displays the reason /
since via new readonly fields. This verifies both halves at the API level:

  1. freezing through that endpoint records on_hold + reason + since + by
  2. the entity-drawer GET now exposes on_hold_reason / on_hold_since so the
     drawer can show them
  3. unfreezing clears them
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
MARK = "ZTESTFREEZE"
failures = []; users = []; prod_id = None; show_id = None


def check(l, ok, d=""):
    print(("PASS  " if ok else "FAIL  ") + l + (f"  [{d}]" if d and not ok else ""))
    if not ok: failures.append(l)


def rest(p): return f"{SUP}/rest/v1/{p}"
def b64(r): return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags):
    em = f"frz-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"T-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{SUP}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers=REPR, json={"name": MARK, "approved": True, **flags})
    td = requests.post(f"{SUP}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return uid, {CN: "base64-" + b64(json.dumps(sess).encode())}


for _ in range(60):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("FAIL dev server never came up"); sys.exit(1)

try:
    uid, ck = mkuser({"role": "tech", "can_view_stages": True, "can_edit_stages": True})
    show_id = requests.post(rest("shows"), headers=REPR,
                            json={"name": f"{MARK} s", "aliases": [], "billing_mode": "none", "active": True}).json()[0]["id"]
    prod_id = requests.post(rest("productions"), headers=REPR,
                            json={"podcast_name": f"{MARK} p", "show_id": show_id, "kind": "internal",
                                  "record_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                                  "status": "בעריכה", "legacy": False}).json()[0]["id"]

    # 1. freeze with a reason via the shared endpoint (what the drawer now calls)
    r = requests.post(f"{APP}/api/productions/{prod_id}", cookies=ck, headers={"Content-Type": "application/json"},
                      json={"hold": {"on": True, "reason": "ממתין לחומרים"}})
    check("1a. freeze accepted", r.status_code == 200, f"{r.status_code} {r.text[:100]}")
    row = requests.get(rest(f"productions?id=eq.{prod_id}&select=on_hold,on_hold_reason,on_hold_since,on_hold_by"), headers=ADMIN).json()[0]
    check("1b. on_hold + reason + since + by all captured",
          row["on_hold"] is True and row["on_hold_reason"] == "ממתין לחומרים" and row["on_hold_since"] and row["on_hold_by"] == uid,
          json.dumps(row, ensure_ascii=False))

    # 2. the drawer GET now exposes the reason/since (readonly fields)
    d = requests.get(f"{APP}/api/entity/production/{prod_id}", cookies=ck).json()
    ent = d.get("entity", {})
    check("2. drawer entity exposes on_hold_reason for display",
          ent.get("on_hold_reason") == "ממתין לחומרים" and ent.get("on_hold_since"),
          json.dumps({k: ent.get(k) for k in ("on_hold", "on_hold_reason", "on_hold_since")}, ensure_ascii=False))

    # 3. unfreeze clears everything
    r = requests.post(f"{APP}/api/productions/{prod_id}", cookies=ck, headers={"Content-Type": "application/json"},
                      json={"hold": {"on": False}})
    row = requests.get(rest(f"productions?id=eq.{prod_id}&select=on_hold,on_hold_reason,on_hold_since"), headers=ADMIN).json()[0]
    check("3. unfreeze clears on_hold + reason + since",
          row["on_hold"] is False and row["on_hold_reason"] is None and row["on_hold_since"] is None,
          json.dumps(row, ensure_ascii=False))

finally:
    print("\n--- cleanup ---")
    if prod_id:
        requests.delete(rest(f"events?entity_id=eq.{prod_id}"), headers=ADMIN)
        requests.delete(rest(f"stages?production_id=eq.{prod_id}"), headers=ADMIN)
        requests.delete(rest(f"productions?id=eq.{prod_id}"), headers=ADMIN)
    if show_id:
        requests.delete(rest(f"shows?id=eq.{show_id}"), headers=ADMIN)
    for u in users:
        requests.delete(rest(f"events?actor_id=eq.{u}"), headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{u}", headers=ADMIN)
    left = requests.get(rest(f"productions?podcast_name=like.*{MARK}*&select=id"), headers=ADMIN).json()
    check("cleanup: no test productions left", left == [], json.dumps(left)[:80])
    print()
    if failures:
        print(f"{len(failures)} FAILED: " + " · ".join(failures)); sys.exit(1)
    print("all checks passed")
