# -*- coding: utf-8 -*-
"""
The studio-hours flow in a REAL browser, on the REAL DOM (F6 שלב 2ב).

WHY THIS FILE EXISTS
--------------------
The API suite (test_hourly_workorder.py) proves the SERVER: the route validates,
prices, re-amounts and refuses. It proves nothing about whether a technician is
ever ASKED. Everything in stage 2ב is a rendering decision — which modal opens
on the second tap, whether "דלג" is on screen, whether the red flag appears the
moment the recording ends — and a client component that throws still returns 200
with a full SSR body. An HTML assertion would pass on a blank page. (Same lesson
as test_edit_title_browser.py and the SSR note in TICKETS.md.)

THE INVERSE IMAGE IS HALF THE TEST. A test that only proves the hours field
appears would also pass if it appeared on every show in the studio. So the same
two taps run on a per-episode show, and the field must NOT be there.

MONEY IS THE OTHER HALF. The technician has no can_view_money. They enter hours;
the amount is derived on the server from a rate their role cannot read (0067's
grants). So the drawer is searched for the computed amount, and it must be
absent — while the queue row, read with the service key, must carry it.

SCOPED TO ITS OWN ROWS. Every production, show and client here is created by
this run under the ZTESTUI mark and deleted in `finally`.

TOUCHES MORNING: never. Nothing approves or issues; the hours route only
enqueues, which is a database write.

Rule 40: the server URL comes from TEST_APP_URL and defaults to :3100.

Requires: pip install playwright && playwright install chromium
Run:      TEST_APP_URL=http://localhost:3100 python3 scripts/test_hourly_hours_browser.py
Headed:   HEADED=1 TEST_APP_URL=... python3 scripts/test_hourly_hours_browser.py
"""
import base64
import json
import os
import sys
import tempfile
import uuid
from urllib.parse import urlparse

import requests
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(__file__), "..")
for _line in open(os.path.join(ROOT, ".env.local"), encoding="utf-8"):
    _line = _line.strip()
    if _line and not _line.startswith("#") and "=" in _line:
        _k, _v = _line.split("=", 1)
        os.environ.setdefault(_k.strip(), _v.strip())

SUP = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
ANON = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SVC = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
APP = os.environ.get("TEST_APP_URL", "http://localhost:3100").rstrip("/")
HEADED = os.environ.get("HEADED") == "1"
SHOT_DIR = os.environ.get("SHOT_DIR", tempfile.gettempdir())
REF = SUP.split("//")[1].split(".")[0]
COOKIE_DOMAIN = urlparse(APP).hostname or "localhost"
ADMIN = {"apikey": SVC, "Authorization": f"Bearer {SVC}", "Content-Type": "application/json"}
RET = {**ADMIN, "Prefer": "return=representation"}
MARK = "ZTESTUI"

fails = []
users, shows, prods, jobs, clients = [], [], [], [], []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail and not ok else ""))
    if not ok:
        fails.append(name)


def get(path):
    return requests.get(f"{SUP}/rest/v1/{path}", headers=ADMIN).json()


def ins(table, body):
    r = requests.post(f"{SUP}/rest/v1/{table}", headers=RET, json=body)
    r.raise_for_status()
    return r.json()[0]


def make_production(show_id, client_id, name):
    row = ins("productions", {
        "podcast_name": name, "show_id": show_id, "client_id": client_id,
        "kind": "client", "legacy": False, "record_date": "2026-09-03",
    })
    prods.append(row["id"])
    return row["id"]


def sweep():
    for pid in [p["id"] for p in (get(f"productions?select=id&podcast_name=like.{MARK}*") or [])]:
        for link in (get(f"job_productions?select=job_id&production_id=eq.{pid}") or []):
            requests.delete(f"{SUP}/rest/v1/pending_documents?job_id=eq.{link['job_id']}", headers=ADMIN)
            requests.delete(f"{SUP}/rest/v1/job_productions?job_id=eq.{link['job_id']}", headers=ADMIN)
            requests.delete(f"{SUP}/rest/v1/jobs?id=eq.{link['job_id']}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/pending_documents?production_id=eq.{pid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/stages?production_id=eq.{pid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/production_log?production_id=eq.{pid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{pid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/productions?id=eq.{pid}", headers=ADMIN)
    requests.delete(f"{SUP}/rest/v1/jobs?campaign=like.{MARK}*", headers=ADMIN)
    requests.delete(f"{SUP}/rest/v1/shows?name=like.{MARK}*", headers=ADMIN)
    requests.delete(f"{SUP}/rest/v1/clients?name=like.{MARK}*", headers=ADMIN)


sweep()

try:
    print(f"target: {APP}   (cookie domain: {COOKIE_DOMAIN})")

    # ---- a TECHNICIAN: stages, no money. The whole point of the flow -------
    email = f"ztest-{uuid.uuid4().hex[:8]}@example.com"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    uid = requests.post(f"{SUP}/auth/v1/admin/users", headers=ADMIN,
                        json={"email": email, "password": pw, "email_confirm": True}).json()["id"]
    users.append(uid)
    requests.patch(f"{SUP}/rest/v1/profiles?id=eq.{uid}", headers=ADMIN,
                   json={"approved": True, "can_view_stages": True, "can_edit_stages": True,
                         "can_view_money": False, "can_edit_money": False, "role": "tech"})
    tok = requests.post(f"{SUP}/auth/v1/token?grant_type=password",
                        headers={"apikey": ANON, "Content-Type": "application/json"},
                        json={"email": email, "password": pw}).json()
    val = "base64-" + base64.b64encode(json.dumps(tok, separators=(",", ":")).encode()).decode()
    cname = f"sb-{REF}-auth-token"
    pairs = ([(cname, val)] if len(val) <= 3180
             else [(f"{cname}.{i}", val[s:s + 3180]) for i, s in enumerate(range(0, len(val), 3180))])
    cookies = [{"name": n, "value": v, "domain": COOKIE_DOMAIN, "path": "/"} for n, v in pairs]

    cli = ins("clients", {"name": f"{MARK} client", "normalized_name": f"{MARK.lower()} client",
                          "morning_client_id": f"{MARK}-morning"})
    clients.append(cli["id"])

    hourly = ins("shows", {"name": f"{MARK} hourly", "active": True, "is_oneoff": True,
                           "client_id": cli["id"], "billing_mode": "per_episode",
                           "pricing_model": "per_hour", "hourly_rate": 250, "default_rate": None})
    shows.append(hourly["id"])
    episodic = ins("shows", {"name": f"{MARK} episodic", "active": True, "is_oneoff": True,
                             "client_id": cli["id"], "billing_mode": "per_episode",
                             "pricing_model": "per_episode", "default_rate": 900})
    shows.append(episodic["id"])
    # a THIRD show, so every card on the board carries a distinct show name.
    # The board searches and labels by show, so two productions of one show
    # would be two cards nothing on screen can tell apart — and a test that
    # picks "the first match" on a board of real work is how a test becomes an
    # incident (see test_edit_title_browser.py's scoping note).
    flagged = ins("shows", {"name": f"{MARK} flagged", "active": True, "is_oneoff": True,
                            "client_id": cli["id"], "billing_mode": "per_episode",
                            "pricing_model": "per_hour", "hourly_rate": 250, "default_rate": None})
    shows.append(flagged["id"])

    p_hourly = make_production(hourly["id"], cli["id"], f"{MARK} hourly")
    p_episodic = make_production(episodic["id"], cli["id"], f"{MARK} episodic")

    with sync_playwright() as pw_:
        browser = pw_.chromium.launch(headless=not HEADED, slow_mo=250 if HEADED else 0)
        ctx = browser.new_context(viewport={"width": 1400, "height": 1100})
        ctx.add_cookies(cookies)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        def find_card(show_name):
            """The board's own search, on the kanban tab.

            The default "היום" tab buckets by record_date and drops anything
            whose stages have started, so a production walks out of it halfway
            through this test. Kanban columns by status and keeps every row,
            and the search box narrows to one show — which is what makes every
            click below provably ours."""
            page.goto(f"{APP}/productions", wait_until="networkidle", timeout=60000)
            # "רק שלי" defaults ON for a technician (ProductionsClient:79) and
            # this user is assigned to nothing, so the board opens empty. Real
            # behaviour, not a bug — and the reason this line exists rather than
            # the test inventing a stage assignment it does not otherwise need.
            mine = page.locator('label:has-text("רק שלי") input[type="checkbox"]').first
            if mine.is_checked():
                mine.uncheck()
                page.wait_for_timeout(300)
            page.get_by_role("button", name="קנבן").click()
            page.wait_for_timeout(400)
            page.get_by_placeholder("חיפוש תוכנית, אורח, אולפן…").fill(show_name)
            page.wait_for_timeout(700)
            return page.locator("div.lift").filter(has_text=show_name)

        def open_drawer(show_name):
            # click the TITLE, not the card's centre: the card carries its own
            # buttons (הקפא / פצל / בטל הפקה) and a centre-point click lands on
            # whichever of them the current card height puts there. The title
            # row is always the first line, and its click bubbles to the card.
            card = find_card(show_name)
            card.first.get_by_text(show_name, exact=True).first.click()
            page.locator("aside").wait_for(state="visible", timeout=15000)
            page.wait_for_timeout(1200)
            return page.locator("aside")

        # both the disk modal and the note modal render at z-[70]; nothing else
        # on this screen does, so it is the one selector that says "a modal is
        # up" without naming which
        MODAL = 'div[class*="z-[70]"]'

        def record_button(drawer):
            # the פרק block's first step button — one tap advances it
            block = drawer.locator("div.rounded-xl").filter(has_text="פרק").first
            return block.get_by_role("button", name="הקלטה").first

        def poll(fn, timeout_ms=20000):
            """Wait for a SERVER fact, the same way wait_step waits for a UI one.

            The hours route writes three things in one request (the column,
            jobs.amount, the queue row) and the browser returns from the click
            before that request lands. A fixed sleep after שמור passed on most
            runs and reported an empty queue on the rest — the check was racing
            the write, not measuring it."""
            waited = 0
            while waited < timeout_ms:
                v = fn()
                if v:
                    return v
                page.wait_for_timeout(300)
                waited += 300
            return None

        def wait_step(drawer, tone, timeout_ms=25000):
            """Wait until the recording button actually WEARS its new state.

            The drawer reloads itself after a stage save, and until that
            round-trip lands its `data.stages` still says `pending` — so a
            second tap sent while the reload is in flight re-sends
            `in_progress` and re-opens the disk modal instead of completing the
            step. That is what made this test alternate between passing and
            failing, and it is also what a person avoids without thinking: they
            wait for the button to turn yellow before pressing it again.

            The colour IS the state (ProductionTrackBlock): amber =
            in_progress, emerald = done."""
            waited = 0
            while waited < timeout_ms:
                cls = record_button(drawer).get_attribute("class") or ""
                if tone in cls:
                    return True
                page.wait_for_timeout(250)
                waited += 250
            return False

        def tap_record(drawer):
            """Tap the recording step and WAIT FOR THE MODAL, never for a clock.

            The drawer reloads itself after every stage change, so a fixed
            timeout races the re-render: the first draft of this file passed and
            failed on alternate runs with no code change between them. Waiting
            on the state the tap is supposed to produce is the only version of
            this that means anything."""
            record_button(drawer).click()
            page.locator(MODAL).first.wait_for(state="visible", timeout=25000)
            page.wait_for_timeout(400)

        def close_modal(name="בטל"):
            # exact=True: the card behind the modal carries a "בטל הפקה" button
            page.get_by_role("button", name=name, exact=True).first.click()
            page.locator(MODAL).first.wait_for(state="detached", timeout=25000)
            page.wait_for_timeout(800)

        # ═══ the hourly show ════════════════════════════════════════════════
        drawer = open_drawer(f"{MARK} hourly")
        check("1. /productions painted and the drawer opened",
              drawer.count() > 0 and len(page.inner_text("body").strip()) > 300)

        # tap 1 — pending → in_progress, which pops the DISK modal
        tap_record(drawer)
        check("2. tap 1 opens the disk modal",
              page.get_by_text("לאיזה דיסק הוקלט הפרק?").count() > 0,
              page.inner_text("body")[:200])
        close_modal()
        check("2b. the recording step turned amber (in progress) before the next tap",
              wait_step(drawer, "amber"), record_button(drawer).get_attribute("class"))

        # tap 2 — in_progress → done, which pops the NOTE modal, now carrying
        # the hours field because this show is priced by the hour
        tap_record(drawer)
        # the modal only follows a stage that actually moved — asserting the
        # row first tells a failed CLICK apart from a missing MODAL, which are
        # two different bugs with the same symptom
        st = get(f"stages?select=status&production_id=eq.{p_hourly}&track=eq.episode&step=eq.record")
        check("2c. the recording step reached 'done'", st and st[0]["status"] == "done", str(st))
        # the DETAIL is the modal's own text, not the page body: when this fails
        # the only useful question is "which dialog is up instead", and the body
        # answers with 300 characters of board header
        check("3. tap 2 opens the note modal with the hours question",
              page.get_by_text("כמה שעות אולפן הוקלטו?").count() > 0,
              (page.locator(MODAL).first.inner_text().replace("\n", " | ")
               if page.locator(MODAL).count() else "NO MODAL ON SCREEN"))
        hours_input = page.locator('input[type="number"][step="0.25"]')
        check("3b. a numeric hours field is on screen, stepping in quarter hours",
              hours_input.count() == 1, f"count={hours_input.count()}")
        check("3c. it is capped at 24", hours_input.first.get_attribute("max") == "24",
              str(hours_input.first.get_attribute("max")))

        # ---- "דלג" is HIDDEN while the field is empty ----------------------
        check("4. 'דלג' is absent while the hours are missing",
              page.get_by_role("button", name="דלג").count() == 0)
        check("4b. ...and the sentence stands in its place",
              page.get_by_text("בלי שעות לא תיווצר הזמנת עבודה").count() > 0,
              page.inner_text("body")[:300])
        save = page.get_by_role("button", name="שמור").first
        check("4c. שמור is disabled until a number is entered", save.is_disabled())

        # ---- the note stays optional: hours alone must save ----------------
        hours_input.first.fill("3.5")
        page.wait_for_timeout(300)
        check("5. שמור enables on a valid number, with the note left empty",
              not page.get_by_role("button", name="שמור").first.is_disabled())
        page.get_by_role("button", name="שמור").first.click()

        # ---- what the server got ------------------------------------------
        row = poll(lambda: (get(f"productions?select=studio_hours&id=eq.{p_hourly}") or [{}])[0].get("studio_hours"))
        check("6. studio_hours reached the database", row is not None and float(row) == 3.5, str(row))
        wo = poll(lambda: get(f"pending_documents?select=id,amount,status&production_id=eq.{p_hourly}&doc_type=eq.work_order"))
        check("6b. a work order was queued at 3.5 × 250 = 875",
              wo and len(wo) == 1 and float(wo[0]["amount"]) == 875.0,
              json.dumps(wo, ensure_ascii=False)[:200])

        # ---- the technician never saw the money ----------------------------
        page.wait_for_timeout(500)
        body_text = page.inner_text("body")
        check("7. the technician's screen never shows the computed amount",
              "875" not in body_text, "the amount is on screen")
        check("7b. ...nor the hourly rate", "250" not in body_text, "the rate is on screen")

        # ---- the flag is gone now that the hours exist ---------------------
        drawer = open_drawer(f"{MARK} hourly")
        check("8. the missing-hours flag is gone once the hours are entered",
              page.get_by_text("לא הוזנו שעות הקלטה").count() == 0)

        # ═══ the inverse image: a per-episode show ══════════════════════════
        drawer = open_drawer(f"{MARK} episodic")
        tap_record(drawer)
        close_modal()
        wait_step(drawer, "amber")
        tap_record(drawer)
        check("9. a per-episode show gets the plain note modal",
              page.get_by_text("רוצה להוסיף הערה?").count() > 0,
              (page.locator(MODAL).first.inner_text().replace("\n", " | ")
               if page.locator(MODAL).count() else "NO MODAL ON SCREEN"))
        check("9b. ...with NO hours field",
              page.locator('input[type="number"][step="0.25"]').count() == 0)
        check("9c. ...and 'דלג' is available, because skipping costs nothing here",
              page.get_by_role("button", name="דלג").count() > 0)
        page.get_by_role("button", name="דלג").first.click()
        page.wait_for_timeout(800)

        # ═══ the flag, on a production recorded WITHOUT hours ═══════════════
        # p3 reaches הוקלט with no hours at all — the state the flag exists for
        p3 = make_production(flagged["id"], cli["id"], f"{MARK} flagged")
        requests.patch(f"{SUP}/rest/v1/productions?id=eq.{p3}", headers=ADMIN, json={"status": "הוקלט"})
        card3 = find_card(f"{MARK} flagged").first
        check("10. the board card carries the missing-hours badge",
              card3.get_by_text("חסרות שעות").count() > 0, card3.inner_text()[:200])
        card3.get_by_text(f"{MARK} flagged", exact=True).first.click()
        page.locator("aside").wait_for(state="visible", timeout=15000)
        page.wait_for_timeout(1200)
        # WAIT for it, do not sample it: the flag is derived from `data.hourly`,
        # which arrives with the drawer's own fetch a beat after the aside is
        # visible. Sampling at the wrong beat reported "no flag" on a drawer
        # that grew one 200ms later — and check 11 below then passed on the very
        # button 10c had just called missing.
        flag = page.get_by_text("לא הוזנו שעות הקלטה")
        try:
            flag.first.wait_for(state="visible", timeout=15000)
        except Exception:
            pass
        check("10b. the drawer shows the red flag", flag.count() > 0,
              page.locator("aside").inner_text()[:300].replace("\n", " | "))
        enter = page.get_by_role("button", name="הזן שעות")
        check("10c. ...and it carries a button, so it is an action and not a notice",
              enter.count() > 0)

        # the button opens the SAME hours modal — this is what closes the loop
        enter.first.click()
        page.wait_for_timeout(900)
        check("11. the flag's button opens the hours modal directly",
              page.get_by_text("כמה שעות אולפן הוקלטו?").count() > 0, page.inner_text("body")[:300])
        page.locator('input[type="number"][step="0.25"]').first.fill("2")
        page.wait_for_timeout(300)
        page.get_by_role("button", name="שמור").first.click()
        wo3 = poll(lambda: get(f"pending_documents?select=amount&production_id=eq.{p3}&doc_type=eq.work_order"))
        check("11b. it priced 2 × 250 = 500 through the same route",
              wo3 and len(wo3) == 1 and float(wo3[0]["amount"]) == 500.0,
              json.dumps(wo3, ensure_ascii=False)[:200])
        page.wait_for_timeout(800)

        card3 = find_card(f"{MARK} flagged").first
        check("11c. the board badge cleared", card3.get_by_text("חסרות שעות").count() == 0,
              card3.inner_text()[:200])

        shot = os.path.join(SHOT_DIR, "hourly-hours.png")
        page.screenshot(path=shot, full_page=True)
        print(f"screenshot: {shot}")

        real_errors = [e for e in errors if "favicon" not in e.lower()]
        check("12. no uncaught client errors during the whole flow",
              len(real_errors) == 0, "; ".join(real_errors[:3]))
        browser.close()

finally:
    print("\n--- cleanup ---")
    for pid in prods:
        for link in (get(f"job_productions?select=job_id&production_id=eq.{pid}") or []):
            if link["job_id"] not in jobs:
                jobs.append(link["job_id"])
        requests.delete(f"{SUP}/rest/v1/pending_documents?production_id=eq.{pid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/job_productions?production_id=eq.{pid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/stages?production_id=eq.{pid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/production_log?production_id=eq.{pid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{pid}", headers=ADMIN)
    for jid in jobs:
        requests.delete(f"{SUP}/rest/v1/pending_documents?job_id=eq.{jid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{jid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/jobs?id=eq.{jid}", headers=ADMIN)
    for pid in prods:
        requests.delete(f"{SUP}/rest/v1/productions?id=eq.{pid}", headers=ADMIN)
    for sid in shows:
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{sid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/shows?id=eq.{sid}", headers=ADMIN)
    for cid in clients:
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{cid}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/clients?id=eq.{cid}", headers=ADMIN)
    for u in users:
        requests.delete(f"{SUP}/rest/v1/events?actor_id=eq.{u}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/events?entity_id=eq.{u}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/production_log?author_id=eq.{u}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/approval_requests?user_id=eq.{u}", headers=ADMIN)
        requests.delete(f"{SUP}/rest/v1/profiles?id=eq.{u}", headers=ADMIN)
        requests.delete(f"{SUP}/auth/v1/admin/users/{u}", headers=ADMIN)
    left = {"productions": get(f"productions?select=id&podcast_name=like.{MARK}*"),
            "shows": get(f"shows?select=id&name=like.{MARK}*"),
            "clients": get(f"clients?select=id&name=like.{MARK}*"),
            "jobs": get(f"jobs?select=id&campaign=like.{MARK}*")}
    check("cleanup: nothing left behind", all(len(v) == 0 for v in left.values()),
          json.dumps(left, ensure_ascii=False))

print(("\nALL PASSED" if not fails else f"\n{len(fails)} FAILED: " + ", ".join(fails)))
sys.exit(1 if fails else 0)
