# -*- coding: utf-8 -*-
"""
The header navigation menu, in a REAL browser (2026-10-07).

WHY THIS FILE EXISTS. The two bugs the owner found in production could not have
been caught by the render suite, and were not:

  1. "The menu closes when the mouse moves down to it, so it cannot be used at
     all." A `mouseleave` across an 8px margin. There is no margin in an HTML
     string — only a real pointer crossing real geometry can see it.
  2. "The menu is cut off under the global search row and other elements." A
     stacking context created by the header's `backdrop-filter`. Which element
     actually paints on top is a question only a layout engine answers.

So the decisive assertion here is `document.elementFromPoint` at the panel's
own centre: if anything covers the menu, the element under that point is not
the menu. That is a measurement, not a screenshot someone has to squint at.

⚠️ THIS SUITE WRITES TO THE DATABASE — exactly ONE throwaway auth user, so an
authenticated page can be opened at all. It creates NO business rows: the menu
is built from the module registry and needs no data. The user is deleted in
`finally` and the deletion is VERIFIED. It is therefore NOT part of the offline
F19 set and must be run deliberately.

TOUCHES MORNING: never.

Requires: pip install playwright && playwright install chromium
Run:    TEST_APP_URL=http://localhost:3100 python3 scripts/test_nav_menu_browser.py
Headed: HEADED=1 TEST_APP_URL=http://localhost:3100 python3 scripts/test_nav_menu_browser.py
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
for _l in open(os.path.join(ROOT, ".env.local"), encoding="utf-8"):
    _l = _l.strip()
    if _l and not _l.startswith("#") and "=" in _l:
        _k, _v = _l.split("=", 1)
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

results = []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail else ""))
    results.append((name, bool(ok)))


# Is the panel actually usable right now? Not "is it in the DOM" — visible,
# on top, and hit-testable.
PANEL_STATE = """
() => {
  const pop = document.querySelector('.navm-pop');
  const panel = document.getElementById('navm-panel');
  if (!pop || !panel) return { missing: true };
  const cs = getComputedStyle(pop);
  const r = panel.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + Math.min(r.height / 2, 40));
  const hit = document.elementFromPoint(cx, cy);
  const root = document.querySelector('[data-navm="root"]');
  return {
    visibility: cs.visibility,
    opacity: cs.opacity,
    pointerEvents: cs.pointerEvents,
    dataOpen: root ? root.getAttribute('data-open') : null,
    expanded: document.querySelector('.navm-trigger')?.getAttribute('aria-expanded'),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    // the decisive one: what is painted at the panel's own centre?
    hitIsInPanel: !!hit && panel.contains(hit),
    hitTag: hit ? hit.tagName + '.' + (hit.className || '').toString().split(' ')[0] : null,
    viewportW: window.innerWidth,
    // every ancestor that clips or traps the panel
    badAncestors: (() => {
      const out = [];
      let el = panel.parentElement;
      while (el && el !== document.documentElement) {
        const s = getComputedStyle(el);
        const traps = [];
        if (s.overflow !== 'visible') traps.push('overflow:' + s.overflow);
        if (s.transform !== 'none') traps.push('transform');
        if (s.filter !== 'none') traps.push('filter');
        if (s.contain !== 'none') traps.push('contain:' + s.contain);
        if (s.backdropFilter && s.backdropFilter !== 'none') traps.push('backdrop-filter');
        if (traps.length) out.push((el.tagName + '.' + (el.className || '').toString().split(' ')[0]) + ' => ' + traps.join(','));
        el = el.parentElement;
      }
      return out;
    })(),
  };
}
"""

uid = None
try:
    print(f"target: {APP}  (cookie domain: {COOKIE_DOMAIN})")
    email = f"ztest-nav-{uuid.uuid4().hex[:8]}@example.com"
    pw = f"Test-{uuid.uuid4().hex}!A1"
    u = requests.post(f"{SUP}/auth/v1/admin/users", headers=ADMIN,
                      json={"email": email, "password": pw, "email_confirm": True}).json()
    uid = u["id"]
    requests.patch(f"{SUP}/rest/v1/profiles?id=eq.{uid}", headers=ADMIN,
                   json={"approved": True, "can_view_stages": True, "can_edit_stages": True,
                         "can_view_money": True, "can_edit_money": True, "role": "owner"})
    tok = requests.post(f"{SUP}/auth/v1/token?grant_type=password",
                        headers={"apikey": ANON, "Content-Type": "application/json"},
                        json={"email": email, "password": pw}).json()
    val = "base64-" + base64.b64encode(json.dumps(tok, separators=(",", ":")).encode()).decode()
    cname = f"sb-{REF}-auth-token"
    pairs = ([(cname, val)] if len(val) <= 3180
             else [(f"{cname}.{i}", val[s:s + 3180]) for i, s in enumerate(range(0, len(val), 3180))])
    cookies = [{"name": n, "value": v, "domain": COOKIE_DOMAIN, "path": "/"} for n, v in pairs]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not HEADED, slow_mo=250 if HEADED else 0)

        # ══════════ DESKTOP ══════════
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        ctx.add_cookies(cookies)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        # /radar, not the hub: a working screen, where page content sits right
        # under the header and is what used to cover the panel
        page.goto(f"{APP}/radar", wait_until="networkidle", timeout=90_000)
        page.wait_for_selector('[data-navm="root"]', timeout=30_000)

        st = page.evaluate(PANEL_STATE)
        check("the menu starts closed", st["visibility"] == "hidden", f"visibility={st['visibility']}")
        check("aria-expanded starts false", st["expanded"] == "false", st["expanded"])
        check("JS took over (data-js stamped)",
              page.get_attribute('[data-navm="root"]', "data-js") == "on")

        # ── BUG 2: nothing clips or traps the panel ──
        print(f"\n  ancestors that create a context or clip: {st['badAncestors']}")
        clippers = [a for a in st["badAncestors"] if "overflow:" in a or "contain:" in a]
        check("no ancestor CLIPS the panel", clippers == [], str(clippers))

        # ── BUG 1: hover the logo, then WALK the pointer into the panel ──
        logo = page.locator(".navm-logo")
        logo.hover()
        page.wait_for_timeout(250)
        st = page.evaluate(PANEL_STATE)
        check("hovering the logo opens the menu", st["visibility"] == "visible", str(st))
        check("...and reports it open", st["dataOpen"] == "true" and st["expanded"] == "true")

        box = page.locator("#navm-panel").bounding_box()
        # a DIAGONAL walk, the movement that used to kill it: down and left
        lb = logo.bounding_box()
        page.mouse.move(lb["x"] + lb["width"] / 2, lb["y"] + lb["height"] / 2)
        steps = [
            (lb["x"] + lb["width"] / 2, lb["y"] + lb["height"] + 2),   # into the bridge
            (box["x"] + box["width"] * 0.75, box["y"] + 6),            # top of the panel
            (box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.4),
        ]
        ok_all = True
        for i, (x, y) in enumerate(steps):
            page.mouse.move(x, y, steps=6)
            page.wait_for_timeout(120)
            s = page.evaluate(PANEL_STATE)
            if s["visibility"] != "visible":
                ok_all = False
                print(f"       closed at step {i} ({int(x)},{int(y)})")
        check("the menu SURVIVES the pointer walking into it", ok_all)

        st = page.evaluate(PANEL_STATE)
        check("the panel is hit-testable at its own centre", st["hitIsInPanel"],
              f"elementFromPoint => {st['hitTag']}")
        check("the panel accepts the pointer", st["pointerEvents"] == "auto", st["pointerEvents"])
        page.screenshot(path=os.path.join(SHOT_DIR, "nav-desktop-open.png"))

        # ── a row actually navigates ──
        rows = page.locator(".navm-item")
        n = rows.count()
        check("the panel holds the owner's rows", n >= 10, f"{n} rows")
        target = page.locator('.navm-item[href="/shows"]')
        check("the shows row is there exactly once", target.count() == 1)
        target.click()
        page.wait_for_url("**/shows", timeout=30_000)
        check("clicking a row navigates", page.url.endswith("/shows"), page.url)
        page.wait_for_selector('[data-navm="root"]', timeout=30_000)
        check("the menu closed after navigating",
              page.evaluate(PANEL_STATE)["visibility"] == "hidden")

        # ── the current screen is marked, on the screen we are on ──
        cur = page.locator('.navm-item[aria-current="page"]')
        check("exactly one row is marked", cur.count() == 1, f"{cur.count()}")
        check("and it is the screen we are on", cur.first.get_attribute("href") == "/shows")

        # ── Esc ──
        page.locator(".navm-logo").hover()
        page.wait_for_timeout(250)
        check("open again before Esc", page.evaluate(PANEL_STATE)["visibility"] == "visible")
        page.keyboard.press("Escape")
        page.wait_for_timeout(250)
        st = page.evaluate(PANEL_STATE)
        check("Esc closes it", st["visibility"] == "hidden", str(st["visibility"]))
        check("focus went back to the trigger",
              page.evaluate("() => document.activeElement?.classList.contains('navm-trigger')"))
        page.wait_for_timeout(300)
        check("Esc does not bounce back open (the focus guard)",
              page.evaluate(PANEL_STATE)["visibility"] == "hidden")

        # ── click outside ──
        page.locator(".navm-trigger").click()
        page.wait_for_timeout(200)
        check("the trigger opens it by click", page.evaluate(PANEL_STATE)["visibility"] == "visible")
        page.mouse.click(700, 700)
        page.wait_for_timeout(250)
        check("a click outside closes it", page.evaluate(PANEL_STATE)["visibility"] == "hidden")

        # ── keyboard: real Tab presses, not locator.focus() ──
        # 🔴 `.focus()` is SCRIPT focus and deliberately does not set
        # `:focus-visible` — testing with it would measure the wrong thing and,
        # worse, would pass if the menu opened on a mouse press too. So this
        # walks the focus ring with actual Tab keys, which is what a keyboard
        # user does and what sets :focus-visible.
        # A fresh load, so the focus ring starts at the top of the document
        # rather than wherever the previous click left it.
        page.goto(f"{APP}/shows", wait_until="networkidle", timeout=90_000)
        page.wait_for_selector('[data-navm="root"]', timeout=30_000)
        page.mouse.move(700, 700)  # pointer away, so hover plays no part
        page.wait_for_timeout(250)
        check("closed before the keyboard pass", page.evaluate(PANEL_STATE)["visibility"] == "hidden")
        reached = False
        for _ in range(8):
            page.keyboard.press("Tab")
            page.wait_for_timeout(120)
            if page.evaluate("() => document.activeElement?.classList.contains('navm-trigger')"):
                reached = True
                break
        check("Tab reaches the trigger", reached)
        page.wait_for_timeout(200)
        check("keyboard focus on the trigger opens it",
              page.evaluate(PANEL_STATE)["visibility"] == "visible",
              page.evaluate(PANEL_STATE)["visibility"])
        page.keyboard.press("Tab")
        page.wait_for_timeout(200)
        st = page.evaluate(PANEL_STATE)
        inside = page.evaluate("() => !!document.getElementById('navm-panel')?.contains(document.activeElement)")
        check("Tab moves focus INTO the panel", inside,
              page.evaluate("() => document.activeElement?.className?.toString().slice(0,40)"))
        check("...and the panel stays open", st["visibility"] == "visible")
        # and Tabbing all the way OUT closes it
        for _ in range(40):
            if not page.evaluate("() => { const p = document.querySelector('[data-navm=\"root\"]');"
                                 " return p.contains(document.activeElement); }"):
                break
            page.keyboard.press("Tab")
        page.wait_for_timeout(250)
        check("focus leaving the menu closes it", page.evaluate(PANEL_STATE)["visibility"] == "hidden")

        check("no page errors on the desktop pass", errors == [], str(errors[:2]))
        ctx.close()

        # ══════════ PHONE (390px) ══════════
        ctx2 = browser.new_context(viewport={"width": 390, "height": 780},
                                   has_touch=True, is_mobile=True)
        ctx2.add_cookies(cookies)
        mp = ctx2.new_page()
        merrors = []
        mp.on("pageerror", lambda e: merrors.append(str(e)))
        mp.goto(f"{APP}/radar", wait_until="networkidle", timeout=90_000)
        mp.wait_for_selector('[data-navm="root"]', timeout=30_000)

        st = mp.evaluate(PANEL_STATE)
        check("phone: starts closed", st["visibility"] == "hidden")
        mp.locator(".navm-trigger").tap()
        mp.wait_for_timeout(300)
        st = mp.evaluate(PANEL_STATE)
        check("phone: a tap opens it", st["visibility"] == "visible", str(st["visibility"]))
        # only meaningful once it is OPEN: a hidden panel still has a box, and
        # hit-testing it measures whatever happens to sit there instead
        check("phone: hit-testable while open",
              st["visibility"] == "visible" and st["hitIsInPanel"], f"=> {st['hitTag']}")
        # never wider than the screen, and never off its edges
        r = st["rect"]
        check("phone: the panel fits the viewport width",
              r["x"] >= 0 and r["x"] + r["w"] <= st["viewportW"],
              f"x={r['x']} w={r['w']} vw={st['viewportW']}")
        check("phone: the list scrolls inside rather than off-screen",
              mp.evaluate("() => { const p = document.getElementById('navm-panel');"
                          " return p.scrollHeight <= p.clientHeight || getComputedStyle(p).overflowY === 'auto'; }"))
        check("phone: the page does not scroll sideways",
              mp.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1"),
              str(mp.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")))
        mp.screenshot(path=os.path.join(SHOT_DIR, "nav-phone-open.png"))

        # a second tap closes it. 🔴 This is the regression the focus handler
        # caused and the `:focus-visible` guard fixed: a touch press focuses the
        # trigger, and when focus ALSO opened the menu the click that followed
        # toggled it straight back shut — one tap, nothing opened.
        mp.locator(".navm-trigger").tap()
        mp.wait_for_timeout(300)
        check("phone: a second tap closes it", mp.evaluate(PANEL_STATE)["visibility"] == "hidden")
        mp.locator(".navm-trigger").tap()
        mp.wait_for_timeout(300)
        check("phone: and a third opens it again", mp.evaluate(PANEL_STATE)["visibility"] == "visible")

        # the X, which is the phone's only way out besides tapping away
        x = mp.locator('button[aria-label="סגור תפריט"]')
        check("phone: the X is visible", x.is_visible())
        x.tap()
        mp.wait_for_timeout(300)
        check("phone: the X closes it", mp.evaluate(PANEL_STATE)["visibility"] == "hidden")
        mp.locator(".navm-trigger").tap()
        mp.wait_for_timeout(250)
        mp.touchscreen.tap(195, 700)
        mp.wait_for_timeout(300)
        check("phone: a tap outside closes it", mp.evaluate(PANEL_STATE)["visibility"] == "hidden")
        check("no page errors on the phone pass", merrors == [], str(merrors[:2]))
        ctx2.close()
        browser.close()
        print(f"\nscreenshots: {SHOT_DIR}/nav-desktop-open.png, {SHOT_DIR}/nav-phone-open.png")

finally:
    # the cleanup rule: delete every test row, and VERIFY. Nothing but the auth
    # user was ever created, and `profiles` cascades from it.
    if uid:
        requests.delete(f"{SUP}/rest/v1/events?actor_id=eq.{uid}", headers=ADMIN)
        d = requests.delete(f"{SUP}/auth/v1/admin/users/{uid}", headers=ADMIN)
        left = requests.get(f"{SUP}/rest/v1/profiles?id=eq.{uid}&select=id", headers=ADMIN).json()
        print(f"\ncleanup: user {uid} delete={d.status_code} profiles_left={len(left)}")
        if left:
            print("🔴 CLEANUP INCOMPLETE")
            results.append(("cleanup removed the test user", False))
        else:
            results.append(("cleanup removed the test user", True))

bad = [n for n, ok in results if not ok]
print(f"\n{'OK' if not bad else 'FAILED'}  {len(results) - len(bad)}/{len(results)} checks passed")
for n in bad:
    print(f"  - {n}")
sys.exit(1 if bad else 0)
