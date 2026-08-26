# -*- coding: utf-8 -*-
"""
ONE-TIME DATA REPAIR (owner decision 2026-08-26).

WHAT WAS WRONG. The 25.8 recording of "גיא ואור" was never created. The
calendar event is an occurrence of a WEEKLY recurring series (master
UID C77AB6A5..., DTSTART 20260818T140000, RRULE:FREQ=WEEKLY) and
src/lib/calendar/parse.ts does not expand RRULE — only the master VEVENT
(18.8) and RECURRENCE-ID overrides (1.9) are ever seen. The 25.8 occurrence
has no VEVENT of its own, so the sync never saw it. Re-syncing cannot
recover it: runSync always reads TODAY, and there is nothing on the feed to
read for that date. Hence a manual creation.

WHAT IT DOES. Mirrors src/app/api/productions/route.ts POST exactly:
kind/client/studio/camera_count/composition inherited from the show,
calendar_uid deliberately null (this row was never a calendar event, so the
sync's match-by-uid loop must never touch it), then moves it to הוקלט the
way the board does — by marking the episode/record STAGE done and letting
trg_derive_production_status move the cursor. productions.status is never
written directly.

TOUCHES MORNING: never. CREATES A DOCUMENT: never — kind='internal' fails
enqueueDocument's applicable gate ("no document is owed here at all").
CREATES A JOB: never — on_production_approved returns early for kind<>'client'.
Both are asserted at the end rather than assumed.

Idempotent: refuses to run if a production already exists for this show on
this date.
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

URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

SHOW_ID = "bfc7f18e-5ca0-4672-ab73-b98938b8f2be"
RECORD_DATE = "2026-08-25"
RECORD_TIME = "14:00"
STUDIO = "גבעון גדול"          # owner decision — their actual room, overrides the show default
GUEST = None


def api(method, path, params=None, body=None, prefer=None):
    url = URL + "/rest/v1/" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {
        "apikey": KEY,
        "Authorization": "Bearer " + KEY,
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    req = urllib.request.Request(
        url, method=method,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None,
        headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            text = r.read().decode("utf-8")
            return json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        print("HTTP %s on %s %s\n%s" % (e.code, method, path, e.read().decode("utf-8")[:600]),
              file=sys.stderr)
        raise


def head(t):
    print("\n" + "=" * 66)
    print(t)
    print("=" * 66)


# ---- 0. PREFLIGHT -----------------------------------------------------------
head("0. PREFLIGHT")
existing = api("GET", "productions", params={
    "select": "id,record_date,status", "show_id": "eq." + SHOW_ID,
    "record_date": "eq." + RECORD_DATE})
if existing:
    sys.exit("ABORT: a production already exists for this show on %s: %s" % (RECORD_DATE, existing))
print("  no production for this show on %s — safe to create" % RECORD_DATE)

show = api("GET", "shows", params={
    "select": "id,name,client_id,billing_mode,default_studio,camera_count,"
              "default_editor_id,has_episode,reels_count,active",
    "id": "eq." + SHOW_ID})[0]
print("  show: %s" % json.dumps(show, ensure_ascii=False))

# identical derivation to route.ts:66-72 and the sync's create branch
kind = ("contract" if show["billing_mode"] == "contract"
        else "client" if show["billing_mode"] == "per_episode" and show["client_id"]
        else "internal")
print("  derived kind = %r  (billing_mode=%r, client_id=%r)"
      % (kind, show["billing_mode"], show["client_id"]))
assert kind == "internal", "expected internal — aborting rather than creating a billable row"

# ---- 1. CREATE --------------------------------------------------------------
head("1. CREATE PRODUCTION")
row = {
    "podcast_name": show["name"],
    "show_id": show["id"],
    "client_id": show["client_id"],
    "kind": kind,
    "contract_id": None,                 # billing_mode != 'contract'
    "record_date": RECORD_DATE,
    "record_time": RECORD_TIME,
    "guest": GUEST,
    "studio": STUDIO,
    "camera_count": show["camera_count"],
    "has_episode": show["has_episode"],
    "reels_count": show["reels_count"],
    "calendar_uid": None,                # never was a calendar row — see docstring
    "legacy": False,
}
created = api("POST", "productions", body=row, prefer="return=representation")[0]
PID = created["id"]
print("  created id = %s" % PID)
for k in ("podcast_name", "kind", "status", "record_date", "record_time", "studio",
          "guest", "client_id", "camera_count", "has_episode", "reels_count",
          "calendar_uid", "external_id", "legacy"):
    print("    %-16s %s" % (k, json.dumps(created.get(k), ensure_ascii=False)))

# ---- 2. STAGES SEEDED BY THE TRIGGER ---------------------------------------
head("2. STAGES (seeded by trg_create_default_stages)")
stages = api("GET", "stages", params={
    "select": "id,track,step,status,done_at", "production_id": "eq." + PID,
    "order": "track.asc,step.asc"})
for s in stages:
    print("    %-8s %-8s %-12s done_at=%s" % (s["track"], s["step"], s["status"], s["done_at"]))
print("  -> %d stages (episode track only; reels_count=0 so no reels line)" % len(stages))

# ---- 3. AUDIT EVENT ---------------------------------------------------------
head("3. AUDIT EVENT")
api("POST", "events", body={
    "entity_type": "production", "entity_id": PID,
    "event_type": "production_created_manually",
    "actor_id": None,                    # a repair script did this, not a person
    "payload": {
        "show_id": SHOW_ID, "show": show["name"], "record_date": RECORD_DATE, "kind": kind,
        "reason": "מופע של אירוע יומן חוזר (RRULE:FREQ=WEEKLY) שהסנכרון לא רואה — "
                  "parse.ts אינו מרחיב RRULE, ולמופע של 25.8 אין VEVENT משלו. "
                  "סנכרון חוזר אינו יכול לשחזר אותו.",
        "calendar_master_uid": "C77AB6A5-DF21-44E4-BDBE-939DCC125F80",
    }})
print("  logged production_created_manually")

# ---- 4. MOVE TO הוקלט VIA THE STAGE, NOT THE STATUS COLUMN ------------------
head("4. MOVE TO RECORDED (episode/record -> done)")
rec = [s for s in stages if s["track"] == "episode" and s["step"] == "record"][0]
print("  marking stage %s done ..." % rec["id"])
api("PATCH", "stages", params={"id": "eq." + rec["id"]},
    body={"status": "done"}, prefer="return=representation")
after = api("GET", "productions", params={
    "select": "id,status,record_date,billing_block_reason", "id": "eq." + PID})[0]
print("  production.status is now %r  (derived by trg_derive_production_status)"
      % after["status"])

# ---- 5. ASSERTIONS ----------------------------------------------------------
head("5. VERIFY — no job, no document, nothing billable")
jp = api("GET", "job_productions", params={"select": "job_id", "production_id": "eq." + PID})
print("  job_productions rows        : %d   %s" % (len(jp), jp))
docs = api("GET", "pending_documents", params={
    "select": "id,doc_type,status", "production_id": "eq." + PID})
print("  pending_documents rows      : %d   %s" % (len(docs), docs))
print("  billing_block_reason        : %s" % json.dumps(after["billing_block_reason"], ensure_ascii=False))
evs = api("GET", "events", params={
    "select": "event_type,created_at", "entity_type": "eq.production",
    "entity_id": "eq." + PID, "order": "created_at.asc"})
print("  events on this production   : %s" % [e["event_type"] for e in evs])
final_stages = api("GET", "stages", params={
    "select": "track,step,status,done_at", "production_id": "eq." + PID,
    "order": "track.asc,step.asc"})
print("  stages:")
for s in final_stages:
    print("    %-8s %-8s %-12s done_at=%s" % (s["track"], s["step"], s["status"], s["done_at"]))

ok = (len(jp) == 0 and len(docs) == 0 and after["status"] == "הוקלט")
print("\n  RESULT: %s" % ("OK — recorded, unbilled, exactly as intended" if ok
                          else "!! UNEXPECTED — review the output above"))
print("  production id: %s" % PID)
