#!/usr/bin/env python3
"""Snapshot of one Morning client's fields, for a before/after comparison.

TOUCHES MORNING: read only. Proves PUT /clients is a partial update —
verified 2026-09-07, 29 fields unchanged.

GET only — the same verb getClientEmails uses, which the code notes "runs for
real even in DRY_RUN (a read writes nothing)". Nothing here mutates anything.

Purpose: the app's rename sends PUT /clients/{id} with a body of {name} alone
(entity/[type]/[id]/route.ts:492). Whether Morning treats that as a partial
update or a full replace was not stated anywhere, so this captures the fields
that would be at risk — taxId, address, phone, emails — to diff across the
change.

The answer it produced is now recorded in lib/morning/client.ts:217-231: run on
client dce40719 (וואיקי דיגיטל -> וואי 360 בע"מ) with a body of {name} alone,
`name` changed and all 29 other fields came back byte-identical. Two caveats
that belong with the result: it was ONE field on ONE client, and it is Morning's
behaviour rather than a contract they publish. Re-run this before trusting a
partial PUT that touches several fields at once.

Set CLIENT below to the id you are about to change, run once before and once
after, and diff the two outputs.

Run:  python3 scripts/morning_client_snapshot.py
"""
import json
import urllib.request

IDP = "https://api.morning.co/idp/v1/oauth/token"
BASE = "https://api.greeninvoice.co.il/api/v1"
CLIENT = "dce40719-639a-4103-ab68-efbd70489b3d"  # וואיקי דיגיטל

env = {}
with open('/Users/admin/bizi-app/.env.local', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip().strip('"').strip("'")

tok_req = urllib.request.Request(
    IDP,
    data=json.dumps({
        "grant_type": "client_credentials",
        "client_id": env["MORNING_CLIENT_ID"],
        "client_secret": env["MORNING_CLIENT_SECRET"],
    }).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(tok_req) as r:
    token = json.loads(r.read())["accessToken"]

req = urllib.request.Request(
    f"{BASE}/clients/{CLIENT}",
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    method="GET",
)
with urllib.request.urlopen(req) as r:
    c = json.loads(r.read())

print("=== BEFORE snapshot — fields a full-replace PUT would blank ===")
for k in ("id", "name", "taxId", "phone", "mobile", "emails", "address",
          "city", "zip", "country", "active", "accountingKey", "category",
          "remarks", "labels"):
    if k in c:
        print(f"  {k:14} = {json.dumps(c[k], ensure_ascii=False)}")

print("\n=== every key Morning returns ===")
print("  " + ", ".join(sorted(c.keys())))
