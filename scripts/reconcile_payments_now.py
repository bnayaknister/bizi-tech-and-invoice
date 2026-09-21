# -*- coding: utf-8 -*-
"""
READ ONLY. Prints exactly what the payment engine WOULD link right now, and
links nothing.

This file used to be the group-A run (owner instruction 2026-07-27): it POSTed
an empty body to /api/finance/reconcile-payments, which linked every certain
payment match in a loop and marked those jobs paid — no preview, no per-row
decision, no undo. F14 stage B (2026-09-21) split that endpoint in two: the
proposals now come from GET /api/finance/payment-matches, and the POST refuses
anything but an explicit list of pairs a human approved. Approving is done on
the screen, not from here.

So what is left of this script is the thing rule 55 already demanded be run
before any change to the payment engine: the reconstruction query. Empty = no
blood, work in peace. Not empty = this is what is about to happen, row by row.

  Run:  python3 scripts/reconcile_payments_now.py

Writes nothing: no link, no mark-paid, no event, no invoices row. The only rows
it creates are the temp trigger user's, deleted in finally and verified.
"""
import base64, json, os, sys, time, uuid
from datetime import datetime, date
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


def debt_and_red():
    jobs = requests.get(rest("jobs?select=id,amount,paid,due_date,dismissed,client_id,campaign"), headers=A).json()
    today = date.today()
    unpaid = [j for j in jobs if j["paid"] == "לא" and not j.get("dismissed") and j["amount"] is not None]
    def od(d):
        try: return (today - datetime.fromisoformat(str(d)[:10]).date()).days
        except: return None
    debt = sum(float(j["amount"]) for j in unpaid)
    red = [j for j in unpaid if j["due_date"] and od(j["due_date"]) and od(j["due_date"]) > 60]
    return debt, len(unpaid), sum(float(j["amount"]) for j in red), len(red)


for _ in range(90):
    try:
        if requests.get(APP, timeout=2).status_code < 500: break
    except requests.exceptions.ConnectionError: pass
    time.sleep(1)
else:
    print("dev server never came up"); sys.exit(1)

em = f"paynow-{uuid.uuid4().hex[:8]}@bizi-test.local"; pw = f"Test-{uuid.uuid4().hex}!A1"
uid = requests.post(f"{U}/auth/v1/admin/users", headers=A, json={"email": em, "password": pw, "email_confirm": True}).json()["id"]
# ⚠️ חולשה ידועה — הסקריפט מנפיק לעצמו הרשאת כספים. השורה הבאה יוצרת משתמש
# זמני ונותנת לו הרשאה, כלומר מי שמריץ את הסקריפט אינו צריך להיות מורשה כספים,
# הכלי מייצר את ההרשאה עבורו, ובסוף מוחק את המשתמש כך שלא נשארת עקבה של מי
# שבאמת הריץ. ⚠️ זו חולשה נפרדת והיא לא נסגרה ב-F14 שלב ב׳.
# מה שכן צומצם: הסקריפט הזה קורא בלבד, ולכן הוא מנפיק לעצמו can_view_money
# ותו לא — **בלי can_edit_money**. גם אילו היה מנפיק אותה, היא כבר לא הייתה
# מספיקה: POST /api/finance/reconcile-payments אינו מקשר בלי רשימת זוגות
# מפורשת שאדם אישר במסך.
requests.patch(rest(f"profiles?id=eq.{uid}"), headers={**A, "Prefer": "return=representation"}, json={"name": "ZTESTPAYNOW", "approved": True, "role": "bookkeeper", "can_view_money": True, "can_edit_money": False})
td = requests.post(f"{U}/auth/v1/token?grant_type=password", headers={"apikey": AN, "Content-Type": "application/json"}, json={"email": em, "password": pw}).json()
sess = {"access_token": td["access_token"], "token_type": "bearer", "expires_in": 3600, "expires_at": int(time.time()) + 3600, "refresh_token": td["refresh_token"], "user": td["user"]}
ck = {CN: "base64-" + base64.urlsafe_b64encode(json.dumps(sess).encode()).decode().rstrip("=")}

try:
    d0, n0, r0, rc0 = debt_and_red()
    print(f"debt={d0:,.0f} ({n0} unpaid) · VU-red(>60d)={r0:,.0f} ({rc0} jobs)")

    resp = requests.get(f"{APP}/api/finance/payment-matches", cookies=ck, timeout=120)
    if resp.status_code != 200:
        print(f"GET /api/finance/payment-matches -> {resp.status_code}: {resp.text[:300]}")
        sys.exit(1)
    matches = resp.json().get("matches", [])

    print("\n" + "=" * 78)
    print(f"payment matches awaiting approval: {len(matches)}")
    print("=" * 78)
    if not matches:
        # The state measured four times on 2026-09-19 and expected to hold.
        print("אפס התאמות. המנוע לא היה מקשר דבר גם אילו רץ.")
    for m in matches:
        print(f"\n  doc #{m['docNumber']} ({m['docTypeLabel']}) {m['docAmount']}₪  {m['docDate']}  · {m['clientName']}")
        print(f"  ->  job {m['jobLabel']}  {m['jobAmount']}₪  {m['jobDate']}")
        gap = "תאריך לא ידוע" if m["dateGapDays"] is None else f"{m['dateGapDays']} יום פער"
        print(f"      {m['amountBasisLabel']} · {gap} · fingerprint {m['fingerprint']}")
    print("\n" + "=" * 78)
    print("לא בוצע שום קישור ושום סימון. אישור נעשה במסך, שורה-שורה.")
    print("=" * 78)
finally:
    requests.delete(f"{U}/auth/v1/admin/users/{uid}", headers=A)
    left = requests.get(rest("profiles?name=like.*ZTESTPAYNOW*&select=id"), headers=A).json()
    print("cleanup temp user:", "ok" if left == [] else f"LEFT {left}")
