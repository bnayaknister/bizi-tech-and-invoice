# -*- coding: utf-8 -*-
"""
READ-ONLY diagnosis (owner spec, "report first, don't fix").

Two questions:
  1. Why is deal invoice 40292 (Dani Spektor) in Morning but not in our
     registry? Is it outside the pull window (date/type), or pulled-but-
     -not-saved? And how many OTHER Morning docs are missing from us?
  2. How many jobs carry 2+ deal invoices (the 40826/40825 duplicate)?

Nothing is written to Morning or to our DB. Pure read + compare.
"""
import json
import os
import urllib.request
import urllib.parse
from collections import defaultdict

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")
env = {}
with open(ENV_PATH, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
            os.environ.setdefault(k.strip(), v.strip())

IDP_HOST = "https://api.morning.co"
RESOURCE_BASE = "https://api.greeninvoice.co.il/api/v1"
SUPABASE_URL = env["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
SERVICE_KEY = env["SUPABASE_SERVICE_ROLE_KEY"]

from datetime import date
TODAY = date.today().isoformat()

TYPE_NAMES = {
    100: "hazmana(work order)",
    300: "deal invoice (heshbon iska)",
    305: "tax invoice (heshbonit mas)",
    320: "tax/receipt",
    330: "credit (zikuy)",
    400: "receipt (kabala)",
}


def get_token():
    body = json.dumps({
        "grant_type": "client_credentials",
        "client_id": env["MORNING_CLIENT_ID"],
        "client_secret": env["MORNING_CLIENT_SECRET"],
    }).encode()
    req = urllib.request.Request(f"{IDP_HOST}/idp/v1/oauth/token", data=body,
                                 method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())["accessToken"]


def morning_search(token, from_date, page_size=100):
    """Mirror src/lib/morning/client.ts searchDocuments EXACTLY: no type/status
    filter, documentDate window fromDate..today, follow pagination."""
    out = []
    for page in range(1, 201):
        body = json.dumps({
            "fromDate": from_date, "toDate": TODAY,
            "page": page, "pageSize": page_size, "sort": "documentDate",
        }).encode()
        req = urllib.request.Request(f"{RESOURCE_BASE}/documents/search", data=body,
                                     method="POST",
                                     headers={"Content-Type": "application/json",
                                              "Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read().decode())
        items = data.get("items", [])
        out.extend(items)
        if len(items) < page_size:
            break
    return out


def rest(path, params=None):
    url = SUPABASE_URL + "/rest/v1/" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY,
        "Accept": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


def fetch_all(path, select, extra=None):
    out, offset, page = [], 0, 1000
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


def by_type(docs, type_key):
    c = defaultdict(int)
    for d in docs:
        c[d.get(type_key)] += 1
    return c


def main():
    token = get_token()

    # --- everything Morning has ever had (very wide window) ---
    all_morning = morning_search(token, "2015-01-01")
    # --- what production's INCREMENTAL pull can ever reach: first run went
    #     90 days back from the first pull (~2026-07-20 -> ~2026-04-21). Anything
    #     with documentDate before that is permanently outside every pull. ---
    reachable = morning_search(token, "2026-04-21")

    m_by_num = {}
    for d in all_morning:
        n = d.get("number")
        if n is not None:
            m_by_num[str(n)] = d

    reachable_ids = {d.get("id") for d in reachable}

    # --- our registry ---
    docs = fetch_all("documents",
                     "id,morning_doc_id,morning_doc_number,type,status,client_id,"
                     "morning_client_id,morning_client_name,amount,document_date,job_id,source")
    reg_ids = {d.get("morning_doc_id") for d in docs}
    reg_by_num = {}
    for d in docs:
        n = d.get("morning_doc_number")
        if n is not None:
            reg_by_num[str(n)] = d

    print("=" * 70)
    print("DIAGNOSIS 1 — missing document 40292 (Dani Spektor)")
    print("=" * 70)
    d92 = m_by_num.get("40292")
    if not d92:
        print("  40292 NOT found in Morning at all (by number).")
    else:
        print(f"  In Morning: type={d92.get('type')} ({TYPE_NAMES.get(d92.get('type'),'?')}) "
              f"status={d92.get('status')} date={d92.get('documentDate')} "
              f"amount={d92.get('amount')} client={ (d92.get('client') or {}).get('name') }")
        print(f"  id={d92.get('id')}")
        print(f"  -> inside production's reachable window (>=2026-04-21)? "
              f"{d92.get('id') in reachable_ids}")
        print(f"  -> present in our registry?                              "
              f"{d92.get('id') in reg_ids}")

    print("-" * 70)
    print("BY-TYPE COUNT: Morning(all)  vs  Morning(reachable>=2026-04-21)  vs  our registry")
    m_all_t = by_type(all_morning, "type")
    m_reach_t = by_type(reachable, "type")
    reg_t = by_type(docs, "type")
    all_types = sorted(set(m_all_t) | set(reg_t))
    print(f"  {'type':<28} {'M-all':>7} {'M-reach':>8} {'registry':>9} {'gap(all-reg)':>13}")
    for t in all_types:
        print(f"  {TYPE_NAMES.get(t, str(t)):<28} {m_all_t[t]:>7} {m_reach_t[t]:>8} "
              f"{reg_t[t]:>9} {m_all_t[t]-reg_t[t]:>13}")
    print(f"  {'TOTAL':<28} {len(all_morning):>7} {len(reachable):>8} {len(docs):>9} "
          f"{len(all_morning)-len(docs):>13}")

    # docs present in Morning but missing from our registry, split by whether
    # they are inside the reachable window (pulled-but-lost = silent error)
    # or outside it (never reachable = window blind spot)
    missing = [d for d in all_morning if d.get("id") not in reg_ids]
    miss_reachable = [d for d in missing if d.get("id") in reachable_ids]
    miss_outside = [d for d in missing if d.get("id") not in reachable_ids]
    print("-" * 70)
    print(f"  Morning docs MISSING from our registry: {len(missing)}")
    print(f"    inside reachable window (pulled but not saved / silent error): {len(miss_reachable)}")
    print(f"    outside window (documentDate < 2026-04-21, never reachable):   {len(miss_outside)}")
    print("    missing-by-type:", dict(by_type(missing, "type")))
    print("    sample of missing (up to 25):")
    for d in sorted(missing, key=lambda x: str(x.get("documentDate")))[:25]:
        inw = "IN-WIN" if d.get("id") in reachable_ids else "outside"
        print(f"      #{d.get('number')} t={d.get('type')} {d.get('documentDate')} "
              f"{d.get('amount')} {(d.get('client') or {}).get('name')} [{inw}]")

    print()
    print("=" * 70)
    print("DIAGNOSIS 2 — jobs carrying 2+ deal invoices (type 300)")
    print("=" * 70)
    # In our registry, group deal invoices by job_id
    deal = [d for d in docs if d.get("type") == 300]
    by_job = defaultdict(list)
    for d in deal:
        if d.get("job_id"):
            by_job[d["job_id"]].append(d)
    dup_jobs = {j: ds for j, ds in by_job.items() if len(ds) >= 2}
    print(f"  deal invoices in registry: {len(deal)}  (linked to a job: "
          f"{sum(1 for d in deal if d.get('job_id'))})")
    print(f"  jobs with 2+ linked deal invoices: {len(dup_jobs)}")
    for j, ds in dup_jobs.items():
        print(f"    job {j[:8]}: " + ", ".join(
            f"#{d.get('morning_doc_number')}(status={d.get('status')},amt={d.get('amount')})" for d in ds))

    # broader signal: same morning_client + same amount deal invoices (may not
    # be job-linked yet), which is what a duplicate looks like before linking
    print("-" * 70)
    print("  broader: deal invoices sharing (morning_client_id, amount) — potential dupes")
    grp = defaultdict(list)
    for d in deal:
        if d.get("morning_client_id") and d.get("amount") is not None:
            grp[(d["morning_client_id"], round(float(d["amount"]), 2))].append(d)
    pairs = {k: v for k, v in grp.items() if len(v) >= 2}
    print(f"  groups of 2+ same client+amount deal invoices: {len(pairs)}")
    for (mc, amt), ds in list(pairs.items())[:30]:
        nums = ", ".join(f"#{d.get('morning_doc_number')}(st={d.get('status')})" for d in ds)
        name = ds[0].get("morning_client_name") or mc[:8]
        print(f"    {name} @ {amt}: {nums}")


if __name__ == "__main__":
    main()
