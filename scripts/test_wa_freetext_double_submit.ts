/**
 * E14 — a double submission of the same summary, through the REAL runFlow. Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_wa_freetext_double_submit.ts
 *
 * What is real: runFlow (run.ts), the machine, the free-text parser, and the
 * conversation store (store.ts — loadConversation / saveConversation and its
 * version lock). What is replaced: the database (scripts/_fake_db.ts, which
 * applies `update … where version = N` atomically like Postgres does) and the
 * two live calls a submission makes (ensureBookingLink, submitBookingRequest),
 * passed through runFlow's `deps` argument and COUNTED.
 * No network (fetch throws and is counted), no Meta, no calendar, no .env.local.
 *
 * Owner rule (20.10): two submissions of the same summary, almost at once
 * -> exactly ONE booking request.
 */
import { fakeDb } from "./_fake_db";
import { eventFromMessage, runFlow, type FlowDeps } from "../src/lib/whatsapp/flow/run";
import { FLOW_ID, expiresAtFor, reduce, start, withAvailability, type FlowState, type Transition } from "../src/lib/whatsapp/flow/machine";
import { COPY } from "../src/lib/whatsapp/flow/copy";
import type { PublicAvailability } from "../src/lib/booking/publicView";
import type { SubmitResult } from "../src/lib/booking/submit";
import type { ContactShow } from "../src/lib/booking/contacts";
import type { InboundMessage } from "../src/lib/whatsapp/webhook";

// ── no network, ever ────────────────────────────────────────────────────────
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("network is forbidden in this test");
}) as unknown as typeof fetch;

const HE = COPY.he;
const NOW = new Date("2026-10-16T10:00:00+03:00"); // Friday
const ME = "972528933975";
const OTHER = "972501234567";

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

// ── fixtures ────────────────────────────────────────────────────────────────
const SHOW: ContactShow = { showId: "11111111-1111-1111-1111-111111111111", showName: "דעה לא פופולרית", contactName: "בדיקה", defaultStudio: "גבעון" };
const ROOMS = ["גבעון גדול", "גבעון", "חשמונאים"];
const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
function FIXTURE(duration: number): PublicAvailability {
  const free = ["2026-10-18", "2026-10-19", "2026-10-20"].flatMap((d) =>
    ROOMS.flatMap((room) => {
      const out = [];
      for (let m = 9 * 60; m + duration <= 21 * 60; m += 30) out.push({ room, dateIsrael: d, startIsrael: hhmm(m), endIsrael: hhmm(m + duration) });
      return out;
    })
  );
  return { fromIsrael: "2026-10-17", toIsrael: "2026-12-10", rooms: ROOMS, durationMinutes: duration, free, refusedRooms: [] };
}

const text = (from: string, body: string): InboundMessage =>
  ({ wamid: `w-${Math.random()}`, waId: from, rawFrom: from, type: "text", body, raw: null }) as InboundMessage;
const tap = (from: string, id: string, title = "x"): InboundMessage =>
  ({ wamid: `w-${Math.random()}`, waId: from, rawFrom: from, type: "interactive", body: title, raw: { interactive: { button_reply: { id, title } } } }) as InboundMessage;

/** Reach the summary the way a free-text client does — machine + parser only, availability from the fixture. */
function summaryByFreeText(): FlowState {
  const show = { showId: SHOW.showId, showName: SHOW.showName, defaultStudio: SHOW.defaultStudio ?? null, multiShow: false, lang: "he" as const, freeTextOn: true, linkUrl: "https://example.test/b/tok" };
  let t: Transition = start(show);
  const drive = (m: InboundMessage) => {
    if (t.kind !== "reply") throw new Error("not at a reply");
    const s = t.state;
    t = reduce(s, eventFromMessage(m, { now: NOW, freeTextOn: true, step: s.step, lang: "he" }), { now: NOW });
    for (let g = 0; g < 5 && t.kind === "need-availability"; g++) t = withAvailability(t.state, FIXTURE(t.state.duration ?? 90));
    if (t.kind !== "reply") throw new Error(`unexpected ${t.kind}`);
  };
  drive(text(ME, "מה פנוי ביום שלישי אחרי 13:00 בחשמונאים?"));
  drive(tap(ME, FLOW_ID.hour("13:00")));
  drive(text(ME, "יהודה לוי"));
  drive(tap(ME, FLOW_ID.noNote));
  if (t.kind !== "reply") throw new Error("not at a reply");
  return t.state;
}

/** A fresh in-memory store holding one live conversation at `state`, version 7. */
function storeWith(waId: string, state: FlowState) {
  return fakeDb(
    {
      wa_conversations: [
        { wa_id: waId, version: 7, state, show_id: state.showId, step: state.step, updated_at: NOW.toISOString(), expires_at: expiresAtFor(NOW) },
      ],
    },
    { unique: [{ table: "wa_conversations", cols: ["wa_id"] }] }
  );
}

/** The two live calls, replaced and counted. The submit yields a tick, like a real round trip. */
function fakeDeps() {
  const submits: unknown[] = [];
  const links: string[] = [];
  const deps: FlowDeps = {
    ensureBookingLink: (async (_admin: unknown, showId: string) => {
      links.push(showId);
      return { ok: true, token: "tok", linkId: "link-1", created: false };
    }) as FlowDeps["ensureBookingLink"],
    submitBookingRequest: (async (_admin: unknown, input: { studio: string | null; startIsrael: string; endIsrael: string | null; guest: string | null }) => {
      submits.push(input);
      await new Promise((r) => setTimeout(r, 5));
      const [date, startT] = input.startIsrael.split(" ");
      const r: SubmitResult = {
        ok: true,
        duplicate: false,
        request: { id: `00000000-0000-4000-8000-${pad(submits.length).padStart(12, "0")}`, studio: input.studio!, dateIsrael: date, startIsrael: startT, endIsrael: input.endIsrael!, guest: input.guest, status: "approved" },
      };
      return r;
    }) as unknown as FlowDeps["submitBookingRequest"],
  };
  return { deps, submits, links };
}

const runOnce = (db: ReturnType<typeof fakeDb>, deps: FlowDeps, waId: string, message: InboundMessage) =>
  runFlow(db.client, { waId, message, shows: [SHOW], pickedShowId: null, now: NOW, baseUrl: "https://example.test", lang: "he" }, deps);

const savedEnv = { f: process.env.WHATSAPP_BOOKING_FREETEXT, a: process.env.WHATSAPP_FREETEXT_ALLOWLIST };

async function main() {
  process.env.WHATSAPP_BOOKING_FREETEXT = "true"; // this process only
  process.env.WHATSAPP_FREETEXT_ALLOWLIST = "0528933975";

  const summary = summaryByFreeText();
  eq("the fixture reached the summary by free text", [summary.step, summary.studio, summary.date, summary.start, summary.guest], ["summary", "חשמונאים", "2026-10-20", "13:00", "יהודה לוי"]);
  ok("…with the layer on in the state", summary.freeTextOn === true);

  console.log("\n=== 1. two taps on the same summary's ✅, delivered at once ===");
  {
    const db = storeWith(ME, summary);
    const { deps, submits } = fakeDeps();
    const [a, b] = await Promise.all([runOnce(db, deps, ME, tap(ME, FLOW_ID.confirm)), runOnce(db, deps, ME, tap(ME, FLOW_ID.confirm))]);
    const ops = db.calls.filter((c) => c.table === "wa_conversations").map((c) => c.op);
    eq("both deliveries READ version 7 before either wrote (a real race)", ops.slice(0, 2), ["select", "select"]);
    eq("exactly ONE booking request was submitted", submits.length, 1);
    eq("one delivery answers, the other is dropped", [a.kind, b.kind].sort(), ["drop", "send"]);
    const sent = [a, b].find((x) => x.kind === "send");
    ok("the answer is the outcome of that one request", !!sent && sent.kind === "send" && sent.meta.request_id === "00000000-0000-4000-8000-000000000001", sent);
    const row = db.store.wa_conversations[0] as { version: number; state: FlowState };
    eq("the stored conversation is done, version 7 -> 8 (claim) -> 9 (result)", [row.state.step, row.version], ["done", 9]);
  }

  console.log("\n=== 2. five copies of the same tap at once (Meta retries + a double tap) ===");
  {
    const db = storeWith(ME, summary);
    const { deps, submits } = fakeDeps();
    const outs = await Promise.all(Array.from({ length: 5 }, () => runOnce(db, deps, ME, tap(ME, FLOW_ID.confirm))));
    eq("still exactly ONE request", submits.length, 1);
    eq("one answer, four drops", outs.map((o) => o.kind).sort(), ["drop", "drop", "drop", "drop", "send"]);
  }

  console.log("\n=== 3. the tap + a typed 'מאשר' at the same moment ===");
  {
    const db = storeWith(ME, summary);
    const { deps, submits } = fakeDeps();
    const outs = await Promise.all([runOnce(db, deps, ME, text(ME, "מאשר")), runOnce(db, deps, ME, tap(ME, FLOW_ID.confirm))]);
    // The version lock lets exactly one of the two through, whichever writes
    // first. Here the text does (it reaches its save first), so the tap is
    // dropped: the client gets "confirm with the button" and the summary is
    // still live, so the next tap books. Never two requests, never a booking
    // from text. (Same lock as E9: any message racing a tap can win.)
    eq("NOT two requests — here none: the text won the lock", submits.length, 0);
    eq("the text was answered, the racing tap dropped", outs.map((o) => o.kind), ["send", "drop"]);
    ok("…the answer points at the button", outs[0].kind === "send" && outs[0].reply.body.includes(HE.NOTICE.confirmByButton), outs[0]);
    const row = db.store.wa_conversations[0] as { state: FlowState };
    eq("…and the summary is still live", row.state.step, "summary");
    const again = await runOnce(db, deps, ME, tap(ME, FLOW_ID.confirm));
    eq("the next tap books exactly one", [again.kind, submits.length], ["send", 1]);
  }

  console.log("\n=== 4. a late duplicate, after the first one finished ===");
  {
    const db = storeWith(ME, summary);
    const { deps, submits } = fakeDeps();
    const first = await runOnce(db, deps, ME, tap(ME, FLOW_ID.confirm));
    const second = await runOnce(db, deps, ME, tap(ME, FLOW_ID.confirm));
    eq("the first submitted", [first.kind, submits.length], ["send", 1]);
    eq("the second submits nothing", submits.length, 1);
    ok("…and is answered, not dropped (conversation already done)", second.kind === "send", second);
  }

  console.log("\n=== 5. the gate inside runFlow: a number NOT on the list gets today's bot ===");
  {
    const db = storeWith(OTHER, summary);
    const { deps, submits } = fakeDeps();
    const out = await runOnce(db, deps, OTHER, text(OTHER, "אורח: דנה"));
    const row = db.store.wa_conversations[0] as { state: FlowState };
    ok("summary text -> 'choose from the options'", out.kind === "send" && out.reply.body.includes(HE.NOTICE.pickFromList), out);
    eq("…the guest is unchanged and nothing was submitted", [row.state.guest, submits.length], ["יהודה לוי", 0]);
    eq("…and the saved state no longer has the layer on", row.state.freeTextOn, false);
  }
  {
    const db = storeWith(ME, summary);
    const { deps, submits } = fakeDeps();
    const out = await runOnce(db, deps, ME, text(ME, "אורח: דנה"));
    const row = db.store.wa_conversations[0] as { state: FlowState };
    ok("the number ON the list: the same text edits the guest", out.kind === "send" && row.state.guest === "דנה", { out, guest: row.state.guest });
    eq("…nothing submitted", submits.length, 0);
  }
  {
    process.env.WHATSAPP_BOOKING_FREETEXT = "false";
    const db = storeWith(ME, summary);
    const { deps } = fakeDeps();
    await runOnce(db, deps, ME, text(ME, "אורח: דנה"));
    const row = db.store.wa_conversations[0] as { state: FlowState };
    eq("switch off: even the listed number gets today's bot", row.state.guest, "יהודה לוי");
    process.env.WHATSAPP_BOOKING_FREETEXT = "true";
  }

  eq("no network call was attempted", fetchCalls, 0);
}

main()
  .catch((e) => {
    failed++;
    console.log(`  ❌ threw: ${e instanceof Error ? e.stack : e}`);
  })
  .finally(() => {
    if (savedEnv.f === undefined) delete process.env.WHATSAPP_BOOKING_FREETEXT;
    else process.env.WHATSAPP_BOOKING_FREETEXT = savedEnv.f;
    if (savedEnv.a === undefined) delete process.env.WHATSAPP_FREETEXT_ALLOWLIST;
    else process.env.WHATSAPP_FREETEXT_ALLOWLIST = savedEnv.a;
    console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
