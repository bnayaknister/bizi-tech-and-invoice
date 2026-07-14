# -*- coding: utf-8 -*-
"""
One-time (owner decision 2026-07-14): the reconciliation production
15ce5e0d (אפרת לקט 15.4, created because the *2 job covered a recording
that was never entered) was actually recorded, delivered and billed back
in April. Close it out so it doesn't sit in the kanban as open work:
all 6 stages done (done_at = 15.4.2026), status אושר_ע"י_לקוח.

Trigger choreography this has to respect:
- enforce_stage_order: stages must be marked done in step order per track.
- set_done_at stamps done_at=now() on the transition — a second pass
  (status unchanged) writes the real April date.
- on_production_approved fires on the approval transition and auto-creates
  a job + link. Here the job ALREADY exists (אפרת לקט בנק הפועלים *2),
  so the auto-created duplicate is deleted immediately and the deletion
  is logged to events.
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

PROD_ID = "15ce5e0d-c21c-4894-a109-985dc5e293e8"
EXISTING_JOB_ID = "07ea2ec5-4d56-48f8-9aa3-82b81d9503c6"  # אפרת לקט בנק הפועלים *2
DONE_AT = "2026-04-15T00:00:00+00:00"


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
    prod = api("GET", "productions", params={"select": "status", "id": f"eq.{PROD_ID}"})[0]
    if prod["status"] == 'אושר_ע"י_לקוח':
        sys.exit("ההפקה כבר סגורה — אין מה לעשות.")

    jobs_before = {j["id"] for j in api("GET", "jobs", params={"select": "id"})}

    # 1. stages → done, in step order (enforce_stage_order)
    for track in ("episode", "reels"):
        for step in ("record", "edit", "deliver"):
            api("PATCH", "stages", params={
                "production_id": f"eq.{PROD_ID}", "track": f"eq.{track}", "step": f"eq.{step}",
            }, body={"status": "done"})
    # 2. second pass: the real done date (set_done_at only fires on the transition)
    api("PATCH", "stages", params={"production_id": f"eq.{PROD_ID}"}, body={"done_at": DONE_AT})

    # 3. approval transition (fires on_production_approved → auto job)
    api("PATCH", "productions", params={"id": f"eq.{PROD_ID}"}, body={"status": 'אושר_ע"י_לקוח'})

    # 4. remove the auto-created duplicate job — billing for this production
    #    already exists (the *2 job)
    jobs_after = api("GET", "jobs", params={"select": "id,campaign,notes"})
    auto = [j for j in jobs_after if j["id"] not in jobs_before]
    if len(auto) != 1:
        sys.exit(f"ציפיתי לחיוב אוטומטי אחד חדש, נמצאו {len(auto)} — בדוק ידנית, לא מוחק כלום.")
    auto_job = auto[0]
    api("DELETE", "jobs", params={"id": f"eq.{auto_job['id']}"})
    api("POST", "events", body={
        "entity_type": "job", "entity_id": auto_job["id"],
        "event_type": "auto_job_removed_duplicate",
        "payload": {"production_id": PROD_ID, "kept_job_id": EXISTING_JOB_ID,
                    "reason": "החיוב האמיתי (אפרת לקט בנק הפועלים *2) כבר קיים ומקושר; "
                              "החיוב שנוצר אוטומטית מאישור הלקוח היה כפילות",
                    "removed_job_snapshot": auto_job,
                    "approved_by": "owner", "source": "step_b_batch_2026-07-14"},
    })

    # verify
    stages = api("GET", "stages", params={"select": "track,step,status,done_at",
                                          "production_id": f"eq.{PROD_ID}"})
    prod = api("GET", "productions", params={"select": "status", "id": f"eq.{PROD_ID}"})[0]
    links = api("GET", "job_productions", params={"select": "job_id",
                                                  "production_id": f"eq.{PROD_ID}"})
    print("סטטוס הפקה:", prod["status"])
    print("שלבים done:", sum(1 for s in stages if s["status"] == "done"), "/", len(stages),
          "| done_at:", {s["done_at"][:10] for s in stages})
    print("חיובים מקושרים להפקה:", [l["job_id"][:8] for l in links])
    print("חיוב אוטומטי כפול נמחק:", auto_job["id"][:8])


if __name__ == "__main__":
    main()
