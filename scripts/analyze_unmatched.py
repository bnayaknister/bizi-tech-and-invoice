# -*- coding: utf-8 -*-
"""
READ-ONLY triage of the unmatched (client_id null) registry documents, to
decide WHO Shiri should map — not all of them, only the ones that matter.

Answers:
  1. real billing (300/305/320/400 + 330 credit) vs noise (10 quote / 100 order)
  2. how many UNIQUE Morning clients the unmatched billing docs represent
  3. per client: recurring (multi-doc / multi-month) vs one-off; whether the
     name already matches one of OUR clients (a slam-dunk map) or is Morning-only
  4. receipts (320/400 = proof of payment) whose mapping would plausibly close
     an OPEN (unpaid) job of a name-matched client
"""
import json, os, re, urllib.request, urllib.parse
from collections import defaultdict
from datetime import datetime

env = {}
for line in open(os.path.join(os.path.dirname(__file__), "..", ".env.local"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
SU = env["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/"); SK = env["SUPABASE_SERVICE_ROLE_KEY"]

BILLING = {300, 305, 320, 400}
CREDIT = {330}
NOISE = {10, 100}          # quotes / work orders
PAYMENT = {320, 400}       # receipts — proof of money in
TYPE_NAME = {10: "quote", 100: "order", 300: "deal-inv", 305: "tax-inv",
             320: "tax/receipt", 330: "credit", 400: "receipt"}
VAT = 1.18


def rest(path):
    req = urllib.request.Request(f"{SU}/rest/v1/{path}",
        headers={"apikey": SK, "Authorization": "Bearer " + SK})
    return json.loads(urllib.request.urlopen(req).read())


def fetch_all(table, select):
    out, off = [], 0
    while True:
        rows = rest(f"{table}?select={urllib.parse.quote(select)}&limit=1000&offset={off}")
        out.extend(rows)
        if len(rows) < 1000: break
        off += 1000
    return out


SUFFIXES = ["בעמ", "בע״מ", "ער", "ע״ר", "גרופ", "group", "ltd", "inc", "בעם"]

def norm(s):
    if not s: return ""
    s = re.sub(r"[֑-ׇ]", "", s)                    # niqud
    s = re.sub(r'[\s"\'׳״\.,\-()]', "", s)  # spaces/punct/quotes/gershayim
    return s.lower()

def core(s):
    """normalized name with common company suffixes stripped, for fuzzy match."""
    n = norm(s)
    for suf in sorted(SUFFIXES, key=len, reverse=True):
        if n.endswith(suf) and len(n) - len(suf) >= 3:
            n = n[: -len(suf)]
    return n

def best_our_match(name):
    """our client whose core name contains-or-is-contained by this one (>=4 chars)."""
    t = core(name)
    if len(t) < 4: return None
    best = None
    for c in clients:
        if not c.get("name"): continue
        o = core(c["name"])
        if len(o) < 4: continue
        if t == o or (len(t) >= 4 and t in o) or (len(o) >= 4 and o in t):
            score = min(len(t), len(o)) / max(len(t), len(o))
            if not best or score > best[1]:
                best = (c, score)
    return best[0] if best else None


def month(d):
    try: return str(d)[:7]
    except Exception: return None


docs = fetch_all("documents", "type,status,morning_client_id,morning_client_name,amount,document_date,job_id,client_id")
clients = fetch_all("clients", "id,name,morning_client_id")
jobs = fetch_all("jobs", "id,client_id,amount,paid,invoice_tax,dismissed,campaign,date")

our_by_norm = {}
for c in clients:
    if c.get("name"):
        our_by_norm.setdefault(norm(c["name"]), c)
mapped_morning_ids = {c["morning_client_id"] for c in clients if c.get("morning_client_id")}

unmatched = [d for d in docs if not d.get("client_id")]
print(f"unmatched docs (client_id null): {len(unmatched)}")

# ---- 1. billing vs noise ----
b = [d for d in unmatched if d["type"] in BILLING]
cr = [d for d in unmatched if d["type"] in CREDIT]
noise = [d for d in unmatched if d["type"] in NOISE]
by_t = defaultdict(int)
for d in unmatched: by_t[d["type"]] += 1
print("\n[1] by type:")
for t in sorted(by_t):
    tag = "BILLING" if t in BILLING else ("credit" if t in CREDIT else "noise")
    print(f"    {TYPE_NAME.get(t,t):<12} {by_t[t]:>4}   {tag}")
print(f"    -> real billing (300/305/320/400): {len(b)} | credit: {len(cr)} | noise (quotes/orders): {len(noise)}")

# ---- group unmatched BILLING+CREDIT by morning client ----
def cli_key(d):
    return d.get("morning_client_id") or f"NONAME::{d.get('morning_client_name')}"

grp = defaultdict(list)
for d in b + cr:
    grp[cli_key(d)].append(d)

# only morning clients that aren't already mapped (they shouldn't be, but guard)
grp = {k: v for k, v in grp.items() if not (isinstance(k, str) and k in mapped_morning_ids)}
print(f"\n[2] unique Morning clients behind the unmatched BILLING/credit docs: {len(grp)}")

# ---- per-client scoring ----
# open (unpaid, non-dismissed) jobs per OUR client id, for receipt-closure check
open_jobs_by_client = defaultdict(list)
for j in jobs:
    if j.get("paid") != "כן" and not j.get("dismissed") and j.get("client_id") and j.get("amount") is not None:
        open_jobs_by_client[j["client_id"]].append(j)

def amt_match(a, jamt):
    if a is None or jamt is None: return False
    a = float(a); jamt = float(jamt)
    for tgt in (jamt, jamt * VAT):
        if abs(a - tgt) <= max(2.0, tgt * 0.01): return True
    return False

rows = []
for k, ds in grp.items():
    name = ds[0].get("morning_client_name") or "(no name)"
    billing = [d for d in ds if d["type"] in BILLING]
    receipts = [d for d in ds if d["type"] in PAYMENT]
    months = {month(d.get("document_date")) for d in ds if d.get("document_date")}
    total = sum(float(d["amount"]) for d in ds if d.get("amount") is not None)
    our = best_our_match(name)
    # receipt-closes-open-job?
    closeable = 0
    if our:
        for r in receipts:
            if any(amt_match(r.get("amount"), j.get("amount")) for j in open_jobs_by_client.get(our["id"], [])):
                closeable += 1
    recurring = len(ds) >= 2 or len(months) >= 2
    rows.append({"name": name, "docs": len(ds), "billing": len(billing), "receipts": len(receipts),
                 "months": len(months), "total": total, "our_match": bool(our),
                 "our_name": our["name"] if our else "",
                 "recurring": recurring, "closeable": closeable, "mid": k})

# rank: closeable receipts first, then recurring + name-matched, then volume
rows.sort(key=lambda r: (r["closeable"], r["our_match"], r["recurring"], r["billing"], r["total"]), reverse=True)

recurring_n = sum(1 for r in rows if r["recurring"])
oneoff_n = sum(1 for r in rows if not r["recurring"])
matched_n = sum(1 for r in rows if r["our_match"])
closeable_docs = sum(r["closeable"] for r in rows)
print(f"[3] of those {len(rows)} clients: recurring(2+ docs/months)={recurring_n}  one-off={oneoff_n}  "
      f"name-matches OUR client={matched_n}")
print(f"[4] receipts among unmatched: {len([d for d in unmatched if d['type'] in PAYMENT])}  "
      f"-> that plausibly CLOSE an open job (name-matched client + amount): {closeable_docs}")

print("\n=== TOP CLIENTS TO MAP (ranked by impact) ===")
print(f"{'#':>2} {'Morning client':<30} {'docs':>4} {'bill':>4} {'rcpt':>4} {'mo':>3} {'total':>8}  {'-> our client (exists?)'}")
shown = [r for r in rows if r["billing"] > 0]
for i, r in enumerate(shown[:37], 1):
    tgt = f"= {r['our_name']}" if r["our_match"] else "(NEW — not in our clients)"
    print(f"{i:>2} {r['name'][:30]:<30} {r['docs']:>4} {r['billing']:>4} {r['receipts']:>4} "
          f"{r['months']:>3} {r['total']:>8,.0f}  {tgt}")

# how much of the total billing value is covered by the top N?
tot_all = sum(r["total"] for r in rows)
for N in (10, 20, 30):
    cov = sum(r["total"] for r in shown[:N])
    print(f"  top {N} clients cover {cov:,.0f} of {tot_all:,.0f} billing value ({100*cov/tot_all:.0f}%) "
          f"and {sum(r['docs'] for r in shown[:N])} docs")
