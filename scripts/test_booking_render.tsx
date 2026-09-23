/**
 * The PUBLIC booking screen, rendered in each state that can mislead. Pure.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_booking_render.tsx
 * No users, no database, no dev server, no route — F19 is open and nothing here
 * goes near it.
 *
 * ═══ EVERY TEXT ASSERTION COUNTS (rule 56) ═══
 * `includes` passes just as happily when a sentence renders twice — that is what
 * happened in F14, through two green suites, and was caught by eye. So the
 * helper is `countOf` and the assertion is a number.
 *
 * ═══ WHAT THIS FILE IS REALLY GUARDING ═══
 * AvailabilityBody now serves TWO audiences from one component, switched by a
 * single boolean. That is what the owner's preview is worth — and it is also
 * one `publicMode` away from showing a client the owner's warnings, which carry
 * other clients' calendar titles. Half the assertions below are ZEROES for
 * exactly that reason: they are not checking that the screen looks right, they
 * are checking that the owner's half of it is ABSENT.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import AvailabilityBody, {
  COPY,
  requestLine,
  summaryLine,
  refusedLine,
  emptyMonthLine,
  type Refused,
} from "../src/app/calendar/availability/AvailabilityBody";
import DeadLink, { DEAD_LINK } from "../src/app/b/[token]/DeadLink";
import type { FreeSlot } from "../src/app/calendar/availability/booking";
import { myRequests, whatsappHref, whatsappNumberFrom, whatsappText, type RequestRow } from "../src/lib/booking/publicView";
import { israelInstant } from "../src/lib/calendar/availability";

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
const countRe = (html: string, re: RegExp) => (seen(html).match(re) ?? []).length;

const GIVON = "גבעון";
const GIVON_BIG = "גבעון גדול";
const HASH = "חשמונאים";
const SUN = "2026-09-27";
const MON = "2026-09-28";
const SHOW = "דעה לא פופולרית";

const slot = (room: string, d: string, s: string, e: string): FreeSlot => ({
  room,
  dateIsrael: d,
  startIsrael: s,
  endIsrael: e,
});

const SOME_FREE: FreeSlot[] = [
  slot(GIVON, SUN, "09:00", "10:30"),
  slot(GIVON, SUN, "11:00", "12:30"),
  slot(HASH, SUN, "15:00", "16:30"),
];

// The component's own prop type, so the base and every override are CHECKED.
// `as never` would have silenced the compiler and the suite along with it — a
// knockout that no longer matches the component would then still "pass".
type BodyProps = React.ComponentProps<typeof AvailabilityBody>;

const PUBLIC_BASE: BodyProps = {
  publicMode: true,
  loading: false,
  error: null,
  fromIsrael: SUN,
  toIsrael: "2026-11-21",
  rooms: [GIVON, GIVON_BIG, HASH],
  free: SOME_FREE,
  // exactly what BookClient passes — the public payload has neither
  unknownRoomBlocks: [],
  skipped: [],
  roomsRefused: [],
  step: 30,
  shows: [{ id: "public", name: SHOW, defaultRoom: GIVON }],
  selectedShowId: "public",
  selectedRoom: GIVON,
  selectedDate: null,
  selectedStart: null,
  visibleMonth: { year: 2026, month: 9 },
  warningsOpen: false,
  onStepChange: () => {},
  onShowChange: () => {},
  onRoomChange: () => {},
  onDateChange: () => {},
  onStartChange: () => {},
  onMonthChange: () => {},
  onToggleWarnings: () => {},
};

const render = (props: Partial<BodyProps> = {}) =>
  renderToString(<AvailabilityBody {...PUBLIC_BASE} {...props} />);

/** the owner's screen, for the side-by-side assertions */
const renderOwner = (props: Partial<BodyProps> = {}) =>
  renderToString(
    <AvailabilityBody
      {...PUBLIC_BASE}
      publicMode={false}
      shows={[{ id: "s1", name: SHOW, defaultRoom: GIVON }]}
      selectedShowId="s1"
      {...props}
    />
  );

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 1. the public page shows NOTHING of the owner's screen ===");
{
  const html = render({ selectedDate: SUN, selectedStart: "11:00" });

  check("0 × 'תצוגה מקדימה'", countOf(html, "תצוגה מקדימה"), 0);
  check("0 × the full preview lead", countOf(html, COPY.previewLead), 0);
  check("0 × 'אירועים בלי חדר'", countOf(html, "אירועים בלי חדר"), 0);
  check("0 × the warnings-empty sentence", countOf(html, COPY.warningsEmpty), 0);
  check("0 × the warnings explanation", countOf(html, COPY.warningsIntro), 0);
  check("0 × the skipped heading", countOf(html, COPY.skippedTitle), 0);
  check("0 × the half-hour step label", countOf(html, COPY.stepHalf), 0);
  check("0 × the ninety-minute step label", countOf(html, COPY.stepFull), 0);
  check("0 × the copy-link button", countOf(html, COPY.copyLink), 0);
  check("0 × 'הקישור הועתק'", countOf(html, COPY.copied), 0);
  check("0 × the OWNER's feed-error sentence", countOf(html, COPY.error), 0);
  check("0 radio inputs (the step selector is the owner's)", countRe(html, /type="radio"/g), 0);
  check("0 × the show name in an <option> — there is no picker", countRe(html, /<option[^>]*>דעה לא פופולרית/g), 0);

  // and the client's own screen IS there
  check("the booking title once", countOf(html, COPY.bookingTitle), 1);
  check("the show name heads the screen once", countOf(html, `>${SHOW}</p>`), 1);
  check("and appears exactly once in the whole document", countOf(html, SHOW), 1);
  // ⚠️ TWICE, and both are correct: once as the select's own label, once inside
  // the approved summary line "… · אולפן גבעון". Asserting 1 here would be
  // asserting that the summary card is missing.
  check("the word אולפן appears twice — the label and the summary line", countOf(html, COPY.studioLabel), 2);
  check("and exactly once when no hour is picked", countOf(render(), COPY.studioLabel), 1);
  check("the duration note once", countOf(html, COPY.durationNote), 1);
  check("three room options", countRe(html, /<option /g), 3);

  // the same props on the OWNER's screen prove the switch is what removed them
  const owner = renderOwner({ selectedDate: SUN, selectedStart: "11:00" });
  check("the owner still sees the preview lead once", countOf(owner, COPY.previewLead), 1);
  check("the owner still sees the copy-link button once", countOf(owner, COPY.copyLink), 1);
}

console.log("\n=== 2. the guest field — once, in the summary card, with its hint ===");
{
  const noPick = render();
  check("no card before an hour is picked: 0 × the guest label", countOf(noPick, COPY.guestLabel), 0);
  check("and 0 × the hint", countOf(noPick, COPY.guestHint), 0);
  check("and 0 × the submit button", countOf(noPick, COPY.submit), 0);

  const html = render({ selectedDate: SUN, selectedStart: "11:00" });
  check("the summary line once", countOf(html, summaryLine(SUN, slot(GIVON, SUN, "11:00", "12:30"), GIVON)), 1);
  check("the guest label EXACTLY once", countOf(html, COPY.guestLabel), 1);
  check("the hint exactly once", countOf(html, COPY.guestHint), 1);
  check("the note placeholder exactly once", countOf(html, COPY.notePlaceholder), 1);
  check("the submit button exactly once", countOf(html, COPY.submit), 1);
  check("one text input", countRe(html, /<input[^>]*type="text"/g), 1);
  check("one textarea", countRe(html, /<textarea/g), 1);
  check("maxLength 120 on the guest input", countRe(html, /maxlength="120"/gi), 1);
  check("still no <form> — the submit is a click, not a navigation", countOf(html, "<form"), 0);
  check("and no type=submit", countOf(html, 'type="submit"'), 0);

  // ⚠️ the OWNER's preview must NOT grow a live submit button
  const owner = renderOwner({ selectedDate: SUN, selectedStart: "11:00" });
  check("owner preview: 0 × the guest label", countOf(owner, COPY.guestLabel), 0);
  check("owner preview: 0 × the submit button", countOf(owner, COPY.submit), 0);
  check("owner preview: 0 text inputs", countRe(owner, /<input[^>]*type="text"/g), 0);
  check("owner preview: the summary line is still there once", countOf(owner, summaryLine(SUN, slot(GIVON, SUN, "11:00", "12:30"), GIVON)), 1);

  // a typed guest round-trips into the input
  const typed = render({ selectedDate: SUN, selectedStart: "11:00", guest: "דנה לוי" });
  check("the typed name appears once, as a value", countRe(typed, /value="דנה לוי"/g), 1);
}

console.log("\n=== 3. after a successful send ===");
{
  const sent = { dateIsrael: SUN, startIsrael: "11:00", studio: GIVON, guest: "דנה לוי" };
  const href = whatsappHref("972501234567", whatsappText({ showName: SHOW, ...sent }));

  const html = render({ selectedDate: SUN, selectedStart: "11:00", submitted: sent, whatsappHref: href });
  check("the confirmation sentence once", countOf(html, COPY.sent), 1);
  check("the WhatsApp button once", countOf(html, COPY.whatsapp), 1);
  check("exactly one wa.me link", countRe(html, /https:\/\/wa\.me\//g), 1);
  check("it opens in a new tab", countRe(html, /rel="noopener noreferrer"/g), 1);

  // ⚠️ the live form is GONE — a second identical request is not offered
  check("0 × the guest label", countOf(html, COPY.guestLabel), 0);
  check("0 × the submit button", countOf(html, COPY.submit), 0);
  check("0 text inputs", countRe(html, /<input[^>]*type="text"/g), 0);
  check("0 textareas", countRe(html, /<textarea/g), 0);
  check("the summary line is gone with it", countOf(html, summaryLine(SUN, slot(GIVON, SUN, "11:00", "12:30"), GIVON)), 0);

  // ── no number configured -> no button, no link, no dead anchor
  const noNumber = render({
    selectedDate: SUN,
    selectedStart: "11:00",
    submitted: sent,
    whatsappHref: whatsappHref(whatsappNumberFrom(undefined), whatsappText({ showName: SHOW, ...sent })),
  });
  check("without STUDIO_WHATSAPP_NUMBER: the sentence still renders once", countOf(noNumber, COPY.sent), 1);
  check("0 wa.me links", countRe(noNumber, /wa\.me/g), 0);
  check("0 × the WhatsApp button label", countOf(noNumber, COPY.whatsapp), 0);
  check("0 anchors anywhere on the screen", countRe(noNumber, /<a /g), 0);
  check("and no phone number appears in the HTML at all", countRe(noNumber, /\d{9,}/g), 0);

  // a guestless send still gets the button, with the shorter sentence
  const noGuest = { ...sent, guest: null };
  const g0 = render({
    selectedDate: SUN,
    selectedStart: "11:00",
    submitted: noGuest,
    whatsappHref: whatsappHref("972501234567", whatsappText({ showName: SHOW, ...noGuest })),
  });
  check("guestless: one wa.me link", countRe(g0, /https:\/\/wa\.me\//g), 1);
  check("guestless: the guest phrase is not encoded into it", countOf(g0, encodeURIComponent("אורח/ת")), 0);
  check("with a guest: the guest phrase IS encoded into it", countOf(html, encodeURIComponent("אורח/ת")), 1);

  // the submit error renders in place of nothing else
  const err = render({ selectedDate: SUN, selectedStart: "11:00", submitError: "המועד הזה נתפס בינתיים. בחרו מועד אחר." });
  check("the server's sentence renders once", countOf(err, "המועד הזה נתפס בינתיים. בחרו מועד אחר."), 1);
  check("and the form is still there to retry with", countOf(err, COPY.submit), 1);
}

console.log("\n=== 4. 'הבקשות שלכם' — above the board, three statuses ===");
{
  const none = render();
  check("no future requests -> the heading is absent entirely", countOf(none, COPY.myRequestsTitle), 0);

  const rows: RequestRow[] = [
    { id: "a", studio: GIVON, start_at: israelInstant(SUN, 9, 0).toISOString(), guest: "דנה לוי", status: "pending" },
    { id: "b", studio: GIVON_BIG, start_at: israelInstant(MON, 11, 0).toISOString(), guest: null, status: "approved" },
    { id: "c", studio: HASH, start_at: israelInstant("2026-09-30", 15, 0).toISOString(), guest: "יוסי כהן", status: "declined" },
  ];
  const views = myRequests(rows, "2026-09-26");
  const html = render({ myRequests: views });

  check("the heading once", countOf(html, COPY.myRequestsTitle), 1);
  check("three rows", countRe(html, /<li /g), 3);
  check("ממתינה לאישור once", countOf(html, "ממתינה לאישור"), 1);
  check("אושרה once", countOf(html, "אושרה"), 1);
  check("נדחתה once", countOf(html, "נדחתה"), 1);

  check("row 1 in full, once", countOf(html, requestLine(views[0])), 1);
  check("row 1 reads as approved copy", requestLine(views[0]), "יום א׳ 27.9 · 09:00 · אולפן גבעון · אורח/ת: דנה לוי");
  check("row 2 has NO guest clause", requestLine(views[1]), "יום ב׳ 28.9 · 11:00 · אולפן גבעון גדול");
  check("row 2 once", countOf(html, requestLine(views[1])), 1);
  check("row 3 once", countOf(html, requestLine(views[2])), 1);
  check("the guest names appear once each", [countOf(html, "דנה לוי"), countOf(html, "יוסי כהן")], [1, 1]);
  check("'אורח/ת:' appears twice — once per guest, not three times", countOf(html, "אורח/ת:"), 2);

  // ⚠️ never on the owner's preview: it is the CLIENT's own history
  check("owner preview: 0 × the heading", countOf(renderOwner({ myRequests: views }), COPY.myRequestsTitle), 0);

  // it renders before the calendar grid
  check("the heading precedes the first day cell", seen(html).indexOf(COPY.myRequestsTitle) < seen(html).indexOf("aspect-square"), true);
  // and with no room chosen it is still there
  const noRoom = render({ myRequests: views, selectedRoom: null });
  check("still shown before a studio is chosen", countOf(noRoom, COPY.myRequestsTitle), 1);
  check("and the pick-a-studio sentence is there once", countOf(noRoom, COPY.pickStudio), 1);
}

console.log("\n=== 5. a failure to load the dates ===");
{
  const html = render({ error: "failed" });
  check("the CLIENT's sentence once", countOf(html, COPY.publicLoadFailed), 1);
  check("0 × the owner's sentence", countOf(html, COPY.error), 0);
  check("0 day cells — no calendar beside a failure", countRe(html, /aspect-square/g), 0);
  check("0 × the booking title", countOf(html, COPY.bookingTitle), 0);
  check("0 × 'תצוגה מקדימה'", countOf(html, "תצוגה מקדימה"), 0);

  const owner = renderOwner({ error: "failed" });
  check("the OWNER still gets the owner's sentence once", countOf(owner, COPY.error), 1);
  check("and 0 × the client's", countOf(owner, COPY.publicLoadFailed), 0);
}

console.log("\n=== 6. a refused room never names the series to a client ===");
{
  const SERIES = "סדרה שבועית של לקוח אחר";
  const refused: Refused[] = [{ room: GIVON, seriesUid: "u1", seriesTitle: SERIES }];

  // BookClient sends an empty title, but assert the worst case: even handed a
  // real one, the public screen must not print it.
  const html = render({ roomsRefused: refused, free: [] });
  check("0 × the series title", countOf(html, SERIES), 0);
  check("0 × the refusal sentence", countOf(html, refusedLine(GIVON, SERIES)), 0);
  check("0 × the words 'סדרה חוזרת'", countOf(html, "סדרה חוזרת"), 0);
  check("the client gets the approved empty-month sentence instead, once", countOf(html, emptyMonthLine(GIVON)), 1);

  const owner = renderOwner({ roomsRefused: refused, free: [] });
  check("the OWNER does see the refusal sentence once", countOf(owner, refusedLine(GIVON, SERIES)), 1);
}

console.log("\n=== 7. the dead-link page ===");
{
  const html = renderToString(<DeadLink />);
  check("the sentence once", countOf(html, DEAD_LINK), 1);
  check("it is the approved wording", DEAD_LINK, "הקישור הזה לא פעיל. פנו לאולפן לקישור חדש.");
  check("0 links anywhere — nothing to click into the app", countRe(html, /<a /g), 0);
  check("0 buttons", countRe(html, /<button/g), 0);
  check("0 × any show name", countOf(html, SHOW), 0);
  check("0 × the booking title", countOf(html, COPY.bookingTitle), 0);
  check("0 day cells", countRe(html, /aspect-square/g), 0);
  check("it is right-to-left", countRe(html, /dir="rtl"/g), 1);
}

console.log("\n=== 8. malformed props must not take the page down ===");
{
  const knockouts: [string, Partial<BodyProps>][] = [
    ["free undefined", { free: undefined }],
    ["rooms undefined", { rooms: undefined }],
    ["myRequests undefined", { myRequests: undefined }],
    ["roomsRefused undefined", { roomsRefused: undefined }],
    ["visibleMonth null", { visibleMonth: null }],
    ["a month outside the window", { visibleMonth: { year: 2030, month: 4 } }],
    ["selectedRoom unknown", { selectedRoom: "אולפן דמיוני" }],
    ["selectedDate malformed", { selectedDate: "27/09/2026" }],
    ["selectedStart with no date", { selectedStart: "11:00", selectedDate: null }],
    ["submitted with no slot picked", { submitted: { dateIsrael: SUN, startIsrael: "11:00", studio: GIVON, guest: null } }],
    ["whatsappHref null while submitted", { selectedDate: SUN, selectedStart: "11:00", submitted: { dateIsrael: SUN, startIsrael: "11:00", studio: GIVON, guest: null }, whatsappHref: null }],
    ["empty shows list", { shows: [] }],
  ];
  for (const [label, props] of knockouts) {
    try {
      const html = render(props);
      // the one thing that must hold in every case: the owner's half stays out
      check(`${label} — renders, 0 × 'תצוגה מקדימה'`, countOf(html, "תצוגה מקדימה"), 0);
    } catch (e) {
      failed++;
      console.log(`  ❌ ${label} — threw: ${(e as Error).message}`);
    }
  }
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
