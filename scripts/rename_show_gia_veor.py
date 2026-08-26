# -*- coding: utf-8 -*-
"""
ONE-TIME DATA REPAIR (owner decision 2026-08-26).

Renames show bfc7f18e "גיא ואור" -> "סדרת חינוך", realigns its aliases, and
refreshes the 40 display copies of the old name (7 productions.podcast_name +
33 stages.podcast_name).

WHY THE COPIES ARE SAFE TO REWRITE. podcast_name is a display column, not an
accounting record. Verified before running: 0 jobs carry campaign='גיא ואור',
0 pending_documents name it in their frozen payload, 0 registry documents,
0 invoices. The show has been kind='internal' since it was created and has
never been billed, so there is no frozen money line to contradict.

TRIGGER PREFLIGHT. stages carries two BEFORE UPDATE triggers that fire on ANY
column, not just status: enforce_stage_order (raises if a non-pending stage's
predecessor isn't done) and set_done_at (nulls done_at when status<>'done').
Both were simulated against all 33 rows before writing: 0 order violations,
0 done_at anomalies. That check is repeated live below and aborts on a hit.

TOUCHES MORNING: never. TOUCHES jobs / documents / invoices: never — asserted
by a before/after fingerprint, not assumed.

Safe to re-run: every write is keyed by id/show_id and the target values are
absolute.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")
for _line in open(ENV_PATH, encoding="utf-8"):
    _line = _line.strip()
    if _line and not _line.startswith("#") and "=" in _line:
        _k, _v = _line.split("=", 1)
        os.environ.setdefault(_k.strip(), _v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
K = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

SHOW_ID = "bfc7f18e-5ca0-4672-ab73-b98938b8f2be"
OLD = "גיא ואור"
NEW = "סדרת חינוך"
ALIASES_AFTER = ["אור בן מלך", "גיא אריאלי", "אור גיא ומיכאלי", "אור וגיא", "גיא ואור"]


def api(method, path, params=None, body=None, prefer=None):
    url = U + "/rest/v1/" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    h = {"apikey": K, "Authorization": "Bearer " + K, "Content-Type": "application/json"}
    if prefer:
        h["Prefer"] = prefer
    req = urllib.request.Request(
        url, method=method,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None,
        headers=h)
    try:
        with urllib.request.urlopen(req) as r:
            t = r.read().decode("utf-8")
            return json.loads(t) if t else None
    except urllib.error.HTTPError as e:
        print("HTTP %s %s %s\n%s" % (e.code, method, path, e.read().decode("utf-8")[:500]), file=sys.stderr)
        raise


def head(t):
    print("\n" + "=" * 68 + "\n" + t + "\n" + "=" * 68)


def money_fingerprint():
    """Everything that must NOT move. Compared before/after."""
    jobs = api("GET", "jobs", params={"select": "id,campaign,amount,invoice_biz,invoice_tax,paid"})
    docs = api("GET", "documents", params={"select": "id,type,status,amount", "limit": "3000"})
    pend = api("GET", "pending_documents", params={"select": "id,doc_type,status"})
    inv = api("GET", "invoices", params={"select": "id", "limit": "3000"})
    return {
        "jobs": len(jobs), "documents": len(docs), "pending": len(pend), "invoices": len(inv),
        "jobs_hash": hash(json.dumps(sorted(json.dumps(j, ensure_ascii=False, sort_keys=True) for j in jobs))),
        "old_name_in_jobs": sum(1 for j in jobs if j.get("campaign") == OLD),
    }


# ---- 0. PREFLIGHT -----------------------------------------------------------
head("0. PREFLIGHT")
show = api("GET", "shows", params={"select": "id,name,aliases,active,billing_mode", "id": "eq." + SHOW_ID})[0]
print("  BEFORE  name    = %s" % json.dumps(show["name"], ensure_ascii=False))
print("          aliases = %s" % json.dumps(show["aliases"], ensure_ascii=False))
if show["name"] == NEW:
    sys.exit("ABORT: already renamed — nothing to do.")
if show["name"] != OLD:
    sys.exit("ABORT: unexpected current name %r — refusing to guess." % show["name"])

prods = api("GET", "productions", params={
    "select": "id,podcast_name,record_date,status", "show_id": "eq." + SHOW_ID})
pids = [p["id"] for p in prods]
stages = api("GET", "stages", params={
    "select": "id,production_id,track,step,status,done_at",
    "production_id": "in.(%s)" % ",".join(pids)})
print("  productions to refresh : %d" % len(prods))
print("  stages to refresh      : %d" % len(stages))

# live re-run of the stage-trigger simulation — abort rather than half-write
by = {(s["production_id"], s["track"], s["step"]): s for s in stages}
viol = []
for s in stages:
    if s["status"] == "pending":
        continue
    prev = "edit" if s["step"] == "deliver" else ("record" if s["step"] == "edit" and s["track"] == "episode" else None)
    if prev is None:
        continue
    p = by.get((s["production_id"], s["track"], prev))
    if (p or {}).get("status") != "done":
        viol.append(s["id"])
anom = [s["id"] for s in stages if s["status"] != "done" and s["done_at"]]
print("  enforce_stage_order violations : %d" % len(viol))
print("  set_done_at anomalies          : %d" % len(anom))
if viol or anom:
    sys.exit("ABORT: stage triggers would raise or mutate — %s %s" % (viol, anom))

before_money = money_fingerprint()
print("  money fingerprint BEFORE: %s" % json.dumps(
    {k: v for k, v in before_money.items() if k != "jobs_hash"}, ensure_ascii=False))

# ---- 1. THE SHOW ------------------------------------------------------------
head("1. RENAME THE SHOW (name + aliases, one write)")
patch = {"name": NEW, "aliases": ALIASES_AFTER}
updated = api("PATCH", "shows", params={"id": "eq." + SHOW_ID}, body=patch,
              prefer="return=representation")[0]
print("  AFTER   name    = %s" % json.dumps(updated["name"], ensure_ascii=False))
print("          aliases = %s" % json.dumps(updated["aliases"], ensure_ascii=False))

api("POST", "events", body={
    "entity_type": "show", "entity_id": SHOW_ID, "event_type": "show_updated",
    "actor_id": None,
    "payload": {
        "patch": patch, "fields": ["name", "aliases"],
        "previous": {"name": show["name"], "aliases": show["aliases"]},
        "reason": "שינוי שם ביוזמת הבעלים. 'סדרת חינוך' הוסר מהכינויים (הפך לשם) "
                  "ו'גיא ואור' נוסף ככינוי — ביטוח, אף כותרת ביומן לא נכתבה כך.",
    }})
print("  logged show_updated")

# ---- 2. THE DISPLAY COPIES --------------------------------------------------
head("2. REFRESH THE DISPLAY COPIES")
pr = api("PATCH", "productions", params={"show_id": "eq." + SHOW_ID, "podcast_name": "eq." + OLD},
         body={"podcast_name": NEW}, prefer="return=representation")
print("  productions.podcast_name updated : %d" % len(pr))
sr = api("PATCH", "stages", params={"production_id": "in.(%s)" % ",".join(pids), "podcast_name": "eq." + OLD},
         body={"podcast_name": NEW}, prefer="return=representation")
print("  stages.podcast_name updated      : %d" % len(sr))

# ---- 3. VERIFY --------------------------------------------------------------
head("3. VERIFY — zero rows left carrying the old name")
for table, col, extra in (("shows", "name", {}),
                          ("productions", "podcast_name", {}),
                          ("stages", "podcast_name", {}),
                          ("jobs", "campaign", {})):
    params = {"select": "id", col: "eq." + OLD}
    params.update(extra)
    left = api("GET", table, params=params)
    print("  %-12s.%-13s = %r : %d" % (table, col, OLD, len(left)))

show2 = api("GET", "shows", params={"select": "name,aliases", "id": "eq." + SHOW_ID})[0]
print("\n  show now: name=%s" % json.dumps(show2["name"], ensure_ascii=False))
print("            aliases=%s" % json.dumps(show2["aliases"], ensure_ascii=False))
print("  'סדרת חינוך' still duplicated in aliases: %s" % (NEW in show2["aliases"]))
print("  'גיא ואור' present as alias             : %s" % (OLD in show2["aliases"]))

print("\n  productions after:")
for p in api("GET", "productions", params={
        "select": "podcast_name,record_date,status", "show_id": "eq." + SHOW_ID,
        "order": "record_date.desc"}):
    print("    %-12s %-12s %s" % (p["podcast_name"], p["record_date"], p["status"]))

st2 = api("GET", "stages", params={
    "select": "podcast_name,status", "production_id": "in.(%s)" % ",".join(pids)})
names = sorted(set(s["podcast_name"] for s in st2))
print("\n  distinct stages.podcast_name across %d rows: %s" % (len(st2), json.dumps(names, ensure_ascii=False)))

head("4. VERIFY — money untouched")
after_money = money_fingerprint()
for k in ("jobs", "documents", "pending", "invoices", "old_name_in_jobs"):
    same = before_money[k] == after_money[k]
    print("  %-16s before=%-6s after=%-6s %s" % (k, before_money[k], after_money[k], "OK" if same else "!! CHANGED"))
print("  jobs row-for-row identical : %s" % (before_money["jobs_hash"] == after_money["jobs_hash"]))
