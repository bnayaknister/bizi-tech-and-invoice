/**
 * The owner's booking queue, rendered in each state that can mislead. Pure.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_bookings_render.tsx
 * No users, no database, no dev server, no route — F19 is open and nothing here
 * goes near it.
 *
 * ═══ EVERY TEXT ASSERTION COUNTS (rule 56) ═══
 * `includes` passes just as happily when a sentence renders twice — that is
 * what happened in F14, through two green suites, and was caught by eye. So the
 * helper is `countOf` and the assertion is a number.
 *
 * ═══ WHAT THIS FILE IS REALLY GUARDING ═══
 * This screen's buttons WRITE. Three of its rules are absences, and an absence
 * is exactly what a suite that only locates text cannot see:
 *   · no approve button on a request whose moment has passed
 *   · no "בלי אורח" on a request that has one
 *   · no room warning on a guest that does not name a room
 * Each is asserted as a zero.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import BookingsBody, {
  COPY,
  approveQuestion,
  declineQuestion,
  guestWarns,
  calendarFailedText,
  type ApprovedPanel,
  type CalendarWriteState,
} from "../src/app/bookings/BookingsBody";
import { splitQueue, NO_GUEST, type QueueRow, type QueueView } from "../src/lib/booking/queue";
import { israelInstant } from "../src/lib/calendar/availability";
import { approvedWhatsappText, declinedWhatsappText, eventTitle } from "../src/lib/booking/title";

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
/**
 * ⚠️ BUTTONS AND HEADINGS ARE COUNTED AS ELEMENTS, NOT AS TEXT, and that is not
 * fussiness — a plain substring count is WRONG here in two measured ways:
 *
 *   COPY.approve         "אישור"   is inside COPY.empty "אין בקשות שממתינות לאישור"
 *   COPY.waitingHeading  "ממתינות" is inside that same sentence, in "שממתינות"
 *
 * So `countOf(html, COPY.approve) === 0` on the empty screen failed while the
 * screen was perfectly correct. Counting `>אישור</button>` asks the question
 * that was actually meant: how many approve BUTTONS are there.
 */
const countButton = (html: string, label: string) => countOf(html, `>${label}</button>`);
const countAnchor = (html: string, label: string) => countOf(html, `>${label}</a>`);
const countHeading = (html: string, label: string) => countOf(html, `>${label}</h2>`);

const GIVON = "גבעון";
const HASH = "חשמונאים";
const SHOW = "דעה לא פופולרית";
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
    // E9-2: null would mean "automatic", so the DEFAULT fixture is a
    // manual approval and the automatic case is opted into per test.
    decidedBy: "owner-uuid",
    ...over,
  };
}

const viewOf = (r: QueueRow): QueueView => {
  const s = splitQueue([r], NOW);
  return (s.waiting[0] ?? s.history[0])!;
};

type BodyProps = React.ComponentProps<typeof BookingsBody>;

const BASE: BodyProps = {
  waiting: [],
  history: [],
  approveFor: null,
  declineFor: null,
  approved: null,
  declined: null,
  busy: false,
  error: null,
  copiedTitleId: null,
  onAskApprove: () => {},
  onAskDecline: () => {},
  onConfirmApprove: () => {},
  onConfirmDecline: () => {},
  onCancelDialog: () => {},
  onCopyTitle: () => {},
  onRetryCalendar: () => {},
  retryingId: null,
  // E9-3: the cancel flow. Closed and empty in the base props; the tests that
  // care open it explicitly.
  cancelFor: null,
  cancelled: null,
  onAskCancel: () => {},
  onConfirmCancel: () => {},
};

const NO_CALENDAR_WRITE: CalendarWriteState = {
  status: null,
  error: null,
  htmlLink: null,
  dryRun: false,
};

const render = (props: Partial<BodyProps> = {}) =>
  renderToString(<BookingsBody {...BASE} {...props} />);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 1. the empty screen ===");
{
  const html = render();
  check("the page title once", countOf(html, COPY.title), 1);
  check("the waiting heading once", countHeading(html, COPY.waitingHeading), 1);
  check("the empty sentence once", countOf(html, COPY.empty), 1);
  check("no history heading when there is no history", countHeading(html, COPY.historyHeading), 0);
  check("0 approve buttons", countButton(html, COPY.approve), 0);
  check("0 decline buttons", countButton(html, COPY.decline), 0);
  check("0 dialogs", countRe(html, /fixed inset-0/g), 0);
  check("0 wa.me links", countRe(html, /wa\.me/g), 0);
  check("0 google links", countRe(html, /calendar\.google\.com/g), 0);
  check("it is right-to-left", countRe(html, /dir="rtl"/g), 1);
}

console.log("\n=== 2. one waiting request: every fixed string exactly once ===");
{
  const v = viewOf(row({ guest: "דנה לוי", note: "נשמח לחניה" }));
  const html = render({ waiting: [v] });

  check("the show name once", countOf(html, SHOW), 1);
  check("the when line once", countOf(html, "יום א׳ 27.9 · 09:00–10:30 · אולפן גבעון"), 1);
  check("the guest once", countOf(html, "דנה לוי"), 1);
  check("the note once", countOf(html, "נשמח לחניה"), 1);
  check("the sent line once", countOf(html, "נשלחה יום ה׳ 24.9 14:03"), 1);
  check("the status once", countOf(html, "ממתינה"), 1);
  check("approve once", countButton(html, COPY.approve), 1);
  check("decline once", countButton(html, COPY.decline), 1);

  // 🔴 "בלי אורח" must NOT appear when there IS a guest
  check("0 × 'בלי אורח'", countOf(html, NO_GUEST), 0);
  check("0 × the overlap tag", countOf(html, COPY.overlapTag), 0);
  check("0 × the empty sentence", countOf(html, COPY.empty), 0);
  check("no history heading", countHeading(html, COPY.historyHeading), 0);
  // a pending row is not an approved one: no hand-off controls yet
  check("0 × the google button", countAnchor(html, COPY.openInGoogle), 0);
  check("0 × the copy-title button", countButton(html, COPY.copyTitle), 0);
  check("0 wa.me links", countRe(html, /wa\.me/g), 0);

  // ── and the guestless twin
  const none = render({ waiting: [viewOf(row())] });
  check("guestless: 'בלי אורח' exactly once", countOf(none, NO_GUEST), 1);
  check("guestless: no stray note paragraph", countOf(none, "נשמח לחניה"), 0);
}

console.log("\n=== 3. a request whose moment has passed ===");
{
  const past = viewOf(row({ id: "past", start_at: iso("2026-09-22", 9), end_at: iso("2026-09-22", 10, 30) }));
  check("it landed in history, not in waiting", past.status, "past");
  const html = render({ history: [past] });

  check("the status reads 'המועד עבר', once", countOf(html, "המועד עבר"), 1);
  // 🔴 THE CENTRAL ABSENCE: approve is gone, not greyed
  check("0 approve buttons", countButton(html, COPY.approve), 0);
  check("decline is still offered, once", countButton(html, COPY.decline), 1);
  check("exactly one button on the row", countRe(html, /<button/g), 1);
  check("the history heading once", countHeading(html, COPY.historyHeading), 1);
  check("the waiting section still says it is empty", countOf(html, COPY.empty), 1);
}

console.log("\n=== 4. the overlap tag ===");
{
  const a = row({ id: "a", start_at: iso(SUN, 9), end_at: iso(SUN, 10, 30) });
  const b = row({ id: "b", start_at: iso(SUN, 10), end_at: iso(SUN, 11, 30) });
  const { waiting } = splitQueue([a, b], NOW);
  const html = render({ waiting });
  check("both rows carry the tag — twice in all", countOf(html, COPY.overlapTag), 2);
  check("two approve buttons", countButton(html, COPY.approve), 2);

  const alone = render({ waiting: splitQueue([a], NOW).waiting });
  check("a lone request carries no tag", countOf(alone, COPY.overlapTag), 0);

  // a different room does not collide
  const other = row({ id: "o", studio: HASH, start_at: iso(SUN, 9), end_at: iso(SUN, 10, 30) });
  check("two rooms, no tag", countOf(render({ waiting: splitQueue([a, other], NOW).waiting }), COPY.overlapTag), 0);
}

console.log("\n=== 5. the approve dialog, and the room warning ===");
{
  const plain = viewOf(row({ guest: "דנה לוי" }));
  const html = render({ waiting: [plain], approveFor: plain });

  check("the question once", countOf(html, approveQuestion(plain)), 1);
  check("the question is the approved wording", approveQuestion(plain),
    "לאשר הקלטה של דעה לא פופולרית ביום א׳ 27.9, 09:00–10:30, אולפן גבעון?");
  check("one dialog", countRe(html, /fixed inset-0/g), 1);
  check("cancel once", countButton(html, COPY.cancel), 1);
  // 🔴 NO WARNING for a guest that names no room
  check("0 × the room warning", countOf(html, COPY.guestRoomWarning), 0);

  // ── a guest whose name contains a room
  const risky = viewOf(row({ guest: "רות גבעון גדול", studio: HASH }));
  check("guestWarns says so", guestWarns(risky.guest), true);
  const warned = render({ waiting: [risky], approveFor: risky });
  check("the warning renders exactly once", countOf(warned, COPY.guestRoomWarning), 1);
  check("and the wording is the approved one", COPY.guestRoomWarning,
    "שם האורח מכיל שם של אולפן. אחרי הסנכרון, בדקו שהאורח בהפקה נכון.");

  check("guestWarns is false for no guest", guestWarns(null), false);
  check("and the dialog then shows no warning", countOf(render({ waiting: [viewOf(row())], approveFor: viewOf(row()) }), COPY.guestRoomWarning), 0);

  // the warning belongs to the DIALOG, not to the row
  check("no dialog -> no warning even for a risky guest", countOf(render({ waiting: [risky] }), COPY.guestRoomWarning), 0);
}

console.log("\n=== 6. the decline dialog ===");
{
  const v = viewOf(row());
  const html = render({ waiting: [v], declineFor: v });
  check("the question once", countOf(html, declineQuestion(v)), 1);
  check("the question is the approved wording", declineQuestion(v),
    "לדחות את הבקשה של דעה לא פופולרית ליום א׳ 27.9 09:00?");
  check("one dialog", countRe(html, /fixed inset-0/g), 1);
  check("no approve question alongside it", countOf(html, approveQuestion(v)), 0);
  check("0 × the room warning — a decline never needs it", countOf(html, COPY.guestRoomWarning), 0);
}

console.log("\n=== 7. just approved: the calendar hand-off ===");
{
  const v = viewOf(row({ guest: "דנה לוי" }));
  const title = eventTitle({ alias: SHOW, guest: "דנה לוי", studio: GIVON });
  const panel: ApprovedPanel = { view: v, title, googleUrl: v.googleUrl, calendar: NO_CALENDAR_WRITE };
  const html = render({ approved: panel });

  check("the lead sentence once", countOf(html, COPY.approvedLead), 1);
  check("the title is SHOWN, not only copied — once", countOf(html, title), 1);
  check("the title is the approved format", title, "דעה לא פופולרית, אורח: דנה לוי, גבעון");
  check("the google button once", countAnchor(html, COPY.openInGoogle), 1);
  check("exactly one google link", countRe(html, /calendar\.google\.com/g), 1);
  check("the copy-title button once", countButton(html, COPY.copyTitle), 1);
  check("the whatsapp button once", countAnchor(html, COPY.approvedWhatsapp), 1);
  check("exactly one wa.me link", countRe(html, /wa\.me/g), 1);
  check("and it carries NO number", countRe(html, /wa\.me\/\d/g), 0);
  check("the message text is encoded into it once", countOf(html, encodeURIComponent(approvedWhatsappText({ showName: SHOW, dateIsrael: SUN, startIsrael: "09:00", studio: GIVON }))), 1);
  check("links open in a new tab", countRe(html, /rel="noopener noreferrer"/g), 2);
  check("0 × 'הכותרת הועתקה' before anything is copied", countOf(html, COPY.titleCopied), 0);

  const copied = render({ approved: panel, copiedTitleId: v.id });
  check("after copying: the confirmation once", countOf(copied, COPY.titleCopied), 1);
}

console.log("\n=== 7b. the calendar write's own state — four mutually exclusive renders (feat/calendar-write, 7.10) ===");
{
  const v = viewOf(row({ guest: "דנה לוי" }));
  const title = eventTitle({ alias: SHOW, guest: "דנה לוי", studio: GIVON });
  const panelWith = (calendar: CalendarWriteState): ApprovedPanel => ({ view: v, title, googleUrl: v.googleUrl, calendar });

  // ── dry-run: zero calls were ever made, so nothing else renders ──────────
  const dry = render({ approved: panelWith({ status: null, error: null, htmlLink: null, dryRun: true }) });
  check("dry-run notice once", countOf(dry, COPY.calendarDryRunNotice), 1);
  check("dry-run: 0 × created text", countOf(dry, COPY.calendarCreated), 0);
  check("dry-run: 0 × retry button", countButton(dry, COPY.retryCalendar), 0);
  check("dry-run: the template google button is STILL there (owner, step 5 — fallback)", countAnchor(dry, COPY.openInGoogle), 1);

  // ── created: the event link, and NO production link ───────────────────
  const created = render({
    approved: panelWith({
      status: "created",
      error: null,
      htmlLink: "https://calendar.google.com/event?eid=abc",
      dryRun: false,
    }),
  });
  check("created notice once", countOf(created, COPY.calendarCreated), 1);
  check("the event link once", countAnchor(created, COPY.eventLink), 1);
  // 🔴 the central absence of the 7.10 correction: an approval creates no
  // production, so the screen must never offer a link to one
  check("0 × any /productions/ link", countOf(created, "/productions/"), 0);
  check("created: 0 × dry-run notice", countOf(created, COPY.calendarDryRunNotice), 0);
  check("created: 0 × retry button", countButton(created, COPY.retryCalendar), 0);

  // ── created, but with no htmlLink: every reloaded history row ─────────
  const createdNoLinks = render({
    approved: panelWith({ status: "created", error: null, htmlLink: null, dryRun: false }),
  });
  check("created with no link: 0 × event link", countAnchor(createdNoLinks, COPY.eventLink), 0);
  check("created with no link: still 0 × production link", countOf(createdNoLinks, "/productions/"), 0);
  check("created with no link: the sentence still renders once", countOf(createdNoLinks, COPY.calendarCreated), 1);

  // ── failed, with the server's own error dropped into the approved template ──
  const failed = render({
    approved: panelWith({ status: "failed", error: "פג הזמן הקצוב", htmlLink: null, dryRun: false }),
  });
  const failedText = calendarFailedText("פג הזמן הקצוב");
  check("the failure sentence once, with the error inside it", countOf(failed, failedText), 1);
  check("the failure wording is the approved template", calendarFailedText("X"), "האישור נשמר, אך היצירה ביומן נכשלה — X. אפשר לנסות שוב.");
  check("the retry button once", countButton(failed, COPY.retryCalendar), 1);
  check("failed: 0 × created text", countOf(failed, COPY.calendarCreated), 0);
  check("failed: 0 × dry-run notice", countOf(failed, COPY.calendarDryRunNotice), 0);
  check("the retry button is enabled when nothing is in flight", countRe(failed, /disabled=""/g), 0);

  const retrying = render({
    approved: panelWith({ status: "failed", error: "שגיאה", htmlLink: null, dryRun: false }),
    retryingId: v.id,
  });
  check("the retry button disables while ITS retry is in flight", countRe(retrying, /disabled=""/g), 1);

  // ── a row from before this feature, or whose write never ran: nothing new ──
  const nothingYet = render({ approved: panelWith(NO_CALENDAR_WRITE) });
  check("nothing-yet: 0 × created", countOf(nothingYet, COPY.calendarCreated), 0);
  check("nothing-yet: 0 × dry-run notice", countOf(nothingYet, COPY.calendarDryRunNotice), 0);
  check("nothing-yet: 0 × retry button", countButton(nothingYet, COPY.retryCalendar), 0);
  check("nothing-yet: the template google button is the only hand-off", countAnchor(nothingYet, COPY.openInGoogle), 1);

  // ── retryingId for a DIFFERENT row must not disable this one's button ──────
  const otherRetrying = render({
    approved: panelWith({ status: "failed", error: "שגיאה", htmlLink: null, dryRun: false }),
    retryingId: "some-other-row",
  });
  check("a retry in flight on another row leaves this button enabled", countRe(otherRetrying, /disabled=""/g), 0);
}

console.log("\n=== 8. the hand-off is on EVERY approved history row, not only the fresh one ===");
{
  const approvedRow = row({ id: "ap", status: "approved", guest: "דנה לוי", start_at: iso(SUN, 15), end_at: iso(SUN, 16, 30) });
  const declinedRow = row({ id: "dc", status: "declined", start_at: iso(MON, 15), end_at: iso(MON, 16, 30) });
  const { history } = splitQueue([approvedRow, declinedRow], NOW);
  const html = render({ history });

  check("two history rows", countRe(html, /נשלחה יום/g), 2);
  check("the google button once — on the approved row only", countAnchor(html, COPY.openInGoogle), 1);
  check("the copy button once", countButton(html, COPY.copyTitle), 1);
  check("the whatsapp button once", countAnchor(html, COPY.approvedWhatsapp), 1);
  check("אושרה once", countOf(html, "אושרה"), 1);
  check("נדחתה once", countOf(html, "נדחתה"), 1);
  check("no approve/decline buttons on decided rows", countButton(html, COPY.approve), 0);
  check("…and none for decline either", countButton(html, COPY.decline), 0);
  // 🔴 E9-3: an APPROVED, FUTURE row now carries a cancel button — so the
  // total is two (copy-title + cancel), not one. Asserted by NAME rather than
  // by counting `<button`, because a bare count cannot say which button
  // appeared and this one was previously asserted as "there is only the copy
  // button", which is exactly the kind of assertion that hides a new control.
  check("the cancel button once — on the approved future row only", countButton(html, COPY.cancelBooking), 1);
  check("two buttons in total: copy-title and cancel", countRe(html, /<button/g), 2);
  // and the auto/manual badge: the fixture's decidedBy is an owner uuid
  check("the approved row says it was approved manually", countOf(html, "אושר ידנית"), 1);
  check("and does not claim it was automatic", countOf(html, "אושר אוטומטית"), 0);

  // the automatic case, by flipping the one column that decides it
  const autoHtml = render({
    history: splitQueue([row({ id: "au", status: "approved", decidedBy: null, start_at: iso(SUN, 15), end_at: iso(SUN, 16, 30) })], NOW).history,
  });
  check("a null decidedBy renders as automatic", countOf(autoHtml, "אושר אוטומטית"), 1);
  check("…and not as manual", countOf(autoHtml, "אושר ידנית"), 0);

  // 🔴 and a PAST approved row offers no cancel — freeing a slot nobody can
  // use, and pointing at an event that documents something real
  const pastHtml = render({
    history: splitQueue([row({ id: "pa", status: "approved", start_at: iso("2026-09-20", 15), end_at: iso("2026-09-20", 16, 30) })], NOW).history,
  });
  check("no cancel button on a past approved row", countButton(pastHtml, COPY.cancelBooking), 0);
  check("and no approve button anywhere", countButton(html, COPY.approve), 0);

  const onlyDeclined = render({ history: splitQueue([declinedRow], NOW).history });
  check("a declined row alone: 0 google links", countRe(onlyDeclined, /calendar\.google\.com/g), 0);
  check("and 0 wa.me links", countRe(onlyDeclined, /wa\.me/g), 0);
}

console.log("\n=== 8b. a reloaded history row carries its OWN calendar state (calendarStateFromView) ===");
{
  // htmlLink/dryRun are never persisted (0099 has no columns for either) — a
  // row reloaded from the database can only ever show status and error.
  const createdRow = row({
    id: "cr",
    status: "approved",
    start_at: iso(SUN, 15),
    end_at: iso(SUN, 16, 30),
    calendarWriteStatus: "created",
  });
  const createdHtml = render({ history: splitQueue([createdRow], NOW).history });
  check("history row: created notice once", countOf(createdHtml, COPY.calendarCreated), 1);
  check("history row: 0 × event link — htmlLink is never persisted", countAnchor(createdHtml, COPY.eventLink), 0);
  // 🔴 an approval creates no production, so there is no production to link to
  check("history row: 0 × any /productions/ link", countOf(createdHtml, "/productions/"), 0);

  const failedRow = row({
    id: "fl",
    status: "approved",
    start_at: iso(SUN, 15),
    end_at: iso(SUN, 16, 30),
    calendarWriteStatus: "failed",
    calendarWriteError: "שגיאת רשת",
  });
  const failedHtml = render({ history: splitQueue([failedRow], NOW).history });
  check("history row: the failure sentence once", countOf(failedHtml, calendarFailedText("שגיאת רשת")), 1);
  check("history row: the retry button once", countButton(failedHtml, COPY.retryCalendar), 1);
}

console.log("\n=== 9. just declined ===");
{
  const v = viewOf(row());
  const html = render({ declined: v });
  check("the confirmation once", countOf(html, COPY.declined), 1);
  check("the wording is approved", COPY.declined, "הבקשה נדחתה.");
  check("the whatsapp button once", countAnchor(html, COPY.declinedWhatsapp), 1);
  check("exactly one wa.me link", countRe(html, /wa\.me/g), 1);
  check("carrying no number", countRe(html, /wa\.me\/\d/g), 0);
  check("the decline text is encoded into it once", countOf(html, encodeURIComponent(declinedWhatsappText({ showName: SHOW, dateIsrael: SUN, startIsrael: "09:00" }))), 1);
  check("0 × the approved lead", countOf(html, COPY.approvedLead), 0);
  check("0 google links", countRe(html, /calendar\.google\.com/g), 0);
}

console.log("\n=== 10. an error, and a busy screen ===");
{
  const v = viewOf(row());
  const err = render({ waiting: [v], error: "המשבצת כבר תפוסה ביומן. אפשר לדחות את הבקשה." });
  check("the server's sentence renders once", countOf(err, "המשבצת כבר תפוסה ביומן. אפשר לדחות את הבקשה."), 1);
  check("and the row is still there to act on", countButton(err, COPY.approve), 1);

  const busy = render({ waiting: [v], busy: true });
  check("both buttons are disabled while a write is in flight", countRe(busy, /disabled=""/g), 2);
}

console.log("\n=== 11. malformed props must not take the page down ===");
{
  const v = viewOf(row());
  const knockouts: [string, Partial<BodyProps>][] = [
    ["waiting undefined", { waiting: undefined as unknown as QueueView[] }],
    ["history undefined", { history: undefined as unknown as QueueView[] }],
    ["approveFor with an empty waiting list", { approveFor: v }],
    ["declineFor with an empty waiting list", { declineFor: v }],
    ["both dialogs at once", { approveFor: v, declineFor: v }],
    ["approved panel with an empty title", { approved: { view: v, title: "", googleUrl: v.googleUrl, calendar: NO_CALENDAR_WRITE } }],
    ["copiedTitleId for a row that is not shown", { copiedTitleId: "nope" }],
  ];
  for (const [label, props] of knockouts) {
    try {
      const html = render(props);
      // the one thing that must hold in every case
      check(`${label} — renders, the page title once`, countOf(html, COPY.title), 1);
    } catch (e) {
      failed++;
      console.log(`  ❌ ${label} — threw: ${(e as Error).message}`);
    }
  }
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
