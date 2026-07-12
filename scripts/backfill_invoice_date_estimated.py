# -*- coding: utf-8 -*-
"""
Marks date_is_estimated=true on the invoices whose issued_at fell back to
today because none of the jobs sharing that doc id had a real date.
Source of truth: the original CSV (archiving already moved half the jobs
out of public.jobs, so it's no longer safe to recompute from the DB).
"""
import csv
import os
from collections import defaultdict
from datetime import datetime

import requests

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BIZI = os.path.expanduser("~/bizi")


def to_date(s):
    # must match seed.py's to_date() exactly — that's what actually
    # landed in jobs.date, not the raw CSV text
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%d.%m.%y", "%d.%m.%Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    return None

H = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}


def api(method, path, headers=None, **kwargs):
    merged_headers = {**H, **(headers or {})}
    r = requests.request(method, f"{SUPABASE_URL}/rest/v1/{path}", headers=merged_headers, **kwargs)
    r.raise_for_status()
    return r.json() if r.text else None


with open(f"{BIZI}/1_חיובים.csv", encoding="utf-8-sig", newline="") as f:
    rows = list(csv.DictReader(f))

by_biz = defaultdict(list)
by_tax = defaultdict(list)
for r in rows:
    parsed_date = to_date(r.get("תאריך"))
    if r.get("חשבונית עסקה"):
        by_biz[r["חשבונית עסקה"]].append(parsed_date)
    if r.get("חשבונית מס"):
        by_tax[r["חשבונית מס"]].append(parsed_date)

undated_doc_ids = []
for doc_id, dates in by_biz.items():
    if not any(dates):
        undated_doc_ids.append(f"biz-{doc_id}")
for doc_id, dates in by_tax.items():
    if not any(dates):
        undated_doc_ids.append(f"tax-{doc_id}")

print("undated doc ids found in source CSV:", undated_doc_ids)
assert len(undated_doc_ids) == 7, f"expected 7, found {len(undated_doc_ids)}"

in_list = ",".join(f'"{d}"' for d in undated_doc_ids)
updated = api(
    "PATCH", f"invoices?morning_doc_id=in.({in_list})",
    headers={"Prefer": "return=representation"},
    json={"date_is_estimated": True},
)
print("updated rows:", len(updated))
for row in updated:
    print(" ", row["morning_doc_id"], row["type"], row["amount"])
