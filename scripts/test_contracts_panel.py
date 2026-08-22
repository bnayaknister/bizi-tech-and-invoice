# -*- coding: utf-8 -*-
"""
Acceptance test for the contracts panel work (owner spec 2026-08-22).
No migration: every column used here already existed.

  1. THE CENTRAL ONE - a closed contract stops feeding the radar. A pending
     milestone whose expected_date is in the past and is_estimated=false hits
     three radar surfaces (open-commitment headline, the red "overdue
     milestone" alert, the blue open-commitment alert). Closing the contract
     above it must return all of them to their exact baseline.
  2. The same for the hub tile metric (modules/contracts).
  3. Close / reopen through the entity route (POST, not PATCH); tech -> 403.
  4. Manual milestone status: the three enum values pass, junk is rejected.
  5. Manual job link with its three validations: missing -> 404, other client
     -> 400, already linked -> 409. Unlink (null) passes.

Cleans up every throwaway row + user in finally (FK order: invoices ->
milestones -> jobs -> contracts -> clients -> events -> users).
"""
import base64, json, os, re, sys, time, uuid, requests

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")
if os.path.exists(ENV_PATH):
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

S = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]; SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
ADMIN = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
REPR = {"Prefer": "return=representation"}
ref = S.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"

MARK = "ZTEST-PANEL"
# a deliberately odd amount: it must never collide with a real milestone, and
# the radar delta below is asserted as exact arithmetic against it
AMOUNT = 777777

fails = []; users = []; client_ids = []; contract_ids = []; job_ids = []


def check(l, ok, d=""):
    print(("PASS  " if ok else "FAIL  ") + l + (f"  [{d}]" if d and not ok else ""))
    if not ok: fails.append(l)


def rest(p): return f"{S}/rest/v1/{p}"
def b64(r): return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags):
    em = f"panel-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{S}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**ADMIN, **REPR},
                   json={"name": MARK, "approved": True, **flags}).raise_for_status()
    td = requests.post(f"{S}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {CN: "base64-" + b64(json.dumps(sess).encode())}


# ---------- radar / hub scraping ----------
# The radar has no API route (computeRadar is called straight from the server
# component), so the assertions read the rendered page - the same approach as
# test_radar_billing.py and test_dormant_clients.py.
OPEN_COMMITMENT_RE = re.compile(
    r"התחייבות פתוחה.*?([\d,]+)\s*₪",
    re.S)
OVERDUE_TITLE = "אבן דרך שעבר מועדה ואין חשבונית"


def radar_open_commitment(cookies):
    html = requests.get(f"{APP}/radar", cookies=cookies).text
    m = OPEN_COMMITMENT_RE.search(html)
    return int(m.group(1).replace(",", "")) if m else None


def radar_overdue_count(cookies):
    """count rendered on the red overdue-milestone alert row; 0 = row absent"""
    html = requests.get(f"{APP}/radar", cookies=cookies).text
    i = html.find(OVERDUE_TITLE)
    if i < 0:
        return 0
    m = re.search(r'min-w-8 text-center">(\d+)<', html[i:i + 900])
    return int(m.group(1)) if m else None


def hub_commitment(cookies):
    """the contracts module tile on the hub - same number, second surface"""
    html = requests.get(f"{APP}/", cookies=cookies).text
    i = html.find("/contracts")
    if i < 0:
        return None
    m = re.search(r"₪([\d,]+)", html[max(0, i - 2500):i + 2500])
    return int(m.group(1).replace(",", "")) if m else None


for _ in range(60):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("FAIL dev server never came up"); sys.exit(1)

try:
    money = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True,
                    "can_view_stages": True, "can_edit_stages": True})
    tech = mkuser({"role": "tech", "can_view_money": False, "can_edit_money": False,
                   "can_view_stages": True, "can_edit_stages": True})

    base_commitment = radar_open_commitment(money)
    base_overdue = radar_overdue_count(money)
    base_hub = hub_commitment(money)
    check("0. radar + hub readable before we touch anything",
          base_commitment is not None and base_overdue is not None and base_hub is not None,
          f"{base_commitment} / {base_overdue} / {base_hub}")

    client_id = requests.post(rest("clients"), headers={**ADMIN, **REPR},
                              json={"name": f"{MARK} client",
                                    "normalized_name": f"ztestpanel{uuid.uuid4().hex[:6]}"}).json()[0]["id"]
    client_ids.append(client_id)
    other_client = requests.post(rest("clients"), headers={**ADMIN, **REPR},
                                 json={"name": f"{MARK} other client",
                                       "normalized_name": f"ztestpanelo{uuid.uuid4().hex[:6]}"}).json()[0]["id"]
    client_ids.append(other_client)

    contract_id = requests.post(rest("contracts"), headers={**ADMIN, **REPR},
                                json={"name": f"{MARK} contract", "client_id": client_id,
                                      "total_amount": AMOUNT, "status": "active"}).json()[0]["id"]
    contract_ids.append(contract_id)

    # pending + past date + NOT estimated = the exact shape the red alert wants
    ms_id = requests.post(rest("contract_milestones"), headers={**ADMIN, **REPR},
                          json={"contract_id": contract_id, "name": f"{MARK} ms1", "amount": AMOUNT,
                                "expected_date": "2020-01-15", "is_estimated": False,
                                "status": "pending"}).json()[0]["id"]
    ms2_id = requests.post(rest("contract_milestones"), headers={**ADMIN, **REPR},
                           json={"contract_id": contract_id, "name": f"{MARK} ms2", "amount": 1000,
                                 "expected_date": "2030-01-15", "is_estimated": True,
                                 "status": "pending"}).json()[0]["id"]

    # ---------- 1. the central test ----------
    check("1a. open commitment grew by exactly the milestone amount",
          radar_open_commitment(money) == base_commitment + AMOUNT + 1000,
          f"{radar_open_commitment(money)} vs {base_commitment}+{AMOUNT}+1000")
    check("1b. overdue-milestone alert counted it",
          radar_overdue_count(money) == base_overdue + 1,
          f"{radar_overdue_count(money)} vs {base_overdue}+1")

    r = requests.post(f"{APP}/api/entity/contract/{contract_id}", cookies=money,
                       headers={"Content-Type": "application/json"},
                       json={"patch": {"status": "closed"}})
    check("1c. close contract -> 200", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
    check("1d. status is closed in the DB",
          requests.get(rest(f"contracts?id=eq.{contract_id}&select=status"),
                       headers=ADMIN).json()[0]["status"] == "closed")

    check("1e. THE CENTRAL ONE - open commitment back to baseline after close",
          radar_open_commitment(money) == base_commitment,
          f"{radar_open_commitment(money)} vs {base_commitment}")
    check("1f. overdue-milestone alert back to baseline after close",
          radar_overdue_count(money) == base_overdue,
          f"{radar_overdue_count(money)} vs {base_overdue}")

    # ---------- 2. the hub tile agrees ----------
    check("2. hub contracts tile back to baseline after close",
          hub_commitment(money) == base_hub, f"{hub_commitment(money)} vs {base_hub}")

    # ---------- 3. reopen + permissions ----------
    r = requests.post(f"{APP}/api/entity/contract/{contract_id}", cookies=money,
                       headers={"Content-Type": "application/json"},
                       json={"patch": {"status": "active"}})
    check("3a. reopen -> 200", r.status_code == 200, f"{r.status_code} {r.text[:160]}")
    check("3b. reopened contract feeds the radar again",
          radar_open_commitment(money) == base_commitment + AMOUNT + 1000)

    r = requests.post(f"{APP}/api/entity/contract/{contract_id}", cookies=tech,
                       headers={"Content-Type": "application/json"},
                       json={"patch": {"status": "closed"}})
    check("3c. technician cannot close a contract", r.status_code in (403, 404),
          f"{r.status_code} {r.text[:160]}")

    # ---------- 4. manual milestone status ----------
    for val in ("paid", "invoiced", "pending"):
        r = requests.post(f"{APP}/api/contracts/milestones/{ms_id}", cookies=money,
                          headers={"Content-Type": "application/json"},
                          json={"patch": {"status": val}})
        got = requests.get(rest(f"contract_milestones?id=eq.{ms_id}&select=status"),
                           headers=ADMIN).json()[0]["status"]
        check(f"4a. status -> {val}", r.status_code == 200 and got == val,
              f"{r.status_code} {got}")

    r = requests.post(f"{APP}/api/contracts/milestones/{ms_id}", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"patch": {"status": "bogus"}})
    check("4b. junk status rejected with a Hebrew 400", r.status_code == 400,
          f"{r.status_code} {r.text[:160]}")

    r = requests.post(f"{APP}/api/contracts/milestones/{ms_id}", cookies=tech,
                      headers={"Content-Type": "application/json"},
                      json={"patch": {"status": "paid"}})
    check("4c. technician cannot edit a milestone status", r.status_code == 403, str(r.status_code))

    # ---------- 5. manual job link, three validations ----------
    job_ok = requests.post(rest("jobs"), headers={**ADMIN, **REPR},
                           json={"client_id": client_id, "campaign": f"{MARK} job ok", "amount": AMOUNT,
                                 "date": "2026-01-10", "paid": "לא", "legacy": False}).json()[0]["id"]
    job_ids.append(job_ok)
    job_other = requests.post(rest("jobs"), headers={**ADMIN, **REPR},
                              json={"client_id": other_client, "campaign": f"{MARK} job other", "amount": 500,
                                    "date": "2026-01-10", "paid": "לא", "legacy": False}).json()[0]["id"]
    job_ids.append(job_other)

    r = requests.post(f"{APP}/api/contracts/milestones/{ms_id}", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"patch": {"job_id": job_ok}})
    linked = requests.get(rest(f"contract_milestones?id=eq.{ms_id}&select=job_id"), headers=ADMIN).json()[0]["job_id"]
    check("5a. link a valid job -> 200 and job_id written",
          r.status_code == 200 and linked == job_ok, f"{r.status_code} {linked}")

    r = requests.post(f"{APP}/api/contracts/milestones/{ms_id}", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"patch": {"job_id": str(uuid.uuid4())}})
    check("5b. missing job -> 404", r.status_code == 404, f"{r.status_code} {r.text[:160]}")

    r = requests.post(f"{APP}/api/contracts/milestones/{ms_id}", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"patch": {"job_id": job_other}})
    check("5c. job of another client -> 400", r.status_code == 400, f"{r.status_code} {r.text[:160]}")

    r = requests.post(f"{APP}/api/contracts/milestones/{ms2_id}", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"patch": {"job_id": job_ok}})
    check("5d. job already linked to another milestone -> 409", r.status_code == 409,
          f"{r.status_code} {r.text[:160]}")

    still = requests.get(rest(f"contract_milestones?id=eq.{ms_id}&select=job_id"), headers=ADMIN).json()[0]["job_id"]
    check("5e. the three rejections left the original link untouched", still == job_ok, str(still))

    r = requests.post(f"{APP}/api/contracts/milestones/{ms_id}", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"patch": {"job_id": None}})
    after = requests.get(rest(f"contract_milestones?id=eq.{ms_id}&select=job_id"), headers=ADMIN).json()[0]["job_id"]
    check("5f. unlink (null) passes without the checks", r.status_code == 200 and after is None,
          f"{r.status_code} {after}")

    # ---------- 6. the derived state reaches the drawer ----------
    r = requests.get(f"{APP}/api/entity/contract/{contract_id}", cookies=money)
    body = r.json() if r.status_code == 200 else {}
    states = [m.get("state") for m in (body.get("milestones") or [])]
    check("6. entity route returns a derived state per milestone (drawer label)",
          r.status_code == 200 and len(states) == 2 and all(s in ("paid", "invoiced", "open", "overdue") for s in states),
          f"{r.status_code} {states}")

finally:
    # FK order (all RESTRICT): invoices -> milestones (drops ms->job) -> jobs
    # -> contracts -> clients. Then events, then the auth users.
    for jid in job_ids:
        requests.delete(rest(f"invoices?job_id=eq.{jid}"), headers=ADMIN)
    for cid in contract_ids:
        requests.delete(rest(f"contract_milestones?contract_id=eq.{cid}"), headers=ADMIN)
    for jid in job_ids:
        r = requests.delete(rest(f"jobs?id=eq.{jid}"), headers={**ADMIN, **REPR})
        if r.status_code >= 300: print("WARNING job delete failed", jid, r.status_code, r.text[:120])
    for cid in contract_ids:
        r = requests.delete(rest(f"contracts?id=eq.{cid}"), headers={**ADMIN, **REPR})
        if r.status_code >= 300: print("WARNING contract delete failed", cid, r.status_code, r.text[:120])
    for cid in client_ids:
        r = requests.delete(rest(f"clients?id=eq.{cid}"), headers={**ADMIN, **REPR})
        if r.status_code >= 300: print("WARNING client delete failed", cid, r.status_code, r.text[:120])
    if users:
        idl = ",".join(users)
        requests.delete(rest(f"events?actor_id=in.({idl})"), headers=ADMIN)
        for uid in users:
            requests.delete(f"{S}/auth/v1/admin/users/{uid}", headers=ADMIN)

    # verify the cleanup actually happened - a leaked contract graph has cost a
    # debugging round before
    leftovers = []
    for cid in contract_ids:
        if requests.get(rest(f"contracts?id=eq.{cid}&select=id"), headers=ADMIN).json():
            leftovers.append(f"contract {cid}")
        if requests.get(rest(f"contract_milestones?contract_id=eq.{cid}&select=id"), headers=ADMIN).json():
            leftovers.append(f"milestones of {cid}")
    for jid in job_ids:
        if requests.get(rest(f"jobs?id=eq.{jid}&select=id"), headers=ADMIN).json():
            leftovers.append(f"job {jid}")
    for cid in client_ids:
        if requests.get(rest(f"clients?id=eq.{cid}&select=id"), headers=ADMIN).json():
            leftovers.append(f"client {cid}")
    for uid in users:
        if requests.get(rest(f"profiles?id=eq.{uid}&select=id"), headers=ADMIN).json():
            leftovers.append(f"profile {uid}")
    check("CLEANUP. no test rows left behind", not leftovers, ", ".join(leftovers))

print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: " + " | ".join(fails)))
sys.exit(1 if fails else 0)
