# -*- coding: utf-8 -*-
"""One-time owner-directed fix (2026-07-15): flip the primary of the
already-merged show so the title clients recognize is primary.

Before:  name='יגאל שפירא ודוד ארז'  aliases=['למה זברה','זברה']
After:   name='למה זברה'             aliases=['יגאל שפירא ודוד ארז','זברה']

Both are the SAME show row (the merge already happened), so no production
or revenue moves — this is purely a rename + alias reorder. The script
verifies the production set is unchanged before and after.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")
with open(ENV_PATH, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}",
     "Content-Type": "application/json", "Prefer": "return=representation"}

OLD_NAME = "יגאל שפירא ודוד ארז"
NEW_NAME = "למה זברה"
NEW_ALIASES = ["יגאל שפירא ודוד ארז", "זברה"]


def api(method, path, params=None, body=None):
    url = f"{URL}/rest/v1/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers=H)
    with urllib.request.urlopen(req) as r:
        text = r.read().decode()
        return json.loads(text) if text else None


# locate the single merged show
hits = api("GET", "shows", params={"select": "id,name,aliases,billing_mode,client_id", "name": f"eq.{OLD_NAME}"})
if len(hits) != 1:
    print(f"expected exactly 1 show named '{OLD_NAME}', found {len(hits)} — aborting.")
    sys.exit(1)
show = hits[0]
show_id = show["id"]

# guard: 'למה זברה' must not already exist as its own show
clash = api("GET", "shows", params={"select": "id", "name": f"eq.{NEW_NAME}"})
if clash:
    print(f"a separate show named '{NEW_NAME}' already exists — aborting to avoid a split.")
    sys.exit(1)

prods_before = api("GET", "productions", params={"select": "id", "show_id": f"eq.{show_id}"})
print(f"show {show_id}  name='{show['name']}'  aliases={show['aliases']}  productions={len(prods_before)}")

api("PATCH", "shows", params={"id": f"eq.{show_id}"},
    body={"name": NEW_NAME, "aliases": NEW_ALIASES})

api("POST", "events", body={
    "entity_type": "show", "entity_id": show_id, "event_type": "show_primary_flipped",
    "payload": {"from_name": OLD_NAME, "to_name": NEW_NAME,
                "aliases_before": show["aliases"], "aliases_after": NEW_ALIASES,
                "reason": "owner: title clients recognize should be primary"},
})

after = api("GET", "shows", params={"select": "id,name,aliases", "id": f"eq.{show_id}"})[0]
prods_after = api("GET", "productions", params={"select": "id", "show_id": f"eq.{show_id}"})
print(f"AFTER  name='{after['name']}'  aliases={after['aliases']}  productions={len(prods_after)}")
ok = (after["name"] == NEW_NAME and set(after["aliases"]) == set(NEW_ALIASES)
      and len(prods_after) == len(prods_before))
print("PASS — rename done, production set unchanged" if ok else "FAIL — mismatch, inspect manually")
sys.exit(0 if ok else 1)
