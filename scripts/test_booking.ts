/**
 * Pure booking suite — stage 3ב of client-booked recordings.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_booking.ts
 *
 * SYNTHETIC FIXTURES ONLY. No user is created, no row is written, no route is
 * called, no dev server is started — F19 is open and every function under test
 * here is pure by construction, which is why they were written that way.
 *
 * Every assertion COUNTS (rule 56). "The guest name is missing from the
 * payload" is not an assertion — "this string occurs exactly 0 times in the
 * serialized payload" is.
 */
import { parseIcsText } from "../src/lib/calendar/parse";
import { findLiveSeriesInWindow } from "../src/lib/calendar/series";
import { STUDIOS } from "../src/lib/calendar/studios";
import {
  computeAvailability,
  israelInstant,
  toRequestBlocks,
  type ApprovedRequest,
  type AvailabilityWindow,
  type Slot,
} from "../src/lib/calendar/availability";
import { toApprovedRequests } from "../src/lib/booking/availabilityServer";
import { cleanAliasFor, isCleanAlias } from "../src/lib/booking/alias";
import {
  findDuplicatePending,
  linkRateLimitReached,
  matchSlot,
  normalizeGuest,
  normalizeNote,
  pendingLimitReached,
  validateStudio,
  type ExistingRequest,
} from "../src/lib/booking/request";
import {
  myRequests,
  toPublicAvailability,
  whatsappHref,
  whatsappNumberFrom,
  whatsappText,
  type RequestRow,
} from "../src/lib/booking/publicView";

const GIVON = "גבעון";
const GIVON_BIG = "גבעון גדול";
const HASH = "חשמונאים";

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

// ── fixtures ────────────────────────────────────────────────────────────────
let uidSeq = 0;
function vevent(lines: string[]): string {
  return `BEGIN:VEVENT\r\nUID:bk-${++uidSeq}\r\n${lines.join("\r\n")}\r\nEND:VEVENT`;
}
function cal(...events: string[]): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//fixture//EN\r\n${events.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
}
function timed(date: string, from: [number, number], to: [number, number], summary: string) {
  const z = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return vevent([
    `SUMMARY:${summary}`,
    `DTSTART:${z(israelInstant(date, from[0], from[1]))}`,
    `DTEND:${z(israelInstant(date, to[0], to[1]))}`,
  ]);
}

const SUNDAY = "2026-09-27";
const MONDAY = "2026-09-28";

const WIN = (from: string, to: string): AvailabilityWindow => ({
  fromIsrael: from,
  toIsrael: to,
  openDays: [0, 1, 2, 3, 4],
  openHour: 9,
  closeHour: 19,
  slotMinutes: 90,
  slotStepMinutes: 30,
});

function run(ics: string, win: AvailabilityWindow, approved: ApprovedRequest[] = []) {
  const events = parseIcsText(ics);
  const from = israelInstant(win.fromIsrael, 0, 0);
  const to = new Date(israelInstant(win.toIsrael, 0, 0).getTime() + 86_400_000);
  const series = findLiveSeriesInWindow(ics, from, to, STUDIOS);
  return computeAvailability(events, series, STUDIOS, win, approved);
}

const req = (room: string, date: string, from: [number, number], to: [number, number], id = "r1"): ApprovedRequest => ({
  id,
  room,
  start: israelInstant(date, from[0], from[1]),
  end: israelInstant(date, to[0], to[1]),
});

const roomCount = (r: { free: Slot[] }, room: string, date: string) =>
  r.free.filter((s) => s.room === room && s.dateIsrael === date).length;

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n=== 1. an approved request blocks ITS room, and only its room ===");
{
  const empty = run(cal(), WIN(SUNDAY, SUNDAY));
  check("baseline: 18 slots in each of the three rooms", [
    roomCount(empty, GIVON, SUNDAY),
    roomCount(empty, GIVON_BIG, SUNDAY),
    roomCount(empty, HASH, SUNDAY),
  ], [18, 18, 18]);

  const r = run(cal(), WIN(SUNDAY, SUNDAY), [req(GIVON, SUNDAY, [9, 0], [10, 30])]);
  // 09:00, 09:30 and 10:00 overlap [09:00,10:30). 10:30 does NOT — half-open
  // on both sides, exactly as a calendar event behaves.
  check("גבעון loses exactly 3 slots", roomCount(r, GIVON, SUNDAY), 15);
  check("the 09:00 start is gone", r.free.filter((s) => s.room === GIVON && s.startIsrael === "09:00").length, 0);
  check("the 10:30 start survives — touching is not overlapping", r.free.filter((s) => s.room === GIVON && s.startIsrael === "10:30").length, 1);
  check("גבעון גדול untouched", roomCount(r, GIVON_BIG, SUNDAY), 18);
  check("חשמונאים untouched", roomCount(r, HASH, SUNDAY), 18);

  check("a request never becomes an unknown-room warning", r.unknownRoomBlocks.length, 0);
  check("and never a skipped event", r.skipped.length, 0);

  // a request in one room beside a ROOMLESS event: the event warns, the request does not
  const mixed = run(cal(timed(SUNDAY, [12, 0], [13, 0], "פגישה בלי חדר")), WIN(SUNDAY, SUNDAY), [
    req(GIVON, SUNDAY, [9, 0], [10, 30]),
  ]);
  check("exactly one warning, and it is the event", mixed.unknownRoomBlocks.length, 1);
  check("the warning is not the request", mixed.unknownRoomBlocks.filter((w) => w.uid.startsWith("request:")).length, 0);
}

console.log("\n=== 2. a PENDING request blocks nothing ===");
{
  // The status filter is applied by toApprovedRequests, which is what the
  // loader calls — so this asserts the real rule and not a rehearsal of it.
  const rows = [
    { id: "a", studio: GIVON, start_at: israelInstant(SUNDAY, 9, 0).toISOString(), end_at: israelInstant(SUNDAY, 10, 30).toISOString(), status: "pending" },
    { id: "b", studio: HASH, start_at: israelInstant(SUNDAY, 9, 0).toISOString(), end_at: israelInstant(SUNDAY, 10, 30).toISOString(), status: "declined" },
    { id: "c", studio: GIVON_BIG, start_at: israelInstant(SUNDAY, 9, 0).toISOString(), end_at: israelInstant(SUNDAY, 10, 30).toISOString(), status: "approved" },
  ];
  const kept = toApprovedRequests(rows);
  check("only the approved row survives the filter", kept.length, 1);
  check("and it is the גבעון גדול one", kept.map((k) => k.room), [GIVON_BIG]);

  const r = run(cal(), WIN(SUNDAY, SUNDAY), kept);
  check("the PENDING request's room is fully open", roomCount(r, GIVON, SUNDAY), 18);
  check("the DECLINED request's room is fully open", roomCount(r, HASH, SUNDAY), 18);
  check("only the approved room lost slots", roomCount(r, GIVON_BIG, SUNDAY), 15);
}

console.log("\n=== 3. approved AND already on the calendar — same slot, no double count ===");
{
  const ics = cal(timed(SUNDAY, [9, 0], [10, 30], `הקלטה ${GIVON}`));
  const calendarOnly = run(ics, WIN(SUNDAY, SUNDAY));
  const requestOnly = run(cal(), WIN(SUNDAY, SUNDAY), [req(GIVON, SUNDAY, [9, 0], [10, 30])]);
  const both = run(ics, WIN(SUNDAY, SUNDAY), [req(GIVON, SUNDAY, [9, 0], [10, 30])]);

  check("calendar alone removes 3", roomCount(calendarOnly, GIVON, SUNDAY), 15);
  check("request alone removes 3", roomCount(requestOnly, GIVON, SUNDAY), 15);
  check("BOTH removes the same 3 — not 6", roomCount(both, GIVON, SUNDAY), 15);
  check("the whole free list is identical to the calendar-only one", both.free.length, calendarOnly.free.length);
  check("no slot appears twice anywhere", new Set(both.free.map((s) => `${s.room}|${s.dateIsrael}|${s.startIsrael}`)).size, both.free.length);
  check("still zero warnings", both.unknownRoomBlocks.length, 0);
}

console.log("\n=== 4. toRequestBlocks refuses to invent occupancy ===");
{
  const bad = toRequestBlocks([
    { id: "1", room: "", start: new Date("2026-09-27T09:00:00Z"), end: new Date("2026-09-27T10:00:00Z") },
    { id: "2", room: GIVON, start: new Date("nope"), end: new Date("2026-09-27T10:00:00Z") },
    { id: "3", room: GIVON, start: new Date("2026-09-27T10:00:00Z"), end: new Date("2026-09-27T10:00:00Z") },
    { id: "4", room: GIVON, start: new Date("2026-09-27T11:00:00Z"), end: new Date("2026-09-27T10:00:00Z") },
  ] as ApprovedRequest[]);
  check("every malformed row is dropped", bad.length, 0);
  const good = toRequestBlocks([req(GIVON, SUNDAY, [9, 0], [10, 30])]);
  check("a good row yields one block", good.length, 1);
  check("carrying exactly one room", good[0].rooms, [GIVON]);
  check("marked as a request", good[0].source, "request");
  check("and it carries NO title — a guest name can never ride along", good[0].title, "");
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n=== 5. studio validation ===");
{
  check("גבעון", validateStudio(GIVON), GIVON);
  check("גבעון גדול", validateStudio(GIVON_BIG), GIVON_BIG);
  check("חשמונאים", validateStudio(HASH), HASH);
  check("double spaces are tolerated", validateStudio("גבעון  גדול"), GIVON_BIG);
  check("TLV is refused — a real room, not a bookable one", validateStudio("TLV"), null);
  check("a variant spelling is refused", validateStudio("גבעון בחוץ"), null);
  check("an unknown string", validateStudio("אולפן דמיוני"), null);
  check("a number", validateStudio(7), null);
  check("null", validateStudio(null), null);
  check("empty", validateStudio(""), null);
}

console.log("\n=== 6. the guest name — normalized, never rewritten ===");
{
  check("a plain name", normalizeGuest("דנה לוי"), { ok: true, value: "דנה לוי" });
  check("a newline becomes one space", normalizeGuest("דנה\nלוי"), { ok: true, value: "דנה לוי" });
  check("a tab becomes one space", normalizeGuest("דנה\tלוי"), { ok: true, value: "דנה לוי" });
  check("NBSP becomes one space", normalizeGuest("דנה לוי"), { ok: true, value: "דנה לוי" });
  check("RLM is removed", normalizeGuest("‏דנה לוי‏"), { ok: true, value: "דנה לוי" });
  check("LRM between words", normalizeGuest("דנה‎לוי"), { ok: true, value: "דנה לוי" });
  check("an isolate pair", normalizeGuest("⁦דנה לוי⁩"), { ok: true, value: "דנה לוי" });
  check("runs collapse to one", normalizeGuest("  דנה   לוי  "), { ok: true, value: "דנה לוי" });

  check("empty -> null", normalizeGuest(""), { ok: true, value: null });
  check("whitespace only -> null", normalizeGuest("   \n  "), { ok: true, value: null });
  check("invisible-only -> null", normalizeGuest("‏‎"), { ok: true, value: null });
  check("undefined -> null", normalizeGuest(undefined), { ok: true, value: null });
  check("null -> null", normalizeGuest(null), { ok: true, value: null });

  // 🔴 the comma SURVIVES. Shaping it for a calendar title belongs to 3ג; doing
  // it here would store a name the client never wrote.
  check("a comma is preserved exactly", normalizeGuest("דנה לוי, יוסי כהן"), { ok: true, value: "דנה לוי, יוסי כהן" });
  check("a colon is preserved", normalizeGuest("דנה: לוי"), { ok: true, value: "דנה: לוי" });
  check("a room name in the guest is preserved", normalizeGuest("רות גבעון"), { ok: true, value: "רות גבעון" });

  const at120 = "א".repeat(120);
  const at121 = "א".repeat(121);
  check("120 characters pass", normalizeGuest(at120), { ok: true, value: at120 });
  check("121 characters are refused", normalizeGuest(at121), { ok: false, reason: "too-long" });
  // 120 characters that normalize DOWN to 120 still pass — the cap is applied
  // after normalizing, which is the string that reaches the column.
  check("121 raw that collapse to 120 pass", normalizeGuest("א".repeat(60) + "  " + "א".repeat(59)), {
    ok: true,
    value: "א".repeat(60) + " " + "א".repeat(59),
  });
}

console.log("\n=== 7. the note ===");
{
  check("trimmed", normalizeNote("  שלום  "), { ok: true, value: "שלום" });
  check("newlines are KEPT — prose, not a title", normalizeNote("שורה\nשנייה"), { ok: true, value: "שורה\nשנייה" });
  check("empty -> null", normalizeNote("   "), { ok: true, value: null });
  check("500 passes", normalizeNote("א".repeat(500)), { ok: true, value: "א".repeat(500) });
  check("501 refused", normalizeNote("א".repeat(501)), { ok: false, reason: "too-long" });
}

console.log("\n=== 8. the slot must be one the SERVER says is free ===");
{
  // A real window from a fixed clock: from = tomorrow = 2026-09-27.
  const win = WIN(SUNDAY, "2026-11-21");
  const free = run(cal(), win).free;

  const ok = matchSlot(free, { studio: GIVON, startIsrael: `${SUNDAY} 09:00` });
  check("a free slot matches", ok.ok, true);
  check("and its end comes from the SLOT", ok.ok && ok.slot.endIsrael, "10:30");
  check("the T separator is accepted too", matchSlot(free, { studio: GIVON, startIsrael: `${SUNDAY}T09:00` }).ok, true);

  check("TODAY is not bookable", matchSlot(free, { studio: GIVON, startIsrael: "2026-09-26 09:00" }), { ok: false, reason: "not-free" });
  check("YESTERDAY is not bookable", matchSlot(free, { studio: GIVON, startIsrael: "2026-09-25 09:00" }), { ok: false, reason: "not-free" });
  check("past the 8-week edge is not bookable", matchSlot(free, { studio: GIVON, startIsrael: "2026-11-23 09:00" }), { ok: false, reason: "not-free" });
  check("Friday is not bookable", matchSlot(free, { studio: GIVON, startIsrael: "2026-10-02 09:00" }), { ok: false, reason: "not-free" });
  check("before opening", matchSlot(free, { studio: GIVON, startIsrael: `${SUNDAY} 08:30` }), { ok: false, reason: "not-free" });
  check("a start with no slot on the grid", matchSlot(free, { studio: GIVON, startIsrael: `${SUNDAY} 09:15` }), { ok: false, reason: "not-free" });
  check("TLV has no slots at all", matchSlot(free, { studio: "TLV", startIsrael: `${SUNDAY} 09:00` }), { ok: false, reason: "not-free" });

  check("a malformed start", matchSlot(free, { studio: GIVON, startIsrael: "27/09/2026 09:00" }), { ok: false, reason: "bad-start" });
  check("a missing start", matchSlot(free, { studio: GIVON, startIsrael: undefined }), { ok: false, reason: "bad-start" });
  check("a numeric start", matchSlot(free, { studio: GIVON, startIsrael: 900 }), { ok: false, reason: "bad-start" });

  // 🔴 the client's end is CHECKED, never trusted and never silently corrected
  check("a matching end is accepted", matchSlot(free, { studio: GIVON, startIsrael: `${SUNDAY} 09:00`, endIsrael: "10:30" }).ok, true);
  check("a WRONG end from the client is refused", matchSlot(free, { studio: GIVON, startIsrael: `${SUNDAY} 09:00`, endIsrael: "10:00" }), { ok: false, reason: "end-mismatch" });
  check("an end of 23:59 is refused", matchSlot(free, { studio: GIVON, startIsrael: `${SUNDAY} 09:00`, endIsrael: "23:59" }), { ok: false, reason: "end-mismatch" });

  // a room blocked by an approved request is no longer matchable
  const afterApproval = run(cal(), win, [req(GIVON, SUNDAY, [9, 0], [10, 30])]).free;
  check("the approved slot can no longer be requested", matchSlot(afterApproval, { studio: GIVON, startIsrael: `${SUNDAY} 09:00` }), { ok: false, reason: "not-free" });
  check("but the same hour in another room still can", matchSlot(afterApproval, { studio: HASH, startIsrael: `${SUNDAY} 09:00` }).ok, true);
}

console.log("\n=== 9. the three brakes ===");
{
  const iso = (d: string, h: number) => israelInstant(d, h, 0).toISOString();
  const row = (id: string, status: string, studio: string, startIso: string, createdIso: string): ExistingRequest => ({
    id, status, studio, start_at: startIso, created_at: createdIso,
  });
  const now = new Date("2026-09-26T12:00:00Z");
  const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();

  // — up to 3 pending per show
  const p = (n: number) =>
    Array.from({ length: n }, (_, i) => row(`p${i}`, "pending", GIVON, iso(SUNDAY, 9 + i), hoursAgo(1)));
  check("0 pending", pendingLimitReached(p(0)), false);
  check("2 pending", pendingLimitReached(p(2)), false);
  check("3 pending is the ceiling", pendingLimitReached(p(3)), true);
  check("4 pending", pendingLimitReached(p(4)), true);
  check("approved rows do not count towards it", pendingLimitReached([
    ...p(2), row("a", "approved", GIVON, iso(SUNDAY, 15), hoursAgo(1)),
    row("d", "declined", GIVON, iso(SUNDAY, 16), hoursAgo(1)),
  ]), false);

  // — up to 10 per link per 24h
  const l = (n: number, ago: number) =>
    Array.from({ length: n }, (_, i) => row(`l${i}`, "pending", GIVON, iso(SUNDAY, 9), hoursAgo(ago)));
  check("9 in the last hour", linkRateLimitReached(l(9, 1), now), false);
  check("10 in the last hour is the ceiling", linkRateLimitReached(l(10, 1), now), true);
  check("10 from 25 hours ago do not count", linkRateLimitReached(l(10, 25), now), false);
  check("every status counts, not just pending", linkRateLimitReached([
    ...l(9, 1), row("x", "declined", GIVON, iso(SUNDAY, 9), hoursAgo(2)),
  ], now), true);
  check("a row exactly 24h old is outside the window", linkRateLimitReached(l(10, 24.0001), now), false);

  // — no duplicate pending for the same slot
  const existing = [row("keep", "pending", GIVON, iso(SUNDAY, 9), hoursAgo(1))];
  check("the same room and moment finds it", findDuplicatePending(existing, { studio: GIVON, start: israelInstant(SUNDAY, 9, 0) })?.id, "keep");
  check("another room does not", findDuplicatePending(existing, { studio: HASH, start: israelInstant(SUNDAY, 9, 0) }), null);
  check("another hour does not", findDuplicatePending(existing, { studio: GIVON, start: israelInstant(SUNDAY, 11, 0) }), null);
  check("a DECLINED row for the same slot is not a duplicate — they may ask again", findDuplicatePending(
    [row("no", "declined", GIVON, iso(SUNDAY, 9), hoursAgo(1))],
    { studio: GIVON, start: israelInstant(SUNDAY, 9, 0) }
  ), null);
  check("an empty list", findDuplicatePending([], { studio: GIVON, start: israelInstant(SUNDAY, 9, 0) }), null);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n=== 10. the public payload leaks nothing ===");
{
  // Every fixture string below is something a real feed carries and a client
  // must never receive.
  const TITLE = "פודקאסט סודי של לקוח אחר";
  const SERIES = "סדרה שבועית של לקוח אחר";
  const GUEST = "רות קבסה אברמזון";
  const NOTE = "ההערה הפרטית של הלקוח השני";
  const UID = "uid-שאסור-לדלוף";

  const win = WIN(SUNDAY, MONDAY);
  const ics = cal(
    timed(SUNDAY, [12, 0], [13, 0], TITLE), // roomless -> becomes a warning
    vevent([`SUMMARY:${TITLE} ${GUEST}`, `DTSTART:${israelInstant(SUNDAY, 14, 0).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`]) // no DTEND -> skipped
  );
  const result = run(ics, win, [req(GIVON, SUNDAY, [9, 0], [10, 30], UID)]);

  check("the INTERNAL result does carry the title — that is the owner's screen", result.unknownRoomBlocks.length > 0, true);

  const pub = toPublicAvailability(result, { fromIsrael: win.fromIsrael, toIsrael: win.toIsrael }, [GIVON, GIVON_BIG, HASH]);
  const json = JSON.stringify(pub);

  for (const [label, needle] of [
    ["the event title", TITLE],
    ["a series title", SERIES],
    ["a guest name", GUEST],
    ["a private note", NOTE],
    ["a request uid", UID],
    ["the word unknownRoomBlocks", "unknownRoomBlocks"],
    ["the word skipped", "skipped"],
    ["the word seriesTitle", "seriesTitle"],
    ["the word uid", "uid"],
    ["the word fetchedAt", "fetchedAt"],
    ["the word guest", "guest"],
    ["the word note", "note"],
    ["the word title", "title"],
  ] as const) {
    check(`${label} — 0 occurrences`, json.split(needle).length - 1, 0);
  }

  check("exactly five keys come back", Object.keys(pub).sort(), ["free", "fromIsrael", "refusedRooms", "rooms", "toIsrael"]);
  check("a slot has exactly four keys", Object.keys(pub.free[0]).sort(), ["dateIsrael", "endIsrael", "room", "startIsrael"]);
  check("the window is carried through", [pub.fromIsrael, pub.toIsrael], [SUNDAY, MONDAY]);
  // passed through EXACTLY as given — the projection does not reorder or
  // re-derive the room list, it forwards the caller's
  check("the rooms are carried through unchanged", pub.rooms, [GIVON, GIVON_BIG, HASH]);
  check("the approved request still blocks in the public payload", pub.free.filter((s) => s.room === GIVON && s.dateIsrael === SUNDAY).length, 15);

  // a refused room comes back as a NAME and nothing else
  const refused = toPublicAvailability(
    { free: [], unknownRoomBlocks: [], skipped: [], roomsRefused: [{ room: GIVON, seriesUid: UID, seriesTitle: SERIES }] },
    { fromIsrael: SUNDAY, toIsrael: MONDAY },
    [GIVON]
  );
  check("the refused room is named", refused.refusedRooms, [GIVON]);
  check("and its series title does not travel", JSON.stringify(refused).split(SERIES).length - 1, 0);
  check("nor its uid", JSON.stringify(refused).split(UID).length - 1, 0);
}

console.log("\n=== 11. הבקשות שלכם ===");
{
  const rows: RequestRow[] = [
    { id: "c", studio: HASH, start_at: israelInstant("2026-09-30", 15, 0).toISOString(), guest: null, status: "declined" },
    { id: "a", studio: GIVON, start_at: israelInstant(SUNDAY, 9, 0).toISOString(), guest: "דנה לוי", status: "pending" },
    { id: "old", studio: GIVON, start_at: israelInstant("2026-09-20", 9, 0).toISOString(), guest: "ישן", status: "approved" },
    { id: "b", studio: GIVON_BIG, start_at: israelInstant(MONDAY, 11, 0).toISOString(), guest: "יוסי כהן", status: "approved" },
  ];
  const v = myRequests(rows, "2026-09-26");
  check("the past request is dropped", v.map((x) => x.id), ["a", "b", "c"]);
  check("sorted by moment, not by insertion", v.map((x) => x.timeIsrael), ["09:00", "11:00", "15:00"]);
  check("the three status labels", v.map((x) => x.statusLabel), ["ממתינה לאישור", "אושרה", "נדחתה"]);
  check("the weekday", v.map((x) => x.dowHe), ["א׳", "ב׳", "ד׳"]);
  check("the date", v.map((x) => x.dayMonth), ["27.9", "28.9", "30.9"]);
  check("the room", v.map((x) => x.studio), [GIVON, GIVON_BIG, HASH]);
  check("the guest, and null where there is none", v.map((x) => x.guest), ["דנה לוי", "יוסי כהן", null]);

  check("today's own request is KEPT — 'from today', not 'from now'", myRequests(
    [{ id: "t", studio: GIVON, start_at: israelInstant("2026-09-26", 9, 0).toISOString(), guest: null, status: "pending" }],
    "2026-09-26"
  ).length, 1);
  check("a blank guest reads as none", myRequests(
    [{ id: "t", studio: GIVON, start_at: israelInstant(SUNDAY, 9, 0).toISOString(), guest: "   ", status: "pending" }],
    "2026-09-26"
  )[0].guest, null);
  check("an unparseable instant is dropped, not placed arbitrarily", myRequests(
    [{ id: "bad", studio: GIVON, start_at: "not a date", guest: null, status: "pending" }],
    "2026-09-26"
  ).length, 0);
  check("an unknown status falls through to its raw value", myRequests(
    [{ id: "u", studio: GIVON, start_at: israelInstant(SUNDAY, 9, 0).toISOString(), guest: null, status: "weird" }],
    "2026-09-26"
  )[0].statusLabel, "weird");
  check("null rows", myRequests(null, "2026-09-26"), []);
}

console.log("\n=== 12. the WhatsApp nudge ===");
{
  const base = { showName: "דעה לא פופולרית", dateIsrael: SUNDAY, startIsrael: "11:00", studio: GIVON };
  check("without a guest", whatsappText(base), "דעה לא פופולרית ביקשו הקלטה ביום א׳ 27.9 ב-11:00, אולפן גבעון.");
  check("with a guest", whatsappText({ ...base, guest: "דנה לוי" }), "דעה לא פופולרית ביקשו הקלטה ביום א׳ 27.9 ב-11:00, אולפן גבעון. אורח/ת: דנה לוי.");
  check("null guest reads as none", whatsappText({ ...base, guest: null }), whatsappText(base));
  check("a blank guest reads as none", whatsappText({ ...base, guest: "   " }), whatsappText(base));
  check("Monday inflects", whatsappText({ ...base, dateIsrael: MONDAY }), "דעה לא פופולרית ביקשו הקלטה ביום ב׳ 28.9 ב-11:00, אולפן גבעון.");

  check("digits only", whatsappNumberFrom("972501234567"), "972501234567");
  check("a leading + is refused rather than stripped", whatsappNumberFrom("+972501234567"), null);
  check("dashes are refused", whatsappNumberFrom("050-123-4567"), null);
  check("unset", whatsappNumberFrom(undefined), null);
  check("empty", whatsappNumberFrom("   "), null);
  check("too short", whatsappNumberFrom("12345"), null);

  check("no number -> no link at all", whatsappHref(null, "טקסט"), null);
  const href = whatsappHref("972501234567", whatsappText({ ...base, guest: "דנה לוי" }));
  check("the link starts with wa.me and the number", href?.startsWith("https://wa.me/972501234567?text="), true);
  check("the '/' in אורח/ת is encoded", (href ?? "").includes("%2F"), true);
  check("no raw space survives", (href ?? "").includes(" "), false);
  check("no raw comma survives", (href ?? "").includes(","), false);
  check("it round-trips back to the exact sentence", decodeURIComponent((href ?? "").split("?text=")[1]), whatsappText({ ...base, guest: "דנה לוי" }));
}

console.log("\n=== 13. a show needs a name that cannot hide a room ===");
{
  check("a plain name is clean", isCleanAlias("דעה לא פופולרית", STUDIOS), true);
  check("a name containing גבעון is not", isCleanAlias("פודקאסט גבעון", STUDIOS), false);
  check("גבעון גדול is not", isCleanAlias("גבעון גדול מדבר", STUDIOS), false);
  check("חשמונאים is not", isCleanAlias("חשמונאים בלילה", STUDIOS), false);
  check("the ה-prefixed variant is not", isCleanAlias("החשמונאים שלנו", STUDIOS), false);
  check("TLV is not — recognised everywhere, bookable or not", isCleanAlias("TLV Talks", STUDIOS), false);
  check("lowercase tlv is caught too", isCleanAlias("tlv talks", STUDIOS), false);
  check("a doubled space inside a room name is caught", isCleanAlias("גבעון  גדול", STUDIOS), false);
  check("empty is not clean", isCleanAlias("", STUDIOS), false);
  check("null is not clean", isCleanAlias(null, STUDIOS), false);

  check("the name wins when it is clean", cleanAliasFor({ name: "דעה לא פופולרית", aliases: ["חלופי"] }, STUDIOS), "דעה לא פופולרית");
  check("an alias rescues a dirty name", cleanAliasFor({ name: "פודקאסט גבעון", aliases: ["הפודקאסט"] }, STUDIOS), "הפודקאסט");
  check("the FIRST clean alias wins", cleanAliasFor({ name: "גבעון", aliases: ["גבעון גדול", "ראשון", "שני"] }, STUDIOS), "ראשון");
  check("no clean name at all -> null, and no link is created", cleanAliasFor({ name: "גבעון", aliases: ["חשמונאים", "TLV"] }, STUDIOS), null);
  check("no aliases at all", cleanAliasFor({ name: "גבעון", aliases: null }, STUDIOS), null);
  check("whitespace is normalized in the answer", cleanAliasFor({ name: "  דעה   לא  פופולרית ", aliases: [] }, STUDIOS), "דעה לא פופולרית");
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
