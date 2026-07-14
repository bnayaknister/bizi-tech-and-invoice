# -*- coding: utf-8 -*-
"""
One-time (owner decision 2026-07-14): the job "אפרת לקט בנק הפועלים *2"
(15.4.2026, 4,000 ₪) covered TWO recordings, but only one production was
ever entered. The second recording really happened — this is exactly the
hole the system exists to catch (work done but never recorded).

Creates the missing production (mirrors the existing 15.4 one: same show,
same client, kind='client'), marks it as born from billing reconciliation,
and links it to the job — which is already linked to the existing one.

Idempotent: refuses to create a second reconciliation production.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")
if os.path.exists(ENV_PATH):
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

JOB_ID = "07ea2ec5-4d56-48f8-9aa3-82b81d9503c6"        # אפרת לקט בנק הפועלים *2
EXISTING_PROD_ID = "1aeec0a9-cb4c-4d30-b5de-09d82c6844b0"  # ההקלטה שכן הוזנה, 15.4
RECON_MARK = "billing_reconciliation"
NOTES = (
    "נוצר מהתאמת חיובים (created_from=billing_reconciliation): "
    'החיוב "אפרת לקט בנק הפועלים *2" מ-15.4.2026 כיסה שתי הקלטות '
    "ורק אחת הוזנה במערכת."
)


def api(method, path, params=None, body=None, headers=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "apikey": SERVICE_KEY,
            "Authorization": f"Bearer {SERVICE_KEY}",
            "Content-Type": "application/json",
            **(headers or {}),
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            text = r.read().decode()
            return json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        print("ERROR", method, path, e.code, e.read().decode()[:400], file=sys.stderr)
        raise


def main():
    dupes = api("GET", "productions", params={
        "select": "id", "record_date": "eq.2026-04-15", "notes": f"like.*{RECON_MARK}*",
    })
    if dupes:
        sys.exit(f"הפקת ההשלמה כבר קיימת ({dupes[0]['id']}) — לא נוצר כפול.")

    job = api("GET", "jobs", params={"select": "id,client_id", "id": f"eq.{JOB_ID}"})[0]
    src = api("GET", "productions", params={
        "select": "podcast_name,show_id,studio", "id": f"eq.{EXISTING_PROD_ID}",
    })[0]

    created = api("POST", "productions", body={
        "podcast_name": src["podcast_name"],
        "show_id": src["show_id"],
        "client_id": job["client_id"],
        "kind": "client",
        "record_date": "2026-04-15",
        "studio": src["studio"],
        "notes": NOTES,
    }, headers={"Prefer": "return=representation"})[0]
    prod_id = created["id"]

    api("POST", "events", body={
        "entity_type": "production", "entity_id": prod_id,
        "event_type": "created_from_billing_reconciliation",
        "payload": {"job_id": JOB_ID, "mirrors_production_id": EXISTING_PROD_ID,
                    "reason": "חיוב *2 מול הפקה אחת — ההקלטה השנייה לא הוזנה",
                    "approved_by": "owner", "source": "step_b_batch_2026-07-14"},
    })

    api("POST", "job_productions", body={"job_id": JOB_ID, "production_id": prod_id})
    api("POST", "events", body={
        "entity_type": "job", "entity_id": JOB_ID,
        "event_type": "production_linked",
        "payload": {"production_id": prod_id, "confidence": "high",
                    "note": "הפקה שנייה שנוצרה מהתאמת חיובים (*2)",
                    "source": "step_b_batch_2026-07-14", "approved_by": "owner"},
    })

    links = api("GET", "job_productions", params={"select": "production_id", "job_id": f"eq.{JOB_ID}"})
    print(f"נוצרה הפקה {prod_id}")
    print(f"החיוב מקושר כעת ל-{len(links)} הפקות: {[l['production_id'][:8] for l in links]}")


if __name__ == "__main__":
    main()
