# -*- coding: utf-8 -*-
"""READ-ONLY. Count how many of the unassigned (client_id null) registry docs
qualify for auto-archive: Morning client not in the app (unmapped) + older than
90 days + not linked to a job. Nothing is written."""
import os, json, urllib.request, urllib.parse
from collections import Counter
from datetime import date, datetime

env = {}
for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
SU = env["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/"); SK = env["SUPABASE_SERVICE_ROLE_KEY"]
TYPE_NAME = {10: "quote", 100: "order", 300: "deal-inv", 305: "tax-inv", 320: "tax/receipt", 330: "credit", 400: "receipt"}
BILLING = {300, 305, 320, 400}
CUTOFF = 90


def rest(path):
    req = urllib.request.Request(f"{SU}/rest/v1/{path}", headers={"apikey": SK, "Authorization": "Bearer " + SK})
    return json.loads(urllib.request.urlopen(req).read())


def fetch_all(table, select):
    out, off = [], 0
    while True:
        rows = rest(f"{table}?select={urllib.parse.quote(select)}&limit=1000&offset={off}")
        out.extend(rows)
        if len(rows) < 1000: break
        off += 1000
    return out


def pdays(s):
    try: return (date.today() - datetime.fromisoformat(str(s)[:10]).date()).days
    except Exception: return None


clients = fetch_all("clients", "morning_client_id")
mapped = {c["morning_client_id"] for c in clients if c.get("morning_client_id")}
docs = fetch_all("documents", "type,client_id,morning_client_id,morning_client_name,amount,document_date,job_id,cancelled_at")

unassigned = [d for d in docs if not d.get("client_id") and not d.get("cancelled_at")]
print(f"unassigned (client_id null, not cancelled): {len(unassigned)}")

qual, not_qual = [], []
reasons = Counter()
for d in unassigned:
    mid = d.get("morning_client_id")
    in_app = bool(mid) and mid in mapped
    age = pdays(d.get("document_date"))
    old = age is not None and age > CUTOFF
    linked = bool(d.get("job_id"))
    if (not in_app) and old and (not linked):
        qual.append(d)
    else:
        not_qual.append(d)
        if in_app: reasons["Morning client IS mapped in app"] += 1
        elif age is None: reasons["no document_date (age unknown)"] += 1
        elif not old: reasons[f"newer than {CUTOFF}d"] += 1
        elif linked: reasons["linked to a job"] += 1

print(f"\n>>> QUALIFY for auto-archive: {len(qual)}")
print(f"    do NOT qualify:          {len(not_qual)}")
print("\n  qualifying by type:", {TYPE_NAME.get(t, t): n for t, n in sorted(Counter(d['type'] for d in qual).items())})
bq = sum(1 for d in qual if d['type'] in BILLING)
print(f"    of which real billing (300/305/320/400): {bq}   noise (quotes/orders/credits): {len(qual)-bq}")
print("\n  NOT-qualifying reasons:", dict(reasons))
print("\n  qualifying — unique Morning clients:", len({d.get('morning_client_name') for d in qual}))
print("  sample (up to 15):")
for d in sorted(qual, key=lambda x: str(x.get("document_date")))[:15]:
    print(f"    t={d['type']} {d.get('document_date')} {d.get('amount')} {d.get('morning_client_name')}")
