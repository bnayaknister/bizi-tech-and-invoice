# -*- coding: utf-8 -*-
"""
Reconciliation gap scan (owner spec, step C — "report first").

READ-ONLY. Sweeps every job and every registry document and measures the
real gap between "what happened" and "what the system knows", in three
buckets that mirror the coming "gaps to handle" screen:

  Gap 1 (red):    a job in the finance "red" state (paid, no tax invoice)
                  that HAS a matching, unlinked tax document sitting in the
                  registry — the money is closed in reality, the job just
                  never got wired to the document.
  Gap 2 (yellow): registry documents that are "unmatched" (no client_id) —
                  Morning client not mapped to one of ours.
  Gap 3 (yellow): jobs stuck "not billed" (purple state) older than 30 days
                  — maybe they were billed by hand in Morning.

Matching key (owner spec): same client (morning_client_id) + amount match
(VAT-aware: a tax document total is base * 1.18) + document date within
+/- 30 days of the job date.
"""
import os
import json
import urllib.request
import urllib.parse
from datetime import date, datetime

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")
if os.path.exists(ENV_PATH):
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

TAX_TYPES = {305, 320}  # tax_invoice / tax_receipt
AMOUNT_TOL = 2.0        # shekels
AMOUNT_TOL_PCT = 0.01   # or 1%
AUTO_DATE_WINDOW = 45   # days — date gates AUTO-LINK only, never suggestions
STALE_WINDOW = 30       # "not billed" older than this
VAT = 1.18


def rest(path, params=None):
    url = SUPABASE_URL + "/rest/v1/" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "apikey": SERVICE_KEY,
        "Authorization": "Bearer " + SERVICE_KEY,
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_all(path, select, extra=None):
    out = []
    offset = 0
    page = 1000
    while True:
        params = {"select": select, "limit": page, "offset": offset}
        if extra:
            params.update(extra)
        rows = rest(path, params)
        out.extend(rows)
        if len(rows) < page:
            break
        offset += page
    return out


def parse_date(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s)[:10]).date()
    except Exception:
        return None


def amount_match(job_amount, doc_amount):
    if job_amount is None or doc_amount is None:
        return False
    ja = float(job_amount)
    da = float(doc_amount)
    for target in (ja, ja * VAT):
        tol = max(AMOUNT_TOL, target * AMOUNT_TOL_PCT)
        if abs(da - target) <= tol:
            return True
    return False


def present(v):
    return v is not None and str(v).strip() != ""


def derive_state(paid, has_biz, has_tax):
    if paid == "כן":
        return "closed" if has_tax else "red"
    if paid == "ללא חיוב":
        return "closed"
    return "blue" if has_biz else "purple"


def main():
    clients = fetch_all("clients", "id,name,morning_client_id")
    jobs = fetch_all(
        "jobs",
        "id,client_id,amount,invoice_biz,invoice_tax,paid,date,due_date,legacy,campaign,contract_id",
    )
    docs = fetch_all(
        "documents",
        "id,morning_doc_number,type,status,client_id,morning_client_id,amount,document_date,job_id,production_id,source",
    )

    client_by_id = {c["id"]: c for c in clients}
    mapped_clients = sum(1 for c in clients if c.get("morning_client_id"))

    # index unlinked tax documents by resolved client key
    tax_docs = [
        d for d in docs
        if d["type"] in TAX_TYPES and not d.get("job_id")
    ]

    def doc_client_key(d):
        # prefer our mapped client; fall back to the raw morning client id
        if d.get("client_id"):
            return ("cid", d["client_id"])
        if d.get("morning_client_id"):
            return ("mid", d["morning_client_id"])
        return None

    def job_client_keys(j):
        keys = []
        if j.get("client_id"):
            keys.append(("cid", j["client_id"]))
            c = client_by_id.get(j["client_id"])
            if c and c.get("morning_client_id"):
                keys.append(("mid", c["morning_client_id"]))
        return keys

    tax_by_key = {}
    for d in tax_docs:
        k = doc_client_key(d)
        if k:
            tax_by_key.setdefault(k, []).append(d)

    # ---- classify jobs ----
    red_jobs = []
    purple_jobs = []
    for j in jobs:
        state = derive_state(
            j.get("paid"),
            present(j.get("invoice_biz")),
            present(j.get("invoice_tax")),
        )
        if state == "red":
            red_jobs.append(j)
        elif state == "purple":
            purple_jobs.append(j)

    # ---- Gap 1: red jobs with a matching unlinked tax doc ----
    gap1_certain = []   # exactly one candidate doc, unambiguous
    gap1_ambiguous = []  # >1 candidate doc
    doc_claimed_by = {}  # doc id -> list of job ids (to detect a doc wanted by >1 job)

    # candidate = same mapped client + amount match (VAT-aware). NO date
    # filter — the date is only a gap we carry (owner rule: date is a weak
    # signal here, must not hide בלאנקו's 80-day-but-perfect match).
    job_candidates = {}
    for j in red_jobs:
        jdate = parse_date(j.get("date")) or parse_date(j.get("due_date"))
        cands = []
        seen = set()
        for k in job_client_keys(j):
            for d in tax_by_key.get(k, []):
                if d["id"] in seen or not amount_match(j.get("amount"), d.get("amount")):
                    continue
                ddate = parse_date(d.get("document_date"))
                gap = abs((ddate - jdate).days) if (jdate and ddate) else None
                seen.add(d["id"])
                cands.append((d, gap))
        job_candidates[j["id"]] = cands
        for d, _ in cands:
            doc_claimed_by.setdefault(d["id"], []).append(j["id"])

    for j in red_jobs:
        cands = job_candidates[j["id"]]
        if not cands:
            continue
        d, gap = cands[0]
        # certain (auto-linkable) = unique 1:1 AND date known within +/-45
        unique = len(cands) == 1 and len(doc_claimed_by[d["id"]]) == 1
        if unique and gap is not None and gap <= AUTO_DATE_WINDOW:
            gap1_certain.append((j, d, gap))
        else:
            gap1_ambiguous.append((j, cands))

    # ---- Gap 2: unmatched documents ----
    unmatched_docs = [d for d in docs if not d.get("client_id")]
    unmatched_tax = [d for d in unmatched_docs if d["type"] in TAX_TYPES]

    # ---- Gap 3: old not-billed (purple) jobs ----
    today = date.today()
    gap3 = []
    for j in purple_jobs:
        if j.get("legacy"):
            continue
        jdate = parse_date(j.get("date"))
        if jdate and (today - jdate).days > STALE_WINDOW:
            gap3.append(j)

    def total(rows, key="amount"):
        return sum(float(r.get(key) or 0) for r in rows)

    print("=" * 64)
    print("RECONCILIATION GAP SCAN")
    print("=" * 64)
    print(f"clients: {len(clients)}  (mapped to Morning: {mapped_clients})")
    print(f"jobs: {len(jobs)}   registry documents: {len(docs)}")
    print(f"  jobs red (paid, no tax invoice):   {len(red_jobs)}  = {total(red_jobs):,.0f} ILS")
    print(f"  jobs purple (delivered, not billed): {len(purple_jobs)}  = {total(purple_jobs):,.0f} ILS")
    print(f"  registry tax docs (305/320): {sum(1 for d in docs if d['type'] in TAX_TYPES)}")
    print(f"  unlinked tax docs (no job_id): {len(tax_docs)}")
    print("-" * 64)
    print("GAP 1  red job WITH a matching unlinked tax doc in registry")
    print(f"  certain (1:1 unique + date <= {AUTO_DATE_WINDOW}d, auto-linkable): {len(gap1_certain)}")
    print(f"  suggestion (needs Shiri to confirm):  {len(gap1_ambiguous)}")
    for j, d, gap in gap1_certain[:20]:
        c = client_by_id.get(j.get("client_id"), {})
        print(f"    AUTO {c.get('name','?')} {j.get('campaign') or ''} "
              f"{j.get('amount')} <- doc #{d.get('morning_doc_number')} "
              f"({d.get('amount')}, {d.get('document_date')}, gap={gap}d)")
    for j, cands in gap1_ambiguous[:20]:
        c = client_by_id.get(j.get("client_id"), {})
        tag = "AMBIGUOUS" if len(cands) > 1 else "SUGGEST"
        docs_s = ", ".join(f"#{d.get('morning_doc_number')}(gap={g}d)" for d, g in cands)
        print(f"    {tag:9} {c.get('name','?')} {j.get('campaign') or ''} {j.get('amount')} <- {docs_s}")
    print("-" * 64)
    print("GAP 2  unmatched registry documents (no client mapping)")
    print(f"  total unmatched docs: {len(unmatched_docs)}")
    print(f"    of which tax docs:  {len(unmatched_tax)}")
    print("-" * 64)
    print(f"GAP 3  jobs not billed > {STALE_WINDOW} days (non-legacy)")
    print(f"  total: {len(gap3)}  = {total(gap3):,.0f} ILS")
    for j in gap3[:20]:
        c = client_by_id.get(j.get("client_id"), {})
        print(f"    - job {j['id'][:8]} {c.get('name','?')} {j.get('campaign') or ''} "
              f"{j.get('amount')}  date={j.get('date')}")
    print("=" * 64)


if __name__ == "__main__":
    main()
