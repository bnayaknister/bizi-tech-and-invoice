/**
 * Renders AvailabilityBody in each of its real states against synthetic props.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_availability_render.tsx
 * Reads nothing, writes nothing, needs no dev server, touches no database.
 *
 * ═══ EVERY TEXT ASSERTION COUNTS (rule 56, 2026-09-22) ═══
 * `html.includes(x)` passes just as happily when x renders twice, and that is
 * not hypothetical: in F14 a whole explanatory paragraph rendered twice and BOTH
 * suites stayed green, because every assertion was a substring check. It was
 * found by eye. So the helper here is `countOf`, and the assertion is `=== 1`.
 *
 * The states are the ones where this screen can mislead rather than merely look
 * wrong: the error (a grid beside "I could not read the calendar" reads as
 * availability), a refused room (which must not read as "full"), and the
 * warnings section (whose empty sentence is the only thing standing between the
 * owner and an unexamined blind spot).
 */
import { renderToString } from "react-dom/server";
import React from "react";
import AvailabilityBody, {
  COPY,
  rangeLine,
  refusedLine,
  fetchedLine,
  SKIPPED_REASON,
  type FreeSlot,
  type Refused,
  type Skipped,
  type UnknownBlock,
} from "../src/app/calendar/availability/AvailabilityBody";

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
/**
 * What a reader actually sees, with two pieces of React's server output undone:
 *
 *   `<!-- -->`  renderToString puts a comment between two adjacent text
 *               expressions, so `{dow} {date}` reaches the HTML as
 *               "ד׳<!-- --> <!-- -->23.9" and a naive search for "ד׳ 23.9"
 *               finds nothing while the screen reads correctly.
 *   entities    approved copy contains a literal quote — the banner says
 *               סדרה חוזרת "כותרת" — and React escapes it to &quot;. Asserting
 *               on the raw HTML would test the escaping, not the sentence.
 *
 * Tags are left in place so structural assertions (">09:00<", "<table") still
 * work on the same string.
 */
const seen = (html: string) =>
  html
    .replace(/<!--.*?-->/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** occurrences of `needle` in the visible text, so "exactly once" is expressible */
const countOf = (haystack: string, needle: string) => seen(haystack).split(needle).length - 1;

const GIVON = "גבעון";
const GIVON_BIG = "גבעון גדול";
const HASH = "חשמונאים";
const ROOMS = [GIVON_BIG, GIVON, HASH];

const slot = (room: string, dateIsrael: string, startIsrael: string, endIsrael: string): FreeSlot => ({
  room, dateIsrael, startIsrael, endIsrael,
});

// the nullable props are annotated, not inferred: `Partial<typeof BASE>` below
// would otherwise narrow them to `string | undefined` and reject the null cases
const BASE = {
  loading: false,
  error: null as string | null,
  fromIsrael: "2026-09-23" as string | null,
  toIsrael: "2026-11-17" as string | null,
  rooms: ROOMS,
  free: [] as FreeSlot[],
  unknownRoomBlocks: [] as UnknownBlock[],
  roomsRefused: [] as Refused[],
  skipped: [] as Skipped[],
  step: 30 as 30 | 90,
  fetchedAt: "2026-09-22T18:30:00.000Z" as string | null,
  onStepChange: () => {},
};
const render = (props: Partial<typeof BASE>) =>
  renderToString(<AvailabilityBody {...BASE} {...props} />);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== every fixed sentence appears EXACTLY ONCE in the loaded state ===");
{
  const html = render({
    free: [
      slot(GIVON, "2026-09-23", "09:00", "10:30"),
      slot(GIVON, "2026-09-23", "10:30", "12:00"),
      slot(HASH, "2026-09-23", "09:00", "10:30"),
      slot(GIVON_BIG, "2026-09-24", "09:00", "10:30"),
    ],
  });
  for (const [label, text] of [
    ["title", COPY.title],
    ["intro", COPY.intro],
    ["step: half hour", COPY.stepHalf],
    ["step: ninety minutes", COPY.stepFull],
    ["warnings heading", COPY.warningsTitle],
    ["warnings intro", COPY.warningsIntro],
    ["warnings empty sentence", COPY.warningsEmpty],
    ["range line", rangeLine("2026-09-23", "2026-11-17")],
    ["fetched line", fetchedLine("2026-09-22T18:30:00.000Z")],
  ] as const) {
    check(`${label} — once`, countOf(html, text), 1);
  }
  check("the error sentence is absent", countOf(html, COPY.error), 0);
  check("the skipped heading is absent when nothing was skipped", countOf(html, COPY.skippedTitle), 0);
  check("range line renders the dates as 23.9 / 17.11", countOf(html, "מ-23.9 עד 17.11"), 1);
  check("fetched line shows Israeli 21:30 for 18:30Z", countOf(html, "נקרא מהיומן ב-21:30 (בשעון ישראל)"), 1);

  // the grid itself
  check("two day rows", countOf(html, "<tr class=\"border-b border-[var(--rule)]/50 align-top\">"), 2);
  check("each room heads a column once", ROOMS.map((r) => countOf(html, `>${r}</th>`)), [1, 1, 1]);
  check("09:00 appears three times (three cells have it)", countOf(html, ">09:00<"), 3);
  check("10:30 appears once as a start", countOf(html, ">10:30<"), 1);
  // 23.9 is a Wednesday -> ד׳ ; 24.9 is a Thursday -> ה׳
  check("weekday letters", [countOf(html, "ד׳ 23.9"), countOf(html, "ה׳ 24.9")], [1, 1]);
  // 3 rooms x 2 days = 6 cells. Filled: גבעון 23.9, חשמונאים 23.9,
  // גבעון גדול 24.9 = 3. So exactly 3 cells carry the sentence.
  check("empty-cell sentence appears three times", countOf(html, COPY.emptyCell), 3);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== the error state: the sentence, and no availability at all ===");
{
  const html = render({
    error: "failed",
    free: [slot(GIVON, "2026-09-23", "09:00", "10:30")], // deliberately supplied
    unknownRoomBlocks: [{ uid: "u1", title: "משהו", startIsrael: "2026-09-24 13:00", allDay: false, isSeries: false }],
  });
  check("error sentence — once", countOf(html, COPY.error), 1);
  check("title still once", countOf(html, COPY.title), 1);
  // zero hours: no HH:MM anywhere
  check("zero clock times rendered", (html.match(/\d{2}:\d{2}/g) ?? []).length, 0);
  // zero weekday names
  check("zero weekday letters", ["א׳", "ב׳", "ג׳", "ד׳", "ה׳"].reduce((a, d) => a + countOf(html, `${d} `), 0), 0);
  check("no table element", countOf(html, "<table"), 0);
  check("no room column headers", ROOMS.reduce((a, r) => a + countOf(html, `>${r}</th>`), 0), 0);
  check("the supplied slot is not rendered", countOf(html, "09:00"), 0);
  check("the supplied warning is not rendered", countOf(html, "משהו"), 0);
  check("the range line is absent", countOf(html, rangeLine("2026-09-23", "2026-11-17")), 0);
  check("the warnings heading is absent", countOf(html, COPY.warningsTitle), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== a refused room: banner once, and NOT presented as merely full ===");
{
  const seriesTitle = "סדרת חינוך - אור גיא ומיכאלי";
  const html = render({
    roomsRefused: [{ room: HASH, seriesUid: "s1", seriesTitle }],
    free: [
      slot(GIVON, "2026-09-23", "09:00", "10:30"),
      slot(GIVON_BIG, "2026-09-23", "09:00", "10:30"),
    ],
  });
  check("banner — once", countOf(html, refusedLine(HASH, seriesTitle)), 1);
  check("the series title appears once", countOf(html, seriesTitle), 1);
  // the crux: חשמונאים must NOT carry the empty-cell sentence, which would
  // claim we checked its calendar and found nothing free
  check("empty-cell sentence appears zero times", countOf(html, COPY.emptyCell), 0);
  check("חשמונאים still heads its column", countOf(html, `>${HASH}</th>`), 1);
  check("its cell renders the unknown dash", countOf(html, ">—</td>"), 1);
  check("one day row", countOf(html, "align-top"), 1);

  // two refused rooms -> two banners, still no empty-cell sentence
  const html2 = render({
    roomsRefused: [
      { room: HASH, seriesUid: "s1", seriesTitle },
      { room: GIVON, seriesUid: "s2", seriesTitle: "סדרה אחרת" },
    ],
    free: [slot(GIVON_BIG, "2026-09-23", "09:00", "10:30")],
  });
  check("two banners", countOf(html2, "לא מוצג: יש ביומן סדרה חוזרת"), 2);
  check("still no empty-cell sentence", countOf(html2, COPY.emptyCell), 0);
  check("two dashes, one per refused room", countOf(html2, ">—</td>"), 2);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== warnings: the empty sentence, and the series marker ===");
{
  const empty = render({ free: [slot(GIVON, "2026-09-23", "09:00", "10:30")] });
  check("no warnings -> empty sentence once", countOf(empty, COPY.warningsEmpty), 1);
  check("no <li> rendered for warnings", countOf(empty, "סדרה חוזרת"), 0);

  const withSeries = render({
    free: [slot(GIVON, "2026-09-23", "09:00", "10:30")],
    unknownRoomBlocks: [
      { uid: "u1", title: "פלואו משרד הפנים", startIsrael: "2026-09-24 13:00", allDay: false, isSeries: true },
      { uid: "u2", title: "חשבים קאסט", startIsrael: "2026-09-25 11:00", allDay: false, isSeries: false },
    ],
  });
  check("empty sentence gone", countOf(withSeries, COPY.warningsEmpty), 0);
  check("series marker — exactly once, for the one series", countOf(withSeries, "סדרה חוזרת"), 1);
  check("both titles once each", [countOf(withSeries, "פלואו משרד הפנים"), countOf(withSeries, "חשבים קאסט")], [1, 1]);
  check("both timestamps once each", [countOf(withSeries, "2026-09-24 13:00"), countOf(withSeries, "2026-09-25 11:00")], [1, 1]);
  check("warnings intro still once", countOf(withSeries, COPY.warningsIntro), 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== skipped: heading absent when empty, present with reasons when not ===");
{
  const none = render({ free: [slot(GIVON, "2026-09-23", "09:00", "10:30")] });
  check("heading absent", countOf(none, COPY.skippedTitle), 0);
  check("neither reason label leaks", [countOf(none, SKIPPED_REASON["no-end"]), countOf(none, SKIPPED_REASON["zero-length"])], [0, 0]);

  const some = render({
    free: [slot(GIVON, "2026-09-23", "09:00", "10:30")],
    skipped: [
      { uid: "k1", title: "אירוע א", reason: "no-end" },
      { uid: "k2", title: "אירוע ב", reason: "zero-length" },
    ],
  });
  check("heading once", countOf(some, COPY.skippedTitle), 1);
  check("אין שעת סיום once", countOf(some, "אין שעת סיום"), 1);
  check("אורך אפס once", countOf(some, "אורך אפס"), 1);
  check("both titles once", [countOf(some, "אירוע א"), countOf(some, "אירוע ב")], [1, 1]);
  const unknownReason = render({
    free: [slot(GIVON, "2026-09-23", "09:00", "10:30")],
    skipped: [{ uid: "k3", title: "אירוע ג", reason: "something-new" }],
  });
  check("an unmapped reason falls back to itself rather than crashing", countOf(unknownReason, "something-new"), 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== the selector reflects the step, and offers both ===");
{
  const at30 = render({ step: 30, free: [slot(GIVON, "2026-09-23", "09:00", "10:30")] });
  const at90 = render({ step: 90, free: [slot(GIVON, "2026-09-23", "09:00", "10:30")] });
  check("both labels once at step 30", [countOf(at30, COPY.stepHalf), countOf(at30, COPY.stepFull)], [1, 1]);
  check("both labels once at step 90", [countOf(at90, COPY.stepHalf), countOf(at90, COPY.stepFull)], [1, 1]);
  check("exactly one radio is checked at 30", countOf(at30, 'checked=""'), 1);
  check("exactly one radio is checked at 90", countOf(at90, 'checked=""'), 1);
  check("the two renders differ", at30 === at90, false);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== the loading state says nothing about availability ===");
{
  const html = render({ loading: true, fromIsrael: null, toIsrael: null });
  check("title once", countOf(html, COPY.title), 1);
  check("no error sentence", countOf(html, COPY.error), 0);
  check("no table", countOf(html, "<table"), 0);
  check("no clock times", (html.match(/\d{2}:\d{2}/g) ?? []).length, 0);
  check("no warnings heading", countOf(html, COPY.warningsTitle), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== broken payloads must not take the screen down ===");
// the 2026-09-15 habit: tsc believed the type, the bundle got undefined
{
  const knockouts: [string, Partial<typeof BASE>][] = [
    ["free is undefined", { free: undefined as unknown as FreeSlot[] }],
    ["rooms is undefined", { rooms: undefined as unknown as string[] }],
    ["warnings undefined", { unknownRoomBlocks: undefined as unknown as UnknownBlock[] }],
    ["refusals undefined", { roomsRefused: undefined as unknown as Refused[] }],
    ["skipped undefined", { skipped: undefined as unknown as Skipped[] }],
    ["fetchedAt null", { fetchedAt: null }],
    ["fetchedAt garbage", { fetchedAt: "not-a-date" }],
    ["a slot missing its room", { free: [{ dateIsrael: "2026-09-23", startIsrael: "09:00", endIsrael: "10:30" } as FreeSlot] }],
    ["a malformed date string", { free: [slot(GIVON, "23/09/2026", "09:00", "10:30")] }],
    ["a warning with a null timestamp", { unknownRoomBlocks: [{ uid: "u", title: "x", startIsrael: null, allDay: true, isSeries: false }] }],
    ["from/to null while loaded", { fromIsrael: null, toIsrael: null }],
  ];
  for (const [label, props] of knockouts) {
    try {
      const html = render(props);
      check(`${label} — renders, title once`, countOf(html, COPY.title), 1);
    } catch (e) {
      failed++;
      console.log(`  ❌ ${label} — threw: ${(e as Error).message}`);
    }
  }
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
