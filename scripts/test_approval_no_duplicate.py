# -*- coding: utf-8 -*-
"""
Acceptance test for migration 0011 (the duplicate-job trigger fix).

  1. approve a production that is ALREADY linked to a job
     -> no new job is created; client_approved_already_billed is logged
  2. approve an unlinked production
     -> a job IS created and linked (the automation still works)

Runs on throwaway rows; cleans up everything including generated events.
If 0011 is not applied, check 1 fails loudly (a duplicate job appears).
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
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
     "Content-Type": "application/json", "Prefer": "return=representation"}

failures = []


def api(method, path, params=None, body=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers=H)
    try:
        with urllib.request.urlopen(req) as r:
            text = r.read().decode()
            return json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        print("ERROR", method, path, e.code, e.read().decode()[:400], file=sys.stderr)
        raise


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail and not ok else ""))
    if not ok:
        failures.append(label)


def approve(prod_id):
    api("PATCH", "productions", params={"id": f"eq.{prod_id}"}, body={"status": 'אושר_ע"י_לקוח'})


def main():
    tag = uuid.uuid4().hex[:6]
    client = api("POST", "clients", body={"name": f"בדיקת-אישור-{tag}",
                                          "normalized_name": f"בדיקתאישור{tag}"})[0]
    p_linked = api("POST", "productions", body={
        "podcast_name": f"בדיקת-אישור-מקושרת-{tag}", "kind": "client", "client_id": client["id"]})[0]
    p_free = api("POST", "productions", body={
        "podcast_name": f"בדיקת-אישור-חופשית-{tag}", "kind": "client", "client_id": client["id"]})[0]
    job = api("POST", "jobs", body={"campaign": f"בדיקת-אישור-{tag}", "client_id": client["id"], "amount": 1})[0]
    api("POST", "job_productions", body={"job_id": job["id"], "production_id": p_linked["id"]})

    cleanup_jobs = [job["id"]]
    try:
        jobs_before = len(api("GET", "jobs", params={"select": "id"}))

        # 1. already linked → no duplicate
        approve(p_linked["id"])
        jobs_after = api("GET", "jobs", params={"select": "id"})
        check("1a approve linked production → no new job", len(jobs_after) == jobs_before,
              f"before={jobs_before} after={len(jobs_after)}")
        ev = api("GET", "events", params={"select": "id",
                                          "entity_id": f"eq.{p_linked['id']}",
                                          "event_type": "eq.client_approved_already_billed"})
        check("1b client_approved_already_billed logged", len(ev) == 1, f"events={len(ev)}")

        # 2. unlinked → automation still creates + links a job
        approve(p_free["id"])
        links = api("GET", "job_productions", params={"select": "job_id",
                                                      "production_id": f"eq.{p_free['id']}"})
        check("2a approve unlinked production → job created and linked", len(links) == 1,
              f"links={len(links)}")
        if links:
            cleanup_jobs.append(links[0]["job_id"])
        jobs_final = api("GET", "jobs", params={"select": "id"})
        check("2b exactly one job added overall", len(jobs_final) == jobs_before + 1,
              f"before={jobs_before} final={len(jobs_final)}")

    finally:
        for jid in cleanup_jobs:
            api("DELETE", "jobs", params={"id": f"eq.{jid}"})
        for pid in (p_linked["id"], p_free["id"]):
            api("DELETE", "events", params={"entity_id": f"eq.{pid}"})
            api("DELETE", "productions", params={"id": f"eq.{pid}"})
        api("DELETE", "clients", params={"id": f"eq.{client['id']}"})
        print("cleaned up throwaway rows + their events")

    if failures:
        print(f"{len(failures)} FAILURES — stop and fix.")
        sys.exit(1)
    print("all checks passed — approval never duplicates billing")


if __name__ == "__main__":
    main()
