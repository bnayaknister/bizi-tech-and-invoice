/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GATE ON EVERY LIVE-DATABASE SUITE — F19, 7.10.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every file in `scripts/live/` builds a **service-role** Supabase client
 * against the PRODUCTION database and most of them WRITE to it. This module
 * is the one thing standing between "I ran the tests" and "I wrote to
 * production", and it has to be called before the suite reads `.env.local`,
 * because reading that file is what hands it the keys.
 *
 * ═══ WHY THIS EXISTS (the incident it is named after) ═══
 * On 7.10 all 18 of these suites ran against production TWICE, because
 * `for f in scripts/test_*.ts` was run with no filter. F19 had already
 * recorded the mitigation in force at the time — grep each file first and
 * skip the ones that touch the database, 22 suites skipped per session —
 * and named its own weakness: "נוהל ידני שעובד כל זמן שמי שמריץ זוכר".
 * Whoever ran it did not remember. The owner's four verification queries
 * came back clean on test users, orphan profiles, business rows and
 * synthetic documents — but one suite had deleted real audit events for a
 * production, and a deletion leaves nothing to restore.
 *
 * ═══ WHY THE DIRECTORY IS THE PRIMARY DEFENCE, AND THIS IS THE SECOND ═══
 * `scripts/live/` is what makes the accident IMPOSSIBLE rather than
 * unlikely: `scripts/test_*.ts` cannot match a file in a subdirectory, so
 * the exact command that caused the incident now runs only pure suites.
 * This gate is the belt to that pair of braces — it catches the case where
 * someone names the file directly, which is the one thing a glob cannot
 * protect against.
 *
 * ⚠️ A THIRD THING IT DOES, AND IT IS NOT DECORATIVE: it forces
 * `MORNING_DRY_RUN=true` before `.env.local` is parsed. `.env.local` holds
 * `MORNING_DRY_RUN=false` and `MORNING_ENV=production`, and every suite's
 * hand-rolled parser assigns with `if (!process.env[k])` — so a suite run
 * without an explicit override inherits **false** and is one function call
 * away from issuing a real document into the real Green Invoice account.
 * `test_parent_ref` even documents `MORNING_DRY_RUN=true` in its own run
 * command, which is exactly the kind of instruction a person skips. Setting
 * it here means no caller has to remember. (It works because `isDryRun()`
 * reads the variable at CALL time — lib/morning/client.ts:35-36 — not at
 * import time, so a value set here is the value every later call sees.)
 */

const ENV_VAR = "ALLOW_LIVE_DB_TESTS";
const EXPECTED = "yes";

/**
 * Call this ONCE, at module scope, BEFORE the `.env.local` parser.
 *
 * Exits the process with code 1 when the opt-in is absent — it does not
 * throw, because a throw inside a suite's own try/catch would be reported
 * as a test failure, and "the gate held" is not a test failure.
 */
export function requireLiveDbOptIn(): void {
  // FIRST, before the gate can exit and before any `.env.local` line is
  // read: the Morning switch, pinned ON. See the header note.
  process.env.MORNING_DRY_RUN = "true";

  if (process.env[ENV_VAR] === EXPECTED) return;

  // argv[1] rather than a name each suite passes in — a hardcoded name is a
  // name that can go stale against the file it sits in.
  const self = (process.argv[1] ?? "").split("/").slice(-2).join("/") || "scripts/live/<suite>.ts";

  console.error(
    [
      "",
      "⛔ בדיקה שנוגעת במסד החי — חסומה.",
      "",
      `   הסוויטה הזאת (${self}) בונה קליינט service role מול מסד הייצור,`,
      "   ורובן גם כותבות אליו. לכן היא לא רצה בלי אישור מפורש.",
      "",
      "   למה השער קיים: ב-7.10 רצו 18 סוויטות כאלה מול הייצור פעמיים, כי הורץ",
      "   `for f in scripts/test_*.ts` בלי סינון. אחת מהן מחקה אירועי אודיט",
      "   אמיתיים של הפקה — מחיקה לא ניתנת לשחזור (F19).",
      "",
      "   להרצה מכוונת:",
      `     ${ENV_VAR}=${EXPECTED} npx tsx ${self}`,
      "",
      "─────────────────────────────────────────────────────────────────────",
      "",
      "⛔ Live-database test blocked.",
      "",
      `   This suite (${self}) builds a service-role client against the`,
      "   PRODUCTION database, and most suites here also write to it. It will",
      "   not run without an explicit opt-in.",
      "",
      "   Why: on 2026-10-07 all 18 of these suites ran against production",
      "   twice, because `for f in scripts/test_*.ts` was run unfiltered. One",
      "   of them deleted real audit events for a production — a deletion that",
      "   cannot be undone (F19).",
      "",
      "   To run it deliberately:",
      `     ${ENV_VAR}=${EXPECTED} npx tsx ${self}`,
      "",
      "   To run every test that is safe by construction:",
      "     for f in scripts/test_*.ts; do npx tsx \"$f\"; done",
      "",
    ].join("\n")
  );
  process.exit(1);
}
