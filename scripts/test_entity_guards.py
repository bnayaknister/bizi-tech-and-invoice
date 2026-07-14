# -*- coding: utf-8 -*-
"""
Acceptance test for the EntityDrawer security model (migration 0010).

The drawer's API runs every read/write through the acting user's own
Supabase session, so testing PostgREST with real user tokens tests
exactly the walls the drawer stands behind.

  tech (stages only, the money-blind role):
    1a. SELECT jobs (any column, incl. amount)   -> zero rows (RLS: no policy)
    1b. UPDATE jobs.amount                       -> zero rows updated (RLS)
        ("לא מקבל amount מהשרת בכלל" — the row itself never reaches him)
    1c. UPDATE productions.on_hold               -> allowed (stages field)
  money-only user (can_edit_money, no stages permissions):
    2a. UPDATE jobs.amount                       -> allowed
    2b. UPDATE productions.on_hold               -> BLOCKED by
        trg_guard_production_stages (RLS alone would have let this through —
        productions_update allows money OR stages; the 0010 trigger is the wall)
    2c. UPDATE productions.status                -> BLOCKED by the same trigger
    2d. UPDATE clients.billing_mode              -> allowed (money field)
  stages editor on clients:
    3.  UPDATE clients.billing_mode              -> zero rows (RLS)

Runs against throwaway rows + throwaway users; never touches real data.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")
if os.path.exists(ENV_PATH):
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
ANON_KEY = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

failures = []


def req(method, url, headers, body=None):
    """Returns (status_code, parsed_json_or_None). Never raises on HTTP errors."""
    r = urllib.request.Request(
        url, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **headers},
    )
    try:
        with urllib.request.urlopen(r) as resp:
            text = resp.read().decode()
            return resp.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        try:
            return e.code, json.loads(text)
        except ValueError:
            return e.code, text


ADMIN = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}
REPR = {"Prefer": "return=representation"}


def rest(path):
    return f"{SUPABASE_URL}/rest/v1/{path}"


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        failures.append(label)


def make_user(name, perms):
    email = f"drawer-test-{uuid.uuid4().hex[:8]}@bizi-test.local"
    password = f"Test-{uuid.uuid4().hex}!A1"
    code, body = req("POST", f"{SUPABASE_URL}/auth/v1/admin/users", ADMIN,
                     {"email": email, "password": password, "email_confirm": True})
    assert code < 300, body
    uid = body["id"]
    code, body = req("PATCH", rest(f"profiles?id=eq.{uid}"), ADMIN,
                     {"name": name, "approved": True, **perms})
    assert code < 300, body
    code, body = req("POST", f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
                     {"apikey": ANON_KEY}, {"email": email, "password": password})
    assert code < 300, body
    return uid, {"apikey": ANON_KEY, "Authorization": f"Bearer {body['access_token']}", **REPR}


def main():
    # gate: migration 0010 must be applied
    code, body = req("GET", rest("productions?select=on_hold&limit=1"), ADMIN)
    if code >= 400:
        sys.exit("productions.on_hold לא קיימת — יש להריץ קודם את מיגרציה 0010 ב-SQL Editor.")

    # throwaway rows
    _, job = req("POST", rest("jobs"), {**ADMIN, **REPR},
                 {"campaign": "בדיקת-מגירה", "amount": 100, "notes": "throwaway"})
    job_id = job[0]["id"]
    _, prod = req("POST", rest("productions"), {**ADMIN, **REPR},
                  {"podcast_name": "בדיקת-מגירה", "notes": "throwaway"})
    prod_id = prod[0]["id"]
    _, client = req("POST", rest("clients"), {**ADMIN, **REPR},
                    {"name": f"בדיקת-מגירה-{uuid.uuid4().hex[:6]}",
                     "normalized_name": f"בדיקתמגירה{uuid.uuid4().hex[:6]}"})
    client_id = client[0]["id"]

    tech_id = money_id = None
    try:
        tech_id, TECH = make_user("טכנאי בדיקה", {
            "can_view_stages": True, "can_edit_stages": True,
            "can_view_money": False, "can_edit_money": False,
        })
        money_id, MONEY = make_user("כספים בדיקה", {
            "can_view_stages": False, "can_edit_stages": False,
            "can_view_money": True, "can_edit_money": True,
        })

        # --- 1. tech: money-blind ---
        code, rows = req("GET", rest(f"jobs?select=id,amount&id=eq.{job_id}"), TECH)
        check("1a tech SELECT jobs → zero rows (amount never reaches him)",
              code == 200 and rows == [], f"code={code} rows={rows}")

        code, rows = req("PATCH", rest(f"jobs?id=eq.{job_id}"), TECH, {"amount": 999999})
        check("1b tech UPDATE jobs.amount → zero rows updated",
              code < 500 and (rows == [] or code >= 400), f"code={code} rows={rows}")
        _, after = req("GET", rest(f"jobs?select=amount&id=eq.{job_id}"), ADMIN)
        check("1b' jobs.amount unchanged in DB", after[0]["amount"] == 100, str(after))

        code, rows = req("PATCH", rest(f"productions?id=eq.{prod_id}"), TECH, {"on_hold": True})
        check("1c tech UPDATE productions.on_hold → allowed",
              code == 200 and rows and rows[0]["on_hold"] is True, f"code={code}")

        # --- 2. money-only user ---
        code, rows = req("PATCH", rest(f"jobs?id=eq.{job_id}"), MONEY, {"amount": 250})
        check("2a money UPDATE jobs.amount → allowed",
              code == 200 and rows and rows[0]["amount"] == 250, f"code={code} rows={rows}")

        code, rows = req("PATCH", rest(f"productions?id=eq.{prod_id}"), MONEY, {"on_hold": False})
        check("2b money UPDATE productions.on_hold → BLOCKED by trigger",
              code >= 400, f"code={code} rows={rows}")

        code, rows = req("PATCH", rest(f"productions?id=eq.{prod_id}"), MONEY, {"status": "הוקלט"})
        check("2c money UPDATE productions.status → BLOCKED by trigger",
              code >= 400, f"code={code} rows={rows}")

        code, rows = req("PATCH", rest(f"clients?id=eq.{client_id}"), MONEY, {"billing_mode": "retainer"})
        check("2d money UPDATE clients.billing_mode → allowed",
              code == 200 and rows and rows[0]["billing_mode"] == "retainer", f"code={code}")

        # --- 3. stages editor on client billing ---
        code, rows = req("PATCH", rest(f"clients?id=eq.{client_id}"), TECH, {"billing_mode": "package"})
        check("3  tech UPDATE clients.billing_mode → zero rows (RLS)",
              code < 500 and (rows == [] or code >= 400), f"code={code} rows={rows}")

    finally:
        for uid in (tech_id, money_id):
            if uid:
                req("DELETE", f"{SUPABASE_URL}/auth/v1/admin/users/{uid}", ADMIN)
        req("DELETE", rest(f"jobs?id=eq.{job_id}"), ADMIN)
        req("DELETE", rest(f"productions?id=eq.{prod_id}"), ADMIN)
        req("DELETE", rest(f"clients?id=eq.{client_id}"), ADMIN)
        print("cleaned up test users + throwaway rows")

    if failures:
        print(f"{len(failures)} FAILURES — stop and fix.")
        sys.exit(1)
    print("all checks passed — the drawer inherits every wall")


if __name__ == "__main__":
    main()
