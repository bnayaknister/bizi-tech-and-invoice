# -*- coding: utf-8 -*-
"""
Contract classification batch (owner decisions 2026-07-15). Requires
migrations 0011+0012. Run without arguments for a PREVIEW (writes nothing);
run with --apply to execute.

1. Merge: רוני וברק is absorbed into מתפשטים (same show; name + aliases
   become aliases of מתפשטים, productions repointed, source deleted).
2. Rename: למה זברה → "יגאל שפירא ודוד ארז", aliases ["למה זברה","זברה"].
   (Owner said "merge", but no show/production named יגאל שפירא ודוד ארז
   exists anywhere — the zebra show IS their show, so this is a rename.)
3. The 27 Jaffa shows: billing_mode='contract', client=ידיעות אחרונות,
   active=false; ALL their productions → kind='contract', client inherited.
   The 🔵 unbilled alert ignores kind='contract' completely.
4. The 8 evidence shows: billing_mode='per_episode', client per the
   recorded evidence; derivation → their productions kind='client',
   client inherited from the show.

Explicitly NOT touched (owner: "אלה חייבות לצעוק", client TBD):
דעה לא פופולרית · מנהלי שיווק מצייצים — and everything else.

Idempotent; every change logged to events (source: contract_classification).
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")
if os.path.exists(ENV_PATH):
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
SOURCE = "contract_classification_2026-07-15"

JAFFA_SHOWS = [
    "מאצ׳ אפ", "אפרת וכטל", "הברזייה", "לא מה שחשבנו", "עיתונות חופרת",
    "מתפשטים", "בלתי ניתנים להחלפה", "אייל דורון", "מהדורה מוגבלת",
    "הכי בזמן", "זה חוקי", "בן של מלך", "לא קונות את זה",
    "נסיכי הגאות והשפל", "איפה אני חי", "סקס אפיל", "נאים להכיר",
    "אנבוקסינג", "פותחות את הפה", "מכונת האמת", "החברות הגאונות שלי",
    "יגאל שפירא ודוד ארז",  # לשעבר "למה זברה" — הרינום קורה לפני הסיווג
    "אברהם טל ומוש בן ארי", "גילי איצקוביץ ואינה בקלמן",
    "ספרות רומנטית BEPO", "אורי מלמד ובניה", "אבק פיות",
]

# show name -> client name (the recorded evidence, approved by owner)
PER_EPISODE = {
    "סטימצקי": "סטימצקי",
    "חתונמיות": "חתונמיות",
    "פארמה תמר": "פארמה תמר",
    "חלאסרטן": "חלאסרטן",
    "דברים שלמדתי מנשים מצליחות": "ענבל מצנע",
    "אפרת לקט": "ידיעות אחרונות",
    "עדן בן שלוש": "עדן בן שלוש",
    "בינה נשית": "נטע צמח",
}

YEDIOTH = "ידיעות אחרונות"


def api(method, path, params=None, body=None, headers=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
                 "Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req) as r:
            text = r.read().decode()
            return json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        print("ERROR", method, path, e.code, e.read().decode()[:400], file=sys.stderr)
        raise


def get_all(path, params):
    out, offset = [], 0
    while True:
        p = dict(params, offset=offset, limit=1000)
        rows = api("GET", path, params=p)
        out += rows
        if len(rows) < 1000:
            return out
        offset += 1000


def event(entity_type, entity_id, event_type, payload):
    api("POST", "events", body={
        "entity_type": entity_type, "entity_id": entity_id, "event_type": event_type,
        "payload": {**payload, "source": SOURCE, "approved_by": "owner"},
    })


def main():
    apply = "--apply" in sys.argv

    # gate (apply only — preview must work before the DDL runs)
    if apply:
        try:
            api("GET", "shows", params={"select": "billing_mode", "limit": 1})
        except urllib.error.HTTPError:
            sys.exit("shows.billing_mode לא קיימת — יש להריץ קודם את מיגרציות 0011+0012.")

    shows = get_all("shows", {"select": "id,name,aliases,active,client_id"})
    prods = get_all("productions", {"select": "id,show_id,kind"})
    clients = {c["name"]: c["id"] for c in get_all("clients", {"select": "id,name"})}
    by_name = {s["name"]: s for s in shows}
    prods_by_show = {}
    for p in prods:
        prods_by_show.setdefault(p["show_id"], []).append(p)

    yedioth_id = clients[YEDIOTH]
    mode = "APPLY" if apply else "PREVIEW (שום דבר לא נכתב; הרץ עם --apply לביצוע)"
    print(f"=== {mode} ===\n")

    # ---------- 1. merge רוני וברק → מתפשטים ----------
    src, tgt = by_name.get("רוני וברק"), by_name.get("מתפשטים")
    if src and tgt:
        moved = prods_by_show.get(src["id"], [])
        aliases = sorted(set((tgt["aliases"] or []) + ["רוני וברק"] + (src["aliases"] or [])) - {tgt["name"]})
        print(f"מיזוג: רוני וברק ({len(moved)} הפקות) ← מתפשטים ({len(prods_by_show.get(tgt['id'], []))}) | aliases={aliases}")
        if apply:
            api("PATCH", "shows", params={"id": f"eq.{tgt['id']}"}, body={"aliases": aliases})
            api("PATCH", "productions", params={"show_id": f"eq.{src['id']}"}, body={"show_id": tgt["id"]})
            api("DELETE", "shows", params={"id": f"eq.{src['id']}"})
            event("show", tgt["id"], "show_merged", {
                "target_aliases_before": tgt["aliases"] or [],
                "source_show": src, "moved_production_ids": [p["id"] for p in moved],
            })
        # the logical result feeds the classification below in both modes
        for p in moved:
            prods_by_show.setdefault(tgt["id"], []).append(p)
    elif tgt and not src:
        print("מיזוג רוני וברק: המקור כבר לא קיים — כנראה בוצע. מדלג.")
    else:
        sys.exit("מתפשטים לא נמצאה — עצירה.")

    # ---------- 2. rename למה זברה → יגאל שפירא ודוד ארז ----------
    zebra = by_name.get("למה זברה")
    if zebra:
        print('שינוי שם: למה זברה → "יגאל שפירא ודוד ארז" | aliases=["למה זברה","זברה"]')
        if apply:
            api("PATCH", "shows", params={"id": f"eq.{zebra['id']}"},
                body={"name": "יגאל שפירא ודוד ארז", "aliases": ["למה זברה", "זברה"]})
            event("show", zebra["id"], "show_renamed", {
                "from": "למה זברה", "to": "יגאל שפירא ודוד ארז",
                "note": "אין תוכנית/הפקה בשם יגאל שפירא ודוד ארז — זהו רינום, לא מיזוג",
            })
        by_name["יגאל שפירא ודוד ארז"] = zebra
    elif "יגאל שפירא ודוד ארז" in by_name:
        print("רינום זברה: כבר בוצע. מדלג.")
    else:
        sys.exit("לא נמצאה למה זברה וגם לא יגאל שפירא ודוד ארז — עצירה.")

    # ---------- 3. Jaffa contract shows ----------
    print("\n--- 27 תוכניות ביפו → billing_mode=contract, לקוח=ידיעות אחרונות, active=false ---")
    missing = [n for n in JAFFA_SHOWS if n not in by_name]
    if missing:
        sys.exit(f"תוכניות חסרות: {missing} — עצירה, שום דבר לא שונה.")
    total_contract = 0
    for name in JAFFA_SHOWS:
        s = by_name[name]
        pool = prods_by_show.get(s["id"], [])
        total_contract += len(pool)
        print(f"  {len(pool):3d} הפקות | {name}")
        if apply:
            api("PATCH", "shows", params={"id": f"eq.{s['id']}"},
                body={"billing_mode": "contract", "client_id": yedioth_id, "active": False})
            api("PATCH", "productions", params={"show_id": f"eq.{s['id']}"},
                body={"kind": "contract", "client_id": yedioth_id})
            event("show", s["id"], "billing_classified", {
                "billing_mode": "contract", "client": YEDIOTH, "active": False,
                "productions_reclassified": len(pool), "production_ids": [p["id"] for p in pool],
            })
    print(f"  סה\"כ: {len(JAFFA_SHOWS)} תוכניות, {total_contract} הפקות → contract")

    # ---------- 4. per-episode shows + derivation ----------
    print("\n--- 8 תוכניות עם ראיות → billing_mode=per_episode + גזירת client ---")
    total_client = 0
    for name, client_name in PER_EPISODE.items():
        s = by_name.get(name)
        if not s:
            sys.exit(f"תוכנית {name} לא נמצאה — עצירה.")
        cid = clients.get(client_name)
        if not cid:
            sys.exit(f"לקוח {client_name} לא נמצא — עצירה.")
        pool = prods_by_show.get(s["id"], [])
        total_client += len(pool)
        print(f"  {len(pool):3d} הפקות | {name} → {client_name}")
        if apply:
            api("PATCH", "shows", params={"id": f"eq.{s['id']}"},
                body={"billing_mode": "per_episode", "client_id": cid})
            api("PATCH", "productions", params={"show_id": f"eq.{s['id']}"},
                body={"kind": "client", "client_id": cid})
            event("show", s["id"], "billing_classified", {
                "billing_mode": "per_episode", "client": client_name,
                "productions_reclassified": len(pool), "production_ids": [p["id"] for p in pool],
            })
    print(f"  סה\"כ: {len(PER_EPISODE)} תוכניות, {total_client} הפקות → client")

    # ---------- summary ----------
    if apply:
        prods_now = get_all("productions", {"select": "id,kind"})
        shows_now = get_all("shows", {"select": "id,name,active,client_id"})
        kinds = {}
        for p in prods_now:
            kinds[p["kind"]] = kinds.get(p["kind"], 0) + 1
        no_client_active = [s["name"] for s in shows_now if s["active"] and not s["client_id"]]
        print(f"\n=== מצב סופי ===")
        print("הפקות לפי kind:", kinds)
        print(f"תוכניות פעילות בלי לקוח: {len(no_client_active)}")
        for n in sorted(no_client_active):
            print("  ✗", n)


if __name__ == "__main__":
    main()
