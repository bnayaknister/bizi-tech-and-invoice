# -*- coding: utf-8 -*-
"""
E2E for the CHEQUE payment fields (owner bug 2026-09-16): a 320 for גל אורן לרנר
came back from Morning as "נא למלא את פרטי הצ׳ק בשורת התקבול" because the
approval modal had no cheque fields to offer at all. Morning declares all four
required for a cheque (PaymentRowRequest: "required when using cheques").

Also covers the payment-METHOD reset that was found beside it: the modal used to
reopen on 4 (העברה בנקאית) whatever had been chosen, so a retry was one click
from issuing by a method nobody picked.

RULE 40 — DRY_RUN server only. Run against :3100 launched with
MORNING_DRY_RUN=true, never against :3000 (.env.local carries
MORNING_DRY_RUN=false). Verified here against /api/morning/status before
anything is sent.

Proves:
  1. the server is in dry-run (rule 40 gate)
  2. cheque missing one of the four fields -> 400 with the approved sentence,
     and the queue row is UNTOUCHED (still pending, attempts unchanged)
  3. payment with no method at all -> 400 "חסר אמצעי תשלום" (not the
     ניכוי במקור sentence Number(null)===0 used to earn)
  4. a complete cheque issues (dry run) and the payload ACTUALLY SENT carries
     chequeNum / bankName / bankBranch / bankAccount as four separate fields,
     with `description` left alone for Morning to compose
  5. העברה בנקאית sends NO cheque keys at all — absent, not empty

The rows are clones of the real failed row 37ae24e0 (same payload, same client,
same linked parent) so the gates run on the real shape. Self-cleaning in FK
order: events, invoices, documents, then the queue rows.
"""
import base64, json, os, sys, time, uuid
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
for line in open(os.path.join(HERE, "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3100")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
ref = U.split("//")[1].split(".")[0]
CN = f"sb-{ref}-auth-token"

# the real failed row this bug was reported on
SOURCE_ROW = "37ae24e0-3729-48cd-ab3c-5dddfabd98fc"

CHEQUE_MSG = "שורת תקבול 1: תקבול בצ׳ק מחייב מס׳ צ׳ק, בנק, סניף ומס׳ חשבון"
NO_METHOD_MSG = "שורת תקבול 1: חסר אמצעי תשלום"
CHEQUE_KEYS = ["chequeNum", "bankName", "bankBranch", "bankAccount"]
SAMPLE = {"chequeNum": "0781", "bankName": "20", "bankBranch": "429", "bankAccount": "600008"}


def rest(p):
    return f"{U}/rest/v1/{p}"


def ins(t, row):
    r = requests.post(rest(t), headers={**A, "Prefer": "return=representation"}, json=row)
    r.raise_for_status()
    return r.json()[0]


def sel(t):
    r = requests.get(rest(t), headers=A)
    r.raise_for_status()
    return r.json()


def patch(t, q, row):
    requests.patch(rest(f"{t}?{q}"), headers=A, json=row)


def dele(t, q):
    requests.delete(rest(f"{t}?{q}"), headers=A)


passed = 0
failed = 0


def check(name, ok, detail=""):
    global passed, failed
    print(("  PASS  " if ok else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))
    passed += bool(ok)
    failed += (not ok)


def mkuser():
    em = f"ZTESTCHQ-{uuid.uuid4().hex[:8]}@bizi-test.local"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(
        f"{U}/auth/v1/admin/users",
        headers=A,
        json={"email": em, "password": pw, "email_confirm": True},
    ).json()["id"]
    patch("profiles", f"id=eq.{uid}", {
        "name": "ZTESTCHQ", "approved": True, "role": "bookkeeper",
        "can_view_money": True, "can_edit_money": True,
        "can_view_stages": True, "can_edit_stages": True,
    })
    td = requests.post(
        f"{U}/auth/v1/token?grant_type=password",
        headers={"apikey": AN, "Content-Type": "application/json"},
        json={"email": em, "password": pw},
    ).json()
    sess = {
        "access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
        "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"],
        "user": td["user"],
    }
    cookie = "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")
    return uid, {CN: cookie}


uid = None
clones = []
dry_ids = []

try:
    # ---- 1. rule 40: the server must be in dry run --------------------------
    print("\n[1] rule 40 — dry-run gate")
    for _ in range(60):
        try:
            if requests.get(APP, timeout=2).status_code < 500:
                break
        except requests.exceptions.ConnectionError:
            pass
        time.sleep(1)
    # the probe is money-gated, so the user comes first
    uid, ck = mkuser()
    st = requests.get(f"{APP}/api/morning/status", cookies=ck, timeout=30).json()
    check(f"{APP} reports dryRun=true", st.get("dryRun") is True, json.dumps(st, ensure_ascii=False))
    if st.get("dryRun") is not True:
        print("\nABORTING — not a dry-run server. Nothing was sent.")
        sys.exit(1)

    src = sel(f"pending_documents?select=*&id=eq.{SOURCE_ROW}")
    if not src:
        print(f"\nABORTING — source row {SOURCE_ROW} not found.")
        sys.exit(1)
    src = src[0]
    print(f"      cloning {SOURCE_ROW} — {src['doc_type']} {src['amount']} "
          f"last_error={src['last_error']!r}")

    def clone(tag):
        row = ins("pending_documents", {
            "doc_type": src["doc_type"],
            "client_id": src["client_id"],
            "amount": src["amount"],
            "status": "pending",
            "payload": src["payload"],
            # bundle_job_ids deliberately dropped: the dry-run path skips the
            # jobs stamp anyway (dry_run_jobs_stamp_skipped), and a clone must
            # not be able to reach a real job at all.
            "bundle_job_ids": None,
        })
        clones.append(row["id"])
        print(f"      clone[{tag}] = {row['id']}")
        return row["id"]

    def approve(pid, payment):
        return requests.post(
            f"{APP}/api/documents/pending/review",
            headers={"Content-Type": "application/json"},
            cookies=ck,
            json={"ids": [pid], "action": "approve", "confirmed": True,
                  "tax_variant": "tax_receipt", "recipients": [], "payment": [payment]},
            timeout=60,
        )

    base_pay = {"date": "2026-09-16", "price": 1770, "amount": 1770,
                "currency": "ILS", "currencyRate": 1}

    # ---- 2. cheque missing a field -----------------------------------------
    print("\n[2] cheque missing מס׳ חשבון -> refused, row untouched")
    pid = clone("incomplete")
    short = {**base_pay, "type": 2, "chequeNum": "0781", "bankName": "20", "bankBranch": "429"}
    r = approve(pid, short)
    body = r.json()
    check("status 400", r.status_code == 400, str(r.status_code))
    check("approved sentence", body.get("error") == CHEQUE_MSG, repr(body.get("error")))
    after = sel(f"pending_documents?select=status,attempts,morning_doc_id&id=eq.{pid}")[0]
    check("row still pending", after["status"] == "pending", after["status"])
    check("nothing issued", after["morning_doc_id"] is None, repr(after["morning_doc_id"]))

    print("\n[2b] blank-but-present field is also refused")
    r = approve(pid, {**short, "bankAccount": "   "})
    check("status 400", r.status_code == 400, str(r.status_code))
    check("approved sentence", r.json().get("error") == CHEQUE_MSG, repr(r.json().get("error")))

    # ---- 3. no method at all ------------------------------------------------
    print("\n[3] payment with type=null -> 'חסר אמצעי תשלום'")
    r = approve(pid, {**base_pay, "type": None})
    check("status 400", r.status_code == 400, str(r.status_code))
    check("names the missing method, not withholding",
          r.json().get("error") == NO_METHOD_MSG, repr(r.json().get("error")))

    # ---- 4. the complete cheque --------------------------------------------
    print("\n[4] complete cheque -> issues (dry run), and the SENT payload")
    r = approve(pid, {**base_pay, "type": 2, **SAMPLE})
    ok_body = r.json()
    check("accepted", r.status_code in (200, 207) and ok_body.get("ok") is True,
          f"{r.status_code} {json.dumps(ok_body, ensure_ascii=False)[:200]}")
    check("server reports dry_run", ok_body.get("dry_run") is True, str(ok_body.get("dry_run")))

    ev = sel(f"events?select=payload,created_at&entity_id=eq.{pid}"
             f"&event_type=eq.morning_call_started&order=created_at.desc")
    check("morning_call_started recorded", len(ev) > 0)
    sent = ev[0]["payload"]["sent"] if ev else {}
    row = sel(f"pending_documents?select=morning_doc_id&id=eq.{pid}")[0]
    if row.get("morning_doc_id"):
        dry_ids.append(row["morning_doc_id"])
        check("issued under a dry- id (no real Morning document)",
              str(row["morning_doc_id"]).startswith("dry-"), row["morning_doc_id"])

    print("\n      ---- PAYLOAD THAT WOULD BE SENT TO MORNING ----")
    print(json.dumps(sent, ensure_ascii=False, indent=2))
    print("      ------------------------------------------------\n")

    p0 = (sent.get("payment") or [{}])[0]
    for k in CHEQUE_KEYS:
        check(f"sent.payment[0].{k} = {SAMPLE[k]!r}", p0.get(k) == SAMPLE[k], repr(p0.get(k)))
    check("leading zero survived (chequeNum is a string)",
          p0.get("chequeNum") == "0781" and isinstance(p0.get("chequeNum"), str), repr(p0.get("chequeNum")))
    check("description NOT composed by us — Morning builds that sentence",
          "description" not in p0 or not p0.get("description"), repr(p0.get("description")))
    check("type is 2 (צ׳ק)", p0.get("type") == 2, repr(p0.get("type")))

    # ---- 4b. the restore contract ------------------------------------------
    print("\n[4b] the row now carries the cheque, so reopening can restore it")
    stored = sel(f"pending_documents?select=payload&id=eq.{pid}")[0]["payload"]
    sp = (stored.get("payment") or [{}])[0]
    check("stored payload holds type 2", sp.get("type") == 2, repr(sp.get("type")))
    check("stored payload holds all four fields",
          all(sp.get(k) == SAMPLE[k] for k in CHEQUE_KEYS),
          json.dumps({k: sp.get(k) for k in CHEQUE_KEYS}, ensure_ascii=False))

    # ---- 5. bank transfer sends no cheque keys ------------------------------
    print("\n[5] העברה בנקאית -> no cheque keys in the payload")
    pid2 = clone("bank")
    r = approve(pid2, {**base_pay, "type": 4})
    check("accepted", r.status_code in (200, 207) and r.json().get("ok") is True, str(r.status_code))
    ev2 = sel(f"events?select=payload&entity_id=eq.{pid2}"
              f"&event_type=eq.morning_call_started&order=created_at.desc")
    sent2 = ev2[0]["payload"]["sent"] if ev2 else {}
    q0 = (sent2.get("payment") or [{}])[0]
    row2 = sel(f"pending_documents?select=morning_doc_id&id=eq.{pid2}")[0]
    if row2.get("morning_doc_id"):
        dry_ids.append(row2["morning_doc_id"])
    print("      payment row: " + json.dumps(q0, ensure_ascii=False))
    check("type is 4 (העברה בנקאית)", q0.get("type") == 4, repr(q0.get("type")))
    for k in CHEQUE_KEYS:
        check(f"{k} ABSENT (not empty)", k not in q0, repr(q0.get(k)))

finally:
    print("\n[cleanup]")
    for did in dry_ids:
        dele("invoices", f"morning_doc_id=eq.{did}")
        dele("documents", f"morning_doc_id=eq.{did}")
    for pid in clones:
        dele("events", f"entity_id=eq.{pid}")
        dele("pending_documents", f"id=eq.{pid}")
    left = []
    for pid in clones:
        if sel(f"pending_documents?select=id&id=eq.{pid}"):
            left.append(pid)
        if sel(f"events?select=id&entity_id=eq.{pid}&limit=1"):
            left.append(f"events/{pid}")
    for did in dry_ids:
        if sel(f"invoices?select=id&morning_doc_id=eq.{did}&limit=1"):
            left.append(f"invoices/{did}")
        if sel(f"documents?select=id&morning_doc_id=eq.{did}&limit=1"):
            left.append(f"documents/{did}")
    if uid:
        dele("events", f"actor_id=eq.{uid}")
        requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
        if requests.get(f"{U}/auth/v1/admin/users/{uid}", headers=A).status_code < 400:
            left.append(f"user/{uid}")
    print("  leftovers: " + (", ".join(left) if left else "none — verified"))
    # the real row must be exactly as we found it
    now = sel(f"pending_documents?select=status,attempts,last_error&id=eq.{SOURCE_ROW}")
    print(f"  source row {SOURCE_ROW[:8]}: {json.dumps(now[0], ensure_ascii=False) if now else 'MISSING'}")
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if (failed or left) else 0)
