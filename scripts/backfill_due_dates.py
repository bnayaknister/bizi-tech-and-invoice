# -*- coding: utf-8 -*-
"""Backfill jobs.due_date (radar VU needs it, screens-spec §4).

Only 1/51 historical jobs had due_date — they were imported before
trg_compute_due_date existed. Re-firing the trigger is enough: PATCHing a
job's `date` to its own value counts as "update of date" and recomputes
due_date via the existing function (client payment_terms + work date). No
value actually changes; money-guarded columns are untouched.

Idempotent. Preview by default; --apply to write.
"""
import json, os, sys, urllib.error, urllib.parse, urllib.request

ENV = os.path.join(os.path.dirname(__file__), "..", ".env.local")
for line in open(ENV, encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())
U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; K = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": K, "Authorization": f"Bearer {K}", "Content-Type": "application/json"}

def api(m, p, params=None, body=None):
    url = f"{U}/rest/v1/{p}" + ("?" + urllib.parse.urlencode(params) if params else "")
    r = urllib.request.Request(url, method=m, data=json.dumps(body).encode() if body is not None else None, headers=H)
    with urllib.request.urlopen(r) as x:
        t = x.read().decode(); return json.loads(t) if t else None

apply = "--apply" in sys.argv
jobs = api("GET", "jobs", {"select": "id,date,due_date"})
missing = [j for j in jobs if not j["due_date"]]
print(f"jobs: {len(jobs)}, missing due_date: {len(missing)}")
if not apply:
    print("PREVIEW — run with --apply to backfill"); sys.exit(0)

fixed = 0
for j in jobs:
    # touch `date` (its own value) to re-fire trg_compute_due_date
    api("PATCH", "jobs", {"id": f"eq.{j['id']}"}, {"date": j["date"]})
    fixed += 1
after = api("GET", "jobs", {"select": "id,due_date"})
cov = sum(1 for j in after if j["due_date"])
print(f"re-fired trigger on {fixed} jobs; due_date coverage now {cov}/{len(after)}")
