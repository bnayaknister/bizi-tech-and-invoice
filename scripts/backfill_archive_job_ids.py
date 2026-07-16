# -*- coding: utf-8 -*-
"""Backfill external_id on archive.jobs (owner-directed fix, 2026-07-16).

Root cause: step2_migrate.py archived 106 jobs before migration 0014 added
external_id, so those rows have external_id=NULL. import_archive_ids (0014)
was already correct — it just had nothing to match. This writes the CSV ID
onto each archived row via the 0015 RPC bridge (archive isn't on REST).

Matches by the same fingerprint as backfill_external_ids.py: normalized
client name + campaign + date + amount. Idempotent; preview by default.
"""
import csv, json, os, sys, urllib.error, urllib.parse, urllib.request
from collections import defaultdict

ENV = os.path.join(os.path.dirname(__file__), "..", ".env.local")
for line in open(ENV, encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())
U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; K = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": K, "Authorization": f"Bearer {K}", "Content-Type": "application/json"}
BIZI = os.path.expanduser("~/bizi")
APPLY = "--apply" in sys.argv

def api(m, p, params=None, body=None):
    url = f"{U}/rest/v1/{p}" + ("?" + urllib.parse.urlencode(params) if params else "")
    r = urllib.request.Request(url, method=m, data=json.dumps(body).encode() if body is not None else None, headers=H)
    with urllib.request.urlopen(r) as x:
        t = x.read().decode(); return json.loads(t) if t else None

def rpc(name, body):
    r = urllib.request.Request(f"{U}/rest/v1/rpc/{name}", method="POST",
                                data=json.dumps(body).encode(), headers=H)
    with urllib.request.urlopen(r) as x:
        t = x.read().decode(); return json.loads(t) if t else None

def norm(s): return (s or "").replace(" ", "").strip().lower()
def pdate(s):
    s = (s or "").strip()
    if not s or s in ("---", "-", "—"): return None
    for sep in (".", "/"):
        if sep in s:
            p = s.split(sep)
            if len(p) == 3:
                d, mth, y = p
                y = ("20" + y) if len(y) == 2 else y
                try: return f"{int(y):04d}-{int(mth):02d}-{int(d):02d}"
                except ValueError: return None
    return None
def pint(s):
    s = (s or "").strip()
    if not s: return None
    try: return int(float(s))
    except ValueError: return None
def amt(v):
    p = pint(str(v)) if v not in (None, "") else None
    return "" if p is None else str(p)

archive_rows = rpc("archive_jobs_for_backfill", {})
print(f"archive.jobs rows: {len(archive_rows)}")

live_ext_ids = {j["external_id"] for j in api("GET", "jobs", {"select": "external_id", "limit": 1000}) if j["external_id"]}

csv_rows = list(csv.DictReader(open(os.path.join(BIZI, "1_חיובים.csv"), encoding="utf-8-sig")))
# only the CSV rows that never made it into public.jobs are candidates for archive
candidates = [r for r in csv_rows if r["ID"] not in live_ext_ids]
print(f"CSV rows not already keyed in public.jobs: {len(candidates)}")

# group both sides by fingerprint (same shape as backfill_external_ids.py)
db_groups = defaultdict(list)
for r in archive_rows:
    fp = (norm(r["client_name"]), norm(r["campaign"]), r["job_date"], amt(r["amount"]))
    db_groups[fp].append(r)
csv_groups = defaultdict(list)
for r in candidates:
    fp = (norm(r["לקוח"]), norm(r["קמפיין"]), pdate(r["תאריך"]), amt(r["מחיר"]))
    csv_groups[fp].append(r)

assignments = []
matched = unmatched_csv = 0
for fp, crows in csv_groups.items():
    drows = [d for d in db_groups.get(fp, []) if not d["external_id"]]
    for c, d in zip(crows, drows):
        assignments.append((d["id"], c["ID"]))
        matched += 1
    unmatched_csv += max(0, len(crows) - len(drows))

print(f"matched (archive row <- external_id): {matched}")
print(f"CSV candidate rows still unmatched: {unmatched_csv}")
print(f"archive rows left without external_id: {len(archive_rows) - matched}")

if not APPLY:
    print("PREVIEW — run with --apply to write")
    sys.exit(0)

for archive_id, ext in assignments:
    rpc("backfill_archive_job_external_id", {"p_id": archive_id, "p_external_id": ext})

after = rpc("archive_jobs_for_backfill", {})
cov = sum(1 for r in after if r["external_id"])
print(f"APPLIED. archive.jobs external_id coverage: {cov}/{len(after)}")
