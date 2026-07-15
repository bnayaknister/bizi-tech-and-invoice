# -*- coding: utf-8 -*-
"""Assign the two big orphan shows (owner decision 2026-07-15).

דעה לא פופולרית (active, continuing):
    client = ברק הרשקוביץ (reuse if the client already exists),
    billing_mode = per_episode, active = true
מנהלי שיווק מצייצים (finished, client moved studios):
    client = אבי זיתן (create),
    billing_mode = per_episode, active = FALSE

Follows the classify_contract_shows pattern: the show gets its money
classification AND every production of that show is cascaded to
kind='client' + client_id inherited — this is what makes them count as
billable so the 🔵 "produced but never billed" alert can see them.

Key rule the owner reinforced: active=false does NOT silence the alert.
Only kind='internal' or billing_mode='none' silences it. מנהלי שיווק is
closed but its productions become kind='client' — they still must shout.

Idempotent. Preview by default; run with --apply to write.
"""
import json
import os
import sys
import urllib.error
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
SOURCE = "assign_two_big_orphans_2026-07-15"

# show name -> (client name, active-after-assignment)
ASSIGN = {
    "דעה לא פופולרית": ("ברק הרשקוביץ", True),
    "מנהלי שיווק מצייצים": ("אבי זיתן", False),
}


def api(method, path, params=None, body=None, headers=None):
    url = f"{URL}/rest/v1/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}",
                 "Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req) as r:
            text = r.read().decode()
            return json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        print("ERROR", method, path, e.code, e.read().decode()[:400], file=sys.stderr)
        raise


def get_all(path, params):
    out, offset = [], 0
    while True:
        rows = api("GET", path, params=dict(params, offset=offset, limit=1000))
        out += rows
        if len(rows) < 1000:
            return out
        offset += 1000


def get_or_create_client(name, apply):
    hit = api("GET", "clients", params={"select": "id,name", "name": f"eq.{name}"})
    if hit:
        print(f"    client '{name}' exists -> reuse ({hit[0]['id']})")
        return hit[0]["id"]
    print(f"    client '{name}' does not exist -> {'create' if apply else 'would create'}")
    if not apply:
        return None
    row = api("POST", "clients",
              body={"name": name, "normalized_name": name.replace(" ", ""),
                    "billing_mode": "per_episode", "payment_terms": "immediate"},
              headers={"Prefer": "return=representation"})[0]
    api("POST", "events", body={
        "entity_type": "client", "entity_id": row["id"], "event_type": "client_created",
        "payload": {"name": name, "source": SOURCE, "approved_by": "owner"}})
    return row["id"]


def main():
    apply = "--apply" in sys.argv
    print(f"=== {'APPLY' if apply else 'PREVIEW (run with --apply to write)'} ===")

    shows = {s["name"]: s for s in get_all("shows", {"select": "id,name,active,client_id,billing_mode"})}
    prods = get_all("productions", {"select": "id,show_id,kind"})
    by_show = {}
    for p in prods:
        by_show.setdefault(p["show_id"], []).append(p)

    for show_name, (client_name, active_after) in ASSIGN.items():
        s = shows.get(show_name)
        if not s:
            sys.exit(f"תוכנית '{show_name}' לא נמצאה — עצירה.")
        pool = by_show.get(s["id"], [])
        print(f"\n{show_name}  ({len(pool)} הפקות)  active_after={active_after}")
        cid = get_or_create_client(client_name, apply)
        print(f"    show -> billing_mode=per_episode, client={client_name}, active={active_after}")
        print(f"    {len(pool)} productions -> kind=client, client inherited")
        if apply:
            api("PATCH", "shows", params={"id": f"eq.{s['id']}"},
                body={"billing_mode": "per_episode", "client_id": cid, "active": active_after})
            api("PATCH", "productions", params={"show_id": f"eq.{s['id']}"},
                body={"kind": "client", "client_id": cid})
            api("POST", "events", body={
                "entity_type": "show", "entity_id": s["id"], "event_type": "billing_classified",
                "payload": {"billing_mode": "per_episode", "client": client_name,
                            "active": active_after, "productions_reclassified": len(pool),
                            "production_ids": [p["id"] for p in pool],
                            "source": SOURCE, "approved_by": "owner"}})

    # ---------- reports ----------
    if apply:
        prods_now = get_all("productions", {"select": "kind"})
        shows_now = get_all("shows", {"select": "id,name,active,client_id,billing_mode"})
        from collections import Counter
        kinds = dict(Counter(p["kind"] for p in prods_now))
        orphans = [s for s in shows_now if s["active"] and not s["client_id"]]
        print("\n=== מצב סופי ===")
        print("1. הפקות לפי kind:", kinds)
        print(f"   (client expected ~178 = 93 + 47 + 38 -> got {kinds.get('client')})")
        print(f"2. תוכניות פעילות בלי לקוח (יתומות): {len(orphans)}  (expected ~28)")

        # alert-data check: מנהלי שיווק is closed but must NOT be silenced
        m = next((s for s in shows_now if s["name"] == "מנהלי שיווק מצייצים"), None)
        if m:
            mp = get_all("productions", {"select": "kind", "show_id": f"eq.{m['id']}"})
            mk = dict(Counter(p["kind"] for p in mp))
            silenced = m["billing_mode"] == "none" or all(p["kind"] == "internal" for p in mp)
            print(f"\n3. מנהלי שיווק מצייצים: active={m['active']}, billing_mode={m['billing_mode']}, "
                  f"productions kind={mk}")
            print(f"   ההתראה 🔵 משותקת? {'כן (בעיה!)' if silenced else 'לא — התוכנית עדיין תצעק ✓'}")


if __name__ == "__main__":
    main()
