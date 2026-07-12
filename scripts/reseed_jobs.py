# -*- coding: utf-8 -*-
"""
Re-seeds ONLY the jobs table with the corrected paid enum mapping.
Does not touch clients / productions / stages.
"""
import csv
import os
import re
import sys
from datetime import datetime

import requests

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BIZI = os.path.expanduser("~/bizi")

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}


def api(method, path, **kwargs):
    r = requests.request(method, f"{SUPABASE_URL}/rest/v1/{path}", headers=HEADERS, **kwargs)
    if not r.ok:
        print("ERROR", method, path, r.status_code, r.text[:500], file=sys.stderr)
        r.raise_for_status()
    return r.json() if r.text else None


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def norm(name):
    return re.sub(r"\s+", "", (name or "").strip().lower())


def to_date(s):
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%d.%m.%y", "%d.%m.%Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def to_amount(s):
    s = (s or "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def map_paid_and_notes(raw_status, existing_notes):
    """Maps the free-text שולם value to the 4-value enum, folding any
    extra text (e.g. 'תקלה' from 'ללא חיוב - תקלה') into notes so it
    isn't lost."""
    s = (raw_status or "").strip()
    notes = (existing_notes or "").strip()
    if s == "כן":
        return "כן", (notes or None)
    if s == "לא":
        return "לא", (notes or None)
    if s.startswith("ללא חיוב"):
        extra = s[len("ללא חיוב"):].strip(" -").strip()
        if extra:
            notes = f"{notes} | סטטוס תשלום: {extra}" if notes else f"סטטוס תשלום: {extra}"
        return "ללא חיוב", (notes or None)
    # blank or anything unrecognized
    return "לא ידוע", (notes or None)


def main():
    # fetch existing clients built from the earlier seed (do not re-insert)
    clients = []
    offset = 0
    while True:
        page = api(
            "GET", "clients", params={"select": "id,normalized_name", "limit": "1000", "offset": str(offset)}
        )
        clients.extend(page)
        if len(page) < 1000:
            break
        offset += 1000
    client_id_by_norm = {c["normalized_name"]: c["id"] for c in clients}
    print("existing clients loaded:", len(client_id_by_norm))

    jobs_rows = read_csv(f"{BIZI}/1_חיובים.csv")

    job_payload = []
    for r in jobs_rows:
        cname = (r.get("לקוח") or "").strip()
        paid, notes = map_paid_and_notes(r.get("שולם"), r.get("הערות"))
        job_payload.append(
            {
                "client_id": client_id_by_norm.get(norm(cname)) if cname else None,
                "date": to_date(r.get("תאריך")),
                "campaign": r.get("קמפיין") or None,
                "amount": to_amount(r.get("מחיר")),
                "invoice_biz": r.get("חשבונית עסקה") or None,
                "invoice_tax": r.get("חשבונית מס") or None,
                "paid": paid,
                "notes": notes,
            }
        )

    # wipe existing jobs only
    api("DELETE", "jobs", params={"id": "not.is.null"})
    print("existing jobs deleted")

    CHUNK = 200
    for i in range(0, len(job_payload), CHUNK):
        api("POST", "jobs", json=job_payload[i : i + CHUNK])
    print("jobs inserted:", len(job_payload))

    # ---- verification ----
    breakdown = {}
    for j in job_payload:
        breakdown[j["paid"]] = breakdown.get(j["paid"], 0) + 1
    print("paid breakdown:", breakdown)

    open_debt = sum(j["amount"] or 0 for j in job_payload if j["paid"] == "לא")
    print("open debt (paid=לא only):", open_debt)

    unknown_rows = [j for j in job_payload if j["paid"] == "לא ידוע"]
    print("unknown-status rows:", [(j["client_id"], j["amount"]) for j in unknown_rows])


if __name__ == "__main__":
    main()
