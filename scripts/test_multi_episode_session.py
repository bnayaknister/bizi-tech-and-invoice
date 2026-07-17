# -*- coding: utf-8 -*-
"""
Acceptance test for the multi-episode session feature (migration 0019):

  Scenario A — calendar duplicate detection:
    two calendar events, same show, same day, different times/guests
    ("ZTEST_SFI יוסי" 10:00, "ZTEST_SFI דנה" 14:00) -> POST /api/calendar/sync
    (test icsText) -> expect 2 productions, distinct calendar_uid,
    record_time/guest extracted correctly. Then a technician "confirm"
    action on the duplicate-group route silences it (calendar_dup_ack=true
    on both).

  Scenario B — manual split:
    one production -> POST /api/productions/<id>/split {count:3} -> expect
    3 productions sharing one calendar_uid, split_index 1/2/3 of 3 -> then
    DELETE the same route (undo) -> expect the 2 created siblings soft-
    hidden (merged_into) and the original's split_index/split_count reset.

  Scenario C — merge a calendar duplicate away, then undo:
    another two calendar events, same show/day -> POST duplicate-group
    {action:"merge"} -> expect the newer row soft-hidden (merged_into =
    survivor) -> DELETE duplicate-group on the merged-away id (undo) ->
    expect merged_into reset to null.

Runs against the real dev server (so the actual route code — guest
extraction, sibling-uid expansion, RLS, the 0019 guard trigger — is what's
being exercised, not a reimplementation of it) plus a throwaway show and a
throwaway technician user. Cleans up everything it created.
"""
import base64
import json
import os
import sys
import time
import uuid

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
ANON_KEY = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP_URL = os.environ.get("TEST_APP_URL", "http://localhost:3000")

ADMIN = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"}
REPR = {"Prefer": "return=representation"}

failures = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        failures.append(label)


def rest(path):
    return f"{SUPABASE_URL}/rest/v1/{path}"


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


# ---- wait for the dev server ----
for _ in range(60):
    try:
        r = requests.get(APP_URL, timeout=2)
        if r.status_code < 500:
            break
    except requests.exceptions.ConnectionError:
        pass
    time.sleep(1)
else:
    print("FAIL  dev server never came up at", APP_URL)
    sys.exit(1)

ref = SUPABASE_URL.split("//")[1].split(".")[0]
cookie_name = f"sb-{ref}-auth-token"

email = f"split-test-{uuid.uuid4().hex[:8]}@bizi-test.local"
password = f"Test-{uuid.uuid4().hex}!A1"

r = requests.post(f"{SUPABASE_URL}/auth/v1/admin/users", headers=ADMIN,
                   json={"email": email, "password": password, "email_confirm": True})
r.raise_for_status()
user_id = r.json()["id"]
print("created test technician:", email)

show_id = None
production_ids = []

try:
    r = requests.patch(f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}", headers={**ADMIN, **REPR},
                        json={"name": "בדיקת פיצול הפקות", "role": "tech", "approved": True,
                              "can_view_stages": True, "can_edit_stages": True})
    r.raise_for_status()

    r = requests.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
                       json={"email": email, "password": password})
    r.raise_for_status()
    token_data = r.json()

    session = {
        "access_token": token_data["access_token"],
        "token_type": token_data.get("token_type", "bearer"),
        "expires_in": token_data.get("expires_in", 3600),
        "expires_at": int(time.time()) + token_data.get("expires_in", 3600),
        "refresh_token": token_data["refresh_token"],
        "user": token_data["user"],
    }
    cookie_value = "base64-" + b64url(json.dumps(session).encode())
    cookies = {cookie_name: cookie_value}

    # throwaway show with a distinctive alias so it never collides with real data
    r = requests.post(rest("shows"), headers={**ADMIN, **REPR},
                       json={"name": "ZTEST show", "aliases": ["ZTEST_SFI"], "active": True,
                             "billing_mode": "per_episode"})
    r.raise_for_status()
    show_id = r.json()[0]["id"]
    print("created test show:", show_id)

    # ---- Scenario A: two calendar events, same show, same day ----
    today = time.strftime("%Y%m%d", time.localtime())
    uid1, uid2 = f"ztest-{uuid.uuid4().hex}@bizi", f"ztest-{uuid.uuid4().hex}@bizi"
    ics = f"""BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:{uid1}
DTSTART;TZID=Asia/Jerusalem:{today}T100000
DTEND;TZID=Asia/Jerusalem:{today}T110000
SUMMARY:ZTEST_SFI יוסי
END:VEVENT
BEGIN:VEVENT
UID:{uid2}
DTSTART;TZID=Asia/Jerusalem:{today}T140000
DTEND;TZID=Asia/Jerusalem:{today}T150000
SUMMARY:ZTEST_SFI דנה
END:VEVENT
END:VCALENDAR
"""
    r = requests.post(f"{APP_URL}/api/calendar/sync", cookies=cookies, headers={"Content-Type": "application/json"},
                       json={"icsText": ics})
    ok = r.status_code == 200
    body = r.json() if ok else {"error": r.text}
    check("A1. fake-ICS sync accepted", ok, str(body))
    check("A2. sync created exactly 2 productions", body.get("created") == 2, str(body))

    r = requests.get(rest("productions"), headers=ADMIN,
                      params={"select": "id,record_time,guest,calendar_uid,calendar_dup_ack,record_date",
                              "show_id": f"eq.{show_id}"})
    rows = r.json()
    production_ids.extend(row["id"] for row in rows)
    by_guest = {row["guest"]: row for row in rows}
    check("A3. two distinct rows", len(rows) == 2, str(rows))
    check("A4. יוסי at 10:00", by_guest.get("יוסי", {}).get("record_time") == "10:00", str(rows))
    check("A5. דנה at 14:00", by_guest.get("דנה", {}).get("record_time") == "14:00", str(rows))
    check("A6. distinct calendar_uid (never auto-merged)",
          len({row["calendar_uid"] for row in rows}) == 2, str(rows))
    check("A7. not yet acknowledged", all(not row["calendar_dup_ack"] for row in rows), str(rows))

    if rows:
        r = requests.post(f"{APP_URL}/api/productions/{rows[0]['id']}/duplicate-group", cookies=cookies,
                           headers={"Content-Type": "application/json"}, json={"action": "confirm"})
        check("A8. technician 'confirm N episodes' accepted", r.status_code == 200, r.text)
        r = requests.get(rest("productions"), headers=ADMIN,
                          params={"select": "id,calendar_dup_ack", "show_id": f"eq.{show_id}"})
        check("A9. both rows now acknowledged (badge silenced)",
              all(row["calendar_dup_ack"] for row in r.json()), str(r.json()))

    # ---- Scenario B: manual split of one production into 3 ----
    r = requests.post(rest("productions"), headers={**ADMIN, **REPR},
                       json={"podcast_name": "ZTEST show", "show_id": show_id, "kind": "internal",
                             "record_date": time.strftime("%Y-%m-%d"), "record_time": "09:00", "legacy": False})
    r.raise_for_status()
    original_id = r.json()[0]["id"]
    production_ids.append(original_id)

    r = requests.post(f"{APP_URL}/api/productions/{original_id}/split", cookies=cookies,
                       headers={"Content-Type": "application/json"}, json={"count": 3})
    ok = r.status_code == 200
    body = r.json() if ok else {"error": r.text}
    check("B1. split into 3 accepted", ok, str(body))
    created_ids = body.get("created", [])
    production_ids.extend(created_ids)
    check("B2. split created 2 new productions", len(created_ids) == 2, str(body))

    r = requests.get(rest("productions"), headers=ADMIN,
                      params={"select": "id,split_index,split_count,calendar_uid",
                              "id": f"in.({','.join([original_id] + created_ids)})"})
    family = r.json()
    check("B3. all 3 share one calendar_uid", len({f["calendar_uid"] for f in family}) == 1, str(family))
    check("B4. split_count=3 on all 3", all(f["split_count"] == 3 for f in family), str(family))
    check("B5. split_index is exactly {1,2,3}",
          sorted(f["split_index"] for f in family) == [1, 2, 3], str(family))

    r = requests.get(rest("stages"), headers=ADMIN,
                      params={"select": "id", "production_id": f"in.({','.join([original_id] + created_ids)})"})
    check("B6. each of the 3 got its own 6 stages (18 total)", len(r.json()) == 18, f"got {len(r.json())}")

    r = requests.delete(f"{APP_URL}/api/productions/{original_id}/split", cookies=cookies)
    check("B7. undo split accepted (no work started yet)", r.status_code == 200, r.text)

    r = requests.get(rest("productions"), headers=ADMIN,
                      params={"select": "id,split_index,split_count,merged_into",
                              "id": f"in.({','.join([original_id] + created_ids)})"})
    after_undo = {row["id"]: row for row in r.json()}
    check("B8. original's split_index/count reset to null",
          after_undo[original_id]["split_index"] is None and after_undo[original_id]["split_count"] is None,
          str(after_undo))
    check("B9. the 2 created siblings are soft-hidden (merged_into = original)",
          all(after_undo[cid]["merged_into"] == original_id for cid in created_ids), str(after_undo))

    # ---- Scenario C: merge a calendar duplicate away, then undo the merge ----
    uid3, uid4 = f"ztest-{uuid.uuid4().hex}@bizi", f"ztest-{uuid.uuid4().hex}@bizi"
    ics_c = f"""BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:{uid3}
DTSTART;TZID=Asia/Jerusalem:{today}T110000
DTEND;TZID=Asia/Jerusalem:{today}T120000
SUMMARY:ZTEST_SFI מרים
END:VEVENT
BEGIN:VEVENT
UID:{uid4}
DTSTART;TZID=Asia/Jerusalem:{today}T160000
DTEND;TZID=Asia/Jerusalem:{today}T170000
SUMMARY:ZTEST_SFI רועי
END:VEVENT
END:VCALENDAR
"""
    r = requests.post(f"{APP_URL}/api/calendar/sync", cookies=cookies, headers={"Content-Type": "application/json"},
                       json={"icsText": ics_c})
    ok = r.status_code == 200
    body = r.json() if ok else {"error": r.text}
    check("C1. second fake-ICS sync accepted", ok, str(body))
    check("C2. sync created exactly 2 more productions", body.get("created") == 2, str(body))

    r = requests.get(rest("productions"), headers=ADMIN,
                      params={"select": "id,guest,created_at", "show_id": f"eq.{show_id}",
                              "guest": "in.(מרים,רועי)"})
    pair = r.json()
    production_ids.extend(row["id"] for row in pair)
    check("C3. two distinct rows for the merge pair", len(pair) == 2, str(pair))

    if len(pair) == 2:
        r = requests.post(f"{APP_URL}/api/productions/{pair[0]['id']}/duplicate-group", cookies=cookies,
                           headers={"Content-Type": "application/json"}, json={"action": "merge"})
        ok = r.status_code == 200
        merge_body = r.json() if ok else {"error": r.text}
        check("C4. technician 'merge to 1' accepted", ok, str(merge_body))
        survivor_id = merge_body.get("survivor")
        removed = merge_body.get("removed", [])
        check("C5. exactly one row removed, one survivor", len(removed) == 1 and survivor_id, str(merge_body))

        r = requests.get(rest("productions"), headers=ADMIN,
                          params={"select": "id,merged_into", "id": f"in.({','.join(p['id'] for p in pair)})"})
        after_merge = {row["id"]: row for row in r.json()}
        check("C6. merged-away row points at the survivor",
              removed and after_merge.get(removed[0], {}).get("merged_into") == survivor_id, str(after_merge))
        check("C7. survivor itself is not merged away",
              survivor_id and after_merge.get(survivor_id, {}).get("merged_into") is None, str(after_merge))

        if removed:
            r = requests.delete(f"{APP_URL}/api/productions/{removed[0]}/duplicate-group", cookies=cookies)
            check("C8. undo merge accepted (no work started yet)", r.status_code == 200, r.text)
            r = requests.get(rest("productions"), headers=ADMIN,
                              params={"select": "id,merged_into", "id": f"eq.{removed[0]}"})
            restored = r.json()
            check("C9. merged_into reset to null after undo",
                  bool(restored) and restored[0]["merged_into"] is None, str(restored))

finally:
    if production_ids:
        requests.delete(rest("productions"), headers=ADMIN,
                         params={"id": f"in.({','.join(production_ids)})"})
    if show_id:
        requests.delete(rest("shows"), headers=ADMIN, params={"id": f"eq.{show_id}"})
    requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}", headers=ADMIN)
    print("cleaned up test show, productions and technician user")

print()
if failures:
    print(f"{len(failures)} FAILURE(S):")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("ALL PASS")
