# -*- coding: utf-8 -*-
"""
Backlog item: the job created on client approval inherits the show's
default_rate as its amount (owner 2026-07-21). Requires migration 0030.
Issues nothing — a status flip via the service role fires the trigger.

Proves:
  1. approving a client production whose show has default_rate=500 creates a
     job with amount=500 (inherited) and the "inherited" note
  2. a show with no default_rate still creates the job with a null amount
     (unchanged fallback)
"""
import json, os, sys, time, uuid
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

SUP = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; SVC = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
ADMIN = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}
REPR = {**ADMIN, "Prefer": "return=representation"}
MARK = "ZTESTRATE"
failures = []; shows = []; prods = []; clients = []


def check(l, ok, d=""):
    print(("PASS  " if ok else "FAIL  ") + l + (f"  [{d}]" if d and not ok else ""))
    if not ok: failures.append(l)


def rest(p): return f"{SUP}/rest/v1/{p}"


def make_case(rate):
    cid = requests.post(rest("clients"), headers=REPR,
                        json={"name": f"{MARK} c {uuid.uuid4().hex[:4]}", "normalized_name": f"ztr{uuid.uuid4().hex[:6]}"}).json()[0]["id"]
    clients.append(cid)
    show_body = {"name": f"{MARK} s {uuid.uuid4().hex[:4]}", "aliases": [], "client_id": cid,
                 "billing_mode": "per_episode", "active": True}
    if rate is not None:
        show_body["default_rate"] = rate
    sid = requests.post(rest("shows"), headers=REPR, json=show_body).json()[0]["id"]
    shows.append(sid)
    pid = requests.post(rest("productions"), headers=REPR,
                        json={"podcast_name": f"{MARK} p", "show_id": sid, "client_id": cid, "kind": "client",
                              "record_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                              "status": "נשלח_ללקוח", "legacy": False}).json()[0]["id"]
    prods.append(pid)
    # flip to approved via the service role (guards pass via the null pattern)
    requests.patch(rest(f"productions?id=eq.{pid}"), headers=REPR, json={"status": 'אושר_ע"י_לקוח'})
    jp = requests.get(rest(f"job_productions?production_id=eq.{pid}&select=job_id"), headers=ADMIN).json()
    if not jp:
        return None
    job = requests.get(rest(f"jobs?id=eq.{jp[0]['job_id']}&select=id,amount,notes"), headers=ADMIN).json()[0]
    return job


try:
    j1 = make_case(500)
    check("1a. job created on approval", j1 is not None)
    if j1:
        check("1b. job amount inherited from default_rate (500)", float(j1["amount"]) == 500.0, str(j1["amount"]))
        check("1c. note says inherited", "יורש" in (j1["notes"] or ""), str(j1["notes"]))

    j2 = make_case(None)
    check("2a. job created even without a rate", j2 is not None)
    if j2:
        check("2b. no rate -> null amount (fallback)", j2["amount"] is None, str(j2["amount"]))
        check("2c. fallback note", "להשלים סכום" in (j2["notes"] or ""), str(j2["notes"]))

finally:
    print("\n--- cleanup ---")
    for pid in prods:
        jp = requests.get(rest(f"job_productions?production_id=eq.{pid}&select=job_id"), headers=ADMIN).json()
        for j in jp if isinstance(jp, list) else []:
            requests.delete(rest(f"job_productions?job_id=eq.{j['job_id']}"), headers=ADMIN)
            requests.delete(rest(f"events?entity_id=eq.{j['job_id']}"), headers=ADMIN)
            requests.delete(rest(f"jobs?id=eq.{j['job_id']}"), headers=ADMIN)
        requests.delete(rest(f"pending_documents?production_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"events?entity_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"stages?production_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"productions?id=eq.{pid}"), headers=ADMIN)
    for sid in shows:
        requests.delete(rest(f"shows?id=eq.{sid}"), headers=ADMIN)
    for cid in clients:
        requests.delete(rest(f"clients?id=eq.{cid}"), headers=ADMIN)
    left = requests.get(rest(f"productions?podcast_name=like.*{MARK}*&select=id"), headers=ADMIN).json()
    check("cleanup: no test productions left", left == [], json.dumps(left)[:80])
    print()
    if failures:
        print(f"{len(failures)} FAILED: " + " · ".join(failures)); sys.exit(1)
    print("all checks passed")
