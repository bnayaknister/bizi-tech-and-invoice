# -*- coding: utf-8 -*-
"""
Step B, owner-approved batch (2026-07-14): the 9 high-confidence
job→production links + manual_only=true for the general jobs.

Owner decisions this encodes:
- The 9 high-confidence proposals: approved as-is.
  - "אפרת לקט בנק הפועלים *2" should link to 2 productions, but only ONE
    production exists on 2026-04-15 (the second recording was never entered
    as a production). Linked to the one that exists — flagged in the report.
  - "חווה זיגנבוים רילז נוסף" links to the SAME production as the
    "חוה זיגנבוים" job (extra reels for the same episode) — intentional.
- manual_only=true for the general/campaign jobs (radio campaigns, studio
  hours, BEPO content). manual_only means: the "unlinked job" alert must
  NEVER fire for them.
- NOT marked manual_only (owner reviews them in the linking screen):
  שוקי איתן, יובל מלחי, דה פקטו *8, SFI פרק 2.

Refuses to run before migration 0009 (job_productions) is applied.
Idempotent: existing links / already-flagged jobs are skipped.
Everything is logged to events.
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


def api(method, path, params=None, body=None, headers=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "apikey": SERVICE_KEY,
            "Authorization": f"Bearer {SERVICE_KEY}",
            "Content-Type": "application/json",
            **(headers or {}),
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            text = r.read().decode()
            return json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        print("ERROR", method, path, e.code, e.read().decode()[:400], file=sys.stderr)
        raise


# (job_id, production_id) — the 9 approved high-confidence links
LINKS = [
    ("07ea2ec5-4d56-48f8-9aa3-82b81d9503c6", "1aeec0a9-cb4c-4d30-b5de-09d82c6844b0"),  # 15.4 ידיעות · אפרת לקט בנק הפועלים *2 → אפרת לקט 15.4 (יש רק הפקה אחת!)
    ("f80d2252-d3fe-49ba-9466-4d24e6727e32", "bf8dd4d3-b82a-40e4-94cc-893ba5a9ef03"),  # 13.5 פארמה תמר · יניב+יפעת → פארמה תמר 13.5 (יפעת בן יוסף)
    ("e9eb2d91-47be-427b-8097-0fd1080e7a6f", "b83ab027-ce6a-4daf-8fce-a11c6c3f86ca"),  # 1.6 נטע צמח · בינה נשית+נועם → בינה נשית 1.6 (נועם)
    ("644e9d34-aed2-46c4-9681-6a2ace221a83", "f9fa699a-7f3e-41f1-8e9c-f71971350ef0"),  # 10.6 ענבל מצנע · רמה בורשטיין → דברים שלמדתי 10.6
    ("fa39346f-3d87-461f-b62c-c3ce97c3aa5c", "024eb7e8-1537-4ee2-ac39-eccd5da064f0"),  # 17.6 הדמוקרטים · פרק 1 → דמוקרטים 17.6
    ("36d2720c-fe53-4254-a818-fe68cd519c14", "8b4aabe5-3dfe-4f35-86b1-39f1a7cf3769"),  # 22.6 ענבל מצנע · חוה זיגנבוים → דברים שלמדתי 22.6
    ("61a702c0-5032-479c-ba2f-334a315e281a", "8b4aabe5-3dfe-4f35-86b1-39f1a7cf3769"),  # 29.6 ענבל מצנע · רילז נוסף → אותה הפקה 22.6 (בכוונה)
    ("73fe118a-7bc7-4d6e-8426-366602ddb2e7", "e6014734-a2fc-4f1c-af55-8ab8d2ec363b"),  # 2.7 יונתן קליין · גלם בלבד → יונתן קליין 2.7
    ("466b195c-0bf3-4099-a835-ad6e9866f0e4", "8c3b6fd9-3a4e-46d7-88d9-778eb50743a0"),  # 5.7 ענבל מצנע · נוף עתמאנה → דברים שלמדתי 5.7
]

# jobs that are general by nature — never linked to a production
MANUAL_ONLY = [
    "acb6eb73-07f8-4640-82f0-1809d4df0e85",  # חוגלה קמפיין (גל אורן לרנר)
    "99d9d06b-0ef5-48f2-b2ab-cbc4a8aa7cbf",  # אלגריה · אודיו+וידאו+גלם
    "eb42317d-a69a-4c79-b3a0-cdce8d9d280a",  # טמפו פסח קמפיין רדיו
    "434694bc-8add-488b-83fa-646fdf08b26d",  # ריץ קרקר קמפיין רדיו
    "a0181cb5-cc3f-4667-81a4-6c58542e25cd",  # מאוחדת ג'וניור
    "fd8c8dc1-c554-4517-af8f-cd72972456a9",  # בלאנקו · פודקאסט מירן פחמן
    "75f3140e-0569-4b87-9a23-f1f33504ff09",  # עיריית ירושלים - נקייה
    "50b53709-df8c-48c5-9f10-307cebbfac12",  # לוסטיג קמפיין רדיו חרדי
    "121bcae3-2155-4914-bc00-4546260632c8",  # תוכן BEPO שירה (החלטת בעלים: אין קישורי BEPO)
    "0faa2bd1-c580-4396-a0c4-bfbfe619ddab",  # טאפר · פודקאסט בוריס
    "f5ccaaea-f0ab-4de4-8a8d-53df23fc2af1",  # טמפו ג'אמפ קמפיין
    "79b1b214-9792-445b-aa62-8f3c4edd3106",  # מכירת ביפו חלק א
    "64198678-e632-4d39-9a9e-66673325f4df",  # רן ניצן · שעתיים אולפן
    "5e2fa487-eaf1-42b3-9b22-437df04e2e9a",  # ענבל מצנע · 2 סרטים עריכות
    "2f133837-0153-4543-9e79-c3e4928a2470",  # תשדיר האגיס
    "bce346b8-7aa1-42d5-8dd8-cd1034a52b25",  # לשבת לקחת · צורית אור
    "4388cb08-6d81-4c85-befc-98c34647ae40",  # לשבת לקחת · לייב רז+חיים כהן
    "f3eef106-aa54-45c9-a96b-27b8b10fad4c",  # תימור גורדון · trustthefungi
    "5008e0c1-d4f3-4ba4-8899-3fc703c4522f",  # עיריית ירושלים - פסטיבל אגדה
    "79881c4b-462b-44d4-9236-45bc9437b6c6",  # עורכת תוכן BEPO ינואר
]


def main():
    # gate: migration 0009 must be applied
    try:
        api("GET", "job_productions", params={"select": "job_id", "limit": 1})
    except urllib.error.HTTPError:
        sys.exit("job_productions לא קיימת — יש להריץ קודם את מיגרציה 0009 ב-SQL Editor.")

    existing = {(r["job_id"], r["production_id"])
                for r in api("GET", "job_productions", params={"select": "job_id,production_id"})}

    linked = skipped = 0
    for job_id, prod_id in LINKS:
        if (job_id, prod_id) in existing:
            skipped += 1
            continue
        api("POST", "job_productions", body={"job_id": job_id, "production_id": prod_id})
        api("POST", "events", body={
            "entity_type": "job", "entity_id": job_id,
            "event_type": "production_linked",
            "payload": {"production_id": prod_id, "confidence": "high",
                        "source": "step_b_batch_2026-07-14", "approved_by": "owner"},
        })
        linked += 1

    flagged = already = 0
    rows = api("GET", "jobs", params={"select": "id,manual_only",
                                      "id": f"in.({','.join(MANUAL_ONLY)})"})
    flags = {r["id"]: r["manual_only"] for r in rows}
    for job_id in MANUAL_ONLY:
        if flags.get(job_id):
            already += 1
            continue
        api("PATCH", "jobs", params={"id": f"eq.{job_id}"}, body={"manual_only": True})
        api("POST", "events", body={
            "entity_type": "job", "entity_id": job_id,
            "event_type": "marked_manual_only",
            "payload": {"source": "step_b_batch_2026-07-14", "approved_by": "owner"},
        })
        flagged += 1

    print(f"קישורים: נוצרו {linked}, דולגו (כבר קיימים) {skipped}")
    print(f"manual_only: סומנו {flagged}, כבר מסומנים {already}")


if __name__ == "__main__":
    main()
