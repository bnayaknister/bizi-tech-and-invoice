/**
 * lib/calendar/sync.ts's buildSyncPlan — pure, no DB, no network, no users.
 * F19 is open; nothing here goes near it.
 *
 * The one test the owner's gate G2 asks for by name (feat/calendar-write,
 * 7.10): a production created on booking-request APPROVAL writes
 * `calendar_uid = <the real iCalUID>` (lib/calendar/createProductionFromEvent.ts).
 * The NEXT sync run reads the SAME event (same UID, from the ICS feed) and
 * must route it to `toUpdate` (or `toFlagChanged`), never `toCreate` — a
 * production minted twice for one recording is exactly the silent
 * double-booking risk this whole feature exists to avoid creating.
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

console.log("\n=== 1. 🔴 G2 regression — a production created at APPROVAL is recognised on the next sync, not re-created ===");
{
  // exactly the shape createProductionFromEvent leaves behind: a production
  // whose calendar_uid is the REAL iCalUID Google returned at write time
  // (write.ts), untouched (no drawer edit, no kanban move) and still at the
  // pipeline's first stage — precisely the state a freshly-approved,
  // not-yet-recorded booking is in.
  const existingByUid = new Map([["uid-abc@google.com", rowOf()]]);
  const plan = buildSyncPlan([eventOf()], [SHOW], existingByUid, new Set());

  check("NOT routed to toCreate — this is the whole point of G2", plan.toCreate.length, 0);
  check("routed to toUpdate instead (untouched, still עתיד_להתחיל)", plan.toUpdate.length, 1);
  check("the update targets the SAME production id, never a new one", plan.toUpdate[0]?.productionId, "prod-1");
  check("zero flags of any kind — a recognised, untouched row is not noise", plan.toFlagChanged.length, 0);
}

console.log("\n=== 2. the SAME regression holds even when the row was touched (booking_calendar_event_created logged on it) ===");
{
  // G3's finding, exercised here directly: `touchedIds` is built from events
  // NOT prefixed "calendar_" — but booking_calendar_event_created/_failed are
  // logged with entity_type 'booking_request' (writeCalendarEvent.ts), so
  // they never reach `touchedIds` for the PRODUCTION at all. This case
  // instead covers the row being legitimately touched some OTHER way (e.g. a
  // manual drawer edit) — still never toCreate, only the touched branch
  // differs (toFlagChanged, not toUpdate).
  const existingByUid = new Map([["uid-abc@google.com", rowOf()]]);
  const plan = buildSyncPlan([eventOf()], [SHOW], existingByUid, new Set(["prod-1"]));

  check("still NOT toCreate", plan.toCreate.length, 0);
  check("touched -> toFlagChanged, not silently overwritten", plan.toFlagChanged.length, 1);
  check("toFlagChanged names the same production", plan.toFlagChanged[0]?.productionId, "prod-1");
  check("and NOT toUpdate — touched rows are never auto-applied", plan.toUpdate.length, 0);
}

console.log("\n=== 3. a genuinely new event (no existing row under its UID) IS toCreate — the baseline the regression above is measured against ===");
{
  const plan = buildSyncPlan([eventOf({ uid: "uid-new@google.com" })], [SHOW], new Map(), new Set());
  check("toCreate, exactly once", plan.toCreate.length, 1);
  check("carries the matched show", plan.toCreate[0]?.show.id, "show-1");
  check("zero updates, zero flags", plan.toUpdate.length + plan.toFlagChanged.length, 0);
}

console.log("\n=== 4. an unmatched title is silently skipped — never created, never flagged (the shared-calendar discipline) ===");
{
  const plan = buildSyncPlan([eventOf({ title: "פרסומת כלשהי", uid: "uid-ad@google.com" })], [SHOW], new Map(), new Set());
  check("zero toCreate for an unmatched title", plan.toCreate.length, 0);
  check("counted as skipped, not silently lost", plan.skippedNoMatch, 1);
}

console.log("\n=== 5. a row whose event vanished from the feed is flagged removed — unless it already was ===");
{
  const existingByUid = new Map([
    ["uid-gone@google.com", rowOf({ id: "prod-2", calendar_uid: "uid-gone@google.com", calendar_removed: false })],
    ["uid-already-flagged@google.com", rowOf({ id: "prod-3", calendar_uid: "uid-already-flagged@google.com", calendar_removed: true })],
  ]);
  const plan = buildSyncPlan([], [SHOW], existingByUid, new Set());
  check("the live row is flagged removed", plan.toFlagRemoved, ["prod-2"]);
  check("an already-flagged row is not flagged twice", plan.toFlagRemoved.includes("prod-3"), false);
}

console.log("\n=== 6. a previously-removed row whose event is BACK is unflagged ===");
{
  const existingByUid = new Map([["uid-abc@google.com", rowOf({ calendar_removed: true })]]);
  const plan = buildSyncPlan([eventOf()], [SHOW], existingByUid, new Set());
  check("unflagged", plan.toUnflagRemoved, ["prod-1"]);
  // still routed normally alongside the unflag — untouched + first stage
  check("and still routed to toUpdate, not re-created", plan.toCreate.length === 0 && plan.toUpdate.length === 1, true);
}

console.log(failed === 0 ? `\n✅  ${passed}/${passed} assertions passed\n` : `\n❌  ${passed}/${passed + failed} assertions passed, ${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
