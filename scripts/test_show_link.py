# -*- coding: utf-8 -*-
"""
E2E for Feature 4 — assign/edit a finance row's תוכנית (show/production).

No Morning calls (pure linking), so any dev server works. Proves:
  1. production search requires can_view_money (tech 403); finds the show
  2. show-link starts empty; link → current shows it; unlink → empty; relink
  3. a linked tax receipt is reported AND survives a relink (invoice_tax
     unchanged) — "show the מס-קבלה and don't break it"
  4. a non-money user cannot link (RLS)
Self-cleaning in FK order.
"""
import base64, json, os, sys, time, uuid
import requests

for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; AN = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]; SK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3000")
A = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
ref = U.split("//")[1].split(".")[0]; CN = f"sb-{ref}-auth-token"

def rest(p): return f"{U}/rest/v1/{p}"
def ins(t, row):
    r = requests.post(rest(t), headers={**A, "Prefer": "return=representation"}, json=row); r.raise_for_status(); return r.json()[0]
def patch(t, q, row): requests.patch(rest(f"{t}?{q}"), headers=A, json=row)
def dele(t, q): requests.delete(rest(f"{t}?{q}"), headers=A)

passed = fail = 0
def check(name, ok):
    global passed, fail
    print(("  ✓ " if ok else "  ✗ ") + name); passed += ok; fail += (not ok)

for _ in range(90):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("dev server never came up"); sys.exit(1)

def mkuser(name, money):
    em = f"{name}-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
    patch("profiles", f"id=eq.{uid}", {"name": name, "approved": True, "role": "bookkeeper" if money else "editor",
          "can_view_money": money, "can_edit_money": money, "can_view_stages": True, "can_edit_stages": True})
    td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"},
                       json={"email": em, "password": pw}).json()
    sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600,
            "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
    return uid, {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}

TAG = "ZTESTLINK" + uuid.uuid4().hex[:5]
money_uid, money_ck = mkuser("ZTESTLINK_money", True)
tech_uid, tech_ck = mkuser("ZTESTLINK_tech", False)
cli = ins("clients", {"name": f"{TAG} client", "normalized_name": f"ztestlink{uuid.uuid4().hex[:8]}"})
s1 = ins("shows", {"name": f"{TAG} show1", "client_id": cli["id"], "billing_mode": "per_episode", "active": True})
s2 = ins("shows", {"name": f"{TAG} show2", "client_id": cli["id"], "billing_mode": "per_episode", "active": True})
def mkprod(s, name, guest):
    return ins("productions", {"show_id": s["id"], "podcast_name": name, "client_id": cli["id"],
                               "record_date": "2026-06-01", "guest": guest, "kind": "client", "status": "עתיד_להתחיל"})
p1 = mkprod(s1, f"{TAG} show1", "GuestA")
p2 = mkprod(s2, f"{TAG} show2", "GuestB")
job = ins("jobs", {"client_id": cli["id"], "amount": 1000, "campaign": f"{TAG} job", "paid": "לא"})

def link(ck, payload):
    return requests.post(f"{APP}/api/jobs/link", cookies=ck, headers={"Content-Type": "application/json"}, json=payload)
def show_link(ck=money_ck):
    return requests.get(f"{APP}/api/jobs/{job['id']}/show-link", cookies=ck).json()

try:
    # 1. search
    r = requests.get(f"{APP}/api/productions/search?q={TAG}+show1", cookies=money_ck)
    check("search finds P1", r.status_code == 200 and any(p["id"] == p1["id"] for p in r.json()["productions"]))
    check("tech search 403", requests.get(f"{APP}/api/productions/search?q={TAG}", cookies=tech_ck).status_code == 403)

    # 2. link lifecycle
    check("show-link starts empty", show_link()["current"] == [])
    check("link J→P1 200", link(money_ck, {"action": "link", "jobId": job["id"], "productionIds": [p1["id"]], "confidence": "manual"}).status_code == 200)
    info = show_link()
    check("current shows P1 (show1)", len(info["current"]) == 1 and info["current"][0]["production_id"] == p1["id"] and info["current"][0]["show"] == f"{TAG} show1")
    check("unlink P1", link(money_ck, {"action": "unlink", "jobId": job["id"], "productionId": p1["id"]}).status_code == 200)
    check("empty after unlink", show_link()["current"] == [])
    check("relink J→P2", link(money_ck, {"action": "link", "jobId": job["id"], "productionIds": [p2["id"]], "confidence": "manual"}).status_code == 200)
    check("current shows P2 (show2)", show_link()["current"][0]["show"] == f"{TAG} show2")

    # 3. tax receipt reported + preserved across a relink
    patch("jobs", f"id=eq.{job['id']}", {"invoice_tax": "TAX123"})
    ins("invoices", {"client_id": cli["id"], "job_id": job["id"], "type": "מס", "doc_number": "TAX123",
                     "morning_doc_id": f"mzl-{uuid.uuid4().hex}", "amount": 1180, "source": "manual"})
    info = show_link()
    check("tax receipt reported", info["invoiceTax"] == "TAX123" and any(t["number"] == "TAX123" for t in info["taxDocs"]))
    link(money_ck, {"action": "unlink", "jobId": job["id"], "productionId": p2["id"]})
    link(money_ck, {"action": "link", "jobId": job["id"], "productionIds": [p1["id"]], "confidence": "manual"})
    jrow = requests.get(rest(f"jobs?id=eq.{job['id']}&select=invoice_tax"), headers=A).json()[0]
    check("invoice_tax survived the relink", jrow["invoice_tax"] == "TAX123")

    # 4. tech cannot link (RLS)
    check("tech link blocked", link(tech_ck, {"action": "link", "jobId": job["id"], "productionIds": [p2["id"]]}).status_code != 200)
finally:
    dele("events", f"entity_id=eq.{job['id']}")
    dele("invoices", f"job_id=eq.{job['id']}")
    dele("job_productions", f"job_id=eq.{job['id']}")
    dele("jobs", f"id=eq.{job['id']}")
    dele("productions", f"id=eq.{p1['id']}")
    dele("productions", f"id=eq.{p2['id']}")
    dele("shows", f"id=eq.{s1['id']}")
    dele("shows", f"id=eq.{s2['id']}")
    dele("clients", f"id=eq.{cli['id']}")
    for uid in (money_uid, tech_uid):
        patch("events", f"actor_id=eq.{uid}", {"actor_id": None})
        requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = requests.get(rest("profiles?name=like.ZTESTLINK*&select=id"), headers=A).json()
    print(f"\n{passed} passed, {fail} failed · cleanup:", "ok" if left == [] else f"LEFT {left}")
    sys.exit(1 if fail else 0)
