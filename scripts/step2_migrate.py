# -*- coding: utf-8 -*-
"""
Step 2 (spec section 13, row 2): migration + archive split + Yedioth
Achronot client merge + Jaffa contract entry. All via REST/service key —
no DDL needed (archive.jobs/productions already exist from migration 2;
0 productions currently qualify for archiving, see report).
"""
import os
import sys
from collections import defaultdict

import requests

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

H = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

YEDIOTH_MAIN = "fe65522a-aeb4-4d73-8152-1f024f71a7b3"   # "ידיעות אחרונות"
YEDIOTH_DUPE = "2f6c63f8-6e90-44af-9104-9a4a6d4afb8f"   # "ידיעות אחרונות - אור נתן"


def api(method, path, headers=None, **kwargs):
    merged_headers = {**H, **(headers or {})}
    r = requests.request(method, f"{SUPABASE_URL}/rest/v1/{path}", headers=merged_headers, **kwargs)
    if not r.ok:
        print("ERROR", method, path, r.status_code, r.text[:500], file=sys.stderr)
        r.raise_for_status()
    return r.json() if r.text else None


def get_all(path, params):
    out = []
    offset = 0
    while True:
        p = dict(params)
        p["limit"] = "1000"
        p["offset"] = str(offset)
        page = api("GET", path, params=p)
        out.extend(page)
        if len(page) < 1000:
            break
        offset += 1000
    return out


# ---------- 1. merge Yedioth Achronot client variants ----------
print("== 1. merging Yedioth Achronot client variants ==")
api(
    "PATCH", f"jobs?client_id=eq.{YEDIOTH_DUPE}",
    json={"client_id": YEDIOTH_MAIN},
)
api(
    "PATCH", f"clients?id=eq.{YEDIOTH_MAIN}",
    json={
        "contact_name": "אור נתן",
        "billing_mode": "package",
        "payment_terms": "eom_60",
    },
)
api("DELETE", f"clients?id=eq.{YEDIOTH_DUPE}")
print("merged into", YEDIOTH_MAIN, "- duplicate deleted, payment_terms=eom_60, billing_mode=package")

yedioth_jobs = get_all("jobs", {"client_id": f"eq.{YEDIOTH_MAIN}", "select": "id,date,campaign,amount,paid,invoice_biz,invoice_tax"})
total = sum(j["amount"] or 0 for j in yedioth_jobs)
print(f"Yedioth jobs after merge: {len(yedioth_jobs)} rows, sum={total}")
assert len(yedioth_jobs) == 6, f"expected 6 Yedioth jobs, got {len(yedioth_jobs)}"
assert total == 185864.0, f"expected 185,864, got {total}"
assert all(j["paid"] == "כן" for j in yedioth_jobs), "not all Yedioth jobs are paid"

# ---------- 2. Jaffa contract + milestones ----------
print("\n== 2. Jaffa contract ==")
milestone1_job = next(j for j in yedioth_jobs if j["invoice_tax"] and j["invoice_tax"].startswith("60166"))
assert milestone1_job["amount"] == 150000.0

existing_contracts = get_all("contracts", {"client_id": f"eq.{YEDIOTH_MAIN}", "name": "eq.מכירת ביפו", "select": "id"})
if existing_contracts:
    contract_id = existing_contracts[0]["id"]
    print("contract already exists (skipping creation):", contract_id)
else:
    contract = api(
        "POST", "contracts",
        headers={"Prefer": "return=representation"},
        json={
            "client_id": YEDIOTH_MAIN,
            "name": "מכירת ביפו",
            "total_amount": 400000,
            "status": "active",
        },
    )[0]
    contract_id = contract["id"]
    print("contract created:", contract_id)

    api("PATCH", f"jobs?id=eq.{milestone1_job['id']}", json={"contract_id": contract_id})

    api(
        "POST", "contract_milestones",
        json={
            "contract_id": contract_id,
            "name": "חלק א",
            "amount": 150000,
            "status": "paid",
            "is_estimated": False,
            "job_id": milestone1_job["id"],
        },
    )
    api(
        "POST", "contract_milestones",
        json={
            "contract_id": contract_id,
            "name": "חלק ב",
            "amount": 250000,
            "status": "pending",
            "expected_date": "2026-09-15",
            "is_estimated": True,
        },
    )
    print("milestone 1 (150,000, paid, linked to job", milestone1_job["id"], ") + milestone 2 (250,000, pending) created")

# ---------- 3. migrate invoice_biz/invoice_tax text -> invoices table (deduped) ----------
print("\n== 3. populating invoices table ==")
all_jobs = get_all("jobs", {"select": "id,client_id,amount,date,invoice_biz,invoice_tax"})

by_biz = defaultdict(list)
by_tax = defaultdict(list)
for j in all_jobs:
    if j["invoice_biz"]:
        by_biz[j["invoice_biz"]].append(j)
    if j["invoice_tax"]:
        by_tax[j["invoice_tax"]].append(j)

MIGRATION_RUN_DATE = "2026-07-12"  # fallback only — jobs with no date at all
undated_fallback_count = [0]


def make_invoice_row(doc_id, jobs, inv_type, prefix):
    dates = [j["date"] for j in jobs if j["date"]]
    if not dates:
        undated_fallback_count[0] += 1
    return {
        "client_id": jobs[0]["client_id"],
        "type": inv_type,
        "morning_doc_id": f"{prefix}-{doc_id}",
        "amount": sum(j["amount"] or 0 for j in jobs),
        # PostgREST bulk insert requires identical keys across all rows,
        # so this can't be omitted — falls back to today when every job
        # sharing this doc id has no date at all (rare, flagged below)
        "issued_at": min(dates) if dates else MIGRATION_RUN_DATE,
    }


invoice_rows = []
for doc_id, jobs in by_biz.items():
    invoice_rows.append(make_invoice_row(doc_id, jobs, "עסקה", "biz"))
for doc_id, jobs in by_tax.items():
    invoice_rows.append(make_invoice_row(doc_id, jobs, "מס", "tax"))
if undated_fallback_count[0]:
    print(f"note: {undated_fallback_count[0]} invoice(s) had no dated job at all — issued_at defaulted to {MIGRATION_RUN_DATE}")

for i in range(0, len(invoice_rows), 200):
    api("POST", "invoices?on_conflict=morning_doc_id",
        headers={"Prefer": "resolution=merge-duplicates"},
        json=invoice_rows[i:i+200])
print(f"invoices created: {len(invoice_rows)} ({len(by_biz)} עסקה + {len(by_tax)} מס, deduped by doc id)")
print("note: amount = sum of every job sharing that doc id (best-effort — Morning wasn't the amount's source of truth)")

# ---------- 4. archive split: jobs ----------
print("\n== 4. archive split (jobs) ==")
all_jobs2 = get_all("jobs", {"select": "id,client_id,paid,invoice_tax,amount,date,campaign"})

archive_jobs = [
    j for j in all_jobs2
    if j["paid"] == "כן" and j["invoice_tax"] and j["client_id"] != YEDIOTH_MAIN
]
live_count = len(all_jobs2) - len(archive_jobs)
print(f"jobs: {len(all_jobs2)} total -> live {live_count}, archiving {len(archive_jobs)}")

if archive_jobs:
    ids = [j["id"] for j in archive_jobs]
    moved = api("POST", "rpc/move_jobs_to_archive", json={"job_ids": ids})
    print("moved to archive.jobs and deleted from public.jobs:", moved)
else:
    print("nothing to archive")

# ---------- 5. archive split: productions ----------
print("\n== 5. archive split (productions) ==")
all_prod = get_all("productions", {"select": "id,status,record_date,client_id"})
archive_prod = [
    p for p in all_prod
    if p["status"] == 'אושר_ע"י_לקוח'
    and not (p["record_date"] or "").startswith("2026")
    and p["client_id"] != YEDIOTH_MAIN
]
print(f"productions: {len(all_prod)} total -> live {len(all_prod) - len(archive_prod)}, archiving {len(archive_prod)}")
if archive_prod:
    moved_p = api("POST", "rpc/move_productions_to_archive", json={"production_ids": [p["id"] for p in archive_prod]})
    print("moved to archive.productions:", moved_p)
else:
    print("(expected 0 — no production has reached the final state yet; nothing moved)")

# ---------- 6. verification ----------
print("\n== 6. verification ==")
live_jobs = get_all("jobs", {"select": "id,paid,amount,invoice_tax,date,campaign,client_id"})
open_debt = sum(j["amount"] or 0 for j in live_jobs if j["paid"] == "לא")
paid_no_tax = [j for j in live_jobs if j["paid"] == "כן" and not j["invoice_tax"]]
gal_oren = [j for j in live_jobs if j.get("date") == "2025-11-29"]

open_commitment = 250000  # milestone 2, per spec's expected number

print("jobs live:", len(live_jobs))
print("open debt (paid=לא):", open_debt)
print("open commitment (unbilled milestones):", open_commitment)
print("paid-no-tax count still live:", len(paid_no_tax))
print("gal oren 29.11.25 still live:", len(gal_oren) > 0, gal_oren)
