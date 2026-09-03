# -*- coding: utf-8 -*-
"""Acceptance test for POST /api/productions/[id]/hours (F6 שלב 2א, 0067).

Drives the REAL Next route with a constructed @supabase/ssr cookie session, on
throwaway rows only, and deletes every one of them in `finally`.

RULE 40. This test never approves a document — it never calls
/api/documents/pending/review — so nothing here can reach Morning. It is still
run the rule-40 way, against a separate dry-run server, because "this one can't
issue" is a judgement that has to be re-made correctly every time the file
changes, and the isolated server does not:

    MORNING_DRY_RUN=true npx next dev -p 3100
    curl -s localhost:3100/api/morning/status          # expect "dryRun": true
    TEST_APP_URL=http://localhost:3100 python3 scripts/test_hourly_workorder.py

WHAT IT PINS
  0.  the cookie authenticates at all (400, not 401)
  1.  permission is STAGES, not money — and a user with neither is refused
  2.  validation: missing / non-numeric / 0 / negative / >24 / 3 decimals
  3.  the happy path writes all THREE sides: studio_hours, the work order, and
      jobs.amount — the third being the one that is easy to forget
  4.  the event trail: production_hours_set {from,to}
  5.  re-entering hours RE-AMOUNTS the queued row in place (same row id) and
      logs work_order_reamounted
  6.  rounding survives the round trip to the database (1.5 × 333.33 = 500.00)
  7.  an approved work order is refused with 409 AND the hours are not written —
      the refusal happens before any write
  8.  a per-episode show is refused rather than silently storing hours that
      multiply nothing
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
# rule 40: :3100 is the default, never :3000
APP = os.environ.get("TEST_APP_URL", "http://localhost:3100")
REF = SUP.split("//")[1].split(".")[0]
ADMIN = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}
RET = {**ADMIN, "Prefer": "return=representation"}
MARK = "ZTESTHOURS"

fails = []
users, shows, prods, jobs, clients = [], [], [], [], []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        fails.append(label)


def make_user(stages, money):
    email = f"ztest-{uuid.uuid4().hex[:8]}@example.com"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    u = requests.post(f"{SUP}/auth/v1/admin/users", headers=ADMIN,
                      json={"email": email, "password": pw, "email_confirm": True}).json()
    uid = u["id"]
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
    jar = {}
    if len(val) <= 3180:
        jar[name] = val
    else:
        for i, s in enumerate(range(0, len(val), 3180)):
            jar[f"{name}.{i}"] = val[s:s + 3180]
    return jar


def post_hours(jar, pid, body):
    return requests.post(f"{APP}/api/productions/{pid}/hours",
                         headers={"Content-Type": "application/json"}, cookies=jar, json=body)


def get(path):
    return requests.get(f"{SUP}/rest/v1/{path}", headers=ADMIN).json()


def make_production(show_id, client_id, name):
    row = requests.post(f"{SUP}/rest/v1/productions", headers=RET, json={
        "podcast_name": name, "show_id": show_id, "client_id": client_id,
        "kind": "client", "legacy": False, "record_date": "2026-09-03",
    }).json()[0]
    prods.append(row["id"])
    # the technician's answer only matters once the session happened; put the
    # row where it really is when the hours are typed
    requests.patch(f"{SUP}/rest/v1/productions?id=eq.{row['id']}", headers=ADMIN,
                   json={"status": "הוקלט"})
    return row["id"]


def linked_job(prod_id):
    """The job ensure_job_for_production created on the transition into הוקלט
    (0060 → 0067 §7). NOT made by hand: the whole point of the hours route is
    that it finds and re-amounts the job the DB already made, and a hand-built
    one would have tested a link the real system never produces.

    On an hourly production this job is born with amount NULL — the transition
    happens before anyone has typed a number, which 0067's header records as a
    KNOWN CONSEQUENCE. That null is the starting state of every assertion here.
    """
    link = get(f"job_productions?select=job_id&production_id=eq.{prod_id}")
    if not link:
        return None
    jid = link[0]["job_id"]
    jobs.append(jid)
    return jid


def work_orders(prod_id):
    return get(f"pending_documents?select=id,status,amount,payload&production_id=eq.{prod_id}"
               f"&doc_type=eq.work_order&order=created_at.desc")


def events(prod_id, kind):
    return get(f"events?select=event_type,payload&entity_id=eq.{prod_id}&event_type=eq.{kind}")


def sweep():
    """Remove anything a previous crashed run left behind. clients.normalized_name
    is unique, so one survivor makes every later run fail at the fixture instead
    of at the assertion that actually broke."""
    for pid in [p["id"] for p in (get(f"productions?select=id&podcast_name=like.{MARK}*") or [])]:
        for link in (get(f"job_productions?select=job_id&production_id=eq.{pid}") or []):
            requests.delete(f"{SUP}/rest/v1/pending_documents?job_id=eq.{link['job_id']}", headers=ADMIN)
            requests.delete(f"{SUP}/rest/v1/job_productions?job_id=eq.{link['job_id']}", headers=ADMIN)
            requests.delete(f"{SUP}/rest/v1/jobs?id=eq.{link['job_id']}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/pending_documents?production_id=eq.{pid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/stages?production_id=eq.{pid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{pid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/productions?id=eq.{pid}", headers=ADMIN)
    requests.delete(f"{SUP}/rest/v1/jobs?campaign=like.{MARK}*", headers=ADMIN)
    requests.delete(f"{SUP}/rest/v1/shows?name=like.{MARK}*", headers=ADMIN)
    requests.delete(f"{SUP}/rest/v1/clients?name=like.{MARK}*", headers=ADMIN)


sweep()

try:
    # ---- the fixture: a client, an hourly show, a per-episode show ----------
    cli = requests.post(f"{SUP}/rest/v1/clients", headers=RET, json={
        "name": f"{MARK} client", "normalized_name": f"{MARK.lower()} client",
        # any non-empty string: enqueueDocument only checks that the mapping
        # EXISTS. Nothing in this test talks to Morning.
        "morning_client_id": f"{MARK}-morning",
    }).json()[0]
    clients.append(cli["id"])

    hourly = requests.post(f"{SUP}/rest/v1/shows", headers=RET, json={
        "name": f"{MARK} hourly", "active": False, "is_oneoff": True,
        "client_id": cli["id"], "billing_mode": "per_episode",
        # shows_one_rate_per_model (0067 §3) forbids carrying both rates
        "pricing_model": "per_hour", "hourly_rate": 250, "default_rate": None,
    }).json()[0]
    shows.append(hourly["id"])

    episodic = requests.post(f"{SUP}/rest/v1/shows", headers=RET, json={
        "name": f"{MARK} episodic", "active": False, "is_oneoff": True,
        "client_id": cli["id"], "billing_mode": "per_episode",
        "pricing_model": "per_episode", "default_rate": 900,
    }).json()[0]
    shows.append(episodic["id"])

    tech = make_user(stages=True, money=False)
    viewer = make_user(stages=False, money=False)

    p1 = make_production(hourly["id"], cli["id"], f"{MARK} alpha")
    job1 = linked_job(p1)
    check("setup. the DB created a job on הוקלט (0060)", job1 is not None, "no job_productions link")
    if job1:
        row = get(f"jobs?select=amount&id=eq.{job1}")[0]
        check("setup. ...and an hourly job is born unpriced (0067's KNOWN CONSEQUENCE)",
              row["amount"] is None, str(row))

    # ---- 0. the cookie works ------------------------------------------------
    probe = post_hours(tech, p1, {})
    check("0. cookie authenticates (400 not 401)", probe.status_code == 400,
          f"got {probe.status_code}: {probe.text[:160]}")

    # ---- 1. permission is stages ------------------------------------------
    r = post_hours(viewer, p1, {"hours": 3})
    check("1. a user without can_edit_stages is refused (403)", r.status_code == 403,
          f"{r.status_code}: {r.text[:160]}")
    # and the refusal wrote nothing
    row = get(f"productions?select=studio_hours&id=eq.{p1}")[0]
    check("1b. ...and no hours were written", row["studio_hours"] is None, str(row))

    # ---- 2. validation ------------------------------------------------------
    for label, body in [
        ("missing", {}),
        ("null", {"hours": None}),
        ("empty string", {"hours": ""}),
        ("non-numeric", {"hours": "שלוש"}),
        ("zero", {"hours": 0}),
        ("negative", {"hours": -2}),
        ("over 24", {"hours": 25}),
        ("three decimals", {"hours": 1.234}),
    ]:
        r = post_hours(tech, p1, body)
        check(f"2. {label} is refused (400)", r.status_code == 400, f"{r.status_code}: {r.text[:120]}")
    # the boundary itself is allowed, and quarter hours are the point of numeric(5,2)
    row = get(f"productions?select=studio_hours&id=eq.{p1}")[0]
    check("2b. no invalid attempt left a value behind", row["studio_hours"] is None, str(row))

    # ---- 3. the happy path, all three sides --------------------------------
    r = post_hours(tech, p1, {"hours": 3.5})
    ok3 = r.status_code == 200 and r.json().get("ok")
    check("3. 3.5 hours accepted", ok3, f"{r.status_code}: {r.text[:200]}")
    body3 = r.json() if ok3 else {}
    check("3a. work order was created", body3.get("work_order") == "queued", json.dumps(body3, ensure_ascii=False))

    row = get(f"productions?select=studio_hours&id=eq.{p1}")[0]
    check("3b. studio_hours persisted", float(row["studio_hours"]) == 3.5, str(row))

    wos = work_orders(p1)
    check("3c. exactly one work order row", len(wos) == 1, str(len(wos)))
    if wos:
        wo = wos[0]
        check("3d. its amount is 3.5 × 250 = 875", float(wo["amount"]) == 875.0, str(wo["amount"]))
        price = wo["payload"]["income"][0]["price"]
        check("3e. and the printed line carries the same number", float(price) == 875.0, str(price))

    job = get(f"jobs?select=amount&id=eq.{job1}")[0]
    check("3f. jobs.amount was updated too (the forgettable side)",
          job["amount"] is not None and float(job["amount"]) == 875.0, str(job))

    # ---- 4. the event trail -------------------------------------------------
    ev = events(p1, "production_hours_set")
    check("4. production_hours_set recorded", len(ev) == 1, str(len(ev)))
    if ev:
        p = ev[0]["payload"]
        check("4b. ...with from=null and to=3.5", p.get("from") is None and float(p.get("to")) == 3.5,
              json.dumps(p, ensure_ascii=False))

    # ---- 5. correcting the hours re-amounts the SAME row --------------------
    first_id = wos[0]["id"] if wos else None
    r = post_hours(tech, p1, {"hours": 2})
    ok5 = r.status_code == 200 and r.json().get("work_order") == "reamounted"
    check("5. a correction re-amounts rather than duplicating", ok5, f"{r.status_code}: {r.text[:200]}")
    wos2 = work_orders(p1)
    check("5b. still exactly one work order row", len(wos2) == 1, str(len(wos2)))
    if wos2 and first_id:
        check("5c. and it is the SAME row (queue position kept)", wos2[0]["id"] == first_id,
              f"{first_id} -> {wos2[0]['id']}")
        check("5d. its amount moved to 2 × 250 = 500", float(wos2[0]["amount"]) == 500.0, str(wos2[0]["amount"]))
        check("5e. the line moved with it", float(wos2[0]["payload"]["income"][0]["price"]) == 500.0,
              str(wos2[0]["payload"]["income"][0]["price"]))
    job = get(f"jobs?select=amount&id=eq.{job1}")[0]
    check("5f. jobs.amount followed", float(job["amount"]) == 500.0, str(job))
    ev = events(p1, "work_order_reamounted")
    check("5g. work_order_reamounted recorded with from/to", len(ev) == 1 and
          float(ev[0]["payload"]["from"]) == 875.0 and float(ev[0]["payload"]["to"]) == 500.0,
          json.dumps(ev, ensure_ascii=False)[:200])

    # ---- 6. rounding survives the round trip -------------------------------
    requests.patch(f"{SUP}/rest/v1/shows?id=eq.{hourly['id']}", headers=ADMIN, json={"hourly_rate": 333.33})
    r = post_hours(tech, p1, {"hours": 1.5})
    ok6 = r.status_code == 200
    wos3 = work_orders(p1)
    check("6. 1.5 × 333.33 stored as 500.00, never 499.995",
          ok6 and wos3 and float(wos3[0]["amount"]) == 500.0,
          f"{r.status_code}: " + (str(wos3[0]["amount"]) if wos3 else r.text[:150]))
    if wos3:
        check("6b. the line agrees with the column (the balance gate's invariant)",
              float(wos3[0]["payload"]["income"][0]["price"]) == float(wos3[0]["amount"]),
              str(wos3[0]["payload"]["income"][0]["price"]))
    requests.patch(f"{SUP}/rest/v1/shows?id=eq.{hourly['id']}", headers=ADMIN, json={"hourly_rate": 250})

    # ---- 7. an approved work order refuses, BEFORE writing anything --------
    p2 = make_production(hourly["id"], cli["id"], f"{MARK} beta")
    linked_job(p2)
    r = post_hours(tech, p2, {"hours": 4})
    check("7. first entry on the second production succeeds", r.status_code == 200,
          f"{r.status_code}: {r.text[:150]}")
    wos_p2 = work_orders(p2)
    if wos_p2:
        requests.patch(f"{SUP}/rest/v1/pending_documents?id=eq.{wos_p2[0]['id']}", headers=ADMIN,
                       json={"status": "approved"})
    r = post_hours(tech, p2, {"hours": 6})
    check("7b. an approved work order refuses the change (409)", r.status_code == 409,
          f"{r.status_code}: {r.text[:180]}")
    row = get(f"productions?select=studio_hours&id=eq.{p2}")[0]
    check("7c. ...and the hours were NOT written (refusal precedes every write)",
          float(row["studio_hours"]) == 4.0, str(row))

    # ---- 8. a per-episode show is refused, not silently stored --------------
    p3 = make_production(episodic["id"], cli["id"], f"{MARK} gamma")
    r = post_hours(tech, p3, {"hours": 3})
    check("8. hours on a per-episode show are refused (400)", r.status_code == 400,
          f"{r.status_code}: {r.text[:180]}")
    row = get(f"productions?select=studio_hours&id=eq.{p3}")[0]
    check("8b. ...and nothing was stored", row["studio_hours"] is None, str(row))

finally:
    print("\n--- cleanup ---")
    for pid in prods:
        # every job the DB made for this production, whether or not the test
        # ever looked at it — a trigger-created row nobody recorded is exactly
        # how test data survives its own cleanup
        for link in (get(f"job_productions?select=job_id&production_id=eq.{pid}") or []):
            if link["job_id"] not in jobs:
                jobs.append(link["job_id"])
        requests.delete(f"{SUP}/rest/v1/pending_documents?production_id=eq.{pid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/job_productions?production_id=eq.{pid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/stages?production_id=eq.{pid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{pid}", headers=ADMIN)
    for jid in jobs:
        requests.delete(f"{SUP}/rest/v1/pending_documents?job_id=eq.{jid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{jid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/jobs?id=eq.{jid}", headers=ADMIN)
    for pid in prods:
        requests.delete(f"{SUP}/rest/v1/productions?id=eq.{pid}", headers=ADMIN)
    for sid in shows:
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{sid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/shows?id=eq.{sid}", headers=ADMIN)
    for cid in clients:
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{cid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/clients?id=eq.{cid}", headers=ADMIN)
    # events before the auth user: the FK is RESTRICT, not cascade
    for uid in users:
        requests.delete(f"{SUP}/rest/v1/events?actor_id=eq.{uid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{uid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/approval_requests?user_id=eq.{uid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/profiles?id=eq.{uid}", headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{uid}", headers=ADMIN)

    leftovers = {
        "productions": get(f"productions?select=id&podcast_name=like.{MARK}*"),
        "shows": get(f"shows?select=id&name=like.{MARK}*"),
        "clients": get(f"clients?select=id&name=like.{MARK}*"),
        "jobs": get(f"jobs?select=id,campaign&campaign=like.{MARK}*"),
    }
    empty = all(isinstance(v, list) and len(v) == 0 for v in leftovers.values())
    check("cleanup: nothing left behind", empty, json.dumps(leftovers, ensure_ascii=False))

print(("\nALL PASSED" if not fails else f"\n{len(fails)} FAILED: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
