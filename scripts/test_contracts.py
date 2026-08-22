# -*- coding: utf-8 -*-
"""
Acceptance test for the contracts screen (migration reuse; 0002 tables).

  A. Real data — the "מכירת ביפו" contract: 400,000 total, 150,000 paid
     (חלק א, status=paid + linked job paid) and 250,000 invoiced (חלק ב, job
     linked, 15.9.26). The two always add up to total_amount. The radar's open
     commitment equals the pending milestones of ACTIVE contracts, and its
     milestone alerts point at /contracts.
     (A4/A5/A6 used to pin חלק ב as pending and the commitment as a literal
     250,000. The business invoiced it and the test broke while nothing was
     wrong — rewritten 2026-08-22 to assert rules, not a snapshot.)
  B. Throwaway contract — create a contract + milestone via the API, issue an
     invoice for the milestone (Morning dry-run): a linked job + invoices row
     are created and the milestone flips to 'invoiced' + job_id set.
  C. A technician can neither create a contract nor issue -> 403.

Cleans up every throwaway row + user in finally (events first).
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
        # A4/A5 pinned חלק ב as `pending` + a 250,000 open commitment. That was
        # a snapshot of 2026-07 and the business moved on: חלק ב was invoiced
        # for real (250,000, job linked), so the assertions failed on live data
        # while nothing was broken. Rewritten 2026-08-22 against the invariant
        # that does NOT drift — the two milestones must always add up to the
        # contract total (0056: 150,000 + 250,000 = 400,000 = total_amount,
        # net of VAT) — plus the current, factual state of חלק ב.
        check("A4. milestones add up to the contract total (400,000)",
              sum(m["amount"] for m in ms) == c[0]["total_amount"], str(ms))
        cheleq_b = next((m for m in ms if m["name"] == "חלק ב"), None)
        check("A5. חלק ב invoiced, 250,000, job linked",
              bool(cheleq_b) and cheleq_b["status"] == "invoiced" and cheleq_b["amount"] == 250000
              and bool(cheleq_b["job_id"]) and cheleq_b["expected_date"] == "2026-09-15",
              str(cheleq_b))

    # A6 was a hardcoded 250,000 for the same reason. It now asserts the RULE
    # instead of the number, which also covers the 2026-08-22 change: the radar
    # counts pending milestones of ACTIVE contracts only, so a closed contract
    # contributes nothing.
    active_ids = {c["id"] for c in requests.get(rest("contracts?select=id&status=eq.active"), headers=ADMIN).json()}
    all_ms = requests.get(rest("contract_milestones?select=amount,status,contract_id"), headers=ADMIN).json()
    expected_open = sum(m["amount"] for m in all_ms if m["status"] == "pending" and m["contract_id"] in active_ids)
    closed_pending = sum(m["amount"] for m in all_ms if m["status"] == "pending" and m["contract_id"] not in active_ids)

    # contracts page renders for a money user + shows the contract
    money = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True, "can_view_stages": True})
    tech = mkuser({"role": "tech", "can_view_stages": True, "can_edit_stages": True})
    r = requests.get(f"{APP}/contracts", cookies=money)
    check("A7. /contracts renders for money user, shows contract", r.status_code == 200 and "מכירת ביפו" in r.text, str(r.status_code))
    # radar shows the open-commitment alert linking to /contracts
    r = requests.get(f"{APP}/radar", cookies=money)
    check("A8. radar links open commitment -> /contracts", 'href="/contracts"' in r.text and "התחייבות פתוחה" in r.text, "")

    m = re.search(r"התחייבות פתוחה.*?([\d,]+)\s*₪", r.text, re.S)
    rendered_open = int(m.group(1).replace(",", "")) if m else None
    check("A6. radar open commitment = pending milestones of ACTIVE contracts",
          rendered_open == expected_open, f"rendered {rendered_open} vs expected {expected_open}")
    # Only meaningful while some closed contract actually holds pending
    # milestones. Today none does, so this is stated rather than asserted —
    # test_contracts_panel.py proves the exclusion on data it builds itself.
    if closed_pending:
        check("A6b. pending milestones under closed contracts are excluded",
              rendered_open == expected_open, f"closed-contract pending = {closed_pending}")
    else:
        print(f"NOTE  A6b. no closed contract holds pending milestones right now "
              f"(exclusion covered by test_contracts_panel.py)")

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

    r = requests.post(f"{APP}/api/contracts/milestones/{mid}/issue", cookies=tech, headers={"Content-Type": "application/json"}, json={"mode": "manual", "doc_number": "MS-9001"})
    check("C2. technician issue milestone -> 403", r.status_code == 403, str(r.status_code))

    # mode 'morning' was removed (2026-07-30) — this route only records a
    # document already issued in Morning. Real issuance is /documents.
    r = requests.post(f"{APP}/api/contracts/milestones/{mid}/issue", cookies=money, headers={"Content-Type": "application/json"}, json={"mode": "morning"})
    check("B3. mode=morning refused -> 400", r.status_code == 400, f"{r.status_code} {r.text[:120]}")
    check("B3b. refusal points at /documents", "/documents" in r.text, r.text[:160])

    r = requests.post(f"{APP}/api/contracts/milestones/{mid}/issue", cookies=money, headers={"Content-Type": "application/json"}, json={"mode": "manual", "doc_number": "MS-9001", "issued_at": "2026-07-02"})
    ok = r.status_code == 200
    d = r.json() if ok else {}
    check("B4. record milestone invoice accepted", ok, r.text[:120])
    if d.get("job_id"): job_ids.append(d["job_id"])
    ms2 = requests.get(rest(f"contract_milestones?id=eq.{mid}&select=status,job_id"), headers=ADMIN).json()[0]
    check("B5. milestone -> invoiced + job linked", ms2["status"] == "invoiced" and ms2["job_id"], str(ms2))
    job = requests.get(rest(f"jobs?id=eq.{ms2['job_id']}&select=contract_id,client_id,invoice_biz,amount"), headers=ADMIN).json()[0]
    check("B6. linked job has contract_id + invoice_biz + amount", job["contract_id"] == contract_id and job["invoice_biz"] and job["amount"] == 60000, str(job))
    inv = requests.get(rest(f"invoices?job_id=eq.{ms2['job_id']}&select=type,source,morning_doc_id"), headers=ADMIN).json()
    check("B7. invoices row source=manual, no morning id",
          any(i["type"] == "עסקה" and i["source"] == "manual" and i["morning_doc_id"] is None for i in inv), str(inv))

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
