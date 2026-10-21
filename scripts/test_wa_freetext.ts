/**
 * E14 — the free-language layer: parser + machine + driver seam. Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_wa_freetext.ts
 * No users, no database, no network, no Meta. Availability is hand-built;
 * "today" is fixed (2026-10-16, a Friday) so relative dates are checkable.
 *
 * The owner's rules under test:
 *   SHARP  — what was not parsed with certainty is not executed: ambiguity
 *            is named in `dropped` or answered with a question, never a guess.
 *   SAFE   — no text ever confirms: "✅ לקבוע" is the only way into
 *            "submitting", and a mixed "מאשר, ותוסיף אורח" edits only.
 *   DEFAULT — an unstated length is 90 minutes, DISCLOSED at the summary,
 *            changeable until the client confirms (owner, 16.10).
 */
import {
  afterSubmit,
  FLOW_ID,
  initialState,
  parseFlowState,
  reduce,
  start,
  withAvailability,
  type FlowReply,
  type FlowState,
  type Transition,
} from "../src/lib/whatsapp/flow/machine";
import { eventFromMessage } from "../src/lib/whatsapp/flow/run";
import { parseAvailabilityText, parseEditText } from "../src/lib/whatsapp/flow/freetext";
import { COPY } from "../src/lib/whatsapp/flow/copy";
import type { PublicAvailability } from "../src/lib/booking/publicView";
import type { InboundMessage } from "../src/lib/whatsapp/webhook";

const C = COPY.he;
const TODAY = "2026-10-16"; // Friday
const NOW = new Date("2026-10-16T10:00:00+03:00");

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
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ""}`);
  }
}

const SHOW = {
  showId: "11111111-1111-1111-1111-111111111111",
  showName: "דעה לא פופולרית",
  defaultStudio: "גבעון",
  multiShow: false,
  freeTextOn: true,
};

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
/** חשמונאים slots: every listed day, starts 09:00..17:30 at 30m steps, 90 long. */
function availability(days: string[], room = "חשמונאים"): PublicAvailability {
  const free = days.flatMap((d) =>
    Array.from({ length: 18 }, (_, i) => 9 * 60 + i * 30).map((m) => ({
      room,
      dateIsrael: d,
      startIsrael: hhmm(m),
      endIsrael: hhmm(m + 90),
    }))
  );
  return { fromIsrael: "2026-10-17", toIsrael: "2026-12-10", rooms: ["גבעון גדול", "גבעון", "חשמונאים"], durationMinutes: 90, free, refusedRooms: [] };
}
// 18=Sun .. 22=Thu of "next week" (today is Friday 16.10)
const NEXT_WEEK = ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"];

const replyOf = (t: Transition): FlowReply => {
  if (t.kind !== "reply") throw new Error(`expected reply, got ${t.kind}`);
  return t.reply;
};
const bodyOf = (t: Transition): string => {
  const r = replyOf(t);
  return r.body;
};

console.log("\n=== 1. menu parser: the owner's example (16.10) ===");
{
  const q = parseAvailabilityText("תגיד לי מה פנוי שבוע הבא בין יום ראשון לרביעי אחרי השעה אחת בצהריים, חדר החשמונאים", TODAY);
  ok("parsed", q !== null, q);
  check("room", q?.studio, "חשמונאים");
  check("next Sunday", q?.dateFrom, "2026-10-18");
  check("through Wednesday", q?.dateTo, "2026-10-21");
  check('"אחת בצהריים" is 13:00', q?.timeFrom, "13:00");
  check("no length stated -> null (the DEFAULT is the machine's call)", q?.duration, null);
  check("nothing dropped", q?.dropped, []);
}
ok('"יש מקום מחר אחרי 4?" — the bare 4 is dropped, not guessed', (() => {
  const q = parseAvailabilityText("יש מקום מחר אחרי 4?", TODAY);
  return q !== null && q.dateFrom === "2026-10-17" && q.timeFrom === null && q.dropped.length === 1;
})());
ok('"גבעון גדול" is the large room ONLY (not also גבעון)', (() => {
  const q = parseAvailabilityText("מה פנוי בגבעון גדול ביום שלישי?", TODAY);
  return q?.studio === "גבעון גדול" && q.dateFrom === "2026-10-20" && q.dateTo === "2026-10-20" && !q.dropped.length;
})());
ok("two rooms named -> neither is picked, and it is said", (() => {
  const q = parseAvailabilityText("מה פנוי מחר, גבעון או חשמונאים?", TODAY);
  return q?.studio === null && q.dropped.includes("האולפן") && q.dateFrom === "2026-10-17";
})());
check("length in words", parseAvailabilityText("מה פנוי מחר לשלוש שעות בחשמונאים?", TODAY)?.duration, 180);
ok("explicit date + 24h time", (() => {
  const q = parseAvailabilityText("מה פנוי ב-21.10 אחרי 15:00?", TODAY);
  return q?.dateFrom === "2026-10-21" && q?.timeFrom === "15:00";
})());
check('"שלום, אפשר לקבוע?" carries no constraint -> not a query', parseAvailabilityText("שלום, אפשר לקבוע?", TODAY), null);
check("English text -> not a query (the parser is Hebrew)", parseAvailabilityText("what's free tomorrow?", TODAY), null);

console.log("\n=== 2. summary parser: every certain edit, nothing silently dropped ===");
check("guest by colon", parseEditText("אורח: יהודה לוי", TODAY), { edits: [{ field: "guest", value: "יהודה לוי", alsoConfirm: false }], dropped: [] });
check("note by colon — its own comma stays", parseEditText("הערה: שלוש מצלמות, תאורה דרמטית", TODAY), { edits: [{ field: "note", value: "שלוש מצלמות, תאורה דרמטית", alsoConfirm: false }], dropped: [] });
check("mixed approve+edit -> the EDIT, flagged", parseEditText("מאשר, ותוסיף אורח יהודה", TODAY), { edits: [{ field: "guest", value: "יהודה", alsoConfirm: true }], dropped: [] });
check("length", parseEditText("3 שעות", TODAY), { edits: [{ field: "duration", minutes: 180, alsoConfirm: false }], dropped: [] });
check("room", parseEditText("תשנו לגבעון גדול", TODAY), { edits: [{ field: "studio", studio: "גבעון גדול", alsoConfirm: false }], dropped: [] });
check("day", parseEditText("יום רביעי", TODAY), { edits: [{ field: "day", date: "2026-10-21", alsoConfirm: false }], dropped: [] });
// E14-2b (owner, 20.10): a bare time is an EXACT start; "אחרי 15:00" stays a "from"
check('bare "15:00" is an exact start', parseEditText("15:00", TODAY), { edits: [{ field: "time-at", hhmm: "15:00", alsoConfirm: false }], dropped: [] });
check('"כן" alone -> the confirm hint, NEVER a confirmation', parseEditText("כן", TODAY), { edits: [{ field: "confirm-hint" }], dropped: [] });
check("guest AND length in one message -> BOTH", parseEditText("אורח: יהודה, וגם 3 שעות", TODAY), {
  edits: [
    { field: "guest", value: "יהודה", alsoConfirm: false },
    { field: "duration", minutes: 180, alsoConfirm: false },
  ],
  dropped: [],
});
check("guest AND note in one message -> BOTH", parseEditText("אורח: יהודה, הערה: שלוש מצלמות", TODAY), {
  edits: [
    { field: "guest", value: "יהודה", alsoConfirm: false },
    { field: "note", value: "שלוש מצלמות", alsoConfirm: false },
  ],
  dropped: [],
});
check("day AND time in one message -> BOTH", parseEditText("יום רביעי אחרי 15:00", TODAY), {
  edits: [
    { field: "day", date: "2026-10-21", alsoConfirm: false },
    { field: "time-from", hhmm: "15:00", alsoConfirm: false },
  ],
  dropped: [],
});
ok("two DIFFERENT days -> the day is dropped, not picked", (() => {
  const r = parseEditText("יום רביעי או יום חמישי", TODAY);
  return r !== null && r.edits.length === 0 && r.dropped.includes("היום");
})());
ok("two different lengths -> the length is dropped, not picked", (() => {
  const r = parseEditText("3 שעות או 4 שעות", TODAY);
  return r !== null && r.edits.length === 0 && r.dropped.includes("משך ההקלטה");
})());
ok('a vague time is SAID, not used ("אחרי 4")', (() => {
  const r = parseEditText("אורח: יהודה, אחרי 4", TODAY);
  return r !== null && r.edits.length === 1 && r.edits[0].field === "guest" && r.dropped.length === 1;
})());
check("nothing certain -> null", parseEditText("זה נראה לי ממש טוב, תודה", TODAY), null);

console.log("\n=== 3. the menu answers a query ===");
{
  let t = start(SHOW);
  t = reduce(t.state, { type: "query", q: { studio: "חשמונאים", duration: null, dateFrom: "2026-10-18", dateTo: "2026-10-21", timeFrom: "13:00", timeTo: null, dropped: [] } });
  check("fresh availability is required first", t.kind, "need-availability");
  if (t.kind !== "need-availability") throw new Error("unreachable");
  check("the room the client wrote", t.state.studio, "חשמונאים");
  check("the DEFAULT length", t.state.duration, 90);
  check("...flagged as defaulted", t.state.durationFromDefault, true);
  check("the filter is stored", t.state.filter, { dateFrom: "2026-10-18", dateTo: "2026-10-21", timeFrom: "13:00", timeTo: null });

  t = withAvailability(t.state, availability(NEXT_WEEK));
  check("only the written range is offered", t.state.days, ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"]);
  ok("the echo says what was understood", bodyOf(t).includes("רשמתי לי"), bodyOf(t));

  t = reduce(t.state, { type: "day", date: "2026-10-20" });
  t = withAvailability(t.state, availability(NEXT_WEEK));
  check("only starts from 13:00 are offered", t.state.hours.length > 0 && t.state.hours.every((h) => h.start >= "13:00"), true);
  check("the first is 13:00", t.state.hours[0]?.start, "13:00");

  t = reduce(t.state, { type: "hour", start: "13:00" });
  t = reduce(t.state, { type: "text", text: "יהודה לוי" });
  t = reduce(t.state, { type: "no-note" });
  check("reached the summary", t.state.step, "summary");
  ok("the DEFAULT is disclosed before confirming", bodyOf(t).includes("ברירת המחדל"), bodyOf(t));
  ok("edits are invited", bodyOf(t).includes(C.SUMMARY.editHint), bodyOf(t));
}

console.log("\n=== 4. a zero-match range offers NOTHING as if it matched — broadening is the client's choice ===");
{
  let t = start(SHOW);
  t = reduce(t.state, { type: "query", q: { studio: "חשמונאים", duration: null, dateFrom: "2026-10-25", dateTo: "2026-10-26", timeFrom: null, timeTo: null, dropped: [] } });
  if (t.kind !== "need-availability") throw new Error("unreachable");
  t = withAvailability(t.state, availability(NEXT_WEEK)); // 18-22 only
  check("no days are offered", t.state.days, []);
  ok("it says there is nothing in the requested days", bodyOf(t).includes("אין פנוי"), bodyOf(t));
  const r = replyOf(t);
  ok("the only way forward is an explicit choice", r.type === "buttons" && r.buttons.some((b) => b.id === "f:broaden"), r);
  // a stale day tap from an earlier message validates against NOTHING
  const staleDay = reduce(t.state, { type: "day", date: "2026-10-20" });
  ok("a stale day pick is refused", bodyOf(staleDay).includes(C.NOTICE.stale), bodyOf(staleDay));
  // the client broadens: fresh read, all days, date filter dropped, time wish kept
  t = reduce(t.state, { type: "broaden" });
  check("broadening re-reads availability", t.kind, "need-availability");
  if (t.kind !== "need-availability") throw new Error("unreachable");
  t = withAvailability(t.state, availability(NEXT_WEEK));
  check("all free days are now offered", t.state.days, NEXT_WEEK);
  // a second broaden tap is stale — the list is live again
  const againBroaden = reduce(t.state, { type: "broaden" });
  ok("a stale broaden is refused", bodyOf(againBroaden).includes(C.NOTICE.stale), bodyOf(againBroaden));
}

console.log("\n=== 5. summary edits: safe, fresh, never confirming ===");
{
  // walk to a summary through the button path
  let t = start(SHOW);
  t = reduce(t.state, { type: "go" });
  t = reduce(t.state, { type: "duration", minutes: 90 });
  t = reduce(t.state, { type: "studio-yes" });
  t = withAvailability(t.state, availability(NEXT_WEEK, "גבעון"));
  t = reduce(t.state, { type: "day", date: "2026-10-18" });
  t = withAvailability(t.state, availability(NEXT_WEEK, "גבעון"));
  t = reduce(t.state, { type: "hour", start: "09:30" });
  t = reduce(t.state, { type: "no-guest" });
  t = reduce(t.state, { type: "no-note" });
  check("at the summary", t.state.step, "summary");

  const s = t.state;
  let e = reduce(s, { type: "edit", edits: [{ field: "guest", value: "יהודה לוי", alsoConfirm: false }], dropped: [] });
  check("a guest edit stays on the summary", e.state.step, "summary");
  check("...with the guest set", e.state.guest, "יהודה לוי");
  ok("...and shown", bodyOf(e).includes("יהודה לוי"), bodyOf(e));

  e = reduce(s, { type: "edit", edits: [{ field: "duration", minutes: 180, alsoConfirm: false }], dropped: [] });
  check("a length edit re-reads availability", e.kind, "need-availability");
  if (e.kind !== "need-availability") throw new Error("unreachable");
  check("...with the new length", e.state.duration, 180);
  // E14-2 (owner, 20.10): the day stays, the time is to be KEPT if it fits
  check("...the time held for re-checking, the day kept", [e.state.date, e.state.start, e.state.end, e.state.keep?.start], ["2026-10-18", null, null, "09:30"]);
  check("...no longer 'defaulted'", e.state.durationFromDefault, false);

  e = reduce(s, { type: "edit", edits: [{ field: "day", date: "2026-10-21", alsoConfirm: false }], dropped: [] });
  check("a day edit re-reads availability", e.kind, "need-availability");
  if (e.kind !== "need-availability") throw new Error("unreachable");
  check("...filtered to that day", e.state.filter?.dateFrom, "2026-10-21");
  e = withAvailability(e.state, availability(NEXT_WEEK, "גבעון"));
  check("...and the same time is free there: kept, back to the summary (E14-2)", [e.state.step, e.state.date, e.state.start], ["summary", "2026-10-21", "09:30"]);

  e = reduce(s, { type: "edit", edits: [{ field: "guest", value: "יהודה", alsoConfirm: false }, { field: "duration", minutes: 240, alsoConfirm: false }], dropped: [] });
  check("a TWO-FIELD message applies both", e.kind, "need-availability");
  if (e.kind !== "need-availability") throw new Error("unreachable");
  check("...guest saved AND length changed", [e.state.guest, e.state.duration], ["יהודה", 240]);

  e = reduce(s, { type: "edit", edits: [{ field: "confirm-hint" }], dropped: [] });
  check('"כן" changes nothing and submits nothing', [e.state.step, e.state.requestId], ["summary", null]);
  ok("...pointing at the button", bodyOf(e).includes("✅ לקבוע"), bodyOf(e));

  e = reduce(s, { type: "edit", edits: [{ field: "guest", value: "יהודה", alsoConfirm: true }], dropped: [] });
  check("a mixed message edits ONLY", [e.state.step, e.state.guest], ["summary", "יהודה"]);
  ok("...and says confirmation is the button", bodyOf(e).includes(C.NOTICE.confirmByButton), bodyOf(e));

  e = reduce(s, { type: "edit", edits: [{ field: "guest", value: "א".repeat(121), alsoConfirm: false }, { field: "duration", minutes: 180, alsoConfirm: false }], dropped: [] });
  check("one bad field fails the WHOLE message — no partial apply", [e.state.step, e.state.guest, e.state.duration], ["summary", null, 90]);
  ok("...saying why", bodyOf(e).includes(C.GUEST.tooLong), bodyOf(e));

  e = reduce(s, { type: "edit", edits: [{ field: "guest", value: "יהודה", alsoConfirm: false }], dropped: ['השעה "4"'] });
  ok("a dropped fragment is SAID, not silent", bodyOf(e).includes("לא בטוח שהבנתי"), bodyOf(e));
  ok("...and 'updated' does NOT overstate a partial apply", bodyOf(e).includes(C.NOTICE.changedPartial) && !bodyOf(e).includes("עדכנתי ✔️"), bodyOf(e));
  ok("...the summary still shows the slot that was KEPT (09:30 stays 09:30)", bodyOf(e).includes("09:30"), bodyOf(e));
  let e2 = reduce(s, { type: "edit", edits: [{ field: "studio", studio: "חשמונאים", alsoConfirm: false }], dropped: ["עד רביעי"] });
  check("a partial slot change re-reads availability", e2.kind, "need-availability");
  if (e2.kind !== "need-availability") throw new Error("unreachable");
  e2 = withAvailability(e2.state, availability(NEXT_WEEK, "חשמונאים"));
  ok("...and says 'updated what I understood' (time kept: E14-2)", bodyOf(e2).includes(C.NOTICE.changedPartial) && e2.state.step === "summary", bodyOf(e2));
  const e3 = reduce(s, { type: "edit", edits: [{ field: "guest", value: "יהודה", alsoConfirm: false }], dropped: [] });
  ok("a clean apply keeps the plain 'updated'", bodyOf(e3).includes(C.NOTICE.changed) && !bodyOf(e3).includes(C.NOTICE.changedPartial), bodyOf(e3));

  e = reduce(s, { type: "text", text: "זה נראה לי ממש טוב" });
  ok("an unparsed text asks what to change", bodyOf(e).includes("לא הבנתי מה לשנות"), bodyOf(e));

  e = reduce(s, { type: "confirm" });
  check("the button is still the only way in", e.kind, "submit");

  // a slot edit keeps the values it kept: studio change -> re-choose -> summary
  const withValues = { ...s, guest: "יהודה לוי", note: "שלוש מצלמות, תאורה דרמטית" };
  let sc = reduce(withValues, { type: "edit", edits: [{ field: "studio", studio: "גבעון גדול", alsoConfirm: false }], dropped: [] });
  check("a studio edit re-reads availability", sc.kind, "need-availability");
  if (sc.kind !== "need-availability") throw new Error("unreachable");
  sc = withAvailability(sc.state, availability(NEXT_WEEK, "גבעון גדול"));
  check("...straight back to the summary (not re-asked the guest)", sc.state.step, "summary");
  check("...guest preserved", sc.state.guest, "יהודה לוי");
  check("...note preserved, comma and all", sc.state.note, "שלוש מצלמות, תאורה דרמטית");
  check("...same day and time, new room (E14-2: kept because it fits)", [sc.state.date, sc.state.start, sc.state.studio], ["2026-10-18", "09:30", "גבעון גדול"]);
}

console.log("\n=== 6. the layer OFF behaves exactly as before ===");
{
  const off = { ...SHOW, freeTextOn: false };
  let t = start(off);
  check("no freeTextOn in a fresh state when off", t.state.freeTextOn, false);
  t = reduce(t.state, { type: "text", text: "מה פנוי מחר?" });
  check("text at the menu re-sends the menu", t.state.step, "menu");
  const s2 = initialState(off);
  const e = reduce({ ...s2, step: "summary", date: "2026-10-18", start: "09:30", end: "11:00", duration: 90, studio: "גבעון" }, { type: "edit", edits: [{ field: "guest", value: "יהודה", alsoConfirm: false }], dropped: [] });
  ok("an edit event with the layer off -> pick-from-list", bodyOf(e).includes(C.NOTICE.pickFromList), bodyOf(e));
  const sum = reduce({ ...s2, step: "summary", date: "2026-10-18", start: "09:30", end: "11:00", duration: 90, studio: "גבעון" }, { type: "text", text: "whatever" });
  ok("summary text with the layer off -> pick-from-list (unchanged)", bodyOf(sum).includes(C.NOTICE.pickFromList), bodyOf(sum));
}

console.log("\n=== 7. the driver seam: text becomes a structured event ===");
const msg = (body: string): InboundMessage => ({ type: "text", body, raw: null } as unknown as InboundMessage);
check("a Hebrew query at the menu", (() => {
  const e = eventFromMessage(msg("מה פנוי מחר בחשמונאים?"), { now: NOW, freeTextOn: true, step: "menu", lang: "he" });
  return e.type === "query" ? { studio: e.q.studio, date: e.q.dateFrom } : e;
})(), { studio: "חשמונאים", date: "2026-10-17" });
check("...but not in an English conversation", eventFromMessage(msg("מה פנוי מחר בחשמונאים?"), { now: NOW, freeTextOn: true, step: "menu", lang: "en" }), { type: "text", text: "מה פנוי מחר בחשמונאים?" });
check("...not with the layer off", eventFromMessage(msg("מה פנוי מחר בחשמונאים?"), { now: NOW, freeTextOn: false, step: "menu", lang: "he" }), { type: "text", text: "מה פנוי מחר בחשמונאים?" });
check("...and NEVER at the guest step, where text is a value", eventFromMessage(msg("מה פנוי מחר בחשמונאים?"), { now: NOW, freeTextOn: true, step: "guest", lang: "he" }), { type: "text", text: "מה פנוי מחר בחשמונאים?" });
check("an edit at the summary", eventFromMessage(msg("אורח: יהודה לוי"), { now: NOW, freeTextOn: true, step: "summary", lang: "he" }), { type: "edit", edits: [{ field: "guest", value: "יהודה לוי", alsoConfirm: false }], dropped: [] });
check('"חזרה" stays navigation, not text', eventFromMessage(msg("חזרה"), { now: NOW, freeTextOn: true, step: "summary", lang: "he" }), { type: "back" });

console.log("\n=== 8. stale availability is re-read, not trusted ===");
{
  // a day edit to a day that filled up: the fresh answer rules
  let t = start(SHOW);
  t = reduce(t.state, { type: "go" });
  t = reduce(t.state, { type: "duration", minutes: 90 });
  t = reduce(t.state, { type: "studio-yes" });
  t = withAvailability(t.state, availability(NEXT_WEEK, "גבעון"));
  t = reduce(t.state, { type: "day", date: "2026-10-18" });
  t = withAvailability(t.state, availability(NEXT_WEEK, "גבעון"));
  t = reduce(t.state, { type: "hour", start: "09:30" });
  t = reduce(t.state, { type: "no-guest" });
  t = reduce(t.state, { type: "no-note" });
  const taken = afterSubmit(t.state, { ok: false, code: "taken" });
  check("a slot taken at submission still re-reads the day", taken.kind, "need-availability");
  if (taken.kind !== "need-availability") throw new Error("unreachable");
  check("...back on the hour step", taken.state.step, "hour");
}


console.log("\n=== 9. ranges parse whole — and what is not used is SAID ===");
{
  const q = parseAvailabilityText("מה פנוי בין 9:00 ל-10:00 בחדר החשמונאים, ראשון עד רביעי?", TODAY);
  check("a time range: from", q?.timeFrom, "09:00");
  check("...to", q?.timeTo, "10:00");
  check("a bare weekday range: from Sunday", q?.dateFrom, "2026-10-18");
  check("...through Wednesday", q?.dateTo, "2026-10-21");
  check("nothing dropped", q?.dropped, []);
}
{
  const q = parseAvailabilityText("מה פנוי יום ראשון עד רביעי בחשמונאים?", TODAY);
  check('"יום ראשון עד רביעי" is the whole range too', [q?.dateFrom, q?.dateTo], ["2026-10-18", "2026-10-21"]);
}
{
  const q = parseAvailabilityText("מה פנוי מחר עד רביעי?", TODAY);
  check("מחר is taken", [q?.dateFrom, q?.dateTo], ["2026-10-17", "2026-10-17"]);
  ok('...and "עד רביעי" is SAID as not applied, not silently ignored', (q?.dropped ?? []).some((d) => d.includes("רביעי")), q?.dropped);
}
{
  const q = parseAvailabilityText("מה פנוי בין 4 ל-6?", TODAY);
  check("bare 4-6 are ambiguous: no times used", [q?.timeFrom, q?.timeTo], [null, null]);
  check("...both named", q?.dropped.length, 2);
}
{
  const q = parseAvailabilityText("מה פנוי בין 10 בבוקר ל-4 בערב?", TODAY);
  check("dayparts make the range certain", [q?.timeFrom, q?.timeTo], ["10:00", "16:00"]);
}
{
  const e = parseEditText("אורח: יהודה לוי, שעה: עד 11", TODAY);
  check("the guest is cut at the time clause", e?.edits, [{ field: "guest", value: "יהודה לוי", alsoConfirm: false }]);
  ok('"עד 11" is named, not silent', (e?.dropped ?? []).some((d) => d.includes("עד 11")), e?.dropped);
}
{
  const e = parseEditText("אורח: יהודה לוי, הערות: שלוש מצלמות, תאורה דרמטית, אולפן: גבעון גדול", TODAY);
  check("a three-field message: guest", e?.edits[0], { field: "guest", value: "יהודה לוי", alsoConfirm: false });
  check("...note WHOLE, its own comma kept", e?.edits[1], { field: "note", value: "שלוש מצלמות, תאורה דרמטית", alsoConfirm: false });
  check("...studio", e?.edits[2], { field: "studio", studio: "גבעון גדול", alsoConfirm: false });
  check("...nothing dropped", e?.dropped, []);
}
{
  const e = parseEditText("עד 11:00", TODAY);
  check("an end time is never a start-time edit", e?.edits ?? [], []);
  ok('"עד 11:00" is named', (e?.dropped ?? []).some((d) => d.includes("עד 11:00")), e);
}

console.log("\n=== 10. regression: a re-chosen hour skips to the summary ONLY with the layer on, in Hebrew ===");
{
  // the live bot's path: guest + note given, the slot is taken at submission,
  // a new hour is picked. Before E14 that asked the guest again — and with the
  // layer off, or in English, it still must.
  const takenThenNewHour = (show: typeof SHOW & { lang?: "he" | "en" }, tamper?: (s: FlowState) => FlowState) => {
    let t = start(show);
    t = reduce(t.state, { type: "go" });
    t = reduce(t.state, { type: "duration", minutes: 90 });
    t = reduce(t.state, { type: "studio-yes" });
    t = withAvailability(t.state, availability(NEXT_WEEK, "גבעון"));
    t = reduce(t.state, { type: "day", date: "2026-10-18" });
    t = withAvailability(t.state, availability(NEXT_WEEK, "גבעון"));
    t = reduce(t.state, { type: "hour", start: "09:30" });
    t = reduce(t.state, { type: "text", text: "Yehuda Levi" });
    t = reduce(t.state, { type: "text", text: "three cameras" });
    if (t.state.step !== "summary") throw new Error(`walk: expected summary, got ${t.state.step}`);
    const taken = afterSubmit(t.state, { ok: false, code: "taken" });
    if (taken.kind !== "need-availability") throw new Error("walk: expected need-availability");
    let s = taken.state;
    if (tamper) s = tamper(s);
    t = withAvailability(s, availability(NEXT_WEEK, "גבעון"));
    return reduce(t.state, { type: "hour", start: "10:00" });
  };

  const off = takenThenNewHour({ ...SHOW, freeTextOn: false });
  check("layer OFF: back to the guest step, as on main", off.state.step, "guest");
  check("...the new hour is kept", [off.state.start, off.state.end], ["10:00", "11:30"]);

  const en = takenThenNewHour({ ...SHOW, freeTextOn: true, lang: "en" });
  check("layer ON, English: back to the guest step, as on main", en.state.step, "guest");
  check("...the new hour is kept", [en.state.start, en.state.end], ["10:00", "11:30"]);

  const he = takenThenNewHour({ ...SHOW, freeTextOn: true, lang: "he" });
  check("layer ON, Hebrew: straight back to the summary", he.state.step, "summary");
  check("...guest and note kept, new hour", [he.state.guest, he.state.note, he.state.start], ["Yehuda Levi", "three cameras", "10:00"]);

  // a conversation saved BEFORE E14 carries no freeTextOn at all
  const legacyRaw = takenThenNewHour({ ...SHOW, freeTextOn: true, lang: "he" }, (s) => {
    const { freeTextOn: _drop, ...rest } = s;
    void _drop;
    return rest as FlowState;
  });
  check("an old state without freeTextOn (raw): guest step", legacyRaw.state.step, "guest");
  const legacyParsed = takenThenNewHour({ ...SHOW, freeTextOn: true, lang: "he" }, (s) => {
    const raw = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
    delete raw.freeTextOn;
    const parsed = parseFlowState(raw);
    if (!parsed) throw new Error("parseFlowState refused the legacy state");
    return parsed;
  });
  check("an old state without freeTextOn (through parseFlowState): defaults off, guest step", [legacyParsed.state.freeTextOn, legacyParsed.state.step], [false, "guest"]);
}

// ─── regression 16.10: the zero-match screens and the "updated" lines ──────
const buttonIds = (t: Transition) => {
  const r = replyOf(t);
  return r.type === "buttons" ? r.buttons.map((b) => b.id) : r.type === "list" ? r.sections.flatMap((x) => x.rows.map((y) => y.id)) : [];
};
const textAt = (s: FlowState, text: string) =>
  reduce(s, eventFromMessage(msg(text), { now: NOW, freeTextOn: s.freeTextOn, step: s.step, lang: s.lang }), { now: NOW });

console.log("\n=== 11. zero-match DAYS: typed text never empties the screen; only the tap broadens ===");
{
  let t = start(SHOW);
  t = reduce(t.state, { type: "query", q: { studio: "חשמונאים", duration: null, dateFrom: "2026-10-28", dateTo: "2026-10-28", timeFrom: null, timeTo: null, dropped: [] } });
  if (t.kind !== "need-availability") throw new Error("unreachable");
  t = withAvailability(t.state, availability(NEXT_WEEK));
  const Z = t.state;
  check("the zero-match screen: broaden + back", buttonIds(t), [FLOW_ID.broaden, FLOW_ID.back]);
  ok("…no invitation to type other days", !bodyOf(t).includes("לכתוב"), bodyOf(t));
  for (const typed of ["סתם משהו", "כן"]) {
    const r = textAt(Z, typed);
    check(`"${typed}": the same zero-match screen again (broaden + back)`, [r.kind, buttonIds(r)], ["reply", [FLOW_ID.broaden, FLOW_ID.back]]);
    ok(`"${typed}": says nothing is free — never "these are the free days"`, bodyOf(r).includes(C.NOTICE.noMatchDates) && !bodyOf(r).includes("שיש בהם מקום"), bodyOf(r));
    check(`"${typed}": filter and (empty) list untouched`, [r.state.filter, r.state.days, r.state.step], [Z.filter, [], "day"]);
  }
  // E14-2b: ANOTHER day typed is a new narrow request, not a broadening
  const retyped = textAt(Z, "אז אולי ביום שני?");
  check("another day typed: a fresh read for THAT day (E14-2b)", [retyped.kind, retyped.state.filter?.dateFrom, retyped.state.filter?.dateTo], ["need-availability", "2026-10-19", "2026-10-19"]);
  const staleDay = reduce(Z, { type: "day", date: "2026-10-20" });
  ok("a stale day tap: 'no longer active' + the zero-match screen", bodyOf(staleDay).includes(C.NOTICE.stale) && bodyOf(staleDay).includes(C.NOTICE.noMatchDates), bodyOf(staleDay));
  check("…its buttons kept", buttonIds(staleDay), [FLOW_ID.broaden, FLOW_ID.back]);
  const back = reduce(Z, { type: "back" });
  check("back is not blocked (to the room question)", back.state.step, "studio-default");
  const restart = reduce(Z, { type: "restart" });
  check("restart is not blocked (to the menu, filter gone)", [restart.state.step, restart.state.filter], ["menu", null]);
  let b = reduce(Z, { type: "broaden" });
  check("the explicit tap re-reads availability", b.kind, "need-availability");
  if (b.kind !== "need-availability") throw new Error("unreachable");
  b = withAvailability(b.state, availability(NEXT_WEEK));
  check("…and offers every free day", b.state.days, NEXT_WEEK);
  const oldBroaden = reduce(b.state, { type: "broaden" });
  ok("an OLD broaden tap after that is stale — the list stays", bodyOf(oldBroaden).includes(C.NOTICE.stale) && oldBroaden.state.days.length === NEXT_WEEK.length, bodyOf(oldBroaden));
}

console.log("\n=== 12. zero-match HOURS: the same rule ===");
{
  let t = start(SHOW);
  t = reduce(t.state, { type: "query", q: { studio: "חשמונאים", duration: null, dateFrom: "2026-10-20", dateTo: "2026-10-20", timeFrom: "20:00", timeTo: null, dropped: [] } });
  if (t.kind !== "need-availability") throw new Error("unreachable");
  // E14-2: one day asked and free -> straight to its hours, no day tap
  t = withAvailability(t.state, availability(NEXT_WEEK));
  const Z = t.state;
  check("the zero-match hours screen: broaden + back", [Z.step, buttonIds(t)], ["hour", [FLOW_ID.broaden, FLOW_ID.back]]);
  for (const typed of ["סתם משהו", "כן"]) {
    const r = textAt(Z, typed);
    check(`"${typed}": the same zero-match screen again`, [r.kind, buttonIds(r)], ["reply", [FLOW_ID.broaden, FLOW_ID.back]]);
    ok(`"${typed}": says nothing is free at those times`, bodyOf(r).includes(C.NOTICE.noMatchHours), bodyOf(r));
    check(`"${typed}": filter and (empty) list untouched`, [r.state.filter, r.state.hours, r.state.date], [Z.filter, [], "2026-10-20"]);
  }
  // E14-2b: an exact time typed is a new request for THAT slot (kept if free)
  const retypedHour = textAt(Z, "אז אולי ב-10:00?");
  check("an exact time typed: that slot is checked (E14-2b)", [retypedHour.kind, retypedHour.state.keep?.start], ["need-availability", "10:00"]);
  const staleHour = reduce(Z, { type: "hour", start: "13:00" });
  ok("a stale hour tap: 'no longer active' + the zero-match screen", bodyOf(staleHour).includes(C.NOTICE.stale) && bodyOf(staleHour).includes(C.NOTICE.noMatchHours), bodyOf(staleHour));
  const back = reduce(Z, { type: "back" });
  check("back is not blocked (to the day list)", [back.state.step, back.state.days], ["day", ["2026-10-20"]]);
  check("restart is not blocked", reduce(Z, { type: "restart" }).state.step, "menu");
  let b = reduce(Z, { type: "broaden" });
  if (b.kind !== "need-availability") throw new Error("unreachable");
  b = withAvailability(b.state, availability(NEXT_WEEK));
  check("the explicit tap: every hour of that day", b.state.hours[0]?.start, "09:00");
  const oldBroaden = reduce(b.state, { type: "broaden" });
  ok("an OLD broaden tap after that is stale — the hours stay", bodyOf(oldBroaden).includes(C.NOTICE.stale) && oldBroaden.state.hours.length > 0, bodyOf(oldBroaden));
}

console.log("\n=== 13. the 'updated' line is said only about a real change ===");
{
  let t = start(SHOW);
  t = reduce(t.state, { type: "go" });
  t = reduce(t.state, { type: "duration", minutes: 90 });
  t = reduce(t.state, { type: "studio-yes" });
  t = withAvailability(t.state, availability(NEXT_WEEK, "גבעון"));
  t = reduce(t.state, { type: "day", date: "2026-10-20" });
  t = withAvailability(t.state, availability(NEXT_WEEK, "גבעון"));
  t = reduce(t.state, { type: "hour", start: "14:00" });
  t = reduce(t.state, { type: "text", text: "יהודה" });
  t = reduce(t.state, { type: "no-note" });
  const S = { ...t.state, filter: { dateFrom: "2026-10-18", dateTo: "2026-10-21", timeFrom: "13:00", timeTo: null } };
  const UPDATED = "עדכנתי";
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;

  for (const typed of ["כן", "מאשר"]) {
    const r = textAt(S, typed);
    ok(`"${typed}": explains the button, no "updated"`, bodyOf(r).includes(C.NOTICE.confirmByButton) && !bodyOf(r).includes(UPDATED), bodyOf(r));
    check(`"${typed}": nothing submitted, nothing changed`, [r.kind, r.state.step, r.state.guest, r.state.start], ["reply", "summary", "יהודה", "14:00"]);
  }
  const unclear = textAt(S, "יום רביעי או יום חמישי");
  ok("two conflicting days: says what was unclear AND that nothing changed", bodyOf(unclear).includes(C.NOTICE.unchanged) && bodyOf(unclear).includes("היום") && !bodyOf(unclear).includes(UPDATED), bodyOf(unclear));
  check("…the summary is the real one", [unclear.state.date, unclear.state.start], ["2026-10-20", "14:00"]);
  const mixed = textAt(S, "מאשר, ותוסיף אורח רון");
  check('a real edit + "מאשר": exactly ONE "updated"', count(bodyOf(mixed), UPDATED), 1);
  ok("…plus the button line, guest changed, still the summary", bodyOf(mixed).includes(C.NOTICE.confirmByButton) && mixed.state.guest === "רון" && mixed.state.step === "summary", bodyOf(mixed));
  const same = textAt(S, "אורח: יהודה");
  ok("the guest already saved: 'already set', no 'updated'", bodyOf(same).includes(C.NOTICE.alreadySet) && !bodyOf(same).includes(UPDATED), bodyOf(same));
  const sameConfirm = textAt(S, "מאשר, ותוסיף אורח יהודה");
  ok("…with 'מאשר' too: 'already set' + the button line, no 'updated'", bodyOf(sameConfirm).includes(C.NOTICE.alreadySet) && bodyOf(sameConfirm).includes(C.NOTICE.confirmByButton) && !bodyOf(sameConfirm).includes(UPDATED), bodyOf(sameConfirm));
  const sameDay = textAt(S, "יום שלישי");
  check("the day already chosen: no re-read, 'already set'", [sameDay.kind, bodyOf(sameDay).includes(C.NOTICE.alreadySet)], ["reply", true]);
  const sameTime = textAt(S, "14:00");
  check("the hour already chosen: no re-read, 'already set'", [sameTime.kind, bodyOf(sameTime).includes(C.NOTICE.alreadySet)], ["reply", true]);
  const sameRoom = textAt(S, "גבעון");
  check("the room already chosen: no re-read, 'already set'", [sameRoom.kind, bodyOf(sameRoom).includes(C.NOTICE.alreadySet)], ["reply", true]);
  // the filter already says 13:00 but the chosen start is 14:00: "13:00" IS a change
  const earlier = textAt(S, "13:00");
  check("13:00 when 14:00 is chosen (filter already 13:00): a real change -> hours re-read", [earlier.kind, earlier.state.step], ["need-availability", "hour"]);
  // a length change on the same day keeps the day the client named
  const longer = textAt(S, "יום שלישי, 3 שעות");
  check("3 hours + the same day: re-read, narrowed to that day", [longer.kind, longer.state.duration, longer.state.filter?.dateFrom], ["need-availability", 180, "2026-10-20"]);
}

console.log("\n=== 14. switch off / English: unchanged ===");
{
  const S = { ...initialState({ ...SHOW, freeTextOn: false }), step: "summary" as const, date: "2026-10-18", start: "09:30", end: "11:00", duration: 90 as const, studio: "גבעון" as const };
  for (const typed of ["כן", "יום רביעי או יום חמישי", "אורח: רון"]) {
    const r = textAt(S, typed);
    ok(`off, "${typed}": 'choose from the options', no new copy`, bodyOf(r).includes(C.NOTICE.pickFromList) && !bodyOf(r).includes(C.NOTICE.unchanged) && !bodyOf(r).includes(C.NOTICE.alreadySet), bodyOf(r));
  }
  const E = { ...initialState({ ...SHOW, freeTextOn: true, lang: "en" }), step: "summary" as const, date: "2026-10-18", start: "09:30", end: "11:00", duration: 90 as const, studio: "גבעון" as const };
  const en = textAt(E, "כן");
  ok('English + on, "כן": the old pick-from-list', bodyOf(en).includes(COPY.en.NOTICE.pickFromList), bodyOf(en));
}

console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
