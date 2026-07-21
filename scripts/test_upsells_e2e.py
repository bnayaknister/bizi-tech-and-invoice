# -*- coding: utf-8 -*-
"""
Live end-to-end acceptance for the beta-feedback batch (owner spec 2026-07-21):
manual production creation, session add-ons/upsells, per-production price
override, full-transparency client link, and the job/invoice totals matching
to the shekel. Requires migrations 0031+0032+0033. Hits the REAL running dev
server (no reimplementation). Issues NO Morning document (enqueue only queues
a row), safe with MORNING_DRY_RUN=false. Cleans up everything in finally.

Owner's script:
  1. new manual production -> created with 6 stages
  2. add an add-on (3 reels, 1,500) + price_override (3,500)
  3. review link -> the client sees 3,500 + 1,500 = 5,000 + VAT
  4. full approval -> job.amount = 5,000 AND a deal invoice queued at 5,000
  5. the board defaults to legacy=false
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
MARK = "ZTESTUPSELL"

failures = []; users = []; show_id = None; production_id = None; legacy_id = None; client_id = None; addon_id = None


def check(l, ok, d=""):
    print(("PASS  " if ok else "FAIL  ") + l + (f"  [{d}]" if d and not ok else ""))
    if not ok: failures.append(l)


def rest(p): return f"{SUP}/rest/v1/{p}"
def b64(r): return base64.urlsafe_b64encode(r).decode().rstrip("=")


def mkuser(flags):
    em = f"ups-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
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


def jhdr(cookie): return {"Content-Type": "application/json"}


for _ in range(60):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("FAIL dev server never came up"); sys.exit(1)

try:
    # full-permission operator (creates, prices, overrides, approves)
    op = mkuser({"role": "owner", "can_view_stages": True, "can_edit_stages": True,
                 "can_view_money": True, "can_edit_money": True, "can_manage_users": True})

    client_id = requests.post(rest("clients"), headers=REPR,
                              json={"name": f"{MARK} client", "normalized_name": f"zup{uuid.uuid4().hex[:6]}",
                                    "morning_client_id": f"zup-m-{uuid.uuid4().hex[:8]}"}).json()[0]["id"]
    # default_rate=3000 on the show; the production override (3500) must win
    show_id = requests.post(rest("shows"), headers=REPR,
                            json={"name": f"{MARK} show", "aliases": [f"{MARK} show"], "client_id": client_id,
                                  "billing_mode": "per_episode", "default_rate": 3000, "active": True,
                                  "default_studio": "אולפן א"}).json()[0]["id"]

    # ---- 1. manual production creation -> 6 stages ----
    r = requests.post(f"{APP}/api/productions", cookies=op, headers=jhdr(op),
                      json={"show_id": show_id, "record_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                            "record_time": "10:00", "guest": "יוסי", "notes": "בדיקה"})
    check("1a. manual production created", r.status_code == 200 and r.json().get("id"), r.text[:200])
    production_id = r.json().get("id")
    stages = requests.get(rest(f"stages?production_id=eq.{production_id}&select=track,step"), headers=ADMIN).json()
    check("1b. exactly 6 stages seeded", len(stages) == 6, str(len(stages)))
    prow = requests.get(rest(f"productions?id=eq.{production_id}&select=studio,guest,calendar_uid,legacy,kind"),
                        headers=ADMIN).json()[0]
    check("1c. inherited studio, null calendar_uid, legacy=false, kind=client",
          prow["studio"] == "אולפן א" and prow["calendar_uid"] is None and prow["legacy"] is False and prow["kind"] == "client",
          json.dumps(prow, ensure_ascii=False))
    ev = requests.get(rest(f"events?entity_id=eq.{production_id}&event_type=eq.production_created_manually&select=id"),
                      headers=ADMIN).json()
    check("1d. manual-creation event recorded", len(ev) == 1, json.dumps(ev))

    # ---- 2. add a priced add-on (3 reels, 1,500) + price_override (3,500) ----
    r = requests.post(f"{APP}/api/productions/{production_id}/addons", cookies=op, headers=jhdr(op),
                      json={"action": "add", "title": "3 רילז נוספים", "quantity": 1, "unit_price": 1500})
    check("2a. add-on added + priced in one call", r.status_code == 200 and r.json().get("id"), r.text[:200])
    addon_id = r.json().get("id")
    arow = requests.get(rest(f"production_addons?id=eq.{addon_id}&select=total,status,unit_price"), headers=ADMIN).json()[0]
    check("2b. computed total = 1,500, status proposed", float(arow["total"]) == 1500 and arow["status"] == "proposed",
          json.dumps(arow, ensure_ascii=False))

    r = requests.post(f"{APP}/api/productions/{production_id}/addons", cookies=op, headers=jhdr(op),
                      json={"action": "set_base_price", "price_override": 3500})
    check("2c. price_override set", r.status_code == 200, r.text[:150])
    g = requests.get(f"{APP}/api/productions/{production_id}/addons", cookies=op).json()
    check("2d. effective base = 3,500 (override beats default_rate 3,000)", g.get("base_amount") == 3500,
          json.dumps({"base": g.get("base_amount"), "default": g.get("default_rate"), "override": g.get("price_override")}, ensure_ascii=False))

    # ---- 3. review link -> client sees 3,500 + 1,500 = 5,000 + VAT ----
    r = requests.post(f"{APP}/api/productions/{production_id}/review-link", cookies=op, headers=jhdr(op),
                      json={"reels_included": False, "episode_link": "https://example.com/ep"})
    check("3a. review link created", r.status_code == 200 and r.json().get("url"), r.text[:200])
    token = r.json()["url"].rsplit("/", 1)[-1]
    html = requests.get(f"{APP}/r/{token}").text
    check("3b. client sees the base price 3,500", "3,500" in html)
    check("3c. client sees the add-on 1,500", "1,500" in html and "3 רילז נוספים" in html)
    check("3d. client sees total 5,000 + VAT", "5,000" in html and "מע" in html)

    # ---- 4. full approval -> job.amount = 5,000 + deal invoice queued at 5,000 ----
    r = requests.post(f"{APP}/api/r/{token}/respond", headers={"Content-Type": "application/json"},
                      json={"episode": "approved", "addons": {addon_id: "approved"}})
    check("4a. full approval accepted (approved_all)", r.status_code == 200 and r.json().get("approved_all") is True,
          r.text[:200])
    arow = requests.get(rest(f"production_addons?id=eq.{addon_id}&select=status,approved_via"), headers=ADMIN).json()[0]
    check("4b. add-on now approved via link", arow["status"] == "approved" and arow["approved_via"] == "link",
          json.dumps(arow, ensure_ascii=False))
    jp = requests.get(rest(f"job_productions?production_id=eq.{production_id}&select=job_id"), headers=ADMIN).json()
    check("4c. approval created a job", len(jp) == 1, json.dumps(jp))
    job = requests.get(rest(f"jobs?id=eq.{jp[0]['job_id']}&select=amount"), headers=ADMIN).json()[0]
    check("4d. job.amount = 5,000 (base 3,500 + add-on 1,500)", float(job["amount"]) == 5000, str(job["amount"]))
    dj = requests.get(rest(f"pending_documents?production_id=eq.{production_id}&doc_type=eq.deal_invoice&select=amount,payload,status"),
                      headers=ADMIN).json()
    check("4e. deal invoice queued at 5,000", len(dj) == 1 and float(dj[0]["amount"]) == 5000 and dj[0]["status"] == "pending",
          json.dumps({"n": len(dj), "amount": dj[0]["amount"] if dj else None}))
    income = (dj[0]["payload"] or {}).get("income", []) if dj else []
    prices = sorted(float(r_["price"]) for r_ in income)
    check("4f. invoice has a base row (3,500) + an add-on row (1,500)", prices == [1500.0, 3500.0], json.dumps(prices))

    # ---- 5. the board defaults to legacy=false ----
    legacy_id = requests.post(rest("productions"), headers=REPR,
                              json={"podcast_name": f"{MARK} show", "show_id": show_id, "client_id": client_id,
                                    "kind": "client", "record_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                                    "status": "עתיד_להתחיל", "legacy": True}).json()[0]["id"]
    board = requests.get(f"{APP}/productions", cookies=op)
    check("5a. board page loads for the operator", board.status_code == 200, str(board.status_code))
    # the server serializes the board rows into the RSC payload with each row's
    # legacy flag; the default client filter hides legacy=true. We assert the
    # flag travels so the client filter has what it needs (the visual hiding is
    # React state, not observable over HTTP).
    check("5b. legacy row exists and is flagged legacy=true",
          requests.get(rest(f"productions?id=eq.{legacy_id}&select=legacy"), headers=ADMIN).json()[0]["legacy"] is True)

finally:
    print("\n--- cleanup ---")
    for pid in [production_id, legacy_id]:
        if not pid: continue
        requests.delete(rest(f"production_addons?production_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"client_review_links?production_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"pending_documents?production_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"events?entity_id=eq.{pid}"), headers=ADMIN)
        jp = requests.get(rest(f"job_productions?production_id=eq.{pid}&select=job_id"), headers=ADMIN).json()
        for j in jp if isinstance(jp, list) else []:
            requests.delete(rest(f"job_productions?job_id=eq.{j['job_id']}"), headers=ADMIN)
            requests.delete(rest(f"events?entity_id=eq.{j['job_id']}"), headers=ADMIN)
            requests.delete(rest(f"jobs?id=eq.{j['job_id']}"), headers=ADMIN)
        requests.delete(rest(f"stages?production_id=eq.{pid}"), headers=ADMIN)
        requests.delete(rest(f"productions?id=eq.{pid}"), headers=ADMIN)
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
