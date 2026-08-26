# -*- coding: utf-8 -*-
"""
Acceptance test for the recurring-series warning (owner decision 2026-08-26).

Drives the real POST /api/calendar/sync through its `icsText` escape hatch, so
the whole detection path runs against a fake calendar and never touches the
live feed or the calendar_sync_enabled gate. Asserts on `recurringUnsynced` in
the response body.

The cases mirror the two filters the design rests on:
  1  a live unbounded master on an active show     -> WARN
  2  a master whose UNTIL has passed               -> silent
  3  a master whose COUNT is exhausted             -> silent
  4  a master whose COUNT is NOT exhausted         -> WARN
  5  a master matching no active show              -> silent
  6  a master whose DTSTART is outside today's window -> WARN
     (the regression that matters: detection must read the whole feed, not
      the day slice, or the alert fires one day a year)
  7  a RECURRENCE-ID override                      -> silent (it is materialised)
  8  a plain non-recurring event                   -> silent
  9  the same master twice                         -> counted once

Creates one ZTESTRECUR show, deletes it in `finally`, verified.
Run:  npx next dev   (in another shell)  then  python3 scripts/test_calendar_recurring_alert.py

⚠️ PRE-EXISTING HAZARD OF THE icsText PATH — not introduced by this test, but
triggered by it. runSync scopes `existingByUid` to productions whose
record_date is TODAY, then flags every one of them whose calendar_uid is
absent from the feed as `calendar_removed`. A fake feed contains none of the
real UIDs, so every real production recorded today gets flagged. This test
therefore snapshots `calendar_removed` for today's calendar-linked
productions up front and restores it in `finally`, and verifies the restore.
Anyone writing another icsText test must do the same, or add today's real
UIDs to the fake feed.
"""
import os
import sys
import json
import base64
import uuid
from datetime import datetime, timezone, timedelta
import requests

ENV = os.path.join(os.path.dirname(__file__), "..", ".env.local")
for line in open(ENV, encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

SUP = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SVC = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
REF = SUP.split("//")[1].split(".")[0]
ADMIN = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}

MARK = "ZTESTRECUR"
ALIAS = "ZTESTRECURALIAS"
# Deliberately NOT a superstring of ALIAS. Matching is a plain substring test,
# so "ZTESTRECURALIASOFF" would contain "ZTESTRECURALIAS" and match the ACTIVE
# show — making case 5 pass or fail for the wrong reason.
ALIAS_OFF = "ZQQINACTIVE"

fails = []
users, shows = [], []
# [{id, calendar_removed}] for today's calendar-linked productions — see the
# hazard note in the docstring. Module level so `finally` can always reach it.
removed_snapshot = []
# Israel local date, matching israelDayWindow() in the route
TODAY_IL = (datetime.now(timezone.utc) + timedelta(hours=3)).strftime("%Y-%m-%d")
# everything this run writes is stamped after this instant — the cleanup uses
# it so it can never delete an event the real 06:00 cron logged
STARTED_AT = datetime.now(timezone.utc).isoformat()


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        fails.append(label)


def make_owner():
    email = f"ztest-{uuid.uuid4().hex[:8]}@example.com"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    u = requests.post(f"{SUP}/auth/v1/admin/users", headers=ADMIN,
                      json={"email": email, "password": pw, "email_confirm": True}).json()
    uid = u["id"]
    users.append(uid)
    requests.patch(f"{SUP}/rest/v1/profiles?id=eq.{uid}", headers=ADMIN,
                   json={"approved": True, "can_view_stages": True, "can_edit_stages": True,
                         "can_view_money": True, "can_edit_money": True, "role": "owner"})
    tok = requests.post(f"{SUP}/auth/v1/token?grant_type=password",
                        headers={"apikey": ANON, "Content-Type": "application/json"},
                        json={"email": email, "password": pw}).json()
    val = "base64-" + base64.b64encode(json.dumps(tok, separators=(",", ":")).encode()).decode()
    name = f"sb-{REF}-auth-token"
    jar = {}
    if len(val) <= 3180:
        jar[name] = val
    else:
        for i, s in enumerate(range(0, len(val), 3180)):
            jar[f"{name}.{i}"] = val[s:s + 3180]
    return jar


def vevent(uid, summary, dtstart, rrule=None, recurrence_id=None, dtend=None):
    out = ["BEGIN:VEVENT", f"UID:{uid}", f"SUMMARY:{summary}", f"DTSTART:{dtstart}"]
    out.append(f"DTEND:{dtend or dtstart}")
    if rrule:
        out.append(f"RRULE:{rrule}")
    if recurrence_id:
        out.append(f"RECURRENCE-ID:{recurrence_id}")
    out.append("STATUS:CONFIRMED")
    out.append("END:VEVENT")
    return "\n".join(out)


def ics(*events):
    return "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//ztest//EN\n" + "\n".join(events) + "\nEND:VCALENDAR"


def sync(jar, text):
    return requests.post(f"{APP}/api/calendar/sync",
                         headers={"Content-Type": "application/json"},
                         cookies=jar, json={"icsText": text})


def warned(resp):
    """-> list of show names the run warned about"""
    body = resp.json()
    return [r.get("showName") for r in (body.get("recurringUnsynced") or [])]


try:
    # snapshot BEFORE the first sync call — the very first fake feed already
    # flags today's real productions
    removed_snapshot = requests.get(
        f"{SUP}/rest/v1/productions?select=id,calendar_removed"
        f"&record_date=eq.{TODAY_IL}&calendar_uid=not.is.null&merged_into=is.null",
        headers=ADMIN).json()
    print(f"guarding {len(removed_snapshot)} real production(s) recorded today ({TODAY_IL})\n")

    owner = make_owner()

    probe = sync(owner, ics())
    check("0. cookie authenticates (200 not 401)", probe.status_code == 200,
          f"got {probe.status_code}: {probe.text[:160]}")
    if probe.status_code != 200:
        raise SystemExit("cannot authenticate — is `npx next dev` running?")

    # an ACTIVE show whose alias is unmistakable
    r = requests.post(f"{SUP}/rest/v1/shows", headers={**ADMIN, "Prefer": "return=representation"},
                      json={"name": MARK, "aliases": [ALIAS], "active": True,
                            "billing_mode": "none", "has_episode": True, "reels_count": 0})
    show_id = r.json()[0]["id"]
    shows.append(show_id)

    # an INACTIVE show, for case 5
    r2 = requests.post(f"{SUP}/rest/v1/shows", headers={**ADMIN, "Prefer": "return=representation"},
                       json={"name": MARK + "OFF", "aliases": [ALIAS_OFF], "active": False,
                             "billing_mode": "none", "has_episode": True, "reels_count": 0})
    shows.append(r2.json()[0]["id"])

    # ---- 1. live unbounded master on an active show -> WARN
    res = sync(owner, ics(vevent("rec-1", f"{ALIAS} weekly", "20260818T110000Z", rrule="FREQ=WEEKLY")))
    check("1. unbounded master on an active show warns", warned(res) == [MARK], str(res.json())[:200])

    # ---- 2. UNTIL in the past -> silent
    res = sync(owner, ics(vevent("rec-2", f"{ALIAS} expired", "20190217T103000Z",
                                 rrule="FREQ=WEEKLY;UNTIL=20190720T205959Z;BYDAY=SU")))
    check("2. master whose UNTIL has passed is silent", warned(res) == [], str(res.json())[:200])

    # ---- 3. COUNT exhausted -> silent
    res = sync(owner, ics(vevent("rec-3", f"{ALIAS} counted out", "20201125T100000Z",
                                 rrule="FREQ=WEEKLY;COUNT=5;INTERVAL=1;BYDAY=WE")))
    check("3. master whose COUNT is exhausted is silent", warned(res) == [], str(res.json())[:200])

    # ---- 4. COUNT still running -> WARN  (500 weeks from 2026-08-18)
    res = sync(owner, ics(vevent("rec-4", f"{ALIAS} counting", "20260818T110000Z",
                                 rrule="FREQ=WEEKLY;COUNT=500")))
    check("4. master whose COUNT is NOT exhausted warns", warned(res) == [MARK], str(res.json())[:200])

    # ---- 5. matches no ACTIVE show -> silent (both an unknown title and an inactive show's alias)
    res = sync(owner, ics(vevent("rec-5a", "nothing matches this", "20260818T110000Z", rrule="FREQ=WEEKLY"),
                          vevent("rec-5b", f"{ALIAS_OFF} weekly", "20260818T110000Z", rrule="FREQ=WEEKLY")))
    check("5. master matching no ACTIVE show is silent", warned(res) == [], str(res.json())[:200])

    # ---- 6. THE REGRESSION: DTSTART far outside today's window -> still WARN
    res = sync(owner, ics(vevent("rec-6", f"{ALIAS} old start", "20240103T090000Z", rrule="FREQ=WEEKLY")))
    check("6. master whose DTSTART is outside today's window still warns",
          warned(res) == [MARK], str(res.json())[:200])

    # ---- 7. a RECURRENCE-ID override is materialised -> silent
    res = sync(owner, ics(vevent("rec-7", f"{ALIAS} moved", "20260901T140000Z",
                                 recurrence_id="20260901T110000Z")))
    check("7. RECURRENCE-ID override does not warn", warned(res) == [], str(res.json())[:200])

    # ---- 8. a plain single event -> silent
    res = sync(owner, ics(vevent("rec-8", f"{ALIAS} one off", "20260818T110000Z")))
    check("8. non-recurring event does not warn", warned(res) == [], str(res.json())[:200])

    # ---- 9. one series counted once, however many components carry its UID
    res = sync(owner, ics(vevent("rec-9", f"{ALIAS} weekly", "20260818T110000Z", rrule="FREQ=WEEKLY"),
                          vevent("rec-9", f"{ALIAS} weekly", "20260915T140000Z",
                                 recurrence_id="20260915T110000Z")))
    body = res.json()
    check("9. a series is reported once, not per component",
          body.get("recurringUnsyncedCount") == 1 and warned(res) == [MARK], str(body)[:200])

    # ---- 10. the count field tracks the list
    res = sync(owner, ics(vevent("rec-10a", f"{ALIAS} a", "20260818T110000Z", rrule="FREQ=WEEKLY"),
                          vevent("rec-10b", f"{ALIAS} b", "20260819T110000Z", rrule="FREQ=DAILY")))
    body = res.json()
    check("10. count matches the list length",
          body.get("recurringUnsyncedCount") == 2 and len(body.get("recurringUnsynced") or []) == 2,
          str(body)[:200])

    # ---- 11. an empty feed reports an empty list, not a missing key
    body = sync(owner, ics()).json()
    check("11. empty feed -> empty list and zero count",
          body.get("recurringUnsynced") == [] and body.get("recurringUnsyncedCount") == 0, str(body)[:200])

finally:
    # restore the real productions the fake feeds flagged (see the docstring).
    # First — before deleting anything — because this is live data, not test data.
    for p in removed_snapshot:
        requests.patch(f"{SUP}/rest/v1/productions?id=eq.{p['id']}", headers=ADMIN,
                       json={"calendar_removed": p["calendar_removed"]})
    if removed_snapshot:
        ids = ",".join(p["id"] for p in removed_snapshot)
        now = requests.get(f"{SUP}/rest/v1/productions?select=id,calendar_removed&id=in.({ids})",
                           headers=ADMIN).json()
        by = {p["id"]: p["calendar_removed"] for p in removed_snapshot}
        drift = [p["id"] for p in now if p["calendar_removed"] != by.get(p["id"])]
        print(f"restored calendar_removed on {len(removed_snapshot)} real production(s); drift={len(drift)}")
        if drift:
            fails.append(f"calendar_removed NOT restored on {drift}")
        # the flagging also logs events against real productions — remove only
        # the ones THIS run wrote (STARTED_AT), never the real cron's
        requests.delete(
            f"{SUP}/rest/v1/events?entity_id=in.({ids})&event_type=eq.calendar_flagged_removed"
            f"&created_at=gte.{STARTED_AT}", headers=ADMIN)

    # cleanup — every test row, verified. Productions first: a warning run
    # never creates one, but an assertion failure mid-run must not leave a
    # show that cannot be deleted.
    for sid in shows:
        requests.delete(f"{SUP}/rest/v1/productions?show_id=eq.{sid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/shows?id=eq.{sid}", headers=ADMIN)
    for uid in users:
        requests.delete(f"{SUP}/rest/v1/events?actor_id=eq.{uid}", headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{uid}", headers=ADMIN)
    left_shows = requests.get(f"{SUP}/rest/v1/shows?select=id&name=like.*{MARK}*", headers=ADMIN).json()
    left_users = [u for u in users if requests.get(
        f"{SUP}/rest/v1/profiles?select=id&id=eq.{u}", headers=ADMIN).json()]
    print(f"\ncleanup: shows left={len(left_shows)}  profiles left={len(left_users)}")
    if left_shows or left_users:
        fails.append("cleanup left rows behind")

print(f"\n{'ALL PASS' if not fails else str(len(fails)) + ' FAILED: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
