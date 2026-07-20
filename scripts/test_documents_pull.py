# -*- coding: utf-8 -*-
"""
Verify the documents registry + daily pull (gap 4) against REAL Morning.
The pull is read-only against Morning and idempotent locally (upsert on
morning_doc_id), so it is safe with MORNING_DRY_RUN=false — it issues nothing.

It DOES populate the real documents registry (exactly what the nightly cron
does). Those rows are legitimate and are LEFT in place; only the temp test
user is cleaned up.

Proves:
  1. the manual pull runs and returns a summary
  2. it populates `documents`, matching some to our mapped clients
  3. the studio doc #40290 (client = ביזי סטודיו, which is NOT one of our
     clients) lands UNMATCHED (client_id null) — the "לא משויך" case
  4. a second pull is idempotent (no duplicate rows)
  5. the registry screen renders for a money user
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
ref = SUPABASE_URL.split("//")[1].split(".")[0]
CN = f"sb-{ref}-auth-token"
STUDIO_DOC_ID = "a4932e75-dcad-4b32-848c-a25f8bbf760c"  # the 1₪ test doc #40290

failures = []
users = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail else ""))
    if not ok:
        failures.append(label)


def rest(p):
    return f"{SUPABASE_URL}/rest/v1/{p}"


def count(path):
    r = requests.get(rest(f"{path}&limit=1"), headers={**ADMIN, "Prefer": "count=exact"})
    cr = r.headers.get("content-range", "*/0")
    return int(cr.split("/")[-1])


def b64(r):
    return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags):
    em = f"pull-{uuid.uuid4().hex[:8]}@bizi-test.local"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{SUPABASE_URL}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**ADMIN, **REPR},
                   json={"name": "ZTESTPULL user", "approved": True, **flags}).raise_for_status()
    td = requests.post(f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {CN: "base64-" + b64(json.dumps(sess).encode())}


for _ in range(60):
    try:
        if requests.get(APP_URL, timeout=2).status_code < 500:
            break
    except requests.exceptions.ConnectionError:
        pass
    time.sleep(1)
else:
    print("FAIL dev server never came up")
    sys.exit(1)

try:
    money = mkuser({"role": "bookkeeper", "can_view_money": True, "can_edit_money": True})

    # 1. run the pull
    r = requests.post(f"{APP_URL}/api/documents/sync", cookies=money, timeout=240)
    body = r.json()
    check("1. pull ran", r.status_code == 200 and body.get("ok"), r.text[:200])
    print(f"      summary: {json.dumps(body, ensure_ascii=False)}")

    total = count("documents?select=id")
    matched = count("documents?select=id&client_id=not.is.null")
    unmatched = count("documents?select=id&client_id=is.null")
    check("2a. registry populated", total >= 1, f"total={total}")
    check("2b. some documents matched to our clients", matched >= 1, f"matched={matched}")
    print(f"      documents: total={total} matched={matched} unmatched={unmatched}")

    # 3. the studio doc is unmatched (ביזי סטודיו isn't one of our clients)
    studio = requests.get(rest(f"documents?morning_doc_id=eq.{STUDIO_DOC_ID}&select=client_id,type,morning_client_name,source"),
                          headers=ADMIN).json()
    if studio:
        check("3a. studio test doc is in the registry", True)
        check("3b. and it is UNMATCHED (client_id null)", studio[0]["client_id"] is None,
              str(studio[0]["client_id"]))
        check("3c. its Morning client name is kept", bool(studio[0]["morning_client_name"]),
              str(studio[0].get("morning_client_name")))
    else:
        # only fails if the doc fell outside the pull window; report, don't hard-fail matching
        check("3a. studio test doc is in the registry", False, "not found — outside pull window?")

    # 4. idempotency
    r2 = requests.post(f"{APP_URL}/api/documents/sync", cookies=money, timeout=240)
    total2 = count("documents?select=id")
    check("4. second pull did not duplicate", total2 == total, f"{total} -> {total2}")
    check("4b. second pull reports 0 inserted", r2.json().get("inserted") == 0, json.dumps(r2.json())[:150])

    # 5. registry screen renders
    html = requests.get(f"{APP_URL}/documents/registry", cookies=money).text
    check("5. registry screen renders", "מסמכים" in html and ("חשבוניות מס" in html or "לא משויך" in html))

finally:
    print("\n--- cleanup (temp user only; real registry rows are kept) ---")
    for uid in users:
        requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=ADMIN)
        requests.delete(f"{SUPABASE_URL}/auth/v1/admin/users/{uid}", headers=ADMIN)
    left = requests.get(rest("profiles?name=like.*ZTESTPULL*&select=id"), headers=ADMIN).json()
    check("cleanup: temp user removed", left == [], json.dumps(left)[:120])

    print()
    if failures:
        print(f"{len(failures)} FAILED: " + " · ".join(failures))
        sys.exit(1)
    print("all checks passed")
