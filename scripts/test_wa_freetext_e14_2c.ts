/**
 * E14-2c stage 1 — a whole booking request in ONE message, the bot side (no
 * LLM yet). The request arrives as the same `edit` event the language layer
 * produces at every choice step; here it is built by hand exactly as the
 * extractor will build it (stage 2), and driven through the REAL machine and,
 * for the first-message / several-podcasts paths, the REAL runFlow on the
 * in-memory store (scripts/_fake_db.ts). Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_wa_freetext_e14_2c.ts
 * No users, no database, no network (fetch throws), no Meta. Availability is a
 * fixed grid; "today" is Wed 21.10.2026, 10:00 Israel.
 *
 * Owner decisions 21.10 under test:
 *   - the first message's request is applied at once (it used to get the menu)
 *   - "החדר הקבוע שלי" = the show's default room; none set -> said, the room asked
 *   - the answer says whether THAT slot is free; nothing is booked by text —
 *     the summary keeps "✅ לקבוע" as the only way in
 *   - taken -> the reason + that day's hours / other days; guest and note kept
 *   - (4) the room is taken and another is free at that very time -> OFFERED,
 *     the client decides
 *   - (3) several podcasts: the request is HELD and applied after the choice
 *   - switch off / English: exactly as before
 */
import { fakeDb } from "./_fake_db";
import { runFlow, type FlowDeps } from "../src/lib/whatsapp/flow/run";
import {
  FLOW_ID,
  parseFlowId,
  parsePendingEvent,
  reduce,
  start,
  withAvailability,
  type FlowEvent,
  type FlowReply,
  type FlowState,
  type Transition,
} from "../src/lib/whatsapp/flow/machine";
import { COPY } from "../src/lib/whatsapp/flow/copy";
import type { ParsedEdit } from "../src/lib/whatsapp/flow/freetext";
import type { PublicAvailability } from "../src/lib/booking/publicView";
import type { ContactShow } from "../src/lib/booking/contacts";
import type { InboundMessage } from "../src/lib/whatsapp/webhook";

let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("network is forbidden in this test");
}) as unknown as typeof fetch;

const HE = COPY.he;
const NOW = new Date("2026-10-21T10:00:00+03:00"); // Wednesday
let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ""}`);
  }
}
const eq = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

// ── availability: Sun 25 .. Thu 29.10, every room, 09:00 on, ending by 21:00 ──
const DAYS = ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"];
const ROOMS = ["גבעון גדול", "גבעון", "חשמונאים"];
const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
type Busy = (room: string, date: string, startMin: number, duration: number) => boolean;
function grid(duration: number, busy: Busy = () => false): PublicAvailability {
  const free = DAYS.flatMap((d) =>
    ROOMS.flatMap((room) => {
      const out = [];
      for (let m = 9 * 60; m + duration <= 21 * 60; m += 30) {
        if (!busy(room, d, m, duration)) out.push({ room, dateIsrael: d, startIsrael: hhmm(m), endIsrael: hhmm(m + duration) });
      }
      return out;
    })
  );
  return { fromIsrael: "2026-10-22", toIsrael: "2026-12-10", rooms: ROOMS, durationMinutes: duration, free, refusedRooms: [] };
}
/** a room that has something at 12:00–13:00 on Sunday 25.10 */
const busyAtNoon = (rooms: string[]): Busy => (room, date, m, d) =>
  rooms.includes(room) && date === "2026-10-25" && m < 13 * 60 && m + d > 12 * 60;
const busyAllDay = (rooms: string[]): Busy => (room, date) => rooms.includes(room) && date === "2026-10-25";

// ── a conversation driven through the machine ───────────────────────────────
class Chat {
  state: FlowState;
  last: FlowReply;
  reads = 0;
  constructor(
    readonly opts: { freeTextOn?: boolean; lang?: "he" | "en"; defaultStudio?: string | null; busy?: Busy } = {}
  ) {
    const t = start({
      showId: "11111111-1111-1111-1111-111111111111",
      showName: "בדיקה",
      defaultStudio: opts.defaultStudio === undefined ? "חשמונאים" : opts.defaultStudio,
      multiShow: false,
      freeTextOn: opts.freeTextOn ?? true,
      lang: opts.lang ?? "he",
    });
    if (t.kind !== "reply") throw new Error("start");
    this.state = t.state;
    this.last = t.reply;
  }
  event(e: FlowEvent) {
    let t: Transition = reduce(this.state, e, { now: NOW });
    for (let g = 0; g < 6; g++) {
      if (t.kind === "reply") {
        this.state = t.state;
        this.last = t.reply;
        return this;
      }
      if (t.kind === "need-availability") {
        this.reads++;
        t = withAvailability(t.state, grid(t.state.duration ?? 90, this.opts.busy));
        continue;
      }
      throw new Error(`unexpected ${t.kind} (a submit from text would be a bug)`);
    }
    throw new Error("did not settle");
  }
  tap(id: string) {
    const e = parseFlowId(id);
    if (!e) throw new Error(`not a flow id: ${id}`);
    if (!this.offered().some((o) => o.id === id)) throw new Error(`not offered: ${id} in ${JSON.stringify(this.offered())}`);
    return this.event(e);
  }
  text(t: string) {
    return this.event({ type: "text", text: t });
  }
  body() {
    return this.last.body;
  }
  offered(): { id: string; title: string }[] {
    const r = this.last;
    return r.type === "buttons" ? r.buttons : r.type === "list" ? r.sections.flatMap((s) => s.rows.map((x) => ({ id: x.id, title: x.title }))) : [];
  }
}

const E = {
  day: (date: string): ParsedEdit => ({ field: "day", date, alsoConfirm: false }),
  at: (hhmm: string): ParsedEdit => ({ field: "time-at", hhmm, alsoConfirm: false }),
  dur: (minutes: 90 | 180 | 240): ParsedEdit => ({ field: "duration", minutes, alsoConfirm: false }),
  room: (studio: "גבעון" | "גבעון גדול" | "חשמונאים"): ParsedEdit => ({ field: "studio", studio, alsoConfirm: false }),
  myRoom: (): ParsedEdit => ({ field: "studio-default", alsoConfirm: false }),
  guest: (value: string): ParsedEdit => ({ field: "guest", value, alsoConfirm: false }),
  note: (value: string): ParsedEdit => ({ field: "note", value, alsoConfirm: false }),
};
const edit = (edits: ParsedEdit[], dropped: string[] = []): FlowEvent => ({ type: "edit", edits, dropped });

/** the owner's sentence, as the extractor will hand it over */
const OWNER_SENTENCE = edit([E.day("2026-10-25"), E.myRoom(), E.at("12:00"), E.dur(180), E.guest("דוד כהן"), E.note("חשוב תפאורה של הפודקאסט")]);

console.log("\n=== 1. the owner's sentence, the slot is free: the full summary, nothing booked ===");
{
  const c = new Chat().event(OWNER_SENTENCE);
  eq("straight to the summary", c.state.step, "summary");
  eq("…every field from the one message", [c.state.date, c.state.start, c.state.end, c.state.studio, c.state.duration, c.state.guest, c.state.note],
    ["2026-10-25", "12:00", "15:00", "חשמונאים", 180, "דוד כהן", "חשוב תפאורה של הפודקאסט"]);
  ok("one availability read", c.reads === 1, c.reads);
  ok("says THAT slot is free, in the regular room", c.body().startsWith(HE.NOTICE.slotFree("2026-10-25", "12:00", "15:00", "חשמונאים", true)), c.body());
  ok("…and that nothing is booked yet", c.body().includes(HE.NOTICE.notBookedYet), c.body());
  ok("no 'עדכנתי' on a first message", !c.body().includes(HE.NOTICE.changed), c.body());
  ok("the confirm button is there — the only way in", c.offered().some((o) => o.id === FLOW_ID.confirm), c.offered());
  ok("the length was stated, so no default disclosure", !c.body().includes(HE.SUMMARY.durationDefault), c.body());
  eq("no stray state", [c.state.keep ?? null, c.state.offer ?? null, c.state.notice], [null, null, null]);
}

console.log("\n=== 2. a room named outright, no guest yet: the slot is said free, then the guest question ===");
{
  const c = new Chat().event(edit([E.day("2026-10-26"), E.room("גבעון"), E.at("10:00")]));
  eq("the guest step", [c.state.step, c.state.start, c.state.studio], ["guest", "10:00", "גבעון"]);
  ok("…under 'free' (not the regular room)", c.body().startsWith(HE.NOTICE.slotFree("2026-10-26", "10:00", "11:30", "גבעון", false)), c.body());
  ok("…without 'press to book' before the summary", !c.body().includes(HE.NOTICE.notBookedYet), c.body());
  ok("the length is the default, disclosed later", c.state.durationFromDefault === true && c.state.duration === 90, c.state);
  c.text("יהודה לוי").event({ type: "no-note" });
  eq("guest typed, note skipped -> the summary", [c.state.step, c.state.guest], ["summary", "יהודה לוי"]);
  ok("…which discloses the default length", c.body().includes(HE.SUMMARY.durationDefault), c.body());
}

console.log("\n=== 3. taken in the room, another room free at that time: OFFERED, the client decides ===");
{
  const c = new Chat({ busy: busyAtNoon(["חשמונאים"]) }).event(OWNER_SENTENCE);
  eq("buttons, not a list", c.last.type, "buttons");
  ok("the offer says which room is taken and which are free", c.body() === HE.OFFER.body("2026-10-25", "12:00", "חשמונאים", 180, ["גבעון", "גבעון גדול"]), c.body());
  eq("one button per free room + 'other times'", c.offered().map((o) => o.id), [FLOW_ID.switchRoom("גבעון"), FLOW_ID.switchRoom("גבעון גדול"), FLOW_ID.otherTimes]);
  ok("button titles within Meta's 20", c.offered().every((o) => Array.from(o.title).length <= 20), c.offered());
  eq("guest and note kept while deciding", [c.state.guest, c.state.note], ["דוד כהן", "חשוב תפאורה של הפודקאסט"]);
  eq("nothing switched by itself", c.state.studio, "חשמונאים");

  const sw = new Chat({ busy: busyAtNoon(["חשמונאים"]) }).event(OWNER_SENTENCE).tap(FLOW_ID.switchRoom("גבעון"));
  eq("'switch' -> the summary in the other room, same slot", [sw.state.step, sw.state.studio, sw.state.date, sw.state.start, sw.state.end], ["summary", "גבעון", "2026-10-25", "12:00", "15:00"]);
  eq("…guest and note still there", [sw.state.guest, sw.state.note], ["דוד כהן", "חשוב תפאורה של הפודקאסט"]);
  ok("…said free, not the regular room", sw.body().startsWith(HE.NOTICE.slotFree("2026-10-25", "12:00", "15:00", "גבעון", false)), sw.body());
  ok("…the slot re-read fresh (2 reads)", sw.reads === 2, sw.reads);

  const other = new Chat({ busy: busyAtNoon(["חשמונאים"]) }).event(OWNER_SENTENCE).tap(FLOW_ID.otherTimes);
  eq("'other times' -> that room's hours that day", [other.state.step, other.state.studio, other.state.date], ["hour", "חשמונאים", "2026-10-25"]);
  ok("…under the reason", other.body().startsWith(HE.NOTICE.slotBusyHour("2026-10-25", "12:00", "חשמונאים", 180)), other.body());
  ok("…12:00 is not offered", !other.offered().some((o) => o.id === FLOW_ID.hour("12:00")), other.offered());
  other.tap(FLOW_ID.hour("15:00"));
  eq("an hour -> straight to the summary (guest and note given)", [other.state.step, other.state.start], ["summary", "15:00"]);

  const typed = new Chat({ busy: busyAtNoon(["חשמונאים"]) }).event(OWNER_SENTENCE).text("מה?");
  ok("typed text at the offer: the offer lapses, the hours list", typed.state.step === "hour" && !typed.state.offer && typed.last.type === "list", typed.last);
  const stale = new Chat({ busy: busyAtNoon(["חשמונאים"]) }).event(OWNER_SENTENCE).event({ type: "switch-room", studio: "TLV" });
  ok("a switch to a room not offered: stale, nothing switched", stale.state.studio === "חשמונאים" && stale.body().startsWith(HE.NOTICE.stale), stale.body());
  const late = new Chat({ busy: busyAtNoon(["חשמונאים"]) }).event(OWNER_SENTENCE).tap(FLOW_ID.otherTimes).event({ type: "switch-room", studio: "גבעון" });
  ok("a switch tap after the offer lapsed: stale", late.state.studio === "חשמונאים" && late.state.step === "hour" && late.body().startsWith(HE.NOTICE.stale), late.body());
  const backed = new Chat({ busy: busyAtNoon(["חשמונאים"]) }).event(OWNER_SENTENCE).event({ type: "back" });
  ok("'back' at the offer: the offer is gone", !backed.state.offer, backed.state);
}

console.log("\n=== 4. taken in every room at that time: the reason + that day's hours (no offer) ===");
{
  const c = new Chat({ busy: busyAtNoon(ROOMS) }).event(OWNER_SENTENCE);
  eq("the hour list of that day, the room kept", [c.state.step, c.state.date, c.state.studio, c.last.type], ["hour", "2026-10-25", "חשמונאים", "list"]);
  ok("the reason, worded for a first message (no 'עדכנתי')", c.body().startsWith(HE.NOTICE.slotBusyHour("2026-10-25", "12:00", "חשמונאים", 180)), c.body());
  ok("no offer", !c.state.offer, c.state.offer);
  eq("guest and note kept", [c.state.guest, c.state.note], ["דוד כהן", "חשוב תפאורה של הפודקאסט"]);
}

console.log("\n=== 5. the whole day is taken in that room ===");
{
  const all = new Chat({ busy: busyAllDay(ROOMS) }).event(OWNER_SENTENCE);
  eq("the other days", [all.state.step, all.state.date], ["day", null]);
  ok("…under the reason", all.body().startsWith(HE.NOTICE.slotBusyDay("2026-10-25", "חשמונאים", 180)), all.body());
  ok("…Sunday is not offered", !all.offered().some((o) => o.id === FLOW_ID.day("2026-10-25")), all.offered());
  const one = new Chat({ busy: busyAllDay(["חשמונאים"]) }).event(OWNER_SENTENCE);
  ok("only the regular room is full that day: another room is offered", one.last.type === "buttons" && one.offered()[0]?.id === FLOW_ID.switchRoom("גבעון"), one.offered());
  one.tap(FLOW_ID.otherTimes);
  ok("…'other times' = the other days, under the reason", one.state.step === "day" && one.body().startsWith(HE.NOTICE.slotBusyDay("2026-10-25", "חשמונאים", 180)), one.body());
}

console.log("\n=== 6. 'the regular room' with no regular room set ===");
{
  const c = new Chat({ defaultStudio: null }).event(OWNER_SENTENCE);
  eq("the room question", c.state.step, "studio");
  ok("…saying there is no regular room", c.body().includes(HE.NOTICE.noDefaultStudio), c.body());
  eq("the rest is remembered", [c.state.duration, c.state.guest, c.state.note, c.state.filter?.dateFrom, c.state.filter?.timeFrom], [180, "דוד כהן", "חשוב תפאורה של הפודקאסט", "2026-10-25", "12:00"]);
  c.tap(FLOW_ID.studio("גבעון"));
  ok("a room -> that day's hours from 12:00", c.state.step === "hour" && c.state.date === "2026-10-25" && c.state.hours.length > 0 && c.state.hours[0].start === "12:00", c.state);
  c.tap(FLOW_ID.hour("12:00"));
  eq("an hour -> the summary, guest and note kept", [c.state.step, c.state.guest, c.state.note], ["summary", "דוד כהן", "חשוב תפאורה של הפודקאסט"]);
  const only = new Chat({ defaultStudio: null }).event(edit([E.myRoom()]));
  ok("only 'my regular room', none set: the room question, saying why", only.state.step === "studio" && only.body().startsWith(HE.NOTICE.noDefaultStudio), only.body());
  const named = new Chat().event(edit([E.myRoom(), E.room("גבעון גדול"), E.day("2026-10-27"), E.at("10:00")]));
  eq("a room named outright wins over 'my regular room'", named.state.studio, "גבעון גדול");
  const def = new Chat().event(edit([E.myRoom(), E.day("2026-10-27")]));
  ok("'my regular room' + a day: that day's hours in the regular room", def.state.step === "hour" && def.state.studio === "חשמונאים" && def.state.date === "2026-10-27", def.state);
  ok("…the echo names it as the regular room", def.body().includes("(החדר הקבוע שלכם)"), def.body());
}

console.log("\n=== 7. what was not understood is said; an invalid value changes nothing ===");
{
  const c = new Chat().event(edit([E.day("2026-10-25"), E.myRoom(), E.at("12:00")], ["ב-4"]));
  ok("the unsure part is said under the free slot", c.body().includes(HE.QUERY.dropped(["ב-4"])), c.body());
  const bad = new Chat().event(edit([E.day("2026-10-25"), E.guest("x".repeat(500))]));
  eq("a guest too long: nothing applied, still the menu", [bad.state.step, bad.state.date, bad.state.guest], ["menu", null, null]);
  const none = new Chat().event(edit([], ["משהו"]));
  ok("nothing certain: the menu again, saying what was unclear", none.state.step === "menu" && none.body().startsWith(HE.QUERY.dropped(["משהו"])), none.body());
  const badDur = new Chat().event({ type: "edit", edits: [{ field: "duration", minutes: 120 as 90, alsoConfirm: false }], dropped: [] });
  eq("a length that is not one of the three: nothing applied", [badDur.state.step, badDur.state.duration], ["menu", null]);
}

console.log("\n=== 8. switch off / English: the menu exactly as before ===");
for (const v of [{ label: "off", freeTextOn: false, lang: "he" as const }, { label: "en", freeTextOn: true, lang: "en" as const }]) {
  const c = new Chat({ freeTextOn: v.freeTextOn, lang: v.lang });
  const before = JSON.stringify(c.state);
  c.event(OWNER_SENTENCE);
  ok(`[${v.label}] a request event at the menu: stale, nothing applied`, c.state.step === "menu" && c.state.date === null && c.body().startsWith(COPY[v.lang].NOTICE.stale), c.body());
  ok(`[${v.label}] the state is the menu state it was`, JSON.stringify({ ...c.state, notice: null }) === before, c.state);
}

console.log("\n=== 9. the held request: only the two layer events pass ===");
{
  ok("an edit passes", parsePendingEvent(OWNER_SENTENCE) !== null);
  ok("a query passes", parsePendingEvent({ type: "query", q: { studio: null, duration: 180, dateFrom: null, dateTo: null, timeFrom: null, timeTo: null, dropped: [] } }) !== null);
  for (const junk of [null, "x", [], { type: "confirm" }, { type: "edit" }, { type: "edit", edits: "x", dropped: [] }, { type: "query", q: {} }]) {
    ok(`refused: ${JSON.stringify(junk)}`, parsePendingEvent(junk) === null);
  }
}

// ── runFlow on the in-memory store ──────────────────────────────────────────
const SHOW_A: ContactShow = { showId: "11111111-1111-1111-1111-111111111111", showName: "תוכנית א", contactName: "בדיקה", defaultStudio: "חשמונאים" };
const SHOW_B: ContactShow = { showId: "22222222-2222-2222-2222-222222222222", showName: "תוכנית ב", contactName: "בדיקה", defaultStudio: null };
const ME = "972528933975";
const text = (body: string): InboundMessage =>
  ({ wamid: `w-${Math.random()}`, waId: ME, rawFrom: ME, type: "text", body, raw: null }) as InboundMessage;
const pick = (showId: string): InboundMessage =>
  ({ wamid: `w-${Math.random()}`, waId: ME, rawFrom: ME, type: "interactive", body: "x", raw: { interactive: { list_reply: { id: `show:${showId}` } } } }) as InboundMessage;
const deps: FlowDeps = {
  ensureBookingLink: (async () => ({ ok: true, token: "tok", linkId: "link-1", created: false })) as unknown as FlowDeps["ensureBookingLink"],
  submitBookingRequest: (async () => {
    throw new Error("nothing submits in this suite");
  }) as unknown as FlowDeps["submitBookingRequest"],
};
const emptyStore = () => fakeDb({ wa_conversations: [] }, { unique: [{ table: "wa_conversations", cols: ["wa_id"] }] });
const run = (db: ReturnType<typeof fakeDb>, shows: ContactShow[], message: InboundMessage, pickedShowId: string | null = null) =>
  runFlow(db.client, { waId: ME, message, shows, pickedShowId, now: NOW, baseUrl: "https://example.test", lang: "he" }, deps);
const rowOf = (db: ReturnType<typeof fakeDb>) => db.store.wa_conversations[0] as { state: FlowState; version: number; show_id: string } | undefined;

async function main() {
  const saved = { f: process.env.WHATSAPP_BOOKING_FREETEXT, a: process.env.WHATSAPP_FREETEXT_ALLOWLIST };
  process.env.WHATSAPP_FREETEXT_ALLOWLIST = "";

  console.log("\n=== 10. runFlow: the FIRST message's request is applied (layer on) ===");
  {
    process.env.WHATSAPP_BOOKING_FREETEXT = "true";
    const db = emptyStore();
    // a request that needs no availability read: a length only -> the room question
    const out = await run(db, [SHOW_A], text("3 שעות"));
    ok("not the bare menu: the room question ('as usual?')", out.kind === "send" && out.meta.flow_step === "studio-default", out);
    eq("…the length taken from the first message", rowOf(db)?.state.duration, 180);
    const hello = await run(emptyStore(), [SHOW_A], text("שלום"));
    ok("a first message with no request: the menu, as before", hello.kind === "send" && hello.meta.flow_step === "menu", hello);
  }
  {
    process.env.WHATSAPP_BOOKING_FREETEXT = "false";
    const out = await run(emptyStore(), [SHOW_A], text("3 שעות"));
    ok("switch OFF: the first message gets the menu, exactly as before", out.kind === "send" && out.meta.flow_step === "menu", out);
  }

  console.log("\n=== 11. runFlow: several podcasts — the request is held, applied after the choice ===");
  {
    process.env.WHATSAPP_BOOKING_FREETEXT = "true";
    const db = emptyStore();
    const first = await run(db, [SHOW_A, SHOW_B], text("3 שעות"));
    eq("the podcast list, saying the request is kept", first, { kind: "shows", kept: true });
    const held = rowOf(db);
    ok("the row holds the request only", !!held && held.state.awaitingShow === true && held.state.pending?.type === "query", held);
    const typed = await run(db, [SHOW_A, SHOW_B], text("נו?"));
    ok("a typed message meanwhile: still the list (the held row is not a conversation)", typed.kind === "shows", typed);
    const chosen = await run(db, [SHOW_A, SHOW_B], pick(SHOW_B.showId), SHOW_B.showId);
    ok("after the choice: the request applied to THAT podcast (no regular room -> the room list)", chosen.kind === "send" && chosen.meta.flow_step === "studio" && chosen.meta.show_id === SHOW_B.showId, chosen);
    const after = rowOf(db);
    eq("…the length from the held message, the row a normal conversation now", [after?.state.duration, after?.state.awaitingShow ?? false, after?.state.pending ?? null, after?.show_id], [180, false, null, SHOW_B.showId]);
  }
  {
    const db = emptyStore();
    await run(db, [SHOW_A, SHOW_B], text("3 שעות"));
    const row = db.store.wa_conversations[0] as { expires_at: string };
    row.expires_at = new Date(NOW.getTime() - 1000).toISOString();
    const chosen = await run(db, [SHOW_A, SHOW_B], pick(SHOW_A.showId), SHOW_A.showId);
    ok("a held request that expired is not applied: the menu", chosen.kind === "send" && chosen.meta.flow_step === "menu", chosen);
  }
  {
    const db = emptyStore();
    const first = await run(db, [SHOW_A, SHOW_B], text("שלום"));
    eq("no request in the message: the list as before, nothing held", [first, db.store.wa_conversations.length], [{ kind: "shows" }, 0]);
    process.env.WHATSAPP_BOOKING_FREETEXT = "false";
    const off = await run(db, [SHOW_A, SHOW_B], text("3 שעות"));
    eq("switch OFF: the list as before, nothing held", [off, db.store.wa_conversations.length], [{ kind: "shows" }, 0]);
  }

  process.env.WHATSAPP_BOOKING_FREETEXT = saved.f;
  process.env.WHATSAPP_FREETEXT_ALLOWLIST = saved.a;
  if (saved.f === undefined) delete process.env.WHATSAPP_BOOKING_FREETEXT;
  if (saved.a === undefined) delete process.env.WHATSAPP_FREETEXT_ALLOWLIST;

  eq("no network call was attempted", fetchCalls, 0);
  console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
