# -*- coding: utf-8 -*-
"""
E2E for the item-mode review path (stage 1b, 2026-08-17).

Scenario: a production with an episode + 2 reels, one scope=all link, then a
SINGLE submit that approves reel 1 and asks for revisions on reel 2 — the
per-item granularity stage 1b introduced. Then a second round approving the
rest, which must fire the deal-invoice chain exactly once.

Round 1 asserts:
  - client_review_items: reel 1 approved=true with approved_at; reel 2
    approved=false with last_note carrying the client's note
  - the production did NOT flip to אושר_ע"י_לקוח; review_reels_approved=false;
    NO deal invoice queued
Round 2 (approve episode + reel 2) asserts:
  - approvedAll: status flipped to אושר_ע"י_לקוח, both flags true
  - a deal invoice IS queued
  - reel 2's last_note reset to null on approval (B3)
  - reel 1 untouched (still approved)

Cleanup deletes client_review_items BEFORE the production (0057 FK).
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
MARK = "ZTESTITEMS"

failures = []; users = []; show_id = None; production_id = None; client_id = None


def check(l, ok, d=""):
    print(("PASS  " if ok else "FAIL  ") + l + (f"  [{d}]" if d and not ok else ""))
    if not ok: failures.append(l)


def rest(p): return f"{SUP}/rest/v1/{p}"
def b64(r): return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags):
    em = f"itm-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
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


def get_items():
    r = requests.get(rest(f"client_review_items?production_id=eq.{production_id}"
                          "&select=id,kind,reel_index,approved,approved_at,last_note&order=kind,reel_index"),
                     headers=ADMIN).json()
    return {("episode" if x["kind"] == "episode" else f"reel{x['reel_index']}"): x for x in r}


def get_prod():
    return requests.get(rest(f"productions?id=eq.{production_id}"
                             "&select=status,review_episode_approved,review_reels_approved"),
                        headers=ADMIN).json()[0]


def deal_invoices():
    return requests.get(rest(f"pending_documents?production_id=eq.{production_id}"
                             "&doc_type=eq.deal_invoice&select=id,status"), headers=ADMIN).json()


try:
    tech = mkuser({"role": "tech", "can_view_stages": True, "can_edit_stages": True})
    client_id = requests.post(rest("clients"), headers=REPR,
                              json={"name": f"{MARK} client", "normalized_name": f"zti{uuid.uuid4().hex[:6]}",
                                    "morning_client_id": f"zti-m-{uuid.uuid4().hex[:8]}"}).json()[0]["id"]
    show_id = requests.post(rest("shows"), headers=REPR,
                            json={"name": f"{MARK} show", "client_id": client_id,
                                  "billing_mode": "per_episode", "default_rate": 1000, "active": True}).json()[0]["id"]
    # episode + 2 reels is the default composition (has_episode=true, reels_count=2)
    production_id = requests.post(rest("productions"), headers=REPR,
                                  json={"podcast_name": f"{MARK} show", "show_id": show_id, "client_id": client_id,
                                        "kind": "client", "record_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                                        "status": "נשלח_ללקוח", "legacy": False}).json()[0]["id"]

    # ---- round 1: mint scope=all, items get seeded ----
    r = requests.post(f"{APP}/api/productions/{production_id}/review-link", cookies=tech,
                      headers={"Content-Type": "application/json"},
                      json={"scope": "all", "episode_link": "https://drive.google.com/file/d/zzEp/view",
                            "reels_link": "https://drive.google.com/file/d/zzRe/view"})
    check("1a. round-1 link minted", r.status_code == 200 and r.json().get("url"), r.text[:150])
    token1 = r.json()["url"].rsplit("/", 1)[-1]

    items = get_items()
    check("1b. items seeded: episode + reel1 + reel2",
          set(items) == {"episode", "reel1", "reel2"}, str(set(items)))

    # ---- ONE submit: approve reel 1, revisions on reel 2 (episode unanswered) ----
    note2 = "לקצר את הפתיח של ריל 2"
    r = requests.post(f"{APP}/api/r/{token1}/respond", headers={"Content-Type": "application/json"},
                      json={"items": {items["reel1"]["id"]: {"response": "approved"},
                                      items["reel2"]["id"]: {"response": "revisions", "note": note2}}})
    check("2a. mixed per-item response accepted", r.status_code == 200, r.text[:150])
    check("2b. response says NOT approved_all", r.json().get("approved_all") is False, r.text[:100])

    items = get_items()
    check("2c. reel1 approved=true with approved_at",
          items["reel1"]["approved"] is True and items["reel1"]["approved_at"], json.dumps(items["reel1"]))
    check("2d. reel2 approved=false, last_note carries the note",
          items["reel2"]["approved"] is False and note2 in (items["reel2"]["last_note"] or ""),
          json.dumps(items["reel2"], ensure_ascii=False))
    check("2e. episode still pending", items["episode"]["approved"] is False)

    prod = get_prod()
    check("2f. production NOT client-approved", prod["status"] != 'אושר_ע"י_לקוח', prod["status"])
    check("2g. review_reels_approved=false", prod["review_reels_approved"] is False)
    check("2h. no deal invoice queued", deal_invoices() == [], json.dumps(deal_invoices()))

    # ---- round 2: new link, approve episode + reel 2 ----
    r = requests.post(f"{APP}/api/productions/{production_id}/review-link", cookies=tech,
                      headers={"Content-Type": "application/json"}, json={"scope": "all"})
    check("3a. round-2 link minted", r.status_code == 200, r.text[:120])
    token2 = r.json()["url"].rsplit("/", 1)[-1]
    time.sleep(1.1)  # per-token throttle is 1s; be kind to the shared process map

    r = requests.post(f"{APP}/api/r/{token2}/respond", headers={"Content-Type": "application/json"},
                      json={"items": {items["episode"]["id"]: {"response": "approved"},
                                      items["reel2"]["id"]: {"response": "approved"}}})
    check("3b. round-2 approval accepted", r.status_code == 200, r.text[:150])
    check("3c. response says approved_all", r.json().get("approved_all") is True, r.text[:100])

    items = get_items()
    prod = get_prod()
    check("3d. production flipped to אושר_ע\"י_לקוח", prod["status"] == 'אושר_ע"י_לקוח', prod["status"])
    check("3e. both flags true",
          prod["review_episode_approved"] is True and prod["review_reels_approved"] is True, json.dumps(prod, ensure_ascii=False))
    di = deal_invoices()
    check("3f. deal invoice queued exactly once", len(di) == 1, json.dumps(di))
    check("3g. reel2 last_note reset on approval (B3)",
          items["reel2"]["approved"] is True and items["reel2"]["last_note"] is None,
          json.dumps(items["reel2"], ensure_ascii=False))
    check("3h. reel1 untouched (still approved)", items["reel1"]["approved"] is True)

finally:
    print("\n--- cleanup ---")
    if production_id:
        # jobs the approval trigger created — unlink and remove
        jp = requests.get(rest(f"job_productions?production_id=eq.{production_id}&select=job_id"), headers=ADMIN).json()
        requests.delete(rest(f"pending_documents?production_id=eq.{production_id}"), headers=ADMIN)
        requests.delete(rest(f"job_productions?production_id=eq.{production_id}"), headers=ADMIN)
        for j in jp:
            requests.delete(rest(f"jobs?id=eq.{j['job_id']}"), headers=ADMIN)
        # 0057: items carry an FK to the production — delete them FIRST
        requests.delete(rest(f"client_review_items?production_id=eq.{production_id}"), headers=ADMIN)
        requests.delete(rest(f"client_review_links?production_id=eq.{production_id}"), headers=ADMIN)
        requests.delete(rest(f"production_log?production_id=eq.{production_id}"), headers=ADMIN)
        requests.delete(rest(f"stages?production_id=eq.{production_id}"), headers=ADMIN)
        requests.delete(rest(f"productions?id=eq.{production_id}"), headers=ADMIN)
    if show_id: requests.delete(rest(f"shows?id=eq.{show_id}"), headers=ADMIN)
    if client_id: requests.delete(rest(f"clients?id=eq.{client_id}"), headers=ADMIN)
    for uid in users:
        requests.delete(rest(f"events?actor_id=eq.{uid}"), headers=ADMIN)
        requests.delete(rest(f"profiles?id=eq.{uid}"), headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{uid}", headers=ADMIN)
    left = requests.get(rest(f"productions?podcast_name=like.{MARK}*&select=id"), headers=ADMIN).json()
    left_items = requests.get(rest("client_review_items?select=id,production_id&limit=500"), headers=ADMIN).json()
    stray = [x for x in left_items if x["production_id"] == production_id] if production_id else []
    check("cleanup: no test productions left", left == [], json.dumps(left)[:80])
    check("cleanup: no test review items left", stray == [], json.dumps(stray)[:80])

print()
if failures:
    print(f"{len(failures)} FAILED: " + " · ".join(failures)); sys.exit(1)
print("ALL PASS")
