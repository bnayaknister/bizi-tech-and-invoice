/**
 * Pure suite for the owner's booking queue — stage 3ג-1.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_bookings.ts
 *
 * SYNTHETIC FIXTURES ONLY. No user is created, no row is written, no route is
 * called, no dev server is started — F19 is open, and every function under
 * test here is pure by construction because they were written that way.
 *
 * Every assertion COUNTS (rule 56). "The title parses" is not an assertion —
 * "extractStudioAndGuest returns exactly this studio and exactly this guest"
 * is.
 */
import { extractStudioAndGuest, matchTitleToShow, type ShowForMatch } from "../src/lib/calendar/match";
import { STUDIOS } from "../src/lib/calendar/studios";
import { israelInstant } from "../src/lib/calendar/availability";
import { namesAnyRoom } from "../src/lib/booking/alias";
import { duplicateWrite, findDuplicatePending, type ExistingRequest } from "../src/lib/booking/request";
import { whatsappText } from "../src/lib/booking/publicView";
import {
  approvedWhatsappText,
  declinedWhatsappText,
  eventTitle,
  googleCalendarUrl,
  googleDateStamp,
  guestForTitle,
  whatsappComposeHref,
} from "../src/lib/booking/title";
import {
  approveErrorMessage,
  isOverlapping,
  pendingFutureCount,
  splitQueue,
  APPROVE_TAKEN_IN_DB,
  HISTORY_LIMIT,
  NO_GUEST,
  type QueueRow,
} from "../src/lib/booking/queue";
import {
  mergeBookingsInto,
  showDeleteBlockedByBookings,
  MERGE_LINKS_FAILED,
  MERGE_REQUESTS_FAILED,
  type BookingMergeOps,
} from "../src/lib/booking/showLifecycle";

const GIVON = "גבעון";
const GIVON_BIG = "גבעון גדול";
const HASH = "חשמונאים";
const SHOW = "דעה לא פופולרית";

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

const SUN = "2026-09-27";
const MON = "2026-09-28";
const NOW = new Date("2026-09-24T12:00:00Z");

const iso = (d: string, h: number, m = 0) => israelInstant(d, h, m).toISOString();

function row(over: Partial<QueueRow> = {}): QueueRow {
  return {
    id: "r1",
    show_id: "s1",
    showName: SHOW,
    studio: GIVON,
    start_at: iso(SUN, 9),
    end_at: iso(SUN, 10, 30),
    guest: null,
    note: null,
    status: "pending",
    created_at: iso("2026-09-24", 14, 3),
    alias: SHOW,
    calendarWriteStatus: null,
    calendarWriteError: null,
    ...over,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n=== 1. the 24.9 bug: a re-sent request is an EDIT ===");
{
  // The exact shape found by hand: a pending request for חשמונאים carrying
  // "עידן", re-sent for the same slot with "יובל EY".
  const existing: ExistingRequest = {
    id: "existing-id",
    studio: HASH,
    start_at: iso("2026-09-29", 9, 30),
    status: "pending",
    created_at: iso("2026-09-24", 14, 3),
  };

  const found = findDuplicatePending([existing], { studio: HASH, start: israelInstant("2026-09-29", 9, 30) });
  check("the re-send still matches the existing row", found?.id, "existing-id");

  const write = duplicateWrite(existing, { guest: "יובל EY", note: "הערה חדשה" });
  check("the write targets the EXISTING row — zero new rows", write.id, "existing-id");
  check("and carries the NEW guest", write.guest, "יובל EY");
  check("and the NEW note", write.note, "הערה חדשה");
  check("it writes exactly three fields — no slot, no status, no timestamps", Object.keys(write).sort(), [
    "guest",
    "id",
    "note",
  ]);
  check("clearing the guest is a real edit, not a skipped one", duplicateWrite(existing, { guest: null, note: null }).guest, null);

  // ── and the message the client sends now agrees with the row ──────────────
  // The route answers with `write.guest`; the page builds the wa.me text from
  // the ANSWER. Both strings below are built that way.
  const before = whatsappText({
    showName: SHOW,
    dateIsrael: "2026-09-29",
    startIsrael: "09:30",
    studio: HASH,
    guest: "עידן",
  });
  const after = whatsappText({
    showName: SHOW,
    dateIsrael: "2026-09-29",
    startIsrael: "09:30",
    studio: HASH,
    guest: write.guest,
  });
  check("the old name is gone from the message — 0 occurrences", after.split("עידן").length - 1, 0);
  check("the new name is there exactly once", after.split("יובל EY").length - 1, 1);
  check("the two messages really do differ", after === before, false);

  const href = whatsappComposeHref(after);
  check("the href carries the new name, encoded, once", href.split(encodeURIComponent("יובל EY")).length - 1, 1);
  check("and not the old one", href.split(encodeURIComponent("עידן")).length - 1, 0);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n=== 2. the event title, read back by the REAL parsers ===");
{
  const shows: ShowForMatch[] = [{ id: "s1", name: SHOW, aliases: [SHOW] }];

  // ── an ordinary guest
  const t1 = eventTitle({ alias: SHOW, guest: "דנה לוי", studio: GIVON });
  check("the title", t1, "דעה לא פופולרית, אורח: דנה לוי, גבעון");
  check("studio reads back", extractStudioAndGuest(t1, STUDIOS).studio, GIVON);
  check("guest reads back", extractStudioAndGuest(t1, STUDIOS).guest, "דנה לוי");
  check("the show matches", matchTitleToShow(t1, shows)?.show.id, "s1");

  // ── two guests the client separated with a comma
  const t2 = eventTitle({ alias: SHOW, guest: "דנה לוי, יוסי כהן", studio: GIVON });
  check("the comma became ו", t2, "דעה לא פופולרית, אורח: דנה לוי ויוסי כהן, גבעון");
  check("BOTH names survive the parser", extractStudioAndGuest(t2, STUDIOS).guest, "דנה לוי ויוסי כהן");
  check("and the studio is still right", extractStudioAndGuest(t2, STUDIOS).studio, GIVON);
  check("the show still matches", matchTitleToShow(t2, shows)?.show.id, "s1");
  // the control: what the comma would have done
  check("WITHOUT the fix the second name is lost", extractStudioAndGuest(`${SHOW}, אורח: דנה לוי, יוסי כהן, ${GIVON}`, STUDIOS).guest, "דנה לוי");

  // ── no guest
  const t3 = eventTitle({ alias: SHOW, guest: null, studio: HASH });
  check("the guestless title", t3, "דעה לא פופולרית, חשמונאים");
  check("no label appears", t3.split("אורח").length - 1, 0);
  check("studio reads back", extractStudioAndGuest(t3, STUDIOS).studio, HASH);
  check("and the guest is honestly null", extractStudioAndGuest(t3, STUDIOS).guest, null);
  check("the show matches", matchTitleToShow(t3, shows)?.show.id, "s1");
  check("an empty guest behaves as none", eventTitle({ alias: SHOW, guest: "   ", studio: HASH }), t3);

  // ── guestForTitle in isolation
  check("a newline", guestForTitle("דנה\nלוי"), "דנה לוי");
  check("a tab", guestForTitle("דנה\tלוי"), "דנה לוי");
  check("NBSP", guestForTitle("דנה לוי"), "דנה לוי");
  check("RLM", guestForTitle("‏דנה לוי"), "דנה לוי");
  check("an isolate pair", guestForTitle("⁦דנה לוי⁩"), "דנה לוי");
  check("double spaces", guestForTitle("  דנה   לוי  "), "דנה לוי");
  check("a comma with no space", guestForTitle("דנה,יוסי"), "דנה ויוסי");
  check("a comma before a newline", guestForTitle("דנה,\nיוסי"), "דנה ויוסי");
  check("two commas", guestForTitle("א, ב, ג"), "א וב וג");
  check("a COLON is left alone — measured as harmless", guestForTitle("דנה: לוי"), "דנה: לוי");
  check("null", guestForTitle(null), "");
  check("the stored name is never mutated by this", guestForTitle("רות גבעון"), "רות גבעון");
}

console.log("\n=== 3. the guest-names-a-room warning ===");
{
  check("a plain name does not warn", namesAnyRoom("דנה לוי", STUDIOS), false);
  check("'רות גבעון' warns", namesAnyRoom("רות גבעון", STUDIOS), true);
  check("'רות גבעון גדול' warns", namesAnyRoom("רות גבעון גדול", STUDIOS), true);
  check("חשמונאים warns", namesAnyRoom("יוסי חשמונאים", STUDIOS), true);
  check("TLV warns — recognised everywhere", namesAnyRoom("Dana TLV", STUDIOS), true);
  check("no guest does not warn", namesAnyRoom(null, STUDIOS), false);
  check("an empty guest does not warn", namesAnyRoom("   ", STUDIOS), false);

  // and the reason it matters, measured: the room really is misread
  const bad = eventTitle({ alias: SHOW, guest: "רות גבעון גדול", studio: HASH });
  check("a title with a room inside the guest parses the WRONG room", extractStudioAndGuest(bad, STUDIOS).studio, GIVON_BIG);
  check("which is not the room that was booked", extractStudioAndGuest(bad, STUDIOS).studio === HASH, false);
}

console.log("\n=== 4. the Google Calendar hand-off ===");
{
  // ⚠️ both sides of the 25.10.2026 DST change. 09:00 Israel is 06:00Z while
  // the country is on UTC+3 and 07:00Z after it falls back to UTC+2.
  check("20.10 — UTC+3", googleDateStamp(israelInstant("2026-10-20", 9, 0)), "20261020T060000Z");
  check("27.10 — UTC+2", googleDateStamp(israelInstant("2026-10-27", 9, 0)), "20261027T070000Z");
  check("and the ends move with them", [
    googleDateStamp(israelInstant("2026-10-20", 10, 30)),
    googleDateStamp(israelInstant("2026-10-27", 10, 30)),
  ], ["20261020T073000Z", "20261027T083000Z"]);
  check("a bad date throws rather than guessing", (() => {
    try {
      googleDateStamp(new Date("nope"));
      return "no throw";
    } catch {
      return "threw";
    }
  })(), "threw");

  const title = eventTitle({ alias: SHOW, guest: "דנה לוי", studio: GIVON });
  const url = googleCalendarUrl({
    title,
    start: israelInstant("2026-10-27", 9, 0),
    end: israelInstant("2026-10-27", 10, 30),
    details: "הערה של הלקוח",
  });
  check("it is a TEMPLATE link", url.startsWith("https://calendar.google.com/calendar/render?"), true);
  check("action=TEMPLATE once", url.split("action=TEMPLATE").length - 1, 1);
  check("the dates range, post-DST", url.split("dates=20261027T070000Z%2F20261027T083000Z").length - 1, 1);
  check("the timezone travels with it", url.split("ctz=Asia%2FJerusalem").length - 1, 1);
  check("the title is encoded, not raw", url.includes(title), false);
  check("and round-trips exactly", new URL(url).searchParams.get("text"), title);
  check("the note goes in details", new URL(url).searchParams.get("details"), "הערה של הלקוח");
  check("no raw space anywhere", url.includes(" "), false);

  const noNote = googleCalendarUrl({
    title,
    start: israelInstant("2026-10-27", 9, 0),
    end: israelInstant("2026-10-27", 10, 30),
    details: null,
  });
  check("no note -> no details parameter at all", noNote.includes("details="), false);
  check("a blank note -> no details parameter", googleCalendarUrl({ title, start: israelInstant(SUN, 9, 0), end: israelInstant(SUN, 10, 30), details: "   " }).includes("details="), false);
  check("🔴 the note NEVER reaches the title", eventTitle({ alias: SHOW, guest: "דנה לוי", studio: GIVON }).includes("הערה"), false);
}

console.log("\n=== 5. the owner's two messages ===");
{
  check("approved", approvedWhatsappText({ showName: SHOW, dateIsrael: SUN, startIsrael: "09:00", studio: GIVON }),
    "ההקלטה של דעה לא פופולרית אושרה: יום א׳ 27.9 ב-09:00, אולפן גבעון. נתראה!");
  check("declined", declinedWhatsappText({ showName: SHOW, dateIsrael: SUN, startIsrael: "09:00" }),
    "הבקשה של דעה לא פופולרית ליום א׳ 27.9 ב-09:00 לא אושרה. אפשר לבחור מועד אחר בקישור.");
  check("Monday inflects", approvedWhatsappText({ showName: SHOW, dateIsrael: MON, startIsrael: "11:00", studio: HASH }),
    "ההקלטה של דעה לא פופולרית אושרה: יום ב׳ 28.9 ב-11:00, אולפן חשמונאים. נתראה!");

  // 🔴 NO NUMBER in the owner's links — they pick the podcast's chat
  const href = whatsappComposeHref(approvedWhatsappText({ showName: SHOW, dateIsrael: SUN, startIsrael: "09:00", studio: GIVON }));
  check("the href has no number segment", href.startsWith("https://wa.me/?text="), true);
  check("no digits between wa.me/ and ?", /wa\.me\/\d/.test(href), false);
  check("it round-trips", decodeURIComponent(href.split("?text=")[1]), approvedWhatsappText({ showName: SHOW, dateIsrael: SUN, startIsrael: "09:00", studio: GIVON }));
  check("no raw space", href.includes(" "), false);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n=== 6. waiting / history / past-its-moment ===");
{
  const rows: QueueRow[] = [
    row({ id: "future-pending", start_at: iso(SUN, 9), end_at: iso(SUN, 10, 30) }),
    row({ id: "later-pending", start_at: iso(MON, 11), end_at: iso(MON, 12, 30) }),
    row({ id: "past-pending", start_at: iso("2026-09-22", 9), end_at: iso("2026-09-22", 10, 30) }),
    row({ id: "approved", status: "approved", start_at: iso(SUN, 15), end_at: iso(SUN, 16, 30), studio: HASH }),
    row({ id: "declined", status: "declined", start_at: iso(MON, 15), end_at: iso(MON, 16, 30), studio: HASH }),
  ];
  const { waiting, history } = splitQueue(rows, NOW);

  check("waiting holds only FUTURE pending", waiting.map((v) => v.id), ["future-pending", "later-pending"]);
  check("earliest first — it is a worklist", waiting.map((v) => v.startIsrael), ["09:00", "11:00"]);
  check("history holds the rest", history.map((v) => v.id).sort(), ["approved", "declined", "past-pending"]);
  check("newest first", history.map((v) => v.id), ["declined", "approved", "past-pending"]);

  const past = history.find((v) => v.id === "past-pending")!;
  check("a pending row whose moment passed reads 'המועד עבר'", past.statusLabel, "המועד עבר");
  check("it CANNOT be approved", past.canApprove, false);
  check("but it CAN still be declined — the client is owed an answer", past.canDecline, true);

  const fut = waiting[0];
  check("a live pending row can be both", [fut.canApprove, fut.canDecline], [true, true]);
  check("an approved row can be neither", (() => {
    const a = history.find((v) => v.id === "approved")!;
    return [a.canApprove, a.canDecline];
  })(), [false, false]);
  check("a declined row can be neither", (() => {
    const d = history.find((v) => v.id === "declined")!;
    return [d.canApprove, d.canDecline];
  })(), [false, false]);
  check("the four status labels", [
    waiting[0].statusLabel,
    history.find((v) => v.id === "approved")!.statusLabel,
    history.find((v) => v.id === "declined")!.statusLabel,
    past.statusLabel,
  ], ["ממתינה", "אושרה", "נדחתה", "המועד עבר"]);

  // ── the line builders
  check("the when line", fut.whenLine, "יום א׳ 27.9 · 09:00–10:30 · אולפן גבעון");
  check("the sent line", fut.sentLine, "נשלחה יום ה׳ 24.9 14:03");
  check("no guest -> the approved phrase, never a gap", fut.guestLine, NO_GUEST);
  check("and the raw guest stays null", fut.guest, null);
  const withGuest = splitQueue([row({ guest: "  דנה לוי  " })], NOW).waiting[0];
  check("a guest is shown trimmed", withGuest.guestLine, "דנה לוי");
  check("and 'בלי אורח' is NOT shown", withGuest.guestLine === NO_GUEST, false);
  check("a blank guest reads as none", splitQueue([row({ guest: "   " })], NOW).waiting[0].guestLine, NO_GUEST);
  check("a blank note reads as none", splitQueue([row({ note: "  " })], NOW).waiting[0].note, null);

  // ── history is capped
  const many: QueueRow[] = Array.from({ length: 40 }, (_, i) =>
    row({ id: `h${i}`, status: "declined", start_at: iso("2026-09-20", 9 + (i % 9)), end_at: iso("2026-09-20", 10 + (i % 9)) })
  );
  check(`history is capped at ${HISTORY_LIMIT}`, splitQueue(many, NOW).history.length, HISTORY_LIMIT);
  check("waiting is not capped by it", splitQueue(Array.from({ length: 40 }, (_, i) => row({ id: `w${i}`, start_at: iso(MON, 9), end_at: iso(MON, 10, 30) })), NOW).waiting.length, 40);

  // ── malformed rows
  check("an unparseable start is dropped from BOTH lists", (() => {
    const r = splitQueue([row({ id: "bad", start_at: "not a date" })], NOW);
    return [r.waiting.length, r.history.length];
  })(), [0, 0]);
  check("null rows", splitQueue(null, NOW), { waiting: [], history: [] });
  check("an unknown status is treated as pending", splitQueue([row({ status: "weird" })], NOW).waiting.length, 1);
}

console.log("\n=== 7. overlap is a TAG on pending rows ===");
{
  const a = row({ id: "a", studio: GIVON, start_at: iso(SUN, 9), end_at: iso(SUN, 10, 30) });
  const b = row({ id: "b", studio: GIVON, start_at: iso(SUN, 10), end_at: iso(SUN, 11, 30) });
  const touching = row({ id: "t", studio: GIVON, start_at: iso(SUN, 10, 30), end_at: iso(SUN, 12) });
  const other = row({ id: "o", studio: HASH, start_at: iso(SUN, 9), end_at: iso(SUN, 10, 30) });
  const approved = row({ id: "ap", status: "approved", studio: GIVON, start_at: iso(SUN, 9), end_at: iso(SUN, 10, 30) });
  const declined = row({ id: "dc", status: "declined", studio: GIVON, start_at: iso(SUN, 9), end_at: iso(SUN, 10, 30) });

  check("two pending that overlap", isOverlapping(a, [a, b]), true);
  check("both sides see it", isOverlapping(b, [a, b]), true);
  check("a row never overlaps itself", isOverlapping(a, [a]), false);
  check("TOUCHING is not overlapping — no buffer between bookings", isOverlapping(a, [a, touching]), false);
  check("a different room does not collide", isOverlapping(a, [a, other]), false);
  check("an APPROVED row does collide", isOverlapping(a, [a, approved]), true);
  check("a DECLINED row holds nothing", isOverlapping(a, [a, declined]), false);
  check("an unparseable other row is ignored", isOverlapping(a, [a, row({ id: "x", start_at: "nope" })]), false);

  // through the view
  const views = splitQueue([a, b, other], NOW).waiting;
  // ⚠️ the order here is the WAITING order — sorted by start time, not by the
  // order the rows were passed in: a and o both start at 09:00 and b at 10:00.
  check("the tag lands on both overlapping rows and not the third", views.map((v) => [v.id, v.overlapping]), [
    ["a", true],
    ["o", false],
    ["b", true],
  ]);
  check("an approved row carries no tag — nothing left to decide", splitQueue([approved, a], NOW).history[0].overlapping, false);
}

console.log("\n=== 8. the badge counts only FUTURE pending ===");
{
  const rows: QueueRow[] = [
    row({ id: "1", start_at: iso(SUN, 9) }),
    row({ id: "2", start_at: iso(MON, 9) }),
    row({ id: "3", start_at: iso("2026-09-22", 9) }), // past
    row({ id: "4", status: "approved", start_at: iso(SUN, 15) }),
    row({ id: "5", status: "declined", start_at: iso(SUN, 17) }),
  ];
  check("two", pendingFutureCount(rows, NOW), 2);
  check("and it equals what the waiting section shows", pendingFutureCount(rows, NOW), splitQueue(rows, NOW).waiting.length);
  check("a past pending row does not keep the badge alive", pendingFutureCount([row({ start_at: iso("2026-09-22", 9) })], NOW), 0);
  check("an empty table", pendingFutureCount([], NOW), 0);
  check("null", pendingFutureCount(null, NOW), 0);
  check("a malformed row is not counted", pendingFutureCount([row({ start_at: "nope" })], NOW), 0);
  check("a row starting exactly now still counts", pendingFutureCount([row({ start_at: NOW.toISOString() })], NOW), 1);
}

console.log("\n=== 9. 23P01 becomes a sentence the owner can act on ===");
{
  check("the exclusion violation is mapped", approveErrorMessage("23P01"), APPROVE_TAKEN_IN_DB);
  check("the sentence is the approved wording", APPROVE_TAKEN_IN_DB, "כבר אושרה בקשה אחרת לאותו חדר ולאותה שעה.");
  check("a unique violation is NOT this", approveErrorMessage("23505"), null);
  check("a foreign key violation is not", approveErrorMessage("23503"), null);
  check("no code at all", approveErrorMessage(undefined), null);
  check("null", approveErrorMessage(null), null);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n=== 10. a show with bookings cannot be deleted ===");
{
  check("zero bookings -> deletable", showDeleteBlockedByBookings(0), false);
  check("one booking -> blocked", showDeleteBlockedByBookings(1), true);
  check("fifty -> blocked", showDeleteBlockedByBookings(50), true);
  // 🔴 a count we do not have is not a zero
  check("null count -> blocked, because we do not know", showDeleteBlockedByBookings(null), true);
  check("undefined count -> blocked", showDeleteBlockedByBookings(undefined), true);
}

// ⚠️ WRAPPED IN AN ASYNC FUNCTION, not written at the top level. tsx compiles
// these scripts to CJS, where top-level await is a transform error — the suite
// would not run at all rather than fail an assertion. `void main()` keeps it
// off the top level; the summary moves inside so it prints after the awaits.
async function main() {
console.log("\n=== 11. merge moves bookings, in order, before any delete ===");
{
  /**
   * A fake pair that records the order it was called in.
   *
   * `const fn = (…) => …` rather than `function fn()`: the root tsconfig
   * targets ES5, where a function DECLARATION inside a block is a strict-mode
   * error (TS1252) — tsx runs the file happily and `tsc --noEmit` refuses it,
   * which is the build failing on a green suite.
   */
  const fakeOps = (fail?: "links" | "requests") => {
    const calls: string[] = [];
    const ops: BookingMergeOps = {
      moveLinks: async (s, t, u) => {
        calls.push(`links:${s}->${t}:${u}`);
        return { error: fail === "links" ? "boom" : null };
      },
      moveRequests: async (s, t) => {
        calls.push(`requests:${s}->${t}`);
        return { error: fail === "requests" ? "boom" : null };
      },
    };
    return { ops, calls };
  };

  const okRun = fakeOps();
  const okResult = await mergeBookingsInto(okRun.ops, { sourceId: "src", targetId: "tgt", userId: "u1" });
  check("it succeeds", okResult, { ok: true });
  check("LINKS FIRST, THEN REQUESTS — the order the unique index requires", okRun.calls, [
    "links:src->tgt:u1",
    "requests:src->tgt",
  ]);

  const linkFail = fakeOps("links");
  const linkResult = await mergeBookingsInto(linkFail.ops, { sourceId: "src", targetId: "tgt", userId: "u1" });
  check("a link failure stops the merge", linkResult, { ok: false, error: MERGE_LINKS_FAILED });
  check("and requests are NOT touched — nothing moved at all", linkFail.calls, ["links:src->tgt:u1"]);
  check("the message says the source was not deleted", MERGE_LINKS_FAILED.includes("לא נמחקה"), true);

  const reqFail = fakeOps("requests");
  const reqResult = await mergeBookingsInto(reqFail.ops, { sourceId: "src", targetId: "tgt", userId: "u1" });
  check("a request failure stops the merge", reqResult, { ok: false, error: MERGE_REQUESTS_FAILED });
  check("both steps were attempted", reqFail.calls.length, 2);
  check("the message admits the links DID move", MERGE_REQUESTS_FAILED.includes("הועברו"), true);
  check("and still says the source was not deleted", MERGE_REQUESTS_FAILED.includes("לא נמחקה"), true);
  check("neither message is a raw database error", [MERGE_LINKS_FAILED, MERGE_REQUESTS_FAILED].some((m) => m.includes("boom")), false);

  check("a null actor is accepted — the column is nullable", (await mergeBookingsInto(fakeOps().ops, { sourceId: "s", targetId: "t", userId: null })).ok, true);
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
}

void main();
