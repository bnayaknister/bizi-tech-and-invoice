# -*- coding: utf-8 -*-
"""Backfill external_id (CSV C0001/P0001), episode_no, and legacy=true for
all existing rows, so the bidirectional importer can match by stable ID.

Requires migration 0014. Matching is by fingerprint groups; within a group
of truly-identical rows (same show+date+guest+studio) the CSV IDs are
assigned to DB rows in a deterministic order (created_at,id) — arbitrary
but consistent, which is harmless because those rows are identical.

Idempotent. Preview by default; --apply to write.
"""
import csv, json, os, sys, urllib.error, urllib.parse, urllib.request
from collections import defaultdict

ENV = os.path.join(os.path.dirname(__file__), "..", ".env.local")
for line in open(ENV, encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())
U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]; K = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": K, "Authorization": f"Bearer {K}", "Content-Type": "application/json"}
BIZI = os.path.expanduser("~/bizi")

def api(m, p, params=None, body=None):
    url = f"{U}/rest/v1/{p}" + ("?" + urllib.parse.urlencode(params) if params else "")
    r = urllib.request.Request(url, method=m, data=json.dumps(body).encode() if body is not None else None, headers=H)
    with urllib.request.urlopen(r) as x:
        t = x.read().decode(); return json.loads(t) if t else None

def get_all(p, sel):
    out, off = [], 0
    while True:
        rows = api("GET", p, {"select": sel, "limit": 1000, "offset": off})
        out += rows
        if len(rows) < 1000: return out
        off += 1000

def norm(s): return (s or "").replace(" ", "").strip().lower()

def pdate(s):
    s = (s or "").strip()
    if not s or s in ("---", "-", "—"): return None
    for sep in (".", "/"):
        if sep in s:
            parts = s.split(sep)
            if len(parts) == 3:
                d, m, y = parts
                y = ("20" + y) if len(y) == 2 else y
                try: return f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
                except ValueError: return None
    return None

def pint(s):
    s = (s or "").strip()
    if not s: return None
    try: return int(float(s))
    except ValueError: return None

APPLY = "--apply" in sys.argv

def assign(kind, csv_path, fp_db, fp_csv, extra_from_csv):
    """Generic: group DB + CSV rows by fingerprint, zip within groups."""
    db_rows = fp_db()
    csv_rows = list(csv.DictReader(open(csv_path, encoding="utf-8-sig")))
    db_groups = defaultdict(list); csv_groups = defaultdict(list)
    for r in db_rows: db_groups[fp_csv["db"](r)].append(r)
    for r in csv_rows: csv_groups[fp_csv["csv"](r)].append(r)

    assignments = []  # (db_id, external_id, extra dict)
    matched = unmatched_csv = 0
    for fp, crows in csv_groups.items():
        drows = db_groups.get(fp, [])
        crows_sorted = sorted(crows, key=lambda r: (pint(r.get("פרק מספר")) or 0, r["ID"]))
        drows_sorted = sorted(drows, key=lambda r: (r["created_at"], r["id"]))
        for c, d in zip(crows_sorted, drows_sorted):
            assignments.append((d["id"], c["ID"], extra_from_csv(c)))
            matched += 1
        unmatched_csv += max(0, len(crows_sorted) - len(drows_sorted))

    print(f"\n=== {kind} ===")
    print(f"  CSV rows: {len(csv_rows)}, DB rows: {len(db_rows)}")
    print(f"  matched (get external_id): {matched}")
    print(f"  CSV rows with no DB counterpart: {unmatched_csv}")
    print(f"  DB rows left without external_id: {len(db_rows) - matched}")
    if not APPLY:
        print("  PREVIEW — run with --apply to write")
        return
    # write external_id + extras
    for db_id, ext, extra in assignments:
        api("PATCH", kind + "s" if kind == "job" else "productions",
            {"id": f"eq.{db_id}"}, {"external_id": ext, **extra})
    # legacy=true for ALL existing rows (they are historical)
    table = "jobs" if kind == "job" else "productions"
    api("PATCH", table, {"external_id": "not.is.null"}, {"legacy": True})
    api("PATCH", table, {"external_id": "is.null"}, {"legacy": True})
    cov = sum(1 for r in get_all(table, "external_id") if r["external_id"])
    print(f"  APPLIED. external_id coverage: {cov}/{len(db_rows)}")

# ---- productions ----
assign(
    "production",
    os.path.join(BIZI, "2_הפקות.csv"),
    lambda: get_all("productions", "id,podcast_name,record_date,guest,studio,created_at"),
    {
        "db": lambda r: (norm(r["podcast_name"]), r["record_date"], norm(r["guest"]), norm(r["studio"])),
        "csv": lambda r: (norm(r["שם הפודקאסט"]), pdate(r["תאריך הקלטה"]), norm(r["שם אורחים"]), norm(r["אולפן"])),
    },
    lambda c: {"episode_no": pint(c.get("פרק מספר"))},
)

# ---- jobs (accounts) ----
clients = {c["id"]: c["name"] for c in get_all("clients", "id,name")}
def amt(v):
    p = pint(str(v)) if v not in (None, "") else None
    return "" if p is None else str(p)
assign(
    "job",
    os.path.join(BIZI, "1_חיובים.csv"),
    lambda: get_all("jobs", "id,client_id,campaign,date,amount,created_at"),
    {
        "db": lambda r: (norm(clients.get(r["client_id"], "")), norm(r["campaign"]), r["date"], amt(r["amount"])),
        "csv": lambda r: (norm(r["לקוח"]), norm(r["קמפיין"]), pdate(r["תאריך"]), amt(r["מחיר"])),
    },
    lambda c: {},
)
