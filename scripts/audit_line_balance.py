# -*- coding: utf-8 -*-
"""
READ-ONLY. Does Sigma(income.price x quantity) equal pending_documents.amount on
every queue row?

The invariant the balance gate enforces (lib/documents/lineBalance.ts,
2026-09-02). Run it before shipping a change to the gate, and after — a row it
would refuse is a row that can never be approved, so this is the check that
says whether the gate is safe to tighten.

Baseline at the time the gate was written: 51 of 51 rows carrying income
satisfied it, zero exceptions.

Writes nothing.

Run:  python3 scripts/audit_line_balance.py
"""
import json
import os
import sys
import urllib.request
from collections import Counter

ROOT = os.path.join(os.path.dirname(__file__), "..")
env = {}
for line in open(os.path.join(ROOT, ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()

SU = env["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
SK = env["SUPABASE_SERVICE_ROLE_KEY"]
EPSILON = 0.01
# a row in one of these can still be edited or approved, so an imbalance in it
# is actionable rather than historical
LIVE = ("pending", "failed", "approved", "accrued")


def get(path):
    req = urllib.request.Request(f"{SU}/rest/v1/{path}",
                                 headers={"apikey": SK, "Authorization": "Bearer " + SK})
    return json.loads(urllib.request.urlopen(req).read())


rows = get("pending_documents?select=id,doc_type,status,amount,payload,created_at&order=created_at.asc")

with_income, off, live_off = 0, [], []
by_status = Counter()
for r in rows:
    income = (r["payload"] or {}).get("income") or []
    if not income:
        continue  # a receipt (400) carries none by design — not in scope
    with_income += 1
    by_status[r["status"]] += 1
    total = round(sum(float(x.get("price") or 0) * float(x.get("quantity") or 1) for x in income), 2)
    amount = float(r["amount"] or 0)
    if abs(total - amount) > EPSILON:
        off.append((r, total, amount, len(income)))
        if r["status"] in LIVE:
            live_off.append((r, total, amount, len(income)))

print(f"queue rows: {len(rows)}   carrying income: {with_income}")
print(f"by status: {dict(by_status)}")
print(f"\nimbalanced: {len(off)}   of them LIVE ({'/'.join(LIVE)}): {len(live_off)}")
for r, total, amount, n in off:
    tag = "LIVE" if r["status"] in LIVE else "past"
    print(f"  [{tag}] {r['doc_type']:<12} {r['status']:<11} lines={n} "
          f"sum={total:<10.2f} amount={amount:<10.2f} diff={total - amount:<+10.2f} "
          f"id={r['id'][:8]} {r['created_at'][:10]}")

if not off:
    print("  (none — every row carrying income balances)")

# A historical imbalance is a fact about the past and cannot be fixed by us; a
# LIVE one is a row nobody will ever be able to approve, and that is the failure.
print()
if live_off:
    print(f"FAIL: {len(live_off)} live row(s) would be refused by the balance gate")
    sys.exit(1)
print("OK: no live row is blocked by the balance gate")
sys.exit(0)
