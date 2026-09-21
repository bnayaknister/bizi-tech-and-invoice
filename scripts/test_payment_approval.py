# -*- coding: utf-8 -*-
"""
E2E for F14 stage B — the payment approval split (owner decision 2026-09-21).

  GET  /api/finance/payment-matches     proposes, writes nothing
  POST /api/finance/reconcile-payments  links ONLY explicitly approved pairs

Isolated ZTESTAPPROVE data — its own client, its own unpaid job, its own
receipt — driven through the real routes. Deleted in finally, and the deletion
is verified before the script reports success (test-data-cleanup-rule).

⚠️ THE AMOUNT IS ₪1,013 ON PURPOSE. The proposal list is computed over the
WHOLE graph, so a round number that some real client also bills would put a
real row beside the test row. An odd number nobody uses keeps the list
readable, and the very first assertion is that the list holds EXACTLY the
seeded pair — a real row appearing there is itself a failure worth stopping on.
No real client is touched: matching requires a shared client key, and this
client is created here and deleted here (rule 44 — אסתטיטוקס 740d206e and every
other live client stay out).

Proves, in this order because each step sets up the next:
  1. GET proposes exactly the seeded pair, and writes nothing
  2. POST with no pairs / empty pairs / a pair missing its fingerprint → 400
  3. an amount nudged INSIDE the tolerance → the pair survives the allowed-set
     gate and is refused by the FINGERPRINT — reason "stale", nothing written
  4. a second matching document → the pair leaves the allowed set entirely and
     is refused there — reason "not_in_set", nothing written
  5. the approved pair → linked, paid=כן, event written
  6. and it then disappears from the proposals

Run (rule 40 — an isolated server, verified, never :3000):
  MORNING_DRY_RUN=true npx next dev -p 3100
  curl -s localhost:3100/api/morning/status        # must say "dryRun": true
  TEST_APP_URL=http://localhost:3100 python3 scripts/test_payment_approval.py
"""
import base64, json, os, sys, time, uuid
from datetime import date, timedelta
import requests

for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]; SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
# defaults to the ISOLATED port, not :3000 — a careless run must not reach the
# server whose .env.local issues real Morning documents
APP = os.environ.get("TEST_APP_URL", "http://localhost:3100")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
REPR = {"Prefer": "return=representation"}
ref = U.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"

AMOUNT = 1013  # see the header

failures = []
users = []
created = {"clients": [], "jobs": [], "docs": []}


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail else ""))
    if not ok:
        failures.append(label)


def rest(p): return f"{U}/rest/v1/{p}"


def mkuser(flags):
    em = f"appr-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**A, **REPR}, json={"name": "ZTESTAPPROVE", "approved": True, **flags}).raise_for_status()
    td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"}, json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600, "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}


def mkclient():
    c = requests.post(rest("clients"), headers={**A, **REPR}, json={
        "name": "ZTESTAPPROVE לקוח " + uuid.uuid4().hex[:4],
        "normalized_name": "ztestapprove" + uuid.uuid4().hex[:6],
        "morning_client_id": "ZTA-" + uuid.uuid4().hex[:8],
    }).json()[0]
    created["clients"].append(c["id"]); return c["id"], c["morning_client_id"]


def mkjob(cid, amount):
    j = requests.post(rest("jobs"), headers={**A, **REPR}, json={
        "client_id": cid, "amount": amount,
        "date": (date.today() - timedelta(days=40)).isoformat(),
        "paid": "לא", "campaign": "ZTESTAPPROVE job", "legacy": False, "dismissed": False,
    }).json()[0]
    created["jobs"].append(j["id"]); return j["id"]


def mkdoc(cid, mcid, typ, amount):
    d = requests.post(rest("documents"), headers={**A, **REPR}, json={
        "morning_doc_id": "ZTA-DOC-" + uuid.uuid4().hex[:10],
        "morning_doc_number": "ZA" + uuid.uuid4().hex[:5],
        "type": typ, "amount": amount, "currency": "ILS",
        "document_date": (date.today() - timedelta(days=5)).isoformat(),
        "source": "pull", "client_id": cid, "morning_client_id": mcid,
    }).json()[0]
    created["docs"].append(d["id"]); return d["id"], d["morning_doc_number"]


def get_matches(ck):
    r = requests.get(f"{APP}/api/finance/payment-matches", cookies=ck, timeout=120)
    if r.status_code != 200:
        print(f"  !! GET -> {r.status_code}: {r.text[:200]}")
        return None
    return r.json().get("matches", [])


def job_state(jid):
    return requests.get(rest(f"jobs?id=eq.{jid}&select=paid,invoice_tax"), headers=A).json()[0]


def doc_job(did):
    return requests.get(rest(f"documents?id=eq.{did}&select=job_id"), headers=A).json()[0]["job_id"]


for _ in range(90):
    try:
        if requests.get(APP, timeout=2).status_code < 500:
            break
    except requests.exceptions.ConnectionError:
        pass
    time.sleep(1)
else:
    print(f"dev server never came up at {APP}"); sys.exit(1)

try:
    money = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True})

    # ---- rule 40, step 2: the server must be the isolated one ------------
    # /api/morning/status requires a session, which is why this sits after the
    # test user and not before it — the rule says so in as many words. The user
    # is already created, so a refusal here still runs the cleanup in finally.
    # This suite issues no Morning document, but a test that ever drifts into a
    # route that does must fail CLOSED rather than discover it afterwards.
    status = requests.get(f"{APP}/api/morning/status", cookies=money, timeout=10).json()
    print(f"target: {APP}   dryRun={status.get('dryRun')}")
    if status.get("dryRun") is not True:
        print("⚠️  REFUSING TO RUN: /api/morning/status did not report dryRun=true (rule 40)")
        failures.append("rule 40: dryRun was not true")
        raise SystemExit(1)

    cid, mcid = mkclient()
    jid = mkjob(cid, AMOUNT)
    did, docnum = mkdoc(cid, mcid, 400, AMOUNT)  # קבלה — the type that flips paid

    # ── 1. the proposals ──────────────────────────────────────────────────
    print("\n--- 1. GET proposes, and proposes only this ---")
    m = get_matches(money)
    check("1a. GET 200", m is not None)
    m = m or []
    foreign = [x for x in m if x["docId"] != did]
    check("1b. EXACTLY one proposal, and it is the seeded pair",
          len(m) == 1 and m[0]["docId"] == did and m[0]["jobId"] == jid,
          f"got {len(m)}" + (f" · foreign rows: {json.dumps(foreign, ensure_ascii=False)[:300]}" if foreign else ""))
    if foreign:
        print("  ⚠️  A REAL ROW IS IN THE PROPOSAL LIST. That is a live finding, not a test bug.")
    if len(m) == 1:
        row = m[0]
        check("1c. enriched: number, type label, amounts, dates, client",
              row["docNumber"] == docnum and row["docTypeLabel"] == "קבלה"
              and row["docAmount"] == AMOUNT and row["jobAmount"] == AMOUNT
              and row["docDate"] and row["jobDate"] and "ZTESTAPPROVE" in row["clientName"],
              json.dumps(row, ensure_ascii=False)[:300])
        check("1d. basis phrased as confidence.ts phrases it",
              row["amountBasisLabel"] == "סכום מדויק לפני מע״מ", row["amountBasisLabel"])
        check("1e. date gap present", isinstance(row["dateGapDays"], int), str(row["dateGapDays"]))
        check("1f. fingerprint present", bool(row.get("fingerprint")), str(row.get("fingerprint")))
        fp = row["fingerprint"]
    else:
        fp = ""
    check("1g. GET wrote nothing — job still unpaid, doc still unlinked",
          job_state(jid)["paid"] == "לא" and doc_job(did) is None)

    # ── 2. the body is mandatory ──────────────────────────────────────────
    print("\n--- 2. POST refuses without an explicit list ---")
    r = requests.post(f"{APP}/api/finance/reconcile-payments", cookies=money, timeout=60)
    check("2a. no body → 400", r.status_code == 400, f"{r.status_code} {r.text[:120]}")
    check("2b. …and says the endpoint no longer links everything",
          "אינו מקשר עוד את כל ההתאמות" in r.text, r.text[:160])
    r = requests.post(f"{APP}/api/finance/reconcile-payments", cookies=money, json={"pairs": []}, timeout=60)
    check("2c. empty pairs → 400", r.status_code == 400, f"{r.status_code} {r.text[:120]}")
    r = requests.post(f"{APP}/api/finance/reconcile-payments", cookies=money, json={"pairs": [{"docId": did, "jobId": jid}]}, timeout=60)
    check("2d. a pair with no fingerprint → 400", r.status_code == 400, f"{r.status_code} {r.text[:120]}")
    check("2e. nothing written by any of the three",
          job_state(jid)["paid"] == "לא" and doc_job(did) is None)

    # ── 3. the fingerprint gate ───────────────────────────────────────────
    # An amount moved INSIDE the tolerance (max(₪2, 1%) = ₪10.13 here). The pair
    # is still an edge, still unique, still "high" — so it passes the
    # allowed-set gate and only the signature can tell it is no longer the row
    # that was approved. This is the one case the fingerprint actually catches.
    print("\n--- 3. an amount nudged inside tolerance → refused as stale ---")
    requests.patch(rest(f"documents?id=eq.{did}"), headers={**A, **REPR}, json={"amount": AMOUNT + 5})
    m2 = get_matches(money) or []
    check("3a. the pair is STILL proposed (inside tolerance)",
          len(m2) == 1 and m2[0]["docId"] == did, f"got {len(m2)}")
    check("3b. …but its fingerprint changed", len(m2) == 1 and m2[0]["fingerprint"] != fp)
    r = requests.post(f"{APP}/api/finance/reconcile-payments", cookies=money,
                      json={"pairs": [{"docId": did, "jobId": jid, "fingerprint": fp}]}, timeout=60)
    body = r.json()
    check("3c. 200 with per-pair results, not a blanket failure", r.status_code == 200 and "results" in body, r.text[:160])
    res = (body.get("results") or [{}])[0]
    check("3d. refused", res.get("ok") is False, json.dumps(body, ensure_ascii=False)[:250])
    check("3e. reason is 'stale'", res.get("reason") == "stale", str(res.get("reason")))
    check("3f. the message says the state changed", "המצב השתנה" in (res.get("error") or ""), str(res.get("error"))[:160])
    check("3g. NOTHING was written", job_state(jid)["paid"] == "לא" and doc_job(did) is None)
    requests.patch(rest(f"documents?id=eq.{did}"), headers={**A, **REPR}, json={"amount": AMOUNT})
    m3 = get_matches(money) or []
    check("3h. restoring the amount restores the fingerprint", len(m3) == 1 and m3[0]["fingerprint"] == fp)

    # ── 4. the allowed-set gate ───────────────────────────────────────────
    # A second matching document arrives (what a pull does). Both degrees rise,
    # confidence drops to medium, and the pair leaves the list altogether — so
    # it is refused BEFORE the fingerprint is ever compared.
    print("\n--- 4. a second matching document → refused as no longer unique ---")
    did2, _ = mkdoc(cid, mcid, 400, AMOUNT)
    m4 = get_matches(money) or []
    check("4a. the proposal list is now empty — ambiguity is never proposed", len(m4) == 0, f"got {len(m4)}")
    r = requests.post(f"{APP}/api/finance/reconcile-payments", cookies=money,
                      json={"pairs": [{"docId": did, "jobId": jid, "fingerprint": fp}]}, timeout=60)
    body = r.json()
    res = (body.get("results") or [{}])[0]
    check("4b. refused", r.status_code == 200 and res.get("ok") is False, r.text[:200])
    check("4c. reason is 'not_in_set'", res.get("reason") == "not_in_set", str(res.get("reason")))
    check("4d. the message names the ambiguity", "אינו התאמה ייחודית יותר" in (res.get("error") or ""), str(res.get("error"))[:200])
    check("4e. NOTHING was written", job_state(jid)["paid"] == "לא" and doc_job(did) is None)

    # remove the second document; the pair becomes unique again
    requests.delete(rest(f"documents?id=eq.{did2}"), headers=A)
    created["docs"].remove(did2)

    # ── 5. the approved pair ──────────────────────────────────────────────
    print("\n--- 5. the approved pair links and marks paid ---")
    m5 = get_matches(money) or []
    check("5a. proposed again", len(m5) == 1 and m5[0]["docId"] == did, f"got {len(m5)}")
    fp5 = m5[0]["fingerprint"] if m5 else ""
    r = requests.post(f"{APP}/api/finance/reconcile-payments", cookies=money,
                      json={"pairs": [{"docId": did, "jobId": jid, "fingerprint": fp5}]}, timeout=60)
    body = r.json()
    res = (body.get("results") or [{}])[0]
    check("5b. linked", r.status_code == 200 and res.get("ok") is True, r.text[:250])
    check("5c. state reported 'paid'", res.get("state") == "paid", str(res.get("state")))
    check("5d. counters", body.get("linked") == 1 and body.get("refused") == 0, json.dumps(body, ensure_ascii=False)[:200])
    js = job_state(jid)
    check("5e. job paid=כן", js["paid"] == "כן", str(js["paid"]))
    check("5f. NO invoice_tax (a bare קבלה is not a tax invoice)", not js["invoice_tax"], str(js["invoice_tax"]))
    check("5g. document linked to the job", doc_job(did) == jid)
    ev = requests.get(rest(f"events?entity_id=eq.{jid}&event_type=eq.job_marked_paid&select=payload"), headers=A).json()
    check("5h. job_marked_paid event written", len(ev) == 1 and ev[0]["payload"].get("via") == "reconcile", str(len(ev)))
    evr = requests.get(rest(f"events?entity_id=eq.{jid}&event_type=eq.document_reconciled&select=payload"), headers=A).json()
    check("5i. document_reconciled event records it as NOT automatic",
          len(evr) == 1 and evr[0]["payload"].get("auto") is False, json.dumps(evr, ensure_ascii=False)[:200])

    # ── 6. and it leaves the list ─────────────────────────────────────────
    print("\n--- 6. a linked pair stops being proposed ---")
    m6 = get_matches(money) or []
    check("6a. proposals empty again", len(m6) == 0, f"got {len(m6)}")
    r = requests.post(f"{APP}/api/finance/reconcile-payments", cookies=money,
                      json={"pairs": [{"docId": did, "jobId": jid, "fingerprint": fp5}]}, timeout=60)
    res = (r.json().get("results") or [{}])[0]
    check("6b. re-approving the same pair is refused", res.get("ok") is False, r.text[:200])
    check("6c. …as already linked", "כבר שויך" in (res.get("error") or ""), str(res.get("error"))[:160])

finally:
    print("\n--- cleanup ---")
    for j in created["jobs"]:
        requests.delete(rest(f"invoices?job_id=eq.{j}"), headers=A)
        requests.delete(rest(f"events?entity_id=eq.{j}"), headers=A)
    for d in created["docs"]:
        requests.delete(rest(f"documents?id=eq.{d}"), headers=A)
    for j in created["jobs"]:
        requests.delete(rest(f"jobs?id=eq.{j}"), headers=A)
    for c in created["clients"]:
        requests.delete(rest(f"clients?id=eq.{c}"), headers=A)
    for u in users:
        requests.delete(rest(f"events?actor_id=eq.{u}"), headers=A)
        requests.delete(f"{U}/auth/v1/admin/users/{u}", headers=A)
    leftc = requests.get(rest("clients?normalized_name=like.ztestapprove*&select=id"), headers=A).json()
    leftp = requests.get(rest("profiles?name=like.*ZTESTAPPROVE*&select=id"), headers=A).json()
    check("cleanup: no ZTESTAPPROVE clients left", leftc == [], json.dumps(leftc)[:120])
    check("cleanup: no ZTESTAPPROVE profiles left", leftp == [], json.dumps(leftp)[:120])

print()
if failures:
    print(f"{len(failures)} FAILED: " + " · ".join(failures)); sys.exit(1)
print("all checks passed")
