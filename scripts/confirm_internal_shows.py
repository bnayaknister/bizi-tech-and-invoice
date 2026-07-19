# -*- coding: utf-8 -*-
"""
Mark the owner's own shows as confirmed-internal (owner decision 2026-07-19).
Requires migration 0024.

Two active shows carry no client and no explicit "never bills" marking:
ברחובות שלנו and גיא ואור. The owner confirmed both are his own internal
productions. This writes the decision down: billing_mode='none' plus
internal_confirmed_at/by, so nothing downstream ever has to infer intent
from an empty client_id.

Safety: the cross-check that must pass before marking a show internal is
"no production of this show is linked to a job" — a show with billing
history is a 🔴, not an internal show. It is re-run here at apply time
rather than trusted from an earlier report, because the answer can change
between the report and the run.

Run with no arguments for a PREVIEW (writes nothing); --apply to execute.
Idempotent; every change logged to events.
"""
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

BASE = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
OWNER_ID = "432bc1cc-b71b-4d68-9037-3e6384612510"

TARGETS = ["ברחובות שלנו", "גיא ואור"]

APPLY = "--apply" in sys.argv


def api(method, path, body=None, prefer=None):
    headers = {
        "apikey": KEY,
        "Authorization": "Bearer " + KEY,
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + "/rest/v1/" + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8")
        if "internal_confirmed" in detail and "does not exist" in detail:
            sys.exit("migration 0024 has not been applied yet — apply it before running this.")
        sys.exit("HTTP %s on %s %s\n%s" % (e.code, method, path, detail))


def job_linked_count(show_id):
    """productions of this show that are linked to a job — billing history."""
    links = api(
        "GET",
        "job_productions?select=job_id,productions!inner(show_id)"
        "&productions.show_id=eq." + show_id,
    )
    return len(links or [])


def main():
    print("MODE: %s\n" % ("APPLY" if APPLY else "PREVIEW (no writes)"))

    shows = api("GET", "shows?active=eq.true&select=id,name,billing_mode,client_id,"
                       "internal_confirmed_at,internal_confirmed_by")
    by_name = {s["name"]: s for s in shows}

    planned = []
    for name in TARGETS:
        s = by_name.get(name)
        if not s:
            print("SKIP  %-16s not found among active shows" % name)
            continue
        if s.get("client_id"):
            print("SKIP  %-16s has a client_id — not internal, resolve by hand" % name)
            continue

        n = job_linked_count(s["id"])
        if n:
            print("BLOCK %-16s has %d job-linked production(s) — billing history, refusing" % (name, n))
            continue

        if s.get("billing_mode") == "none" and s.get("internal_confirmed_at"):
            print("OK    %-16s already confirmed internal (%s)" % (name, s["internal_confirmed_at"]))
            continue

        print("SET   %-16s billing_mode %s -> none, confirmed by owner" % (name, s.get("billing_mode")))
        planned.append(s)

    if not planned:
        print("\nnothing to do.")
        return
    if not APPLY:
        print("\n%d show(s) would change. Re-run with --apply." % len(planned))
        return

    now = datetime.now(timezone.utc).isoformat()
    for s in planned:
        api(
            "PATCH",
            "shows?id=eq." + s["id"],
            {
                "billing_mode": "none",
                "internal_confirmed_at": now,
                "internal_confirmed_by": OWNER_ID,
            },
            prefer="return=minimal",
        )
        api(
            "POST",
            "events",
            {
                "entity_type": "show",
                "entity_id": s["id"],
                "event_type": "show_confirmed_internal",
                "actor_id": OWNER_ID,
                "payload": {
                    "name": s["name"],
                    "billing_mode_before": s.get("billing_mode"),
                    "billing_mode_after": "none",
                    "reason": "owner internal production, no client, no billing history",
                },
            },
            prefer="return=minimal",
        )
        print("DONE  %s" % s["name"])


if __name__ == "__main__":
    main()
