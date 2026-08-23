# -*- coding: utf-8 -*-
"""The tax route fed with documentIds — auth wall, v1 valve, and one real build.

Run:  python3 scripts/test_tax_route_pull.py               (all tests, 0-5)
      python3 scripts/test_tax_route_pull.py --readonly    (0-4 only: no
      business rows are created — the only write is the temporary test user
      the harness authenticates with, deleted and verified in cleanup)

PRECONDITIONS
  * the dev server must be running (TEST_APP_URL, default http://localhost:3000)
  * run it while WATCHING the approvals queue: test 4 creates a REAL pending
    tax_invoice row for a few seconds until this script deletes it. Nothing
    reaches Morning without a human approving in the modal — but the owner
    asked to see the window, not hear about it (2026-08-11).

DO NOT RUN WITHOUT EXPLICIT OWNER APPROVAL (session rule 6: Morning live,
DRY_RUN=false). The script writes: one temporary auth user, and the pending
child that test 4 builds. Both are deleted in the finally block and the
deletion is VERIFIED — events before the auth user (FK RESTRICT).

TOUCHES MORNING: never. The route only enqueues; the Morning call lives in
issue.ts behind the approval screen, off this path.

What it proves, via real HTTP against the real route:
  0. no cookie                                -> 401 (the can_edit_money gate
     stands in front of the new path exactly as it does the old one)
  1. empty body                               -> 400 "חסרים מסמכי מקור"
  2. sourceIds + documentIds in one request   -> 400 (the v1 mixing valve)
  3. two documentIds                          -> 400 (one pulled doc per request)
  4. an app-issued document's documents.id    -> 400 "משורת התור" (refusal, not
     silent redirect — and read-only: nothing is created)
  5. a REAL eligible pulled 300               -> 200; the child's amount is the
     NET computed from raw.income (never documents.amount), linked and
     remarked; then the child and its events are deleted, verified.
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
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
REF = SUP.split("//")[1].split(".")[0]
ADMIN = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}
ROUTE = f"{APP}/api/documents/tax"
READONLY = "--readonly" in sys.argv

fails = []
made = {"users": [], "children": []}

def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        fails.append(label)

def rest(path):
    r = requests.get(f"{SUP}/rest/v1/{path}", headers=ADMIN)
    r.raise_for_status()
    return r.json()

def make_money_user():
    email = f"ztest-taxroute-{uuid.uuid4().hex[:8]}@example.com"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    u = requests.post(f"{SUP}/auth/v1/admin/users", headers=ADMIN,
                      json={"email": email, "password": pw, "email_confirm": True}).json()
    uid = u["id"]
    made["users"].append(uid)
    requests.patch(f"{SUP}/rest/v1/profiles?id=eq.{uid}", headers=ADMIN,
                   json={"approved": True, "can_view_stages": True, "can_edit_stages": False,
                         "can_view_money": True, "can_edit_money": True, "role": "owner"})
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

def post(jar, **body):
    return requests.post(ROUTE, headers={"Content-Type": "application/json"},
                         cookies=jar or None, json=body)

def net_of(raw):
    return round(sum(l["price"] * l["quantity"] for l in (raw.get("income") or [])), 2)

try:
    owner = make_money_user()

    # -- 0: the auth wall stands in front of the new path ---------------------
    r = post(None, documentIds=[str(uuid.uuid4())])
    check("0. no cookie -> 401", r.status_code == 401, f"got {r.status_code}: {r.text[:120]}")

    # -- 1: empty body --------------------------------------------------------
    r = post(owner)
    check("1. empty body -> 400 missing sources",
          r.status_code == 400 and "חסרים מסמכי מקור" in r.json().get("error", ""),
          f"got {r.status_code}: {r.text[:120]}")

    # -- 2: the mixing valve --------------------------------------------------
    r = post(owner, sourceIds=[str(uuid.uuid4())], documentIds=[str(uuid.uuid4())])
    check("2. mixed request -> 400 with its own message",
          r.status_code == 400 and "לא ניתן לשלב" in r.json().get("error", ""),
          f"got {r.status_code}: {r.text[:120]}")

    # -- 3: one pulled document per request -----------------------------------
    r = post(owner, documentIds=[str(uuid.uuid4()), str(uuid.uuid4())])
    check("3. two documentIds -> 400 one-per-request",
          r.status_code == 400 and "אחד לבקשה" in r.json().get("error", ""),
          f"got {r.status_code}: {r.text[:120]}")

    # -- 4: an app document is sent back to its queue row (read-only) ---------
    app_docs = rest("documents?type=eq.300&status=eq.0&source=eq.app"
                    "&cancelled_at=is.null&archived_at=is.null&select=id,morning_doc_number&limit=1")
    if app_docs:
        r = post(owner, documentIds=[app_docs[0]["id"]])
        check("4. app document -> 400 toward its queue row",
              r.status_code == 400 and "משורת התור" in r.json().get("error", ""),
              f"got {r.status_code}: {r.text[:120]}")
    else:
        print("SKIP  4. no open app-issued 300 in the registry right now")

    # -- 5: the real build — smallest eligible pulled 300 ---------------------
    # eligible = open pull 300, job linked, job carries no invoice_tax yet
    if READONLY:
        print("SKIP  5. --readonly: the real build is reserved for the owner, run at the screen")
        raise SystemExit  # caught by finally; cleanup still runs
    cands = rest("documents?type=eq.300&status=eq.0&source=eq.pull"
                 "&cancelled_at=is.null&archived_at=is.null&job_id=not.is.null"
                 "&select=id,morning_doc_id,morning_doc_number,client_id,job_id,amount,raw"
                 "&order=amount.asc")
    doc = None
    for c in cands:
        jobs = rest(f"jobs?id=eq.{c['job_id']}&select=id,invoice_tax")
        if jobs and not (jobs[0].get("invoice_tax") or "").strip():
            doc = c
            break
    if not doc:
        print("SKIP  5. no eligible pulled 300 with a tax-free job — nothing to build on")
    else:
        net = net_of(doc["raw"])
        print(f"      building on #{doc['morning_doc_number']} (gross {doc['amount']}, expected net {net})")
        r = post(owner, documentIds=[doc["id"]])
        ok = r.status_code == 200
        check("5a. builds -> 200", ok, f"got {r.status_code}: {r.text[:200]}")
        if ok:
            t = r.json().get("tax_document", {})
            child_id = t.get("id")
            if child_id:
                made["children"].append(child_id)
            check("5b. response amount is the NET, not documents.amount",
                  t.get("amount") == net, f"amount={t.get('amount')} net={net} gross={doc['amount']}")
            payload = t.get("payload") or {}
            check("5c. linked to the parent",
                  payload.get("linkedDocumentIds") == [doc["morning_doc_id"]],
                  json.dumps(payload.get("linkedDocumentIds")))
            check("5d. remark names the parent number",
                  str(doc["morning_doc_number"]) in (payload.get("remarks") or ""),
                  payload.get("remarks") or "(none)")
            check("5e. openness known (pull raw carries ref)",
                  t.get("parent_openness_unknown") is False, str(t.get("parent_openness_unknown")))
            # and the row itself, straight from the table
            rows = rest(f"pending_documents?id=eq.{child_id}"
                        "&select=doc_type,status,amount,client_id,bundle_job_ids")
            row = rows[0] if rows else {}
            check("5f. child row: pending tax_invoice",
                  row.get("doc_type") == "tax_invoice" and row.get("status") == "pending", json.dumps(row))
            check("5g. child row amount is the NET", row.get("amount") == net, f"row amount={row.get('amount')}")
            check("5h. bundle_job_ids carries the documents.job_id",
                  row.get("bundle_job_ids") == [doc["job_id"]], json.dumps(row.get("bundle_job_ids")))
            check("5i. client attributed", row.get("client_id") == doc["client_id"])

finally:
    print("\ncleanup")
    leftovers = []

    # the child first: its events, then the row (events before anything with FKs)
    for cid in made["children"]:
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{cid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/pending_documents?id=eq.{cid}", headers=ADMIN)
    for cid in made["children"]:
        if rest(f"pending_documents?id=eq.{cid}&select=id"):
            leftovers.append(f"pending_documents: {cid}")
        if rest(f"events?entity_id=eq.{cid}&select=id"):
            leftovers.append(f"events of child {cid}")

    # then the user: any events it acted in, then the auth user (FK RESTRICT)
    for uid in made["users"]:
        requests.delete(f"{SUP}/rest/v1/events?actor_id=eq.{uid}", headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{uid}", headers=ADMIN)
    for uid in made["users"]:
        u = requests.get(f"{SUP}/auth/v1/admin/users/{uid}", headers=ADMIN)
        if u.status_code == 200 and u.json().get("id"):
            leftovers.append(f"auth user: {uid}")

    if leftovers:
        print("  LEFTOVER ROWS — DELETE BY HAND:")
        for l in leftovers:
            print(f"    {l}")
        fails.append("cleanup")
    else:
        print("  clean — every test row deleted and verified")


print(("\nALL CHECKS PASSED" if not fails else f"\n{len(fails)} FAILURE(S): " + ", ".join(fails)))
sys.exit(0 if not fails else 1)
