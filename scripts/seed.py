# -*- coding: utf-8 -*-
"""
Seeds clients/productions/stages/jobs from the clean ~/bizi CSVs
into Supabase via the REST API (PostgREST), using the service_role key
(bypasses RLS for the seed only — this script is never deployed).

Run only after supabase/migrations/0001_init.sql has been applied.
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
    return "לא ידוע", (notes or None)


def main():
    jobs_rows = read_csv(f"{BIZI}/1_חיובים.csv")
    episodes_rows = read_csv(f"{BIZI}/2_הפקות.csv")

    # ---- clients: union of jobs.לקוח, dedup by normalized name ----
    client_names = {}
    for r in jobs_rows:
        n = (r.get("לקוח") or "").strip()
        if n:
            client_names.setdefault(norm(n), n)

    client_id_by_norm = {}
    CHUNK = 200
    names = list(client_names.items())
    for i in range(0, len(names), CHUNK):
        batch = [{"name": n, "normalized_name": k} for k, n in names[i : i + CHUNK]]
        inserted = api(
            "POST", "clients?on_conflict=normalized_name", json=batch,
            params={"select": "id,normalized_name"},
        )
        for row in inserted:
            client_id_by_norm[row["normalized_name"]] = row["id"]

    print("clients inserted:", len(client_id_by_norm))

    # ---- jobs ----
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
    for i in range(0, len(job_payload), CHUNK):
        api("POST", "jobs", json=job_payload[i : i + CHUNK])
    print("jobs inserted:", len(job_payload))

    # ---- productions (triggers auto-create 6 stages each) ----
    prod_payload = []
    for r in episodes_rows:
        podcast = (r.get("שם הפודקאסט") or "").strip()
        if not podcast:
            continue
        cid = client_id_by_norm.get(norm(podcast))  # best-effort match, often None
        prod_payload.append(
            {
                "podcast_name": podcast,
                "client_id": cid,
                "guest": r.get("שם אורחים") or None,
                "record_date": to_date(r.get("תאריך הקלטה")),
                "studio": r.get("אולפן") or None,
                "notes": r.get("הערות לפרק") or None,
            }
        )
    for i in range(0, len(prod_payload), 50):  # smaller batches: each row fans out a trigger
        api("POST", "productions", json=prod_payload[i : i + 50])
    print("productions inserted:", len(prod_payload))


if __name__ == "__main__":
    main()
