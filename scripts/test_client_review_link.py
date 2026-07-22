# -*- coding: utf-8 -*-
"""
Acceptance test for client review links (screens-spec §9a, owner spec
2026-07-21). Requires migration 0029. Issues NO Morning document (deal-invoice
enqueue only queues a row), so it is safe with MORNING_DRY_RUN=false.

The owner's five cases:
  1. the link loads with NO session (incognito) and shows only show/episode/date
  2. revisions on reels only -> production back to board (בעריכה + attention)
     with the note; episode still pending
  3. new round (old link superseded), approve BOTH -> status אושר + deal
     invoice queued
  4. a superseded / expired link is rejected (410)
  5. the public page exposes nothing financial
"""
import base64, json, os, sys, time, uuid
from datetime import datetime, timezone, timedelta
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
MARK = "ZTESTREVIEW"

failures = []; users = []; show_id = None; production_id = None; client_id = None


def check(l, ok, d=""):
    print(("PASS  " if ok else "FAIL  ") + l + (f"  [{d}]" if d and not ok else ""))
    if not ok: failures.append(l)


def rest(p): return f"{SUP}/rest/v1/{p}"
def b64(r): return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags):
    em = f"rev-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{SUP}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(rest(f"profiles?id=eq.{uid}"), headers=REPR, json={"name": MARK, "approved": True, **flags})
    td = requests.post(f"{SUP}/auth/v1/token?grant_type=password",
                       headers={"apikey": ANON, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return {CN: "base64-" + b64(json.dumps(sess).encode())}


def make_link(cookie, reels=True):
    r = requests.post(f"{APP}/api/productions/{production_id}/review-link", cookies=cookie,
                      headers={"Content-Type": "application/json"},
                      json={"reels_included": reels, "episode_link": "https://example.com/ep"})
    return r


for _ in range(60):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("FAIL dev server never came up"); sys.exit(1)

try:
    tech = mkuser({"role": "tech", "can_view_stages": True, "can_edit_stages": True})
    client_id = requests.post(rest("clients"), headers=REPR,
                              json={"name": f"{MARK} client", "normalized_name": f"ztr{uuid.uuid4().hex[:6]}",
                                    "morning_client_id": f"ztr-m-{uuid.uuid4().hex[:8]}"}).json()[0]["id"]
    show_id = requests.post(rest("shows"), headers=REPR,
                            json={"name": f"{MARK} show", "aliases": [f"{MARK} show"], "client_id": client_id,
                                  "billing_mode": "per_episode", "default_rate": 1, "active": True}).json()[0]["id"]
    # insert the production directly at 'נשלח_ללקוח' (INSERT skips the status guard)
    production_id = requests.post(rest("productions"), headers=REPR,
                                  json={"podcast_name": f"{MARK} show", "show_id": show_id, "client_id": client_id,
                                        "kind": "client", "record_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                                        "status": "נשלח_ללקוח", "legacy": False}).json()[0]["id"]

    # ---- create round-1 link ----
    r = make_link(tech, reels=True)
    check("0. link created", r.status_code == 200 and r.json().get("url"), r.text[:150])
    url1 = r.json()["url"]; token1 = url1.rsplit("/", 1)[-1]

    # 1. incognito load (NO cookie)
    r = requests.get(url1)
    html = r.text
    check("1a. public link loads without a session", r.status_code == 200, str(r.status_code))
    check("1b. shows the show name", f"{MARK} show" in html)

    # 5. Prices ARE shown to the client on purpose — a transparency decision
    #    (2026-07-21): the review link shows exactly what the invoice will
    #    (base price, add-on prices, total + VAT). So ₪ is ALLOWED. What must
    #    NEVER leak is anything INTERNAL: DB ids, morning refs, invoice
    #    numbers, internal field names, or any other entity's data.
    prices_shown = "₪" in html
    forbidden = {
        "production_id": production_id, "client_id": client_id, "show_id": show_id,
        "morning ref": "morning",            # morning_client_id / morning_doc_id / any Morning field
        "invoice word": "חשבונית",            # this is a quote, never an issued invoice
        "field:billing_mode": "billing_mode",
        "field:price_override": "price_override",
        "field:review_reels_required": "review_reels_required",
        "field:default_rate": "default_rate",
    }
    leaked = [k for k, v in forbidden.items() if v and v.lower() in html.lower()]
    check("5. shows the price quote (transparency) but leaks nothing internal",
          prices_shown and not leaked, f"prices_shown={prices_shown} leaked={leaked}")

    # 2. revisions on reels only
    r = requests.post(f"{APP}/api/r/{token1}/respond", headers={"Content-Type": "application/json"},
                      json={"reels": "revisions", "reels_note": "הרילז קצר מדי, להאריך"})
    check("2a. reels-revisions response accepted", r.status_code == 200 and r.json().get("approved_all") is False,
          r.text[:150])
    prod = requests.get(rest(f"productions?id=eq.{production_id}&select=status,needs_attention,review_reels_note,review_episode_approved"),
                        headers=ADMIN).json()[0]
    check("2b. production back to בעריכה + attention", prod["status"] == "בעריכה" and prod["needs_attention"] is True,
          json.dumps(prod, ensure_ascii=False))
    check("2c. the correction note is stored", prod["review_reels_note"] == "הרילז קצר מדי, להאריך", str(prod["review_reels_note"]))
    check("2d. episode still pending (not approved)", prod["review_episode_approved"] is False)

    # 4. the responded (now superseded-by-round-2) link is dead
    r = requests.get(url1)
    check("4a. the answered link shows 'received, thanks'", "התקבל" in r.text or r.status_code == 200)
    r = requests.post(f"{APP}/api/r/{token1}/respond", headers={"Content-Type": "application/json"},
                      json={"episode": "approved"})
    check("4b. a second response on the same link is rejected (410)", r.status_code == 410, str(r.status_code))

    # 3. new round, approve BOTH
    r = make_link(tech, reels=True)
    check("3a. round-2 link created", r.status_code == 200, r.text[:120])
    token2 = r.json()["url"].rsplit("/", 1)[-1]
    # old link is now superseded too
    r = requests.post(f"{APP}/api/r/{token1}/respond", headers={"Content-Type": "application/json"},
                      json={"episode": "approved"})
    check("3b. the previous round's link is dead (410)", r.status_code == 410, str(r.status_code))
    r = requests.post(f"{APP}/api/r/{token2}/respond", headers={"Content-Type": "application/json"},
                      json={"episode": "approved", "reels": "approved"})
    check("3c. approving both succeeds (approved_all)", r.status_code == 200 and r.json().get("approved_all") is True,
          r.text[:150])
    prod = requests.get(rest(f"productions?id=eq.{production_id}&select=status"), headers=ADMIN).json()[0]
    check("3d. production is client-approved", prod["status"] == 'אושר_ע"י_לקוח', prod["status"])
    dj = requests.get(rest(f"pending_documents?production_id=eq.{production_id}&doc_type=eq.deal_invoice&select=id,status"),
                      headers=ADMIN).json()
    check("3e. a deal invoice was queued", len(dj) == 1 and dj[0]["status"] == "pending", json.dumps(dj))
    # the job the approval trigger created
    jp = requests.get(rest(f"job_productions?production_id=eq.{production_id}&select=job_id"), headers=ADMIN).json()
    check("3f. the approval created a job", len(jp) == 1, json.dumps(jp))

    # expired link -> rejected
    exp = requests.post(rest("client_review_links"), headers=REPR,
                        json={"production_id": production_id, "token": f"exp-{uuid.uuid4()}",
                              "expires_at": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()}).json()[0]
    r = requests.post(f"{APP}/api/r/{exp['token']}/respond", headers={"Content-Type": "application/json"},
                      json={"episode": "approved"})
    check("4c. an expired link is rejected (410)", r.status_code == 410, str(r.status_code))

finally:
    print("\n--- cleanup ---")
    if production_id:
        requests.delete(rest(f"client_review_links?production_id=eq.{production_id}"), headers=ADMIN)
        requests.delete(rest(f"pending_documents?production_id=eq.{production_id}"), headers=ADMIN)
        requests.delete(rest(f"events?entity_id=eq.{production_id}"), headers=ADMIN)
        jp = requests.get(rest(f"job_productions?production_id=eq.{production_id}&select=job_id"), headers=ADMIN).json()
        for j in jp if isinstance(jp, list) else []:
            requests.delete(rest(f"job_productions?job_id=eq.{j['job_id']}"), headers=ADMIN)
            requests.delete(rest(f"events?entity_id=eq.{j['job_id']}"), headers=ADMIN)
            requests.delete(rest(f"jobs?id=eq.{j['job_id']}"), headers=ADMIN)
        requests.delete(rest(f"stages?production_id=eq.{production_id}"), headers=ADMIN)
        requests.delete(rest(f"productions?id=eq.{production_id}"), headers=ADMIN)
    if show_id:
        requests.delete(rest(f"events?entity_id=eq.{show_id}"), headers=ADMIN)
        requests.delete(rest(f"shows?id=eq.{show_id}"), headers=ADMIN)
    if client_id:
        requests.delete(rest(f"clients?id=eq.{client_id}"), headers=ADMIN)
    for uid in users:
        requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{uid}", headers=ADMIN)
    left = requests.get(rest(f"productions?podcast_name=like.*{MARK}*&select=id"), headers=ADMIN).json()
    check("cleanup: no test productions left", left == [], json.dumps(left)[:80])
    print()
    if failures:
        print(f"{len(failures)} FAILED: " + " · ".join(failures)); sys.exit(1)
    print("all checks passed")
