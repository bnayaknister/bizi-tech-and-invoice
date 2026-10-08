/**
 * Pure WhatsApp-send / contacts / cancel suite — E9-3.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_wa_send.ts
 *
 * SYNTHETIC FIXTURES ONLY. No user is created, no row is written, no route is
 * called, and NOTHING reaches Meta — F19 is open, so every decision under test
 * was written as a pure function and the impure halves (`sendWhatsapp`,
 * `recordBookingNotification`, `replyToInbound`) are thin wrappers around
 * them. `sendWhatsapp` itself is never called here: its only untested line is
 * the `fetch`, and calling it would violate the no-live-API rule.
 *
 * Every assertion COUNTS (rule 56).
 *
 * 🔴 THE SECRETS BELOW ARE FIXTURES. The real token lives only in
 * WHATSAPP_TOKEN on Vercel and is never read by this file.
 */
import {
  LIST_LIMITS,
  describeGraphError,
  isWhatsappDryRun,
  listPayload,
  readConfig,
  templatePayload,
  textPayload,
  truncate,
} from "../src/lib/whatsapp/client";
import { PHONE_ERROR, displayWaId, isWaId, toWaId } from "../src/lib/whatsapp/phone";
import {
  EXCERPT_MAX_CHARS,
  TEMPLATE_BOOKING_APPROVED,
  TEMPLATE_BOOKING_APPROVED_VARS,
  TEMPLATE_BOOKING_PENDING,
  TEMPLATE_BOOKING_PENDING_VARS,
  TEMPLATE_LANGUAGE,
  TEMPLATE_UNKNOWN_CONTACT,
  TEMPLATE_UNKNOWN_CONTACT_VARS,
  excerptParam,
  shouldApplyStatus,
  unknownContactBody,
} from "../src/lib/whatsapp/notify";
import {
  LIST_COPY,
  NEUTRAL_REPLY,
  linkReplyBody,
  listRowsFor,
  parseShowRowId,
  planReply,
  replyWamid,
  showRowId,
} from "../src/lib/whatsapp/reply";
import { parseStatusUpdates } from "../src/lib/whatsapp/webhook";
import { calendarDayUrl, splitQueue, type QueueRow } from "../src/lib/booking/queue";
import { israelInstant } from "../src/lib/calendar/availability";
import type { ContactShow } from "../src/lib/booking/contacts";

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

const SHOW_A = "11111111-1111-4111-8111-111111111111";
const SHOW_B = "22222222-2222-4222-8222-222222222222";
const contact = (showId: string, showName: string): ContactShow => ({
  showId,
  showName,
  contactName: "דנה לוי",
});

console.log("\n=== 1. Israeli phone input -> wa_id ===");
{
  // the shapes a human actually types
  check("a plain mobile", toWaId("0501234567"), { ok: true, waId: "972501234567" });
  check("with ASCII dashes", toWaId("050-123-4567"), { ok: true, waId: "972501234567" });
  check("with spaces", toWaId("050 123 4567"), { ok: true, waId: "972501234567" });
  check("with a dash after the prefix only", toWaId("050-1234567"), { ok: true, waId: "972501234567" });
  check("a landline (9 digits)", toWaId("03-1234567"), { ok: true, waId: "97231234567" });
  check("already international with +", toWaId("+972501234567"), { ok: true, waId: "972501234567" });
  check("already international with 00", toWaId("00972501234567"), { ok: true, waId: "972501234567" });
  check("already a wa_id", toWaId("972501234567"), { ok: true, waId: "972501234567" });
  check("a foreign number is kept as given", toWaId("447911123456"), { ok: true, waId: "447911123456" });
  check("surrounding whitespace", toWaId("  0501234567  "), { ok: true, waId: "972501234567" });
  check("parentheses and a slash", toWaId("(050) 123/4567"), { ok: true, waId: "972501234567" });

  // 🔴 THE UNICODE DASH. A number pasted out of a Mac contact card or a Word
  // document carries U+2013, and a regex that only knows U+002D refuses a
  // number the owner can see is fine.
  check("an en dash (U+2013) is accepted", toWaId("050–123–4567"), { ok: true, waId: "972501234567" });
  check("a non-breaking space is accepted", toWaId("050 1234567"), { ok: true, waId: "972501234567" });

  // refusals, each with its own reason so the card can say what is wrong
  check("empty", toWaId(""), { ok: false, reason: "empty" });
  check("whitespace only", toWaId("   "), { ok: false, reason: "empty" });
  check("a non-string", toWaId(972501234567), { ok: false, reason: "empty" });
  check("null", toWaId(null), { ok: false, reason: "empty" });
  check("letters", toWaId("050abc4567"), { ok: false, reason: "not-digits" });
  check("a Hebrew word is 'not-digits' — the more precise of the two", toWaId("טלפון"), { ok: false, reason: "not-digits" });
  // `not-a-number` is reached only when there is nothing left after the
  // separators are stripped — i.e. the input was ALL punctuation.
  check("separators only", toWaId("---"), { ok: false, reason: "not-a-number" });
  check("brackets only", toWaId("()"), { ok: false, reason: "not-a-number" });
  check("too short, national", toWaId("05012"), { ok: false, reason: "too-short" });
  check("too short, international", toWaId("123456"), { ok: false, reason: "too-short" });
  check("too long, national", toWaId("05012345678901"), { ok: false, reason: "too-long" });
  check("too long, international (16 digits)", toWaId("1234567890123456"), { ok: false, reason: "too-long" });
  check("every refusal has a sentence", Object.keys(PHONE_ERROR).length, 5);
  check("and none of them is empty", Object.values(PHONE_ERROR).every((v) => v.length > 0), true);

  // 🔴 THE ROUND TRIP. What is stored is what gets displayed back, and what is
  // displayed back must re-convert to the same stored value — otherwise the
  // owner edits a number by retyping what they see and gets a different one.
  for (const input of ["0501234567", "050-123-4567", "+972501234567", "03-1234567"]) {
    const first = toWaId(input);
    const shown = first.ok ? displayWaId(first.waId) : "";
    const again = toWaId(shown);
    check(`round trip: ${input}`, again.ok && first.ok && again.waId === first.waId, true);
  }
  check("a mobile displays in local form", displayWaId("972501234567"), "050-1234567");
  check("a landline displays in local form", displayWaId("97231234567"), "03-1234567");
  check("a foreign number displays with a +", displayWaId("447911123456"), "+447911123456");
  check("garbage displays as empty rather than as a wrong number", displayWaId("abc"), "");

  check("isWaId accepts the canonical form", isWaId("972501234567"), true);
  check("isWaId refuses a + ", isWaId("+972501234567"), false);
  check("isWaId refuses a local form", isWaId("050-1234567"), false);
  check("isWaId refuses a non-string", isWaId(123), false);
}

console.log("\n=== 2. number -> podcasts (zero / one / several) ===");
{
  check("no permissions at all -> neutral", planReply([], null), { kind: "neutral" });

  const one = [contact(SHOW_A, "דעה לא פופולרית")];
  check("one podcast -> the link", planReply(one, null), { kind: "link", show: one[0] });

  const two = [contact(SHOW_A, "דעה לא פופולרית"), contact(SHOW_B, "פודקאסט שני")];
  check("two podcasts -> the list", planReply(two, null).kind, "list");
  check("…carrying both", (planReply(two, null) as { shows: ContactShow[] }).shows.length, 2);

  // the pick
  check("a tapped row resolves to that show", planReply(two, SHOW_B), { kind: "link", show: two[1] });
  check("a pick is honoured even with one podcast", planReply(one, SHOW_A), { kind: "link", show: one[0] });

  // 🔴 THE SECURITY PROPERTY. `pickedShowId` is a string Meta echoed back, so
  // it is attacker-controllable in principle. A pick that is not one of THIS
  // number's own shows must not be honoured.
  check(
    "🔴 a pick for a show this number does NOT own falls back to the list",
    planReply(two, "99999999-9999-4999-8999-999999999999").kind,
    "list"
  );
  check(
    "…and with a single podcast it falls back to that one, never to the forged id",
    planReply(one, SHOW_B),
    { kind: "link", show: one[0] }
  );

  // the row id, round trip and refusals
  check("the row id is prefixed", showRowId(SHOW_A), `show:${SHOW_A}`);
  check("and parses back", parseShowRowId(showRowId(SHOW_A)), SHOW_A);
  check("a bare uuid is refused — the prefix is required", parseShowRowId(SHOW_A), null);
  check("a wrong prefix is refused", parseShowRowId(`podcast:${SHOW_A}`), null);
  check("a non-uuid after the prefix is refused", parseShowRowId("show:../../etc/passwd"), null);
  check("sql-ish junk is refused", parseShowRowId("show:1 OR 1=1"), null);
  check("empty after the prefix is refused", parseShowRowId("show:"), null);
  check("a non-string is refused", parseShowRowId(42), null);
  check("null is refused", parseShowRowId(null), null);

  // the list rows, and Meta's limits
  const long = "פודקאסט עם שם ארוך במיוחד שלא נכנס בעשרים וארבעה תווים";
  const rows = listRowsFor([contact(SHOW_A, long), contact(SHOW_B, "קצר")]);
  const payload = listPayload({
    to: "972501234567",
    body: LIST_COPY.body,
    button: LIST_COPY.button,
    sectionTitle: LIST_COPY.section,
    rows,
  });
  const sections = (payload.interactive as { action: { sections: { rows: { id: string; title: string; description?: string }[] }[] } }).action.sections;
  check("two rows", sections[0].rows.length, 2);
  check("🔴 a long title is cut to Meta's 24, which would otherwise REJECT the send", Array.from(sections[0].rows[0].title).length, LIST_LIMITS.rowTitle);
  check("…and the full name survives in the description", sections[0].rows[0].description, long);
  check("the row id travels", sections[0].rows[0].id, `show:${SHOW_A}`);
  check("the button is within its own limit", Array.from((payload.interactive as { action: { button: string } }).action.button).length <= LIST_LIMITS.button, true);
  check("a short title is untouched", sections[0].rows[1].title, "קצר");

  // 🔴 truncation is by CODE POINT. An emoji in a show name is a surrogate
  // pair, and slicing it in half yields a lone surrogate — which Meta rejects
  // as malformed UTF-8 for a message that looked fine in the editor.
  check("truncate counts code points, not UTF-16 units", truncate("🎙️🎙️🎙️🎙️🎙️", 2), "🎙️🎙️".slice(0, truncate("🎙️🎙️🎙️🎙️🎙️", 2).length));
  check("…and never produces a lone surrogate", /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(truncate("🎙🎙🎙", 2)), false);
  check("truncate leaves a short string alone", truncate("abc", 10), "abc");
  check("eleven shows are cut to Meta's ten rows", (listPayload({ to: "972501234567", body: "x", button: "y", sectionTitle: "z", rows: Array.from({ length: 11 }, (_, i) => ({ id: `show:${i}`, title: `t${i}` })) }).interactive as { action: { sections: { rows: unknown[] }[] } }).action.sections[0].rows.length, LIST_LIMITS.rows);
}

console.log("\n=== 3. the payloads Graph receives ===");
{
  const t = templatePayload({
    to: "972501234567",
    name: TEMPLATE_BOOKING_APPROVED,
    language: TEMPLATE_LANGUAGE,
    params: ["דעה לא פופולרית", "יום א׳ 27.9, 09:00–10:30", "גבעון", "שעה וחצי", "דנה לוי"],
  });
  check("messaging_product", t.messaging_product, "whatsapp");
  check("the recipient", t.to, "972501234567");
  check("type", t.type, "template");
  const tpl = t.template as { name: string; language: { code: string }; components: { type: string; parameters: { type: string; text: string }[] }[] };
  check("the template name", tpl.name, TEMPLATE_BOOKING_APPROVED);
  check("the language is Hebrew", tpl.language.code, "he");
  check("one body component", tpl.components.length, 1);
  // 🔴 POSITIONAL. The order of this array IS the {{1}}..{{5}} order of the
  // approved template, so it is asserted element by element.
  check("five positional parameters, in order", tpl.components[0].parameters.map((p) => p.text), [
    "דעה לא פופולרית",
    "יום א׳ 27.9, 09:00–10:30",
    "גבעון",
    "שעה וחצי",
    "דנה לוי",
  ]);
  check("every parameter is typed text", tpl.components[0].parameters.every((p) => p.type === "text"), true);
  check("no parameters -> no components at all", (templatePayload({ to: "972501234567", name: "x", language: "he", params: [] }).template as { components: unknown[] }).components.length, 0);

  // the three templates' variable lists are the contract with Meta
  check("approved takes 5 variables", TEMPLATE_BOOKING_APPROVED_VARS.length, 5);
  check("pending takes 5 variables", TEMPLATE_BOOKING_PENDING_VARS.length, 5);
  check("unknown-contact takes 2", TEMPLATE_UNKNOWN_CONTACT_VARS.length, 2);
  check("the three names are distinct", new Set([TEMPLATE_BOOKING_APPROVED, TEMPLATE_BOOKING_PENDING, TEMPLATE_UNKNOWN_CONTACT]).size, 3);
  check("and all three are snake_case with the bizi_ prefix", [TEMPLATE_BOOKING_APPROVED, TEMPLATE_BOOKING_PENDING, TEMPLATE_UNKNOWN_CONTACT].every((n) => /^bizi_[a-z_]+$/.test(n)), true);

  const txt = textPayload({ to: "972501234567", body: "היי" });
  check("a text payload's type", txt.type, "text");
  // 🔴 preview_url FALSE: the body carries the booking link, and a preview
  // would make Meta fetch /b/<token> — putting the credential in a third
  // party's fetch log, for a page that is noindex/no-referrer precisely to
  // avoid that.
  check("🔴 link previews are off", (txt.text as { preview_url: boolean }).preview_url, false);
  check("the body travels verbatim", (txt.text as { body: string }).body, "היי");

  const reply = linkReplyBody("דעה לא פופולרית", "https://x.test/b/tok");
  check("the link reply names the show", reply.includes("דעה לא פופולרית"), true);
  check("…and carries the url", reply.includes("https://x.test/b/tok"), true);
  check("the neutral reply is the approved sentence", NEUTRAL_REPLY, "היי! קיבלנו את ההודעה, נחזור אליך בהקדם 🙂");
}

console.log("\n=== 4. config and Graph errors ===");
{
  const token = process.env.WHATSAPP_TOKEN;
  const pnid = process.env.WHATSAPP_PHONE_NUMBER_ID;
  try {
    delete process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    // 🔴 NAMED, not boolean — the CRON_SECRET week is why. A caller that can
    // log WHICH variable is missing turns seven silent days into one line.
    check("both missing, both named", readConfig(), { ok: false, missing: ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"] });
    process.env.WHATSAPP_TOKEN = "t";
    check("one missing, one named", readConfig(), { ok: false, missing: ["WHATSAPP_PHONE_NUMBER_ID"] });
    process.env.WHATSAPP_PHONE_NUMBER_ID = "p";
    check("both present", readConfig(), { ok: true, config: { token: "t", phoneNumberId: "p" } });
    process.env.WHATSAPP_TOKEN = "   ";
    check("whitespace counts as missing", readConfig().ok, false);
  } finally {
    if (token === undefined) delete process.env.WHATSAPP_TOKEN;
    else process.env.WHATSAPP_TOKEN = token;
    if (pnid === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = pnid;
  }

  check(
    "Meta's message and code are both kept",
    describeGraphError(400, { error: { message: "Template name does not exist", code: 132001 } }),
    "Template name does not exist (code 132001)"
  );
  check(
    "a subcode is kept too",
    describeGraphError(400, { error: { message: "x", code: 131047, error_subcode: 2 } }),
    "x (code 131047/2)"
  );
  check("no error object -> the status", describeGraphError(500, null), "Graph החזירה HTTP 500");
  check("an unexpected shape -> the status", describeGraphError(503, { foo: 1 }), "Graph החזירה HTTP 503");

  const dry = process.env.WHATSAPP_DRY_RUN;
  try {
    delete process.env.WHATSAPP_DRY_RUN;
    check("🔴 the dry run still defaults ON after E9-3 made sending real", isWhatsappDryRun(), true);
    process.env.WHATSAPP_DRY_RUN = "false";
    check("only the exact string 'false' sends", isWhatsappDryRun(), false);
    process.env.WHATSAPP_DRY_RUN = "fasle";
    check("a typo stays a dry run", isWhatsappDryRun(), true);
  } finally {
    if (dry === undefined) delete process.env.WHATSAPP_DRY_RUN;
    else process.env.WHATSAPP_DRY_RUN = dry;
  }
}

console.log("\n=== 5. delivery statuses, matched by provider wamid ===");
{
  const delivery = (statuses: unknown[]) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", statuses } }] }],
  });

  const one = parseStatusUpdates(
    delivery([{ id: "wamid.META.1", status: "delivered", timestamp: "1760000000", recipient_id: "972501234567" }])
  );
  check("one update", one.length, 1);
  check("🔴 the id is META's, which is what provider_wamid holds", one[0].providerWamid, "wamid.META.1");
  check("the status", one[0].status, "delivered");
  check("the recipient is normalized", one[0].waId, "972501234567");
  check("the timestamp becomes an ISO instant", one[0].at, new Date(1760000000 * 1000).toISOString());
  check("no error on a success", one[0].errorText, null);

  const failed = parseStatusUpdates(
    delivery([
      {
        id: "wamid.META.2",
        status: "failed",
        timestamp: "1760000000",
        recipient_id: "972501234567",
        errors: [{ title: "Re-engagement message", message: "More than 24 hours", error_data: { details: "outside window" } }],
      },
    ])
  );
  check("the failure's three error parts are joined", failed[0].errorText, "Re-engagement message — More than 24 hours — outside window");
  check("a partial error object still yields text", parseStatusUpdates(delivery([{ id: "w", status: "failed", errors: [{ title: "only a title" }] }]))[0].errorText, "only a title");

  check("an update with no id is dropped", parseStatusUpdates(delivery([{ status: "read" }])).length, 0);
  check("an update with no status is dropped", parseStatusUpdates(delivery([{ id: "w" }])).length, 0);
  check("a bad timestamp falls back to now rather than dropping the update", parseStatusUpdates(delivery([{ id: "w", status: "read", timestamp: "nope" }])).length, 1);
  check("messages-only delivery yields no statuses", parseStatusUpdates({ entry: [{ changes: [{ field: "messages", value: { messages: [{ id: "x", type: "text" }] } }] }] }).length, 0);
  check("a non-messages field is skipped", parseStatusUpdates({ entry: [{ changes: [{ field: "template_status", value: { statuses: [{ id: "a", status: "read" }] } }] }] }).length, 0);
  check("garbage", parseStatusUpdates(null).length, 0);

  // 🔴 THE ORDERING GUARD. Meta's three statuses arrive with no ordering
  // promise and are retried independently, so a `read` can land before the
  // `delivered` that preceded it.
  check("sent advances from queued", shouldApplyStatus("queued", "sent"), true);
  check("delivered advances from sent", shouldApplyStatus("sent", "delivered"), true);
  check("read advances from delivered", shouldApplyStatus("delivered", "read"), true);
  check("🔴 a late delivered does NOT regress a read", shouldApplyStatus("read", "delivered"), false);
  check("🔴 a late sent does NOT regress a delivered", shouldApplyStatus("delivered", "sent"), false);
  check("the same status twice is not re-applied", shouldApplyStatus("read", "read"), false);
  check("🔴 failed always wins, even after read", shouldApplyStatus("read", "failed"), true);
  check("failed wins after sent", shouldApplyStatus("sent", "failed"), true);
  check("anything advances from null", shouldApplyStatus(null, "sent"), true);
  check("…and from dry_run, which is not on the ladder", shouldApplyStatus("dry_run", "sent"), true);
  check("an unknown incoming status is never applied", shouldApplyStatus("sent", "teleported"), false);
}

console.log("\n=== 6. the unknown-contact notice ===");
{
  check("the excerpt is capped", Array.from(excerptParam("א".repeat(500))).length, EXCERPT_MAX_CHARS);
  check("the cap is 120", EXCERPT_MAX_CHARS, 120);
  // 🔴 NEWLINES ARE A META CONSTRAINT: a template parameter may not contain
  // one, and Graph rejects the whole send rather than that field.
  check("🔴 newlines are collapsed", excerptParam("שורה\nשנייה\n\nשלישית"), "שורה שנייה שלישית");
  check("tabs too", excerptParam("א\tב"), "א ב");
  check("an empty body still yields a parameter", excerptParam(""), "(הודעה בלי טקסט)");
  check("whitespace only", excerptParam("   \n  "), "(הודעה בלי טקסט)");
  check("null", excerptParam(null), "(הודעה בלי טקסט)");
  check("a normal message passes through trimmed", excerptParam("  היי  "), "היי");

  const body = unknownContactBody("972501234567", "רוצה לקבוע הקלטה");
  check("the notice carries the number", body.includes("972501234567"), true);
  check("…and the excerpt", body.includes("רוצה לקבוע הקלטה"), true);
  check("…and points at the new card", body.includes("הרשאות הזמנת חדרים"), true);

  // the reply de-dup key is derived from the INBOUND message
  check("the reply wamid is derived from the inbound id", replyWamid("wamid.ABC"), "local:reply:wamid.ABC");
  check("two different inbound messages get two keys", replyWamid("a") === replyWamid("b"), false);
  check("…and the same inbound message always the same key", replyWamid("a"), replyWamid("a"));
  check("it is 'local:' prefixed so it cannot collide with a Meta id", replyWamid("a").startsWith("local:"), true);
}

console.log("\n=== 7. cancelling releases the slot (the view half) ===");
{
  const SUN = "2026-09-27";
  const NOW = new Date("2026-09-24T12:00:00Z");
  const iso = (d: string, h: number, m = 0) => israelInstant(d, h, m).toISOString();
  const base = (over: Partial<QueueRow>): QueueRow => ({
    id: "r1",
    show_id: "s1",
    showName: "דעה לא פופולרית",
    studio: "גבעון",
    start_at: iso(SUN, 9),
    end_at: iso(SUN, 10, 30),
    guest: null,
    note: null,
    status: "approved",
    created_at: iso("2026-09-23", 12),
    alias: "דעה לא פופולרית",
    calendarWriteStatus: "created",
    calendarWriteError: null,
    decidedBy: "owner-uuid",
    ...over,
  });

  const approved = splitQueue([base({})], NOW).history[0];
  check("an approved future row can be cancelled", approved.canCancel, true);
  check("…and is not awaiting a decision", approved.canApprove, false);
  check("…and says a human approved it", approved.autoApproved, false);

  const auto = splitQueue([base({ decidedBy: null })], NOW).history[0];
  check("🔴 a null decidedBy IS the record of an automatic approval", auto.autoApproved, true);

  const past = splitQueue([base({ start_at: iso("2026-09-20", 9), end_at: iso("2026-09-20", 10, 30) })], NOW).history[0];
  check("a past approved row cannot be cancelled", past.canCancel, false);

  // 🔴 the cancelled row: a released slot, and nothing left to decide
  const cancelled = splitQueue([base({ status: "cancelled" })], NOW).history[0];
  check("a cancelled row reads as cancelled", cancelled.status, "cancelled");
  check("…with the approved label", cancelled.statusLabel, "בוטלה");
  check("…offers no approve", cancelled.canApprove, false);
  check("…offers no decline", cancelled.canDecline, false);
  check("…and cannot be cancelled again", cancelled.canCancel, false);
  check("…and is not reported as auto-approved", cancelled.autoApproved, false);

  // 🔴 AND IT NO LONGER BLOCKS. `toApprovedRequests` keeps only `approved`,
  // which is the same predicate 0096's EXCLUDE carries — so a cancelled row
  // leaves the availability grid by itself, with nothing else to update.
  const declined = splitQueue([base({ status: "declined" })], NOW).history[0];
  check("a declined row is still a separate state from cancelled", declined.statusLabel, "נדחתה");

  check("the day link points at the right day", calendarDayUrl("2026-09-27"), "https://calendar.google.com/calendar/r/day/2026/9/27");
  check("…with no leading zeros, which Google rejects", calendarDayUrl("2026-01-05"), "https://calendar.google.com/calendar/r/day/2026/1/5");
  check("…and no /u/0/, which would pin the wrong Google account", calendarDayUrl("2026-09-27").includes("/u/0/"), false);
  check("a malformed date still yields an openable calendar", calendarDayUrl("nope"), "https://calendar.google.com/calendar/r");
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
