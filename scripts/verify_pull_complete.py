# -*- coding: utf-8 -*-
"""READ-ONLY completeness check: every UNIQUE Morning document id must now
exist in our registry. Proves the historical full pull left no gap."""
import json, os, urllib.request, urllib.parse
from collections import Counter

env = {}
for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); env[k.strip()] = v.strip()

IDP = "https://api.morning.co"; RES = "https://api.greeninvoice.co.il/api/v1"
SU = env["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/"); SK = env["SUPABASE_SERVICE_ROLE_KEY"]
from datetime import date; TODAY = date.today().isoformat()

tok = json.loads(urllib.request.urlopen(urllib.request.Request(
    f"{IDP}/idp/v1/oauth/token",
    data=json.dumps({"grant_type": "client_credentials", "client_id": env["MORNING_CLIENT_ID"],
                     "client_secret": env["MORNING_CLIENT_SECRET"]}).encode(),
    headers={"Content-Type": "application/json"}), timeout=30).read())["accessToken"]

morning = []
for page in range(1, 201):
    req = urllib.request.Request(f"{RES}/documents/search",
        data=json.dumps({"fromDate": "2015-01-01", "toDate": TODAY, "page": page,
                         "pageSize": 100, "sort": "documentDate"}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {tok}"})
    items = json.loads(urllib.request.urlopen(req, timeout=60).read()).get("items", [])
    morning.extend(items)
    if len(items) < 100: break

uniq = {d["id"]: d for d in morning}
print(f"Morning line-items: {len(morning)}   unique ids: {len(uniq)}   (dupes across page boundaries: {len(morning)-len(uniq)})")


def fetch_all(sel):
    out, off = [], 0
    while True:
        req = urllib.request.Request(f"{SU}/rest/v1/documents?select={sel}&limit=1000&offset={off}",
            headers={"apikey": SK, "Authorization": "Bearer " + SK})
        rows = json.loads(urllib.request.urlopen(req).read())
        out.extend(rows)
        if len(rows) < 1000: break
        off += 1000
    return out

reg = fetch_all("morning_doc_id,type,client_id")
reg_ids = {r["morning_doc_id"] for r in reg}
missing = [d for d in uniq.values() if d["id"] not in reg_ids]
print(f"registry docs: {len(reg)}")
print(f"Morning-unique docs NOT in registry: {len(missing)}")
for d in missing[:20]:
    print(f"   MISSING #{d.get('number')} t={d.get('type')} {d.get('documentDate')} {(d.get('client') or {}).get('name')}")
print("registry unmatched (client_id null):", sum(1 for r in reg if not r.get("client_id")),
      "of", len(reg), "-> need client mapping")
