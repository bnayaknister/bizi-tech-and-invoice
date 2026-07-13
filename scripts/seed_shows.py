# -*- coding: utf-8 -*-
"""
Seed the shows table from productions.podcast_name (one-time, after
migration 0008).

Owner decisions (2026-07-13):
- No merge algorithm. The only merge is the explicit one below.
- Merge: אסתטיטוקס absorbs אסטתיטוקס + דוקטור סבלטנה,
  aliases = [אסטתיטוקס, דוקטור סבלטנה, סבטלנה אסתיטוקס].
- Names with exactly ONE production -> active=false, is_oneoff=true
  (a show with a single episode is an event, not a show).
- Everything else -> active=true.
- BEPO names: leave as-is (oneoff). No BEPO show, no link to the Jaffa
  contract. The contract stays as recorded; productions stay as they are.

Refuses to run if shows already has rows (import never deletes).
"""
import os
import sys
from collections import defaultdict

import requests

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

H = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

MERGE_PRIMARY = "אסתטיטוקס"
MERGE_ABSORBED = ["אסטתיטוקס", "דוקטור סבלטנה"]
MERGE_ALIASES = ["אסטתיטוקס", "דוקטור סבלטנה", "סבטלנה אסתיטוקס"]


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


existing = api("GET", "shows", params={"select": "id", "limit": "1"})
if existing:
    print("shows table is not empty — refusing to seed (import never deletes).")
    sys.exit(1)

productions = get_all("productions", {"select": "id,podcast_name"})
print(f"productions: {len(productions)}")

by_name = defaultdict(list)
for p in productions:
    by_name[p["podcast_name"]].append(p["id"])

# fold the absorbed names into the primary before creating shows
for absorbed in MERGE_ABSORBED:
    if absorbed in by_name:
        by_name[MERGE_PRIMARY].extend(by_name.pop(absorbed))

rows = []
for name in sorted(by_name):
    count = len(by_name[name])
    oneoff = count == 1
    rows.append({
        "name": name,
        "aliases": MERGE_ALIASES if name == MERGE_PRIMARY else [],
        "active": not oneoff,
        "is_oneoff": oneoff,
    })

created = api(
    "POST", "shows",
    headers={"Prefer": "return=representation"},
    json=rows,
)
id_by_name = {s["name"]: s["id"] for s in created}
print(f"shows created: {len(created)}")

# link every production to its show by id (avoids URL-encoding Hebrew names)
linked = 0
for name, prod_ids in by_name.items():
    show_id = id_by_name[name]
    for i in range(0, len(prod_ids), 100):
        chunk = prod_ids[i:i + 100]
        api(
            "PATCH", f"productions?id=in.({','.join(chunk)})",
            json={"show_id": show_id},
        )
        linked += len(chunk)
print(f"productions linked: {linked}")

api("POST", "events", json={
    "entity_type": "show",
    "entity_id": id_by_name[MERGE_PRIMARY],
    "event_type": "shows_seeded",
    "payload": {
        "shows_created": len(created),
        "active": sum(1 for r in rows if r["active"]),
        "oneoff": sum(1 for r in rows if r["is_oneoff"]),
        "productions_linked": linked,
        "merge": {
            "primary": MERGE_PRIMARY,
            "absorbed": MERGE_ABSORBED,
            "aliases": MERGE_ALIASES,
        },
    },
})

# ---- verification ----
unlinked = api("GET", "productions", params={"select": "id", "show_id": "is.null", "limit": "1000"})
merged = get_all("productions", {"select": "id", "show_id": f"eq.{id_by_name[MERGE_PRIMARY]}"})
print("")
print(f"VERIFY shows total:   {len(created)} (expected 105)")
print(f"VERIFY active:        {sum(1 for r in rows if r['active'])} (expected 62)")
print(f"VERIFY oneoff:        {sum(1 for r in rows if r['is_oneoff'])} (expected 43)")
print(f"VERIFY unlinked prods: {len(unlinked)} (expected 0)")
print(f"VERIFY {MERGE_PRIMARY} productions: {len(merged)} (expected 14 = 9+3+2)")
if len(created) != 105 or unlinked or len(merged) != 14:
    print("MISMATCH — stop and fix before continuing.")
    sys.exit(1)
print("all checks passed")
