/**
 * AvailabilityBody, rendered in each state that can mislead. Pure.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_availability_render.tsx
 * No users, no database, no dev server — F19 is open and nothing here goes near it.
 *
 * ═══ EVERY TEXT ASSERTION COUNTS (rule 56) ═══
 * `includes` passes just as happily when a sentence renders twice — that is what
 * happened in F14, through two green suites, and was caught by eye. So the helper
 * is `countOf` and the assertion is `=== 1`.
 *
 * ═══ WHAT THIS FILE LOST WHEN THE SCREEN BECAME THE CLIENT'S ═══
 * The part-B assertions for the internal layout were REMOVED, not adapted,
 * because the things they described are gone from the screen (owner, 2026-09-22):
 *   · the title "זמינות אולפנים — בדיקה פנימית" and the paragraph under it
 *   · the range line "מ-… עד … · א׳–ה׳ 9:00–19:00 · משבצת של שעה וחצי"
 *   · the three-room table, its <th> headers, its day rows
 *   · "אין משבצות פנויות" — a table-cell sentence with no table to sit in
 *   · the refused room's "—" cell, which was a cell in that table
 * Keeping assertions for removed copy would be testing a screen that no longer
 * exists. So each of those strings is now asserted at ZERO occurrences instead,
 * in "the retired copy is gone" below — the old expectations are not deleted so
 * much as inverted, which is what stops the old layout creeping back.
 * What SURVIVED unchanged: the error sentence, the series banner, the warnings
 * intro and its empty sentence, the skipped section, and the step selector.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import AvailabilityBody, {
  COPY,
  refusedLine,
  hoursHeading,
  summaryLine,
  emptyMonthLine,
  warningsSummary,
  SKIPPED_REASON,
  type Refused,
  type Show,
  type Skipped,
  type UnknownBlock,
} from "../src/app/calendar/availability/AvailabilityBody";
import { monthOf, toPickerShows, type FreeSlot, type Month, type ShowRow } from "../src/app/calendar/availability/booking";
import { bookableRoomForDefault } from "../src/lib/calendar/rooms";
import { STUDIOS } from "../src/lib/calendar/studios";

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
/** what a reader sees: React's <!-- --> text separators and entities undone */
const seen = (html: string) =>
  html.replace(/<!--.*?-->/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const countOf = (html: string, needle: string) => seen(html).split(needle).length - 1;
/** day cells in the month grid, clickable or dimmed */
const dayCells = (html: string) => (html.match(/aspect-square/g) ?? []).length;
/**
 * Dimmed day cells ONLY. A day cell carries "opacity-30 cursor-not-allowed";
 * the month arrows carry "disabled:opacity-30 disabled:cursor-not-allowed", so
 * the `disabled:` between the two words keeps them out of this match. Counting
 * bare /cursor-not-allowed/ instead picks up both arrows in every month,
 * whether or not they are disabled, because the Tailwind variant sits in the
 * class attribute regardless.
 */
const dimmedDays = (html: string) => (html.match(/opacity-30 cursor-not-allowed/g) ?? []).length;
/** the opening tag of the button carrying this aria-label */
const buttonTag = (html: string, label: string) => {
  const i = html.indexOf(`aria-label="${label}"`);
  if (i < 0) return "";
  const start = html.lastIndexOf("<button", i);
  return start < 0 ? "" : html.slice(start, i);
};
/** hour buttons: the grid-cols-3 block's children */
const hourButtons = (html: string) => (html.match(/dir="ltr"[^>]*>\d{2}:\d{2}</g) ?? []).length;

const GIVON = "גבעון";
const GIVON_BIG = "גבעון גדול";
const HASH = "חשמונאים";
const ROOMS = [GIVON_BIG, GIVON, HASH];

const FROM = "2026-09-23";
const TO = "2026-11-17";
const SUN = "2026-09-27";
const MON = "2026-09-28";

const slot = (room: string, dateIsrael: string, startIsrael: string, endIsrael: string): FreeSlot => ({
  room, dateIsrael, startIsrael, endIsrael,
});

const SHOWS: Show[] = [
  { id: "s1", name: "דעה לא פופולרית", defaultRoom: GIVON },
  { id: "s2", name: "מצנע פודקאסט", defaultRoom: HASH },
  { id: "s3", name: "פודקאסט בלי ברירת מחדל", defaultRoom: null },
];

const BASE = {
  loading: false,
  error: null as string | null,
  fromIsrael: FROM as string | null,
  toIsrael: TO as string | null,
  rooms: ROOMS,
  free: [] as FreeSlot[],
  unknownRoomBlocks: [] as UnknownBlock[],
  roomsRefused: [] as Refused[],
  skipped: [] as Skipped[],
  step: 30 as 30 | 90,
  shows: SHOWS,
  selectedShowId: "s1" as string | null,
  selectedRoom: GIVON as string | null,
  selectedDate: null as string | null,
  selectedStart: null as string | null,
  visibleMonth: monthOf(FROM) as Month | null,
  warningsOpen: false,
  onStepChange: () => {},
  onShowChange: () => {},
  onRoomChange: () => {},
  onDateChange: () => {},
  onStartChange: () => {},
  onMonthChange: () => {},
  onToggleWarnings: () => {},
};
const render = (props: Partial<typeof BASE>) => renderToString(<AvailabilityBody {...BASE} {...props} />);

const SOME_FREE = [
  slot(GIVON, SUN, "09:00", "10:30"),
  slot(GIVON, SUN, "11:00", "12:30"),
  slot(GIVON, SUN, "17:30", "19:00"),
  slot(GIVON, MON, "14:00", "15:30"),
  slot(HASH, SUN, "15:00", "16:30"),
];

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 1. the client screen, loaded: every fixed sentence exactly once ===");
{
  const html = render({ free: SOME_FREE });
  for (const [label, text] of [
    ["preview lead", COPY.previewLead],
    ["booking title", COPY.bookingTitle],
    ["studio label", COPY.studioLabel],
    ["duration note", COPY.durationNote],
    ["warnings empty sentence", COPY.warningsEmpty],
    ["step: half hour", COPY.stepHalf],
    ["step: ninety", COPY.stepFull],
  ] as const) {
    check(`${label} — once`, countOf(html, text), 1);
  }
  // twice in total, and that is correct: once as an <option> in the owner's
  // preview picker, once as the client's heading. The heading is the one asserted.
  check("the show's name heads the client screen once", countOf(html, ">דעה לא פופולרית</p>"), 1);
  check("and appears twice in all, the other being the preview option", countOf(html, "דעה לא פופולרית"), 2);
  check("the 'pick a studio' sentence is absent when a room IS chosen", countOf(html, COPY.pickStudio), 0);
  check("the error sentence is absent", countOf(html, COPY.error), 0);
  check("the skipped heading is absent when nothing was skipped", countOf(html, COPY.skippedTitle), 0);
  check("no hours shown before a day is picked", hourButtons(html), 0);
  check("no summary card before an hour is picked", countOf(html, "·"), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 2. the retired part-B copy is GONE (zero occurrences) ===");
{
  const html = render({ free: SOME_FREE, selectedDate: SUN, selectedStart: "11:00" });
  for (const [label, text] of [
    ["the internal title", "זמינות אולפנים — בדיקה פנימית"],
    ["even the bare phrase", "זמינות אולפנים"],
    ["the internal explanation", "זה מה שלקוח היה רואה אילו הקישור היה פתוח. מחושב מהיומן בלבד. המסך לא גלוי ללקוחות ולא כותב לשום מקום."],
    ["the range line's middle", "· א׳–ה׳ 9:00–19:00 · משבצת של שעה וחצי"],
    ["the range line's opening", "מ-23.9 עד 17.11"],
    ["the table's empty-cell sentence", "אין משבצות פנויות"],
    ["the fetched-at footer", "נקרא מהיומן ב-"],
    // part B had this as a bare <h2>. It only ever appears now prefixed by a
    // count, and this render has zero warnings, so the bare phrase must be absent.
    ["the old bare warnings heading", "אירועים בלי חדר בכותרת — לא נחסמו"],
  ] as const) {
    check(`${label} — zero`, countOf(html, text), 0);
  }
  check("no <table> anywhere", countOf(html, "<table"), 0);
  check("no <th> room headers", ROOMS.reduce((a, r) => a + countOf(html, `>${r}</th>`), 0), 0);
  check("the day column header 'יום' is not a table header", countOf(html, "<th"), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 3. no default room: the sentence, and nothing to click ===");
{
  const html = render({ free: SOME_FREE, selectedShowId: "s3", selectedRoom: null });
  check("the sentence — once", countOf(html, COPY.pickStudio), 1);
  check("zero day cells", dayCells(html), 0);
  check("zero hour buttons", hourButtons(html), 0);
  check("no month label", countOf(html, "ספטמבר 2026"), 0);
  check("no weekday column heads", countOf(html, ">א׳<"), 0);
  check("the studio select is still present", countOf(html, `<select`), 2); // preview show picker + studio
  check("an empty option is offered while nothing is chosen", countOf(html, '<option value="" selected="">'), 1);
  check("the show's own name heads the screen once", countOf(html, ">פודקאסט בלי ברירת מחדל</p>"), 1);
  check("the duration note still renders once", countOf(html, COPY.durationNote), 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 4. TLV is never an option ===");
{
  const html = render({ free: SOME_FREE });
  check("TLV appears zero times in the whole screen", countOf(html, "TLV"), 0);
  // asserted on the option's TEXT, not its value attribute: React stamps
  // selected="" onto the chosen option, so `<option value="גבעון">` matches
  // every room except the selected one — an assertion that would have read as
  // "TLV is absent" while quietly also missing the selected room.
  check("exactly three room options", ROOMS.reduce((a, r) => a + countOf(html, `>${r}</option>`), 0), 3);
  check("each bookable room once", ROOMS.map((r) => countOf(html, `>${r}</option>`)), [1, 1, 1]);
  // and if a caller ever passed TLV in `rooms`, that is the route's bug, not a
  // silent filter here — assert the screen renders exactly what it is given
  const withTlv = render({ free: SOME_FREE, rooms: [...ROOMS, "TLV"] });
  check("the screen does not silently filter — it renders the list it is given", countOf(withTlv, ">TLV</option>"), 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 5. the month grid: clickable vs dimmed ===");
{
  const html = render({ free: SOME_FREE });
  check("month label once", countOf(html, "ספטמבר 2026"), 1);
  check("seven weekday heads", ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"].map((d) => countOf(html, `>${d}<`)).filter((n) => n === 1).length, 7);
  check("30 day cells for September", dayCells(html), 30);
  // two clickable days for גבעון (27.9 and 28.9), so 28 disabled
  check("28 dimmed cells — 30 days less the two free ones", dimmedDays(html), 28);
  check("the empty-month sentence is absent when days exist", countOf(html, emptyMonthLine(GIVON)), 0);

  // חשמונאים has one free day in September
  const asHash = render({ free: SOME_FREE, selectedRoom: HASH });
  check("חשמונאים still shows 30 cells", dayCells(asHash), 30);
  check("but 29 dimmed — it has one free day", dimmedDays(asHash), 29);

  // גבעון גדול has none
  const asBig = render({ free: SOME_FREE, selectedRoom: GIVON_BIG });
  check("גבעון גדול has all 30 dimmed", dimmedDays(asBig), 30);
  check("and gets the empty-month sentence once", countOf(asBig, emptyMonthLine(GIVON_BIG)), 1);
  check("the sentence names גבעון גדול, not another room", countOf(asBig, emptyMonthLine(GIVON)), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 6. an empty month names the selected studio, once ===");
{
  // November: SOME_FREE has nothing there
  const html = render({ free: SOME_FREE, visibleMonth: { year: 2026, month: 11 } });
  check("the sentence once", countOf(html, emptyMonthLine(GIVON)), 1);
  check("the month label is November", countOf(html, "נובמבר 2026"), 1);
  check("30 cells, all dimmed", dimmedDays(html), 30);
  check("zero hour buttons", hourButtons(html), 0);
  for (const room of ROOMS) {
    const h = render({ free: SOME_FREE, selectedRoom: room, visibleMonth: { year: 2026, month: 11 } });
    check(`the sentence names ${room}`, countOf(h, emptyMonthLine(room)), 1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 7. hours for the picked day, in the picked room only ===");
{
  const html = render({ free: SOME_FREE, selectedDate: SUN });
  check("the heading once", countOf(html, hoursHeading(SUN)), 1);
  check("the heading reads יום א׳ 27.9 — שעות פנויות", countOf(html, "יום א׳ 27.9 — שעות פנויות"), 1);
  check("three hours for גבעון on 27.9", hourButtons(html), 3);
  check("each start once", ["09:00", "11:00", "17:30"].map((t) => countOf(html, `>${t}<`)), [1, 1, 1]);
  check("חשמונאים's 15:00 is NOT among them", countOf(html, ">15:00<"), 0);

  // switching room on the same day yields the other room's hours
  const asHash = render({ free: SOME_FREE, selectedRoom: HASH, selectedDate: SUN });
  check("חשמונאים has one hour on 27.9", hourButtons(asHash), 1);
  check("and it is 15:00", countOf(asHash, ">15:00<"), 1);
  check("גבעון's hours are gone", ["09:00", "11:00", "17:30"].reduce((a, t) => a + countOf(asHash, `>${t}<`), 0), 0);

  // a day with nothing free in this room renders no heading at all
  const empty = render({ free: SOME_FREE, selectedRoom: GIVON_BIG, selectedDate: SUN });
  check("no heading when the room has no hours that day", countOf(empty, hoursHeading(SUN)), 0);
  check("and no hour buttons", hourButtons(empty), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 8. the summary card, and the absence of a submit button ===");
{
  const html = render({ free: SOME_FREE, selectedDate: SUN, selectedStart: "11:00" });
  check("summary line once", countOf(html, summaryLine(SUN, slot(GIVON, SUN, "11:00", "12:30"), GIVON)), 1);
  check("11:00 -> 12:30 exactly as approved", countOf(html, "יום א׳ 27.9 · 11:00–12:30 · אולפן גבעון"), 1);

  const late = render({ free: SOME_FREE, selectedDate: SUN, selectedStart: "17:30" });
  check("17:30 -> 19:00", countOf(late, "יום א׳ 27.9 · 17:30–19:00 · אולפן גבעון"), 1);

  const hashCard = render({ free: SOME_FREE, selectedRoom: HASH, selectedDate: SUN, selectedStart: "15:00" });
  check("the card names the chosen room", countOf(hashCard, "יום א׳ 27.9 · 15:00–16:30 · אולפן חשמונאים"), 1);

  // ⚠️ no button inside the card: slice from the card's own border class to the end
  const idx = html.indexOf("border-[var(--cyan)]/50");
  check("the card was found", idx > 0, true);
  const cardHtml = html.slice(idx);
  check("zero <button> inside the summary card", countOf(cardHtml, "<button"), 0);
  check("zero type=submit anywhere on the screen", countOf(html, 'type="submit"'), 0);
  check("zero <form> anywhere on the screen", countOf(html, "<form"), 0);

  // a start that is not among the day's slots renders no card
  const bogus = render({ free: SOME_FREE, selectedDate: SUN, selectedStart: "13:00" });
  check("an unmatched start renders no card", countOf(bogus, "· אולפן"), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 9. the preview bar's collapsed warnings row ===");
{
  const warnings: UnknownBlock[] = [
    { uid: "u1", title: "פלואו משרד הפנים", startIsrael: "2026-09-24 13:00", allDay: false, isSeries: true },
    { uid: "u2", title: "חשבים קאסט", startIsrael: "2026-09-25 11:00", allDay: false, isSeries: false },
    { uid: "u3", title: "דור ה-z", startIsrael: "2026-10-13 11:00", allDay: false, isSeries: false },
  ];
  const closed = render({ free: SOME_FREE, unknownRoomBlocks: warnings, warningsOpen: false });
  check("the summary row once", countOf(closed, warningsSummary(3)), 1);
  check("it reads '3 אירועים…'", countOf(closed, "3 אירועים בלי חדר בכותרת — לא נחסמו"), 1);
  check("closed: the explanation is NOT rendered", countOf(closed, COPY.warningsIntro), 0);
  check("closed: no titles rendered", warnings.reduce((a, w) => a + countOf(closed, w.title), 0), 0);
  check("closed: aria-expanded=false", countOf(closed, 'aria-expanded="false"'), 1);
  check("the empty sentence is absent when there ARE warnings", countOf(closed, COPY.warningsEmpty), 0);

  const open = render({ free: SOME_FREE, unknownRoomBlocks: warnings, warningsOpen: true });
  check("open: the summary row is still once", countOf(open, warningsSummary(3)), 1);
  check("open: the explanation once", countOf(open, COPY.warningsIntro), 1);
  check("open: each title once", warnings.map((w) => countOf(open, w.title)), [1, 1, 1]);
  check("open: the series marker once, for the one series", countOf(open, "סדרה חוזרת"), 1);
  check("open: aria-expanded=true", countOf(open, 'aria-expanded="true"'), 1);

  // n = 0 renders the flat sentence with no disclosure at all
  const none = render({ free: SOME_FREE, unknownRoomBlocks: [] });
  check("n=0: the existing sentence once", countOf(none, COPY.warningsEmpty), 1);
  check("n=0: no summary row", countOf(none, "אירועים בלי חדר בכותרת — לא נחסמו"), 0);
  check("n=0: no disclosure control", countOf(none, "aria-expanded"), 0);
  // n=1 is asserted in 13b, where the singular sentence lives. The earlier
  // expectation here demanded "1 אירועים…" verbatim — that WAS the approved copy
  // and is no longer, so it is replaced rather than kept alongside.
  check("n=1 renders the singular, not the plural template",
    countOf(render({ free: SOME_FREE, unknownRoomBlocks: [warnings[0]] }), "אירוע אחד בלי חדר בכותרת — לא נחסם"), 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 10. a refused room: the existing banner, all days dimmed ===");
{
  const seriesTitle = "סדרת חינוך - אור גיא ומיכאלי";
  const html = render({
    free: SOME_FREE, // carries no חשמונאים-refusal slots; a refused room has none
    selectedRoom: HASH,
    roomsRefused: [{ room: HASH, seriesUid: "s1", seriesTitle }],
  });
  check("the banner once, unchanged wording", countOf(html, refusedLine(HASH, seriesTitle)), 1);
  check("the series title once", countOf(html, seriesTitle), 1);
  // SOME_FREE does give חשמונאים one slot; a truly refused room has none, so assert
  // with a payload that reflects that
  const truly = render({
    free: SOME_FREE.filter((s) => s.room !== HASH),
    selectedRoom: HASH,
    roomsRefused: [{ room: HASH, seriesUid: "s1", seriesTitle }],
  });
  check("all 30 days dimmed", dimmedDays(truly), 30);
  check("zero hour buttons", hourButtons(truly), 0);
  check("the empty-month sentence names חשמונאים", countOf(truly, emptyMonthLine(HASH)), 1);
  check("the banner is absent for a room that is NOT refused",
    countOf(render({ free: SOME_FREE, selectedRoom: GIVON, roomsRefused: [{ room: HASH, seriesUid: "s1", seriesTitle }] }), refusedLine(HASH, seriesTitle)), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 11. the error state: the sentence, and no availability at all ===");
{
  const html = render({
    error: "failed",
    free: SOME_FREE, // deliberately supplied
    selectedDate: SUN,
    selectedStart: "11:00",
    unknownRoomBlocks: [{ uid: "u1", title: "משהו", startIsrael: "2026-09-24 13:00", allDay: false, isSeries: false }],
  });
  check("the error sentence once, unchanged", countOf(html, COPY.error), 1);
  check("zero clock times", (seen(html).match(/\d{2}:\d{2}/g) ?? []).length, 0);
  check("zero day cells", dayCells(html), 0);
  check("zero hour buttons", hourButtons(html), 0);
  check("no month label", countOf(html, "ספטמבר 2026"), 0);
  check("no summary card", countOf(html, "· אולפן"), 0);
  check("no studio select", countOf(html, `<option value="${GIVON}">`), 0);
  check("the supplied warning is not rendered", countOf(html, "משהו"), 0);
  check("the booking title is absent too", countOf(html, COPY.bookingTitle), 0);
  check("the preview lead still renders once", countOf(html, COPY.previewLead), 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 12. skipped: absent when empty, listed when not ===");
{
  const none = render({ free: SOME_FREE });
  check("heading absent", countOf(none, COPY.skippedTitle), 0);
  const some = render({
    free: SOME_FREE,
    skipped: [{ uid: "k1", title: "אירוע א", reason: "no-end" }, { uid: "k2", title: "אירוע ב", reason: "zero-length" }],
  });
  check("heading once", countOf(some, COPY.skippedTitle), 1);
  check("אין שעת סיום once", countOf(some, SKIPPED_REASON["no-end"]), 1);
  check("אורך אפס once", countOf(some, SKIPPED_REASON["zero-length"]), 1);
  check("an unmapped reason falls back to itself",
    countOf(render({ free: SOME_FREE, skipped: [{ uid: "k3", title: "ג", reason: "brand-new" }] }), "brand-new"), 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 13. month arrows stay inside the window ===");
{
  const first = render({ free: SOME_FREE, visibleMonth: { year: 2026, month: 9 } });
  const mid = render({ free: SOME_FREE, visibleMonth: { year: 2026, month: 10 } });
  const last = render({ free: SOME_FREE, visibleMonth: { year: 2026, month: 11 } });
  // scoped to the arrow button's OWN opening tag. The 30 dimmed day cells also
  // carry disabled="", so a document-wide count says nothing about the arrows.
  const arrowDisabled = (h: string, label: string) => {
    const tag = buttonTag(h, label);
    return tag === "" ? "missing" : tag.includes('disabled=""');
  };
  check("first month: previous arrow disabled", arrowDisabled(first, "חודש קודם"), true);
  check("first month: next arrow enabled", arrowDisabled(first, "חודש הבא"), false);
  check("middle month: both enabled", [arrowDisabled(mid, "חודש קודם"), arrowDisabled(mid, "חודש הבא")], [false, false]);
  check("last month: next arrow disabled", arrowDisabled(last, "חודש הבא"), true);
  check("last month: previous arrow enabled", arrowDisabled(last, "חודש קודם"), false);
  check("both arrows exist in every month", [first, mid, last].map((h) => countOf(h, 'aria-label="חודש')), [2, 2, 2]);

  // ⚠️ DIRECTION, per button. ‹ and › are Bidi_Mirrored, so inside dir="rtl"
  // they render flipped — each arrow pointed away from the month it goes to.
  // → and ← are not mirrored. Asserted per aria-label so a future swap of the
  // two buttons cannot pass by symmetry.
  const arrowGlyph = (h: string, label: string) => {
    const i = h.indexOf(`aria-label="${label}"`);
    if (i < 0) return "missing";
    const close = h.indexOf(">", i);
    const end = h.indexOf("</button>", close);
    return close < 0 || end < 0 ? "missing" : seen(h.slice(close + 1, end)).trim();
  };
  check("חודש קודם (right side, RTL) points RIGHT", arrowGlyph(mid, "חודש קודם"), "\u2192");
  check("חודש הבא (left side, RTL) points LEFT", arrowGlyph(mid, "חודש הבא"), "\u2190");
  check("the two glyphs differ", arrowGlyph(mid, "חודש קודם") !== arrowGlyph(mid, "חודש הבא"), true);
  // the mirrored characters must be gone entirely
  check("zero U+203A (single right angle) anywhere", countOf(mid, "\u203a"), 0);
  check("zero U+2039 (single left angle) anywhere", countOf(mid, "\u2039"), 0);
  check("exactly one → and one ← on the screen", [countOf(mid, "\u2192"), countOf(mid, "\u2190")], [1, 1]);
  // and the labels themselves, once each
  check("each accessible label once", [countOf(mid, 'aria-label="חודש קודם"'), countOf(mid, 'aria-label="חודש הבא"')], [1, 1]);
  // direction survives every month, including the ones with a disabled arrow
  check("direction is stable across months",
    [first, mid, last].map((h) => `${arrowGlyph(h, "חודש קודם")}${arrowGlyph(h, "חודש הבא")}`),
    ["\u2192\u2190", "\u2192\u2190", "\u2192\u2190"]);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 13b. the warnings row inflects: one event vs many ===");
{
  const w = (n: number): UnknownBlock[] =>
    Array.from({ length: n }, (_, i) => ({
      uid: `u${i}`, title: `אירוע ${i}`, startIsrael: "2026-09-24 13:00", allDay: false, isSeries: false,
    }));

  const one = render({ free: SOME_FREE, unknownRoomBlocks: w(1) });
  check("n=1 singular sentence once", countOf(one, "אירוע אחד בלי חדר בכותרת — לא נחסם"), 1);
  check("n=1 says נחסם, not נחסמו", countOf(one, "לא נחסמו"), 0);
  check("n=1 does NOT say '1 אירועים'", countOf(one, "1 אירועים"), 0);
  check("n=1 has a disclosure control", countOf(one, "aria-expanded"), 1);
  check("n=1 helper output", warningsSummary(1), "אירוע אחד בלי חדר בכותרת — לא נחסם");

  const two = render({ free: SOME_FREE, unknownRoomBlocks: w(2) });
  check("n=2 plural sentence once", countOf(two, "2 אירועים בלי חדר בכותרת — לא נחסמו"), 1);
  check("n=2 does not use the singular", countOf(two, "אירוע אחד"), 0);
  check("n=2 helper output", warningsSummary(2), "2 אירועים בלי חדר בכותרת — לא נחסמו");
  check("n=3 helper output", warningsSummary(3), "3 אירועים בלי חדר בכותרת — לא נחסמו");

  const none = render({ free: SOME_FREE, unknownRoomBlocks: w(0) });
  check("n=0 keeps today's flat sentence, once", countOf(none, COPY.warningsEmpty), 1);
  check("n=0 has no summary row at all", countOf(none, "בלי חדר בכותרת"), 0);
  check("n=0 has no disclosure control", countOf(none, "aria-expanded"), 0);

  // The regression that prompted this: never the standalone "1 אירועים".
  // ⚠️ A plain substring count is WRONG here, and my first version of this
  // assertion was: "11 אירועים" CONTAINS "1 אירועים", so n=11 failed a guard it
  // should pass. The digit lookbehind is what makes the claim mean what it says
  // — the same too-loose-substring class of mistake rule 56 exists for.
  const bareOne = (h: string) => (seen(h).match(/(?<!\d)1 אירועים/g) ?? []).length;
  for (const [label, n] of [["n=0", 0], ["n=1", 1], ["n=2", 2], ["n=3", 3], ["n=11", 11], ["n=21", 21], ["n=100", 100]] as const) {
    check(`${label}: zero occurrences of a standalone "1 אירועים"`, bareOne(render({ free: SOME_FREE, unknownRoomBlocks: w(n) })), 0);
  }
  // 11 must still read "11 אירועים" — the guard above must not have banned it
  check("n=11 renders '11 אירועים…' once", countOf(render({ free: SOME_FREE, unknownRoomBlocks: w(11) }), "11 אירועים בלי חדר בכותרת — לא נחסמו"), 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 13c. the preview picker lists only the shows it is given ===");
{
  // The `active` filter itself is a pure function and is asserted in
  // scripts/test_booking_calendar.ts §8 — it cannot be reached from a render,
  // because the body receives `shows` already narrowed. What IS assertable here
  // is the other half of the contract: the body renders exactly the list handed
  // to it, once each and no more. Feeding it the REAL toPickerShows output over
  // a mixed active/archived fixture is what joins the two halves.
  const rows: ShowRow[] = [
    { id: "a", name: "תוכנית פעילה", default_studio: "גבעון", active: true },
    { id: "b", name: "תוכנית מארכבת", default_studio: "חשמונאים", active: false },
    { id: "c", name: "עוד אחת פעילה", default_studio: null, active: true },
  ];
  const picker = toPickerShows(rows, (st) => bookableRoomForDefault(st, STUDIOS));
  check("the filter handed two shows to the body", picker.length, 2);

  const html = render({ free: SOME_FREE, shows: picker, selectedShowId: "a" });
  check("the archived show appears ZERO times in the markup", countOf(html, "תוכנית מארכבת"), 0);
  check("each active show is an option exactly once",
    picker.map((sh) => countOf(html, `>${sh.name}</option>`)), [1, 1]);
  check("exactly two options in the show picker",
    (seen(html).match(/<option value="(a|b|c)"/g) ?? []).length, 2);
  check("the selected show heads the client screen once", countOf(html, ">תוכנית פעילה</p>"), 1);
  // and if the page ever stopped filtering, this render would show it
  const unfiltered = render({ free: SOME_FREE, shows: rows.map((r) => ({ id: r.id, name: r.name ?? "—", defaultRoom: null })), selectedShowId: "a" });
  check("an UNFILTERED list would render the archived name — so the assertion above has teeth",
    countOf(unfiltered, "תוכנית מארכבת"), 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 14. broken payloads must not take the screen down ===");
{
  // the 2026-09-15 habit: tsc believed the type, the bundle got undefined
  const knockouts: [string, Partial<typeof BASE>][] = [
    ["free undefined", { free: undefined as unknown as FreeSlot[] }],
    ["rooms undefined", { rooms: undefined as unknown as string[] }],
    ["shows undefined", { shows: undefined as unknown as Show[] }],
    ["warnings undefined", { unknownRoomBlocks: undefined as unknown as UnknownBlock[] }],
    ["refusals undefined", { roomsRefused: undefined as unknown as Refused[] }],
    ["skipped undefined", { skipped: undefined as unknown as Skipped[] }],
    ["visibleMonth null", { visibleMonth: null }],
    ["a month outside the window", { visibleMonth: { year: 2030, month: 4 } }],
    ["selectedShowId unknown", { selectedShowId: "nope" }],
    ["selectedRoom unknown", { selectedRoom: "אולפן דמיוני" }],
    ["selectedDate malformed", { selectedDate: "23/09/2026" }],
    ["selectedDate outside the window", { selectedDate: "2030-01-01" }],
    ["selectedStart with no date", { selectedStart: "11:00", selectedDate: null }],
    ["a slot missing its room", { free: [{ dateIsrael: SUN, startIsrael: "09:00", endIsrael: "10:30" } as FreeSlot] }],
    ["empty shows list", { shows: [] }],
  ];
  for (const [label, props] of knockouts) {
    try {
      const html = render(props);
      check(`${label} — renders, preview lead once`, countOf(html, COPY.previewLead), 1);
    } catch (e) {
      failed++;
      console.log(`  ❌ ${label} — threw: ${(e as Error).message}`);
    }
  }
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
