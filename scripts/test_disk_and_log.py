# -*- coding: utf-8 -*-
"""
Sections 2 (storage disk) + 3 (production log / journal) — owner 2026-07-24.
Migration 0040. Hits the real running dev server through cookie-auth sessions
(the drawer path) and the service role, then cleans up everything.

Covers the owner's acceptance tests:
  #2 disk saved via the drawer endpoint, shown by the entity GET, logged 💾
  #3 completing a stage + adding a note -> logged with author name + date
  #4 completing a stage with NO note -> still logged (the ✓ stage entry)
  #5 a client note (as applyResponse writes it) appears in the same log
  #6 global search by disk name finds the production
plus the guards: a money-only user may READ disk+log but not SET the disk;
a note is editable only by its author (edited_at stamped); log entries are
immutable except the note body (the DB guard trigger).
"""
import base64, json, os, sys, time, uuid
from datetime import datetime, timezone
import requests

ENV = os.path.join(os.path.dirname(__file__), "..", ".env.local")
if os.path.exists(ENV):
    with open(ENV, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

SUP = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SVC = os.environ["SUPABASE_SERVICE_ROLE_KEY"]; APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
ADMIN = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}
REPR = {**ADMIN, "Prefer": "return=representation"}
ref = SUP.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"
MARK = "ZTESTDISKLOG"
DISK = f"SSD-{uuid.uuid4().hex[:5].upper()}"  # unique so search finds only ours
failures = []; users = []; prod_id = None; show_id = None


def check(l, ok, d=""):
    print(("PASS  " if ok else "FAIL  ") + l + (f"  [{d}]" if d and not ok else ""))
    if not ok: failures.append(l)


def rest(p): return f"{SUP}/rest/v1/{p}"
def b64(r): return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags):
    em = f"dl-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"T-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{SUP}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers=REPR, json={"name": MARK, "approved": True, **flags})
    td = requests.post(f"{SUP}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return uid, {CN: "base64-" + b64(json.dumps(sess).encode())}


def stage_id(track, step):
    r = requests.get(rest(f"stages?production_id=eq.{prod_id}&track=eq.{track}&step=eq.{step}&select=id"),
                     headers=ADMIN).json()
    return r[0]["id"]


def get_log(ck):
    d = requests.get(f"{APP}/api/entity/production/{prod_id}", cookies=ck).json()
    return d.get("log") or [], d


for _ in range(60):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("FAIL dev server never came up"); sys.exit(1)

try:
    tech_uid, tck = mkuser({"role": "tech", "can_view_stages": True, "can_edit_stages": True})
    # a "bookkeeper": money view/edit + stage VIEW, but no stage EDIT
    bk_uid, bck = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True,
                          "can_view_stages": True, "can_edit_stages": False})
    show_id = requests.post(rest("shows"), headers=REPR,
                            json={"name": f"{MARK} s", "aliases": [], "billing_mode": "none", "active": True}).json()[0]["id"]
    prod_id = requests.post(rest("productions"), headers=REPR,
                            json={"podcast_name": f"{MARK} p", "show_id": show_id, "kind": "internal",
                                  "record_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                                  "legacy": False}).json()[0]["id"]

    # ---- §2: tech sets the disk through the drawer (entity POST) ----
    r = requests.post(f"{APP}/api/entity/production/{prod_id}", cookies=tck,
                      headers={"Content-Type": "application/json"},
                      json={"patch": {"storage_disk": DISK}})
    check("#2 tech can set storage_disk via the drawer endpoint", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    _, d = get_log(tck)
    check("#2 entity GET returns the disk on the production", d["entity"].get("storage_disk") == DISK, str(d["entity"].get("storage_disk")))
    log, _ = get_log(tck)
    disk_entries = [e for e in log if e["kind"] == "disk"]
    check("#2 a 💾 disk entry was auto-logged with the disk name",
          any(e["note"] == DISK for e in disk_entries), str(disk_entries))
    check("#2 disk appears in the drawer's autocomplete options", DISK in (d.get("diskOptions") or []))

    # ---- §3 test #4: complete a stage with NO note -> still logged ----
    r = requests.post(f"{APP}/api/entity/production/{prod_id}", cookies=tck,
                      headers={"Content-Type": "application/json"},
                      json={"stage": {"id": stage_id("episode", "record"), "patch": {"status": "done"}}})
    check("#4 tech completes episode/record", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    log, _ = get_log(tck)
    stage_done = [e for e in log if e["kind"] == "stage" and e["step"] == "record" and e["stage_status"] == "done"]
    check("#4 completing a stage is logged even without a note (✓ entry)", len(stage_done) == 1, str(stage_done))
    check("#4 the stage entry carries the acting tech's name", stage_done and stage_done[0]["author"] == MARK)

    # ---- §3 test #3: complete a stage AND add a note ----
    requests.post(f"{APP}/api/entity/production/{prod_id}", cookies=tck,
                  headers={"Content-Type": "application/json"},
                  json={"stage": {"id": stage_id("episode", "edit"), "patch": {"status": "in_progress"}}})
    NOTE = "חתכתי 4 דקות מההתחלה, האורח איחר"
    r = requests.post(f"{APP}/api/productions/{prod_id}/log", cookies=tck,
                      headers={"Content-Type": "application/json"},
                      json={"note": NOTE, "track": "episode", "step": "edit"})
    check("#3 tech adds a completion note", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
    log, _ = get_log(tck)
    note_entries = [e for e in log if e["kind"] == "note" and e["note"] == NOTE]
    check("#3 the note is in the journal with author + timestamp",
          len(note_entries) == 1 and note_entries[0]["author"] == MARK and note_entries[0]["created_at"],
          str(note_entries))
    note_id = note_entries[0]["id"] if note_entries else None

    # ---- edit-own-note within window stamps edited_at ("נערך") ----
    if note_id:
        r = requests.patch(f"{APP}/api/productions/{prod_id}/log", cookies=tck,
                           headers={"Content-Type": "application/json"},
                           json={"log_id": note_id, "note": NOTE + " (עדכון)"})
        check("author can edit own note within 5 min", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        log, _ = get_log(tck)
        edited = [e for e in log if e["id"] == note_id]
        check("edited note is marked (edited_at set)", edited and edited[0]["edited_at"], str(edited))

    # ---- §3 test #5: a client note (as applyResponse writes it) ----
    requests.post(rest("production_log"), headers=ADMIN,
                  json={"production_id": prod_id, "kind": "client", "track": "reels",
                        "note": "תעבירו את הריל השני לדקה 3", "author_id": None})
    log, _ = get_log(tck)
    client_entries = [e for e in log if e["kind"] == "client"]
    check("#5 client note appears in the same journal, author=null (client)",
          len(client_entries) == 1 and client_entries[0]["author"] is None, str(client_entries))

    # ---- §6: global search by disk name finds the production ----
    s = requests.get(f"{APP}/api/search", cookies=tck, params={"q": DISK}).json()
    hit = [p for p in s.get("productions", []) if p["id"] == prod_id]
    check("#6 global search by disk name finds the production", len(hit) == 1, str(s.get("productions")))
    check("#6 search result carries the matched disk", hit and hit[0].get("storage_disk") == DISK)

    # ---- guard: money-only (no edit_stages) may READ but not SET the disk ----
    log_bk, d_bk = get_log(bck)
    check("bookkeeper (view only) can READ the disk", d_bk["entity"].get("storage_disk") == DISK)
    check("bookkeeper can READ the journal", len(log_bk) >= 1)
    r = requests.post(f"{APP}/api/entity/production/{prod_id}", cookies=bck,
                      headers={"Content-Type": "application/json"},
                      json={"patch": {"storage_disk": "HACK-01"}})
    check("bookkeeper CANNOT set the disk (no can_edit_stages)", r.status_code == 403, f"{r.status_code} {r.text[:200]}")
    still = requests.get(rest(f"productions?id=eq.{prod_id}&select=storage_disk"), headers=ADMIN).json()[0]["storage_disk"]
    check("disk unchanged after the blocked attempt", still == DISK, still)

    # ---- log immutability: only the note may change (guard trigger) ----
    if note_id:
        r = requests.patch(rest(f"production_log?id=eq.{note_id}"), headers=REPR, json={"kind": "stage"})
        check("log entry kind is immutable (guard raises)", r.status_code >= 400, f"{r.status_code} {r.text[:120]}")

finally:
    if prod_id:
        requests.delete(rest(f"events?entity_id=eq.{prod_id}"), headers=ADMIN)
        requests.delete(rest(f"productions?id=eq.{prod_id}"), headers=ADMIN)  # cascades stages + production_log
    if show_id:
        requests.delete(rest(f"shows?id=eq.{show_id}"), headers=ADMIN)
    for u in users:
        requests.delete(f"{SUP}/auth/v1/admin/users/{u}", headers=ADMIN)
    print(f"\ncleaned {len(users)} users, production, show")

print(f"\n{'ALL PASS' if not failures else str(len(failures)) + ' FAILED'}")
sys.exit(1 if failures else 0)
