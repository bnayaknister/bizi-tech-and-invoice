# -*- coding: utf-8 -*-
"""
Morning LIVE integration test — one document, one call, maximum caution.

There is no sandbox (owner confirmed 2026-07-20): this talks to the real
production account. Running it with --live creates a REAL document in the
owner's books. Treat every safeguard here as load-bearing.

What it does (only with BOTH --live AND an interactive "yes"):
  POST /documents  type=300 (חשבון עסקה — a NON-tax, reversible document),
  amount 1 ₪, client = ביזי סטודיו בע״מ (the owner's OWN business),
  description "בדיקת אינטגרציה", client.add=false.

Safeguards:
  - Without --live it prints the exact payload and exits. Nothing is sent.
  - With --live it STILL prints the payload and waits for a typed "כן"
    before sending. Two gates.
  - type is asserted 300; the script refuses to send anything else. A tax
    document (305/320) can never go out through this test.
  - Every step is written to events (started / sent / result / error) via
    the service role, including the full Morning response.
  - Any non-201, any network error, any unexpected shape -> stop, log, exit.

Auth host and resource host are the two verified production hosts; see
src/lib/morning/client.ts for why they differ.
"""
import argparse
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

IDP_HOST = "https://api.morning.co"
RESOURCE_BASE = "https://api.greeninvoice.co.il/api/v1"

# The owner's own business in Morning (verified 2026-07-20). Hard-coded so a
# typo can't retarget a real client — this test bills the studio itself.
BIZI_STUDIO = {"id": "f93ec57b-6688-419c-98fd-c8ff52e1b538", "name": "ביזי סטודיו בע״מ", "taxId": "516317385"}

DEAL_INVOICE = 300  # חשבון עסקה — non-tax, reversible
NIL_UUID = "00000000-0000-0000-0000-000000000000"

env = {}
ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env.local")
with open(ENV_PATH, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()

SUPABASE_URL = env["NEXT_PUBLIC_SUPABASE_URL"]
SERVICE_KEY = env["SUPABASE_SERVICE_ROLE_KEY"]


def event(event_type, payload):
    body = json.dumps({
        "entity_type": "morning_test",
        "entity_id": NIL_UUID,
        "event_type": event_type,
        "payload": payload,
    }).encode()
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/events", data=body, method="POST",
        headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
                 "Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=15)
    except Exception as e:
        print(f"  (warning: could not write event {event_type}: {e})")


def get_token():
    body = json.dumps({
        "grant_type": "client_credentials",
        "client_id": env["MORNING_CLIENT_ID"],
        "client_secret": env["MORNING_CLIENT_SECRET"],
    }).encode()
    req = urllib.request.Request(f"{IDP_HOST}/idp/v1/oauth/token", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())["accessToken"]


def build_payload():
    return {
        "type": DEAL_INVOICE,
        "lang": "he",
        "currency": "ILS",
        "vatType": 0,
        "description": "בדיקת אינטגרציה",
        "client": {
            "id": BIZI_STUDIO["id"],
            "name": BIZI_STUDIO["name"],
            "add": False,  # never auto-create a client
        },
        "income": [
            {
                "description": "בדיקת אינטגרציה",
                "quantity": 1,
                "price": 1,
                "currency": "ILS",
                "vatType": 0,
            }
        ],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="actually send the request to Morning")
    args = ap.parse_args()

    payload = build_payload()

    # invariant: this test may only ever send a non-tax deal invoice
    assert payload["type"] == DEAL_INVOICE, "refusing: type is not 300"

    print("=" * 64)
    print("MORNING LIVE TEST — exact payload that would be POSTed to")
    print(f"  {RESOURCE_BASE}/documents")
    print("=" * 64)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    print("=" * 64)
    print(f"client: {BIZI_STUDIO['name']}  (taxId {BIZI_STUDIO['taxId']})")
    print("type 300 = חשבון עסקה (NON-tax, reversible)")
    print("amount: 1 ₪")

    if not args.live:
        print("\nDRY: --live not given. Nothing was sent.")
        return

    # second gate: even with --live, require a typed confirmation
    print("\n⚠️  --live is set. This will create a REAL document in the owner's books.")
    ans = input('Type exactly  כן  to send, anything else to abort: ').strip()
    if ans != "כן":
        print("Aborted. Nothing was sent.")
        return

    event("morning_test_started", {"payload": payload, "host": RESOURCE_BASE})

    try:
        token = get_token()
    except Exception as e:
        event("morning_test_error", {"stage": "token", "error": str(e)})
        sys.exit(f"STOP: token request failed: {e}")

    body = json.dumps(payload).encode()
    req = urllib.request.Request(f"{RESOURCE_BASE}/documents", data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {token}"})
    event("morning_test_sent", {"payload": payload})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            status = r.status
            result = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:800]
        event("morning_test_error", {"stage": "documents", "status": e.code, "body": detail})
        sys.exit(f"STOP: Morning returned {e.code}: {detail}")
    except Exception as e:
        event("morning_test_error", {"stage": "documents", "error": str(e)})
        sys.exit(f"STOP: request failed: {e}")

    if status != 201:
        event("morning_test_error", {"stage": "documents", "status": status, "body": result})
        sys.exit(f"STOP: expected 201, got {status}: {json.dumps(result, ensure_ascii=False)[:400]}")

    tax_err = result.get("taxAuthorityConfirmationLastError")
    event("morning_test_result", {
        "status": status,
        "morning_doc_id": result.get("id"),
        "doc_number": result.get("number"),
        "url": result.get("url"),
        "tax_authority_last_error": tax_err,
        "returned": result,
    })

    print("\n" + "=" * 64)
    print("✅ DOCUMENT CREATED")
    print(f"  id:      {result.get('id')}")
    print(f"  number:  {result.get('number')}")
    print(f"  url:     {result.get('url')}")
    if tax_err not in (0, None):
        print(f"  ⚠️ taxAuthorityConfirmationLastError = {tax_err}")
    print("=" * 64)
    print("Logged to events (entity_type=morning_test). This is a REAL")
    print("document — to void it, issue a credit note in Morning directly.")


if __name__ == "__main__":
    main()
