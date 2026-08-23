# -*- coding: utf-8 -*-
"""
The 400 (קבלה) automation — the boundary and the chain claim.

MUST run against a dev server started with MORNING_DRY_RUN=true.

What this covers, and what it deliberately cannot:

  The automation itself (issue.ts, receipt branch) flips paid on the jobs it
  reaches THROUGH the tax invoices the receipt was raised on. Its write path
  cannot be driven end-to-end from here at all: issuing for real means a real
  Morning document in the owner's books, and a dry run stops before the jobs
  write on purpose (2026-08-22). So the work is split three ways:

    * the RULES         -> scripts/test_auto_paid.ts       (pure, no I/O)
    * the CHAIN         -> scripts/test_receipt_chain.ts   (jobsBehindReceipt,
                                                            real rows, dedupe)
    * this file         -> the dry-run boundary on the receipt branch, plus the
                           claim the design rests on, verified on real rows
                           rather than argued: a parent that stamped leaves its
                           jobs carrying invoice_tax, so the automation cannot
                           manufacture a RED job. And the counter-case — a job
                           whose tax number was cleared — is reachable, which is
                           exactly why issue.ts events it as an anomaly instead
                           of assuming it away.

Self-cleaning in FK order, verified in finally.
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
ADMIN = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
REPR = {"Prefer": "return=representation"}
ref = S.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"

MARK = "ZTESTRCPT"
NET, GROSS = 1000.0, 1180.0

fails = []; users = []; client_ids = []; job_ids = []; doc_ids = []; pending_ids = []


def check(l, ok, d=""):
    print(("PASS  " if ok else "FAIL  ") + l + (f"  [{d}]" if d and not ok else ""))
    if not ok: fails.append(l)


def rest(p): return f"{S}/rest/v1/{p}"


def ins(table, row):
    r = requests.post(rest(table), headers={**ADMIN, **REPR}, json=row)
    if r.status_code >= 300:
        raise RuntimeError(f"{table}: {r.status_code} {r.text[:300]}")
    return r.json()[0]


def mkuser():
    em = f"rcpt-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{S}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**ADMIN, **REPR},
                   json={"name": MARK, "approved": True, "role": "bookkeeper", "can_view_money": True,
                         "can_edit_money": True, "can_view_stages": True}).raise_for_status()
    td = requests.post(f"{S}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}


def seed_pulled_305(client_id, morning_client_id, job_id, n):
    """A pulled 305 shaped exactly as mapPullDocToReceiptSource demands:
    source='pull', type 305, open (ref carries 400), ILS, a gross in raw."""
    mdid = f"{MARK}-mid-{n}-{uuid.uuid4().hex[:8]}"
    d = ins("documents", {
        "morning_doc_id": mdid,
        "morning_doc_number": f"90{n}",
        "type": 305,
        "status": 0,
        "client_id": client_id,
        "job_id": job_id,
        "amount": NET,
        "source": "pull",
        "raw": {"amount": GROSS, "currency": "ILS", "ref": [400],
                "client": {"id": morning_client_id, "name": f"{MARK} client"}},
    })
    doc_ids.append(d["id"])
    return d


for _ in range(60):
    # ReadTimeout as well as ConnectionError: a cold dev server accepts the
    # connection and then spends several seconds compiling the page, which the
    # other scripts' ConnectionError-only loop mistakes for a crash.
    try:
        if requests.get(APP, timeout=10).status_code < 500: break
    except (requests.exceptions.ConnectionError, requests.exceptions.ReadTimeout): pass
    time.sleep(1)
else:
    print("FAIL dev server never came up"); sys.exit(1)

try:
    money = mkuser()
    morning_client_id = f"mrc-{uuid.uuid4().hex[:8]}"
    cli = ins("clients", {"name": f"{MARK} client", "normalized_name": f"ztestrcpt{uuid.uuid4().hex[:8]}",
                          "morning_client_id": morning_client_id})
    client_ids.append(cli["id"])

    # --- job A: its parent stamped, the ordinary case -----------------------
    jobA = ins("jobs", {"client_id": cli["id"], "campaign": f"{MARK} A", "amount": NET,
                        "paid": "לא", "invoice_tax": "900001"})
    job_ids.append(jobA["id"])
    parentA = seed_pulled_305(cli["id"], morning_client_id, jobA["id"], "0001")

    # --- job B: same shape, but its tax number was cleared by hand ----------
    jobB = ins("jobs", {"client_id": cli["id"], "campaign": f"{MARK} B", "amount": NET,
                        "paid": "לא", "invoice_tax": None})
    job_ids.append(jobB["id"])
    parentB = seed_pulled_305(cli["id"], morning_client_id, jobB["id"], "0002")

    # --- job C: 'ללא חיוב' — must survive everything ------------------------
    jobC = ins("jobs", {"client_id": cli["id"], "campaign": f"{MARK} C", "amount": NET,
                        "paid": "ללא חיוב", "invoice_tax": "900003"})
    job_ids.append(jobC["id"])
    parentC = seed_pulled_305(cli["id"], morning_client_id, jobC["id"], "0003")

    # ================= 1. the chain claim, on real rows =====================
    # The design rests on this: a receipt reaches jobs only through a 305, and a
    # 305 that reached a job stamped it. Asserted here rather than argued, and
    # the counter-case is asserted too — it is reachable, which is why the code
    # events it instead of assuming it cannot happen.
    ja = requests.get(rest(f"jobs?id=eq.{jobA['id']}&select=invoice_tax,paid"), headers=ADMIN).json()[0]
    check("1a. a job reached through a parent that stamped already carries a tax number "
          "(so flipping paid closes it — it cannot land RED)",
          ja["invoice_tax"] not in (None, "") and ja["paid"] == "לא", str(ja))
    jb = requests.get(rest(f"jobs?id=eq.{jobB['id']}&select=invoice_tax,paid"), headers=ADMIN).json()[0]
    check("1b. the counter-case is REACHABLE: a job with no tax number sits behind a valid "
          "parent, so 'the parent always stamped' is not an invariant to rely on",
          jb["invoice_tax"] in (None, ""), str(jb))

    # ================= 2. build a real receipt on those parents =============
    r = requests.post(f"{APP}/api/documents/receipt", cookies=money,
                      headers={"Content-Type": "application/json"},
                      json={"documentIds": [parentA["id"], parentB["id"]]})
    body = r.json() if r.status_code < 500 else {}
    check("2a. receipt built from two pulled 305s", r.status_code == 200 and (body.get("receipt") or {}).get("id"),
          f"{r.status_code} {r.text[:250]}")
    rcpt_id = (body.get("receipt") or {}).get("id")
    if rcpt_id:
        pending_ids.append(rcpt_id)
        row = requests.get(rest(f"pending_documents?id=eq.{rcpt_id}&select=doc_type,job_id,bundle_job_ids,payload,amount"),
                           headers=ADMIN).json()[0]
        check("2b. the receipt row carries NO job of its own — the whole reason the chain exists",
              row["job_id"] is None and not row["bundle_job_ids"], str(row)[:200])
        linked = (row["payload"] or {}).get("linkedDocumentIds") or []
        check("2c. its linkedDocumentIds name both parents (the only route to the jobs)",
              sorted(linked) == sorted([parentA["morning_doc_id"], parentB["morning_doc_id"]]), str(linked))
        check("2d. amount is the parents' GROSS, summed", abs(float(row["amount"]) - 2 * GROSS) < 0.01,
              str(row["amount"]))

        # ============ 3. the dry-run boundary on the receipt branch =========
        pay = [{"type": 4, "amount": 2 * GROSS, "price": 2 * GROSS, "date": time.strftime("%Y-%m-%d")}]
        r = requests.post(f"{APP}/api/documents/pending/review", cookies=money,
                          headers={"Content-Type": "application/json"},
                          json={"ids": [rcpt_id], "action": "approve", "confirmed": True, "payment": pay})
        ab = r.json() if r.status_code < 500 else {}
        check("3a. the 400 was approved and issued in DRY RUN",
              r.status_code == 200 and ab.get("dry_run") is True and ab.get("ok") is True,
              f"{r.status_code} {r.text[:300]}")

        after = requests.get(rest(f"jobs?id=in.({jobA['id']},{jobB['id']})&select=id,paid"), headers=ADMIN).json()
        check("3b. NEITHER job was flipped — the dry-run boundary holds on the receipt branch too",
              all(j["paid"] == "לא" for j in after), str(after))
        ev = requests.get(rest(f"events?entity_id=in.({jobA['id']},{jobB['id']})&event_type=eq.job_marked_paid&select=id"),
                          headers=ADMIN).json()
        check("3c. and no job_marked_paid event was written (it would corrupt payment timing)",
              len(ev) == 0, str(ev))
        skip = requests.get(rest(f"events?entity_id=eq.{rcpt_id}&event_type=eq.dry_run_jobs_stamp_skipped&select=payload"),
                            headers=ADMIN).json()
        check("3d. the skip is evented, carrying the parents it would have walked",
              len(skip) == 1 and sorted((skip[0]["payload"] or {}).get("linked_document_ids") or []) == sorted(linked),
              str(skip)[:250])

    # ================= 4. a parent with no jobs at all =======================
    # The no-op case the owner asked to be loud rather than silent. Built the
    # same way, with nothing behind it.
    parentD = seed_pulled_305(cli["id"], morning_client_id, None, "0004")
    r = requests.post(f"{APP}/api/documents/receipt", cookies=money,
                      headers={"Content-Type": "application/json"}, json={"documentIds": [parentD["id"]]})
    b2 = r.json() if r.status_code < 500 else {}
    rcpt2 = (b2.get("receipt") or {}).get("id")
    check("4a. a receipt can be built on a parent that has no job", r.status_code == 200 and rcpt2,
          f"{r.status_code} {r.text[:250]}")
    if rcpt2:
        pending_ids.append(rcpt2)
        row2 = requests.get(rest(f"pending_documents?id=eq.{rcpt2}&select=payload"), headers=ADMIN).json()[0]
        linked2 = (row2["payload"] or {}).get("linkedDocumentIds") or []
        reach = requests.get(rest(f"documents?morning_doc_id=in.({','.join(linked2)})&select=job_id,bundle_job_ids"),
                             headers=ADMIN).json()
        check("4b. the chain from it reaches no job at all — the auto_receipt_no_jobs case",
              all(d["job_id"] is None and not d["bundle_job_ids"] for d in reach), str(reach))

    # ================= 5. 'ללא חיוב' is out of reach entirely ================
    jc = requests.get(rest(f"jobs?id=eq.{jobC['id']}&select=paid"), headers=ADMIN).json()[0]
    check("5. a 'ללא חיוב' job is untouched by any of this", jc["paid"] == "ללא חיוב", str(jc))

finally:
    # FK order: events -> pending_documents -> invoices -> documents -> jobs ->
    # clients -> auth users. documents.job_id and invoices.job_id both point at
    # jobs, so both go before them.
    for pid in pending_ids:
        requests.delete(rest(f"events?entity_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"pending_documents?id=eq.{pid}"), headers=ADMIN)
    for jid in job_ids:
        requests.delete(rest(f"events?entity_id=eq.{jid}"), headers=ADMIN)
        requests.delete(rest(f"invoices?job_id=eq.{jid}"), headers=ADMIN)
    # BY CLIENT, not by the seeded ids: issuing the receipt writes a documents
    # row of its own (issue.ts writes through to the registry even in a dry run
    # — that is the 2026-08-22 boundary, jobs only), and an invoices row can
    # follow the same way. Deleting only what this script inserted leaves those
    # behind and the client delete then 409s on the FK.
    for cid in client_ids:
        requests.delete(rest(f"invoices?client_id=eq.{cid}"), headers=ADMIN)
        r = requests.delete(rest(f"documents?client_id=eq.{cid}"), headers={**ADMIN, **REPR})
        if r.status_code >= 300: print("WARNING documents delete", cid, r.status_code, r.text[:120])
    for jid in job_ids:
        r = requests.delete(rest(f"jobs?id=eq.{jid}"), headers={**ADMIN, **REPR})
        if r.status_code >= 300: print("WARNING job delete", jid, r.status_code, r.text[:120])
    for cid in client_ids:
        r = requests.delete(rest(f"clients?id=eq.{cid}"), headers={**ADMIN, **REPR})
        if r.status_code >= 300: print("WARNING client delete", cid, r.status_code, r.text[:120])
    for uid in users:
        requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=ADMIN)
        requests.delete(f"{S}/auth/v1/admin/users/{uid}", headers=ADMIN)

    leftovers = []
    for t, q in [("pending_documents", f"id=in.({','.join(pending_ids)})" if pending_ids else None),
                 ("documents", f"id=in.({','.join(doc_ids)})" if doc_ids else None),
                 ("jobs", f"id=in.({','.join(job_ids)})" if job_ids else None),
                 ("clients", f"id=in.({','.join(client_ids)})" if client_ids else None),
                 ("profiles", f"id=in.({','.join(users)})" if users else None)]:
        if q and requests.get(rest(f"{t}?{q}&select=id"), headers=ADMIN).json():
            leftovers.append(t)
    check("CLEANUP. no test rows left behind", not leftovers, ", ".join(leftovers))

print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: " + " | ".join(fails)))
sys.exit(1 if fails else 0)
