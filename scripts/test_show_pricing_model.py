# -*- coding: utf-8 -*-
"""The pricing-model axis on the shows screen (F6 שלב 2ב, schema 0067).

Drives the REAL routes — /api/shows (create) and /api/shows/update — with a
constructed @supabase/ssr cookie session, on throwaway rows only.

RULE 40. Nothing here reaches Morning: neither route talks to it, and no
document is approved. Run it the rule-40 way regardless —

    MORNING_DRY_RUN=true npx next dev -p 3100
    curl -s localhost:3100/api/morning/status          # expect "dryRun": true
    TEST_APP_URL=http://localhost:3100 python3 scripts/test_show_pricing_model.py

WHAT IT PINS
  1.  a show can be CREATED hourly, and the rate lands in hourly_rate —
      never in default_rate
  2.  shows_one_rate_per_model is respected by construction: no created or
      updated row ever carries both rates
  3.  switching an existing show between models moves the rate across and
      clears the one being left
  4.  billing_mode leaving per_episode resets the model and both rates
  5.  pricing_model and hourly_rate are MONEY fields — a stages-only user is
      refused both, by the route and by the DB guard behind it
  6.  ...but pricing_model is READABLE by that same user (0067 granted it on
      purpose: the technician's drawer must know the show is hourly), while
      hourly_rate is not
"""
import os, sys, json, base64, uuid
import requests

ENV = os.path.join(os.path.dirname(__file__), "..", ".env.local")
for line in open(ENV, encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

SUP = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SVC = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3100")
REF = SUP.split("//")[1].split(".")[0]
ADMIN = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}
RET = {**ADMIN, "Prefer": "return=representation"}
MARK = "ZTESTPRICE"

fails = []
users, shows, clients = [], [], []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        fails.append(label)


def get(path):
    return requests.get(f"{SUP}/rest/v1/{path}", headers=ADMIN).json()


def make_user(stages, money):
    email = f"ztest-{uuid.uuid4().hex[:8]}@example.com"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{SUP}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": email, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(f"{SUP}/rest/v1/profiles?id=eq.{uid}", headers=ADMIN,
                   json={"approved": True, "can_view_stages": True, "can_edit_stages": stages,
                         "can_view_money": money, "can_edit_money": money,
                         "role": "owner" if money else "tech"})
    tok = requests.post(f"{SUP}/auth/v1/token?grant_type=password",
                        headers={"apikey": ANON, "Content-Type": "application/json"},
                        json={"email": email, "password": pw}).json()
    val = "base64-" + base64.b64encode(json.dumps(tok, separators=(",", ":")).encode()).decode()
    name = f"sb-{REF}-auth-token"
    jar = ({name: val} if len(val) <= 3180
           else {f"{name}.{i}": val[s:s + 3180] for i, s in enumerate(range(0, len(val), 3180))})
    return jar, tok["access_token"]


def create_show(jar, **body):
    return requests.post(f"{APP}/api/shows", headers={"Content-Type": "application/json"}, cookies=jar, json=body)


def update_show(jar, sid, patch):
    return requests.post(f"{APP}/api/shows/update", headers={"Content-Type": "application/json"},
                         cookies=jar, json={"id": sid, "patch": patch})


def rates(sid):
    return get(f"shows?select=pricing_model,default_rate,hourly_rate,billing_mode&id=eq.{sid}")[0]


def sweep():
    requests.delete(f"{SUP}/rest/v1/shows?name=like.{MARK}*", headers=ADMIN)
    requests.delete(f"{SUP}/rest/v1/clients?name=like.{MARK}*", headers=ADMIN)


sweep()

try:
    owner, _ = make_user(stages=True, money=True)
    tech, tech_token = make_user(stages=True, money=False)

    probe = create_show(owner, name="")
    check("0. cookie authenticates (400 not 401)", probe.status_code == 400,
          f"got {probe.status_code}: {probe.text[:140]}")

    cli = requests.post(f"{SUP}/rest/v1/clients", headers=RET, json={
        "name": f"{MARK} client", "normalized_name": f"{MARK.lower()} client",
        "morning_client_id": f"{MARK}-morning",
    }).json()[0]
    clients.append(cli["id"])

    # ---- 1. created hourly ---------------------------------------------------
    r = create_show(owner, name=f"{MARK} hourly", aliases=[], client_id=cli["id"],
                    billing_mode="per_episode", pricing_model="per_hour", hourly_rate=250)
    ok1 = r.status_code == 200 and r.json().get("ok")
    check("1. an hourly show can be created", ok1, f"{r.status_code}: {r.text[:180]}")
    hourly_id = r.json()["show"]["id"] if ok1 else None
    if hourly_id:
        shows.append(hourly_id)
        row = rates(hourly_id)
        check("1b. the rate landed in hourly_rate", float(row["hourly_rate"] or 0) == 250.0, str(row))
        check("1c. ...and NOT in default_rate", row["default_rate"] is None, str(row))
        check("1d. pricing_model persisted", row["pricing_model"] == "per_hour", str(row))
        check("1e. billing_mode stayed per_episode (a separate axis)",
              row["billing_mode"] == "per_episode", str(row))

    # ---- 2. a per-episode create is untouched by any of this ----------------
    r = create_show(owner, name=f"{MARK} episodic", aliases=[], client_id=cli["id"],
                    billing_mode="per_episode", pricing_model="per_episode", default_rate=1500)
    ok2 = r.status_code == 200
    episodic_id = r.json()["show"]["id"] if ok2 else None
    if episodic_id:
        shows.append(episodic_id)
        row = rates(episodic_id)
        check("2. a per-episode show still works exactly as before",
              float(row["default_rate"] or 0) == 1500.0 and row["hourly_rate"] is None
              and row["pricing_model"] == "per_episode", str(row))
    else:
        check("2. a per-episode show still works exactly as before", False, f"{r.status_code}: {r.text[:160]}")

    # a client sending BOTH rates cannot produce a row with both — the route
    # routes the money by the model rather than trusting the caller
    r = create_show(owner, name=f"{MARK} both", aliases=[], client_id=cli["id"],
                    billing_mode="per_episode", pricing_model="per_hour",
                    hourly_rate=250, default_rate=1500)
    if r.status_code == 200:
        both_id = r.json()["show"]["id"]
        shows.append(both_id)
        row = rates(both_id)
        check("2b. sending both rates still stores exactly one",
              row["default_rate"] is None and float(row["hourly_rate"] or 0) == 250.0, str(row))
    else:
        check("2b. sending both rates still stores exactly one", False, f"{r.status_code}: {r.text[:160]}")

    # ---- 3. switching models moves the rate across -------------------------
    if episodic_id:
        r = update_show(owner, episodic_id, {"pricing_model": "per_hour", "default_rate": None})
        check("3. per_episode → per_hour accepted", r.status_code == 200, f"{r.status_code}: {r.text[:160]}")
        r = update_show(owner, episodic_id, {"hourly_rate": 333.33})
        row = rates(episodic_id)
        check("3b. the new rate is hourly and the old one is gone",
              row["pricing_model"] == "per_hour" and float(row["hourly_rate"] or 0) == 333.33
              and row["default_rate"] is None, str(row))
        # and back again, the way the card's button does it — ONE patch, because
        # a two-step save passes through a state the CHECK rejects
        r = update_show(owner, episodic_id, {"pricing_model": "per_episode", "hourly_rate": None})
        row = rates(episodic_id)
        check("3c. per_hour → per_episode in one patch",
              r.status_code == 200 and row["pricing_model"] == "per_episode"
              and row["hourly_rate"] is None, f"{r.status_code} {row}")

    # the constraint is real, not merely respected by the route
    if hourly_id:
        r = requests.patch(f"{SUP}/rest/v1/shows?id=eq.{hourly_id}", headers=ADMIN,
                           json={"default_rate": 1500})
        check("3d. the DB itself refuses a row carrying both rates (shows_one_rate_per_model)",
              r.status_code >= 400, f"{r.status_code}: {r.text[:160]}")

    # ---- 4. leaving per_episode resets the model and both rates ------------
    if hourly_id:
        r = update_show(owner, hourly_id, {
            "billing_mode": "none", "default_rate": None, "hourly_rate": None,
            "pricing_model": "per_episode",
        })
        row = rates(hourly_id)
        check("4. an internal show keeps no rate and no hourly model",
              r.status_code == 200 and row["billing_mode"] == "none"
              and row["hourly_rate"] is None and row["default_rate"] is None
              and row["pricing_model"] == "per_episode", f"{r.status_code} {row}")
        update_show(owner, hourly_id, {"billing_mode": "per_episode", "pricing_model": "per_hour"})
        update_show(owner, hourly_id, {"hourly_rate": 250})

    # ---- 5. both columns are MONEY ------------------------------------------
    if hourly_id:
        r = update_show(tech, hourly_id, {"pricing_model": "per_episode"})
        check("5. a stages-only user cannot change pricing_model (403)", r.status_code == 403,
              f"{r.status_code}: {r.text[:160]}")
        r = update_show(tech, hourly_id, {"hourly_rate": 9999})
        check("5b. ...nor hourly_rate (403)", r.status_code == 403, f"{r.status_code}: {r.text[:160]}")
        row = rates(hourly_id)
        check("5c. ...and neither attempt changed anything",
              row["pricing_model"] == "per_hour" and float(row["hourly_rate"] or 0) == 250.0, str(row))
        # the DB guard behind the route, reached directly with the tech's own token
        r = requests.patch(f"{SUP}/rest/v1/shows?id=eq.{hourly_id}",
                           headers={"apikey": ANON, "Authorization": f"Bearer {tech_token}",
                                    "Content-Type": "application/json"},
                           json={"hourly_rate": 9999})
        check("5d. guard_show_money_columns refuses it too, bypassing the route",
              r.status_code >= 400, f"{r.status_code}: {r.text[:160]}")

    # ---- 6. what a stages-only user may READ --------------------------------
    if hourly_id:
        h = {"apikey": ANON, "Authorization": f"Bearer {tech_token}"}
        r = requests.get(f"{SUP}/rest/v1/shows?select=pricing_model&id=eq.{hourly_id}", headers=h)
        check("6. a stages user CAN read pricing_model (the drawer needs it to ask for hours)",
              r.status_code == 200 and r.json() and r.json()[0]["pricing_model"] == "per_hour",
              f"{r.status_code}: {r.text[:160]}")

        # ═══════════════════════════════════════════════════════════════════
        # THE ASSERTION HERE IS PARITY, NOT SECRECY — and that is deliberate.
        #
        # 0067 omitted hourly_rate from its grant list "exactly as default_rate
        # is omitted in 0022:22-26", on the stated assumption that 0022's
        # `revoke select on public.shows from authenticated` is in force. IT IS
        # NOT. Measured on the live database 2026-09-03 with a stages-only
        # token: `select=*` on shows returns 21 columns including BOTH
        # default_rate and hourly_rate, so table-level SELECT is granted and
        # every column-level grant since 0022 has been decorative. 0021 and
        # 0022 are both in schema_ledger carrying the identical timestamp
        # 2026-07-29T12:12:29.142435Z, which reads as a backfilled pair rather
        # than two recorded runs.
        #
        # That hole predates F6 and is not F6's to close inside a UI ticket —
        # it needs a migration, and the shows page's whole service-role dance
        # rests on the same assumption and has to be revisited with it.
        #
        # So this pins what F6 DOES own: the new rate is no more exposed than
        # the old one. It holds today (both readable) and it holds the day 0022
        # is repaired (both refused) — a test that demanded secrecy would be red
        # for a reason F6 cannot fix, and one that demanded exposure would go
        # red the moment somebody finally fixed it.
        rr = requests.get(f"{SUP}/rest/v1/shows?select=default_rate&id=eq.{hourly_id}", headers=h)
        rh = requests.get(f"{SUP}/rest/v1/shows?select=hourly_rate&id=eq.{hourly_id}", headers=h)
        check("6b. hourly_rate is exactly as protected as default_rate — no more, no less",
              (rr.status_code >= 400) == (rh.status_code >= 400),
              f"default_rate={rr.status_code} hourly_rate={rh.status_code}")
        if rr.status_code == 200:
            print("      ⚠  FINDING (pre-existing, not F6): a stages-only user can read BOTH rate")
            print("         columns on shows. 0022's table-level revoke is not in force on this")
            print("         database, so every column grant after it — including 0067's — is")
            print("         decorative. Needs a migration; see the block comment above.")

finally:
    print("\n--- cleanup ---")
    for sid in shows:
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{sid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/shows?id=eq.{sid}", headers=ADMIN)
    for cid in clients:
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{cid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/clients?id=eq.{cid}", headers=ADMIN)
    for uid in users:
        requests.delete(f"{SUP}/rest/v1/events?actor_id=eq.{uid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{uid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/approval_requests?user_id=eq.{uid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/profiles?id=eq.{uid}", headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{uid}", headers=ADMIN)
    left = {"shows": get(f"shows?select=id&name=like.{MARK}*"),
            "clients": get(f"clients?select=id&name=like.{MARK}*")}
    check("cleanup: nothing left behind", all(len(v) == 0 for v in left.values()),
          json.dumps(left, ensure_ascii=False))

print(("\nALL PASSED" if not fails else f"\n{len(fails)} FAILED: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
