# -*- coding: utf-8 -*-
"""
Acceptance test for the contracts screen (migration reuse; 0002 tables).

  A. Real data — the "מכירת ביפו" contract: 400,000 total, 150,000 paid
     (חלק א, status=paid + linked job paid), 250,000 open commitment (חלק ב,
     pending + estimated 15.9.26). Progress = 150k/400k. The radar's open
     commitment (sum of pending milestones) = 250,000, and its milestone
     alerts point at /contracts.
  B. Throwaway contract — create a contract + milestone via the API, issue an
     invoice for the milestone (Morning dry-run): a linked job + invoices row
     are created and the milestone flips to 'invoiced' + job_id set.
  C. A technician can neither create a contract nor issue -> 403.

Cleans up every throwaway row + user in finally (events first).
"""
import base64, json, os, sys, time, uuid, requests

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
ADMIN = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}; REPR = {"Prefer": "return=representation"}
ref = S.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"
fails = []; users = []; contract_id = None; client_id = None; job_ids = []


def check(l, ok, d=""):
    print(("PASS  " if ok else "FAIL  ") + l + (f"  [{d}]" if d and not ok else ""))
    if not ok: fails.append(l)


def rest(p): return f"{S}/rest/v1/{p}"
def b64(r): return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags):
    em = f"con-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{S}/auth/v1/admin/users", headers=ADMIN, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**ADMIN, **REPR}, json={"name": "בדיקת חוזים", "approved": True, **flags}).raise_for_status()
    td = requests.post(f"{S}/auth/v1/token?grant_type=password", headers={"apikey": ANON, "Content-Type": "application/json"}, json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600, "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {CN: "base64-" + b64(json.dumps(sess).encode())}


for _ in range(60):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("FAIL dev server"); sys.exit(1)

try:
    # ---------- A. real "מכירת ביפו" ----------
    c = requests.get(rest("contracts?select=id,name,total_amount,client_id&name=eq.מכירת ביפו"), headers=ADMIN).json()
    check("A1. contract 'מכירת ביפו' exists", len(c) == 1, str(c))
    if c:
        cid = c[0]["id"]
        check("A2. total = 400,000", c[0]["total_amount"] == 400000, str(c[0]["total_amount"]))
        ms = requests.get(rest(f"contract_milestones?contract_id=eq.{cid}&select=name,amount,status,is_estimated,expected_date,job_id"), headers=ADMIN).json()
        paid = [m for m in ms if m["status"] == "paid"]
        pending = [m for m in ms if m["status"] == "pending"]
        check("A3. paid milestone sum = 150,000", sum(m["amount"] for m in paid) == 150000, str(paid))
        check("A4. open commitment sum = 250,000", sum(m["amount"] for m in pending) == 250000, str(pending))
        cheleq_b = next((m for m in pending if m["name"] == "חלק ב"), None)
        check("A5. חלק ב estimated + future date", cheleq_b and cheleq_b["is_estimated"] and cheleq_b["expected_date"] == "2026-09-15", str(cheleq_b))

    # radar open-commitment total = pending milestones sum = 250,000
    all_pending = requests.get(rest("contract_milestones?status=eq.pending&select=amount"), headers=ADMIN).json()
    check("A6. radar open commitment = 250,000", sum(m["amount"] for m in all_pending) == 250000, str(sum(m["amount"] for m in all_pending)))

    # contracts page renders for a money user + shows the contract
    money = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True, "can_view_stages": True})
    tech = mkuser({"role": "tech", "can_view_stages": True, "can_edit_stages": True})
    r = requests.get(f"{APP}/contracts", cookies=money)
    check("A7. /contracts renders for money user, shows contract", r.status_code == 200 and "מכירת ביפו" in r.text, str(r.status_code))
    # radar shows the open-commitment alert linking to /contracts
    r = requests.get(f"{APP}/radar", cookies=money)
    check("A8. radar links open commitment -> /contracts", 'href="/contracts"' in r.text and "התחייבות פתוחה" in r.text, "")

    # ---------- C. technician blocked ----------
    r = requests.post(f"{APP}/api/contracts", cookies=tech, headers={"Content-Type": "application/json"}, json={"name": "x", "client_id": None, "total_amount": 1})
    check("C1. technician create contract -> 403", r.status_code == 403, str(r.status_code))

    # ---------- B. throwaway contract + issue ----------
    client_id = requests.post(rest("clients"), headers={**ADMIN, **REPR}, json={"name": "ZTEST con client", "normalized_name": f"ztestcon{uuid.uuid4().hex[:6]}", "billing_mode": "per_episode", "payment_terms": "net_30"}).json()[0]["id"]
    r = requests.post(f"{APP}/api/contracts", cookies=money, headers={"Content-Type": "application/json"},
                      json={"name": "ZTEST חוזה", "client_id": client_id, "total_amount": 100000,
                            "milestones": [{"name": "שלב 1", "amount": 60000, "expected_date": "2026-08-01", "is_estimated": True}]})
    ok = r.status_code == 200
    contract_id = r.json().get("id") if ok else None
    check("B1. create contract+milestone accepted", ok and contract_id, r.text[:120])
    ms = requests.get(rest(f"contract_milestones?contract_id=eq.{contract_id}&select=id,status,job_id"), headers=ADMIN).json()
    mid = ms[0]["id"] if ms else None
    check("B2. milestone created pending", ms and ms[0]["status"] == "pending", str(ms))

    r = requests.post(f"{APP}/api/contracts/milestones/{mid}/issue", cookies=tech, headers={"Content-Type": "application/json"}, json={"mode": "morning"})
    check("C2. technician issue milestone -> 403", r.status_code == 403, str(r.status_code))

    r = requests.post(f"{APP}/api/contracts/milestones/{mid}/issue", cookies=money, headers={"Content-Type": "application/json"}, json={"mode": "morning"})
    ok = r.status_code == 200
    d = r.json() if ok else {}
    check("B3. issue milestone via Morning accepted", ok, r.text[:120])
    check("B4. dry_run true", d.get("dry_run") is True, str(d))
    if d.get("job_id"): job_ids.append(d["job_id"])
    ms2 = requests.get(rest(f"contract_milestones?id=eq.{mid}&select=status,job_id"), headers=ADMIN).json()[0]
    check("B5. milestone -> invoiced + job linked", ms2["status"] == "invoiced" and ms2["job_id"], str(ms2))
    job = requests.get(rest(f"jobs?id=eq.{ms2['job_id']}&select=contract_id,client_id,invoice_biz,amount"), headers=ADMIN).json()[0]
    check("B6. linked job has contract_id + invoice_biz + amount", job["contract_id"] == contract_id and job["invoice_biz"] and job["amount"] == 60000, str(job))
    inv = requests.get(rest(f"invoices?job_id=eq.{ms2['job_id']}&select=type,source"), headers=ADMIN).json()
    check("B7. invoices row source=morning_api", any(i["type"] == "עסקה" and i["source"] == "morning_api" for i in inv), str(inv))

finally:
    # FK order matters (all RESTRICT): a milestone.job_id points at the
    # issue-created job, and jobs.contract_id points at the contract. So:
    # invoices -> milestones (drops the ms->job ref) -> jobs -> contract ->
    # client. Getting this wrong once already leaked a whole contract graph.
    for jid in job_ids:
        requests.delete(rest(f"invoices?job_id=eq.{jid}"), headers=ADMIN)
    if contract_id:
        requests.delete(rest(f"contract_milestones?contract_id=eq.{contract_id}"), headers=ADMIN)
    for jid in job_ids:
        r = requests.delete(rest(f"jobs?id=eq.{jid}"), headers={**ADMIN, **REPR})
        if r.status_code >= 300:
            print("WARNING job delete failed", jid, r.status_code)
    if contract_id:
        r = requests.delete(rest(f"contracts?id=eq.{contract_id}"), headers={**ADMIN, **REPR})
        if r.status_code >= 300:
            print("WARNING contract delete failed", r.status_code)
    if client_id:
        requests.delete(rest(f"clients?id=eq.{client_id}"), headers=ADMIN)
    if users:
        idl = ",".join(users)
        requests.delete(rest(f"events?actor_id=in.({idl})"), headers=ADMIN)
        for uid in users:
            rr = requests.delete(f"{S}/auth/v1/admin/users/{uid}", headers=ADMIN)
            if rr.status_code >= 300: print("WARNING user delete", uid, rr.status_code)
    print("cleaned up contracts test data + users")

print()
if fails:
    print(f"{len(fails)} FAILURE(S):"); [print(" -", f) for f in fails]; sys.exit(1)
print("ALL PASS")
