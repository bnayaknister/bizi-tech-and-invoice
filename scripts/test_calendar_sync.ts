/**
 * lib/calendar/sync.ts's buildSyncPlan — pure, no DB, no network, no users.
 * F19 is open; nothing here goes near it.
 *
 * ═══ 🔴 THE LOOP, AFTER THE CORRECTION OF 7.10 ═══
 * An approval writes an event to the shared Google Calendar and creates NO
 * production (lib/booking/writeCalendarEvent.ts). So on the recording
 * morning the sync meets that event in the feed with NOTHING holding its
 * UID — and `toCreate` is the CORRECT answer, exactly once. §1 below is
 * that test: it is the one the owner asked for by name, and it asserts the
 * opposite of what the earlier "מתווה א׳" design asserted.
 *
 * §2 keeps the other half honest: IF something does already hold that UID,
 * the plan must still never create a second production. Between them, the
 * two sections say "exactly one production per event, whichever way the row
 * got there" — which is the property that actually matters, and the one
 * 0019's partial unique index backs at the database level.
 *
 * Run: npx tsx scripts/test_calendar_sync.ts
 */
import { buildSyncPlan, type ExistingProductionRow } from "../src/lib/calendar/sync";
import type { ShowForMatch } from "../src/lib/calendar/match";
import type { CalendarEvent } from "../src/lib/calendar/parse";

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}\n       got:  ${g}\n       want: ${w}`);
  }
}

const SHOW: ShowForMatch = { id: "show-1", name: "דעה לא פופולרית", aliases: [] };

function eventOf(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    uid: "uid-abc@google.com",
    title: "דעה לא פופולרית, אורח: דנה לוי, גבעון",
    start: new Date("2026-10-20T06:00:00.000Z"),
    end: new Date("2026-10-20T07:30:00.000Z"),
    location: null,
    recurrence: null,
    ...over,
  };
}

function rowOf(over: Partial<ExistingProductionRow> = {}): ExistingProductionRow {
  return {
    id: "prod-1",
    calendar_uid: "uid-abc@google.com",
    status: "עתיד_להתחיל",
    calendar_removed: false,
    ...over,
  };
}

console.log("\n=== 1. 🔴 THE LOOP — the system wrote the event; on the recording morning the sync creates its production, ONCE ===");
{
  // The state on the recording morning, as the corrected design actually
  // leaves it: the event the approval wrote is in the feed (it is a real
  // event on the shared calendar, and its UID is the iCalUID Google
  // returned and we stored in booking_requests.calendar_event_uid), and
  // NOTHING in `productions` holds that UID — because an approval creates
  // no production.
  //
  // ⚠️ `existingByUid` is EMPTY here, and that is not a shortcut: the sync
  // builds it from productions whose `record_date` is today AND whose
  // calendar_uid is non-null (route.ts:216-225). On the first morning this
  // event is ever in-window, no such row can exist.
  const plan = buildSyncPlan([eventOf()], [SHOW], new Map(), new Set());

  check("toCreate — exactly once, and this is CORRECT", plan.toCreate.length, 1);
  check("the production will carry the event's own UID", plan.toCreate[0]?.event.uid, "uid-abc@google.com");
  check("matched to the right show by title", plan.toCreate[0]?.show.id, "show-1");
  check("zero updates", plan.toUpdate.length, 0);
  check("zero 'changed' flags — nobody touched anything", plan.toFlagChanged.length, 0);
  check("zero 'removed' flags — the event is present", plan.toFlagRemoved.length, 0);
  check("not skipped as unmatched", plan.skippedNoMatch, 0);

  // and the same feed a SECOND time, now that the first run created the row:
  // one production, not two. (The sync is additionally run-once-per-day —
  // route.ts:443's 06:00 gate plus alreadySyncedToday at :452 — so this is
  // belt and braces, which is the right number of belts for a table that
  // bills.)
  const afterFirstRun = new Map([["uid-abc@google.com", rowOf()]]);
  const second = buildSyncPlan([eventOf()], [SHOW], afterFirstRun, new Set());
  check("second run over the same feed: zero new productions", second.toCreate.length, 0);
  check("it recognises the row it created and only refreshes it", second.toUpdate.length, 1);
  check("same production, never a sibling", second.toUpdate[0]?.productionId, "prod-1");
}

console.log("\n=== 2. and if something DOES already hold that UID, no second production is ever created ===");
{
  // Two sub-cases, both ending in "not toCreate" — untouched rows are
  // refreshed in place, touched ones are only flagged and never
  // overwritten ("מה שהיומן יצר, היומן מעדכן, כל עוד לא נגעו בו").
  const existingByUid = new Map([["uid-abc@google.com", rowOf()]]);

  const untouched = buildSyncPlan([eventOf()], [SHOW], existingByUid, new Set());
  check("untouched -> toUpdate, never toCreate", untouched.toCreate.length, 0);
  check("the update targets the SAME production id", untouched.toUpdate[0]?.productionId, "prod-1");

  const touched = buildSyncPlan([eventOf()], [SHOW], existingByUid, new Set(["prod-1"]));
  check("touched -> still NOT toCreate", touched.toCreate.length, 0);
  check("touched -> flagged, not silently overwritten", touched.toFlagChanged.length, 1);
  check("the flag names the same production", touched.toFlagChanged[0]?.productionId, "prod-1");
  check("and NOT toUpdate — a touched row is never auto-applied", touched.toUpdate.length, 0);

  // G3, still true and still worth stating: the approval's own audit events
  // (booking_calendar_event_created/_failed) are logged against
  // entity_type 'booking_request', so they can never land a production in
  // `touchedIds` and push it down the flagged branch above.
}

console.log("\n=== 3. an unmatched title is silently skipped — never created, never flagged (the shared-calendar discipline) ===");
{
  const plan = buildSyncPlan([eventOf({ title: "פרסומת כלשהי", uid: "uid-ad@google.com" })], [SHOW], new Map(), new Set());
  check("zero toCreate for an unmatched title", plan.toCreate.length, 0);
  check("counted as skipped, not silently lost", plan.skippedNoMatch, 1);
}

console.log("\n=== 4. a row whose event vanished from the feed is flagged removed — unless it already was ===");
{
  const existingByUid = new Map([
    ["uid-gone@google.com", rowOf({ id: "prod-2", calendar_uid: "uid-gone@google.com", calendar_removed: false })],
    ["uid-already-flagged@google.com", rowOf({ id: "prod-3", calendar_uid: "uid-already-flagged@google.com", calendar_removed: true })],
  ]);
  const plan = buildSyncPlan([], [SHOW], existingByUid, new Set());
  check("the live row is flagged removed", plan.toFlagRemoved, ["prod-2"]);
  check("an already-flagged row is not flagged twice", plan.toFlagRemoved.includes("prod-3"), false);
}

console.log("\n=== 5. a previously-removed row whose event is BACK is unflagged ===");
{
  const existingByUid = new Map([["uid-abc@google.com", rowOf({ calendar_removed: true })]]);
  const plan = buildSyncPlan([eventOf()], [SHOW], existingByUid, new Set());
  check("unflagged", plan.toUnflagRemoved, ["prod-1"]);
  // still routed normally alongside the unflag — untouched + first stage
  check("and still routed to toUpdate, not re-created", plan.toCreate.length === 0 && plan.toUpdate.length === 1, true);
}

console.log(failed === 0 ? `\n✅  ${passed}/${passed} assertions passed\n` : `\n❌  ${passed}/${passed + failed} assertions passed, ${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
