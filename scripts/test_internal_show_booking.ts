/**
 * E22 — booking through the bot for a show WITHOUT a client (an internal
 * production), "מורשים לקבוע הקלטות" with an optional email, and the B26
 * invitation going to the client card's emails + the bookers' emails.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_internal_show_booking.ts
 *
 * ═══ F19 ═══
 * No database, no network. The database is scripts/_fake_db.ts; Morning is an
 * injected stub that COUNTS its calls; `global.fetch` throws, so nothing can
 * reach Google, Morning or WhatsApp. WHATSAPP_DRY_RUN and
 * CALENDAR_WRITE_DRY_RUN are forced on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDb, REGISTRATION_UNIQUES, type Row } from "./_fake_db";
import { normalizeBookerEmail, validateBooker, BOOKER_ERROR } from "../src/lib/booking/bookers";
import { inviteClientsToBookingEvent, type InviteDeps } from "../src/lib/booking/invite";
import { calendarEventIdFor } from "../src/lib/calendar/write";
import { showsForNumber } from "../src/lib/booking/contacts";
import { replyToInbound } from "../src/lib/whatsapp/reply";
import { COPY } from "../src/lib/whatsapp/flow/copy";
import { autoApproveNewRequest } from "../src/lib/booking/decide";
import { buildProductionInsert } from "../src/lib/calendar/createProductionFromEvent";
import { checkEligibility } from "../src/lib/documents/enqueue";
import type { InboundMessage } from "../src/lib/whatsapp/webhook";

process.env.WHATSAPP_DRY_RUN = "true";
process.env.CALENDAR_WRITE_DRY_RUN = "true";
process.env.WHATSAPP_NOTIFY_NUMBERS = "972500000001,972500000002";
process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
delete process.env.WHATSAPP_BOOKING_FLOW;
delete process.env.WHATSAPP_BILINGUAL;
delete process.env.REGISTRATION_ENABLED;
// the approval re-reads the studio feed: a LOCAL fake calendar, empty, at a
// fake address — every other URL throws
process.env.STUDIO_ICS_URL = "https://ics.invalid/studio.ics";
global.fetch = (async (url: string) => {
  if (String(url) === process.env.STUDIO_ICS_URL) {
    return new Response("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n", { status: 200 });
  }
  throw new Error("F19: this suite must not perform any fetch: " + url);
}) as unknown as typeof fetch;

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
const section = (t: string) => console.log(`\n── ${t}`);

// ── the world: one client show, one internal show ──────────────────────────
const BOOKING = "4f1f5a9e-2b7c-4d3a-9f00-0000000000e2";
const EVENT_ID = calendarEventIdFor(BOOKING);
const HOST = "972541110001"; // books the internal show only
const BOTH = "972541110002"; // books both shows
const STRANGER = "972541119999";
const SHOW_CLIENT = { id: "s-client", name: "ואם נחיה לנצח", aliases: ["מלי אלקובי"], client_id: "c1", default_studio: "חשמונאים", billing_mode: "per_episode" };
const SHOW_INTERNAL = { id: "s-int", name: "סדרת חינוך", aliases: ["גיא ואור"], client_id: null, default_studio: "גבעון", billing_mode: "none" };

function world(over: { bookingShow?: string; contacts?: Row[]; morningId?: string | null } = {}) {
  const showOf = (id: string) => (id === "s-int" ? SHOW_INTERNAL : SHOW_CLIENT);
  const contacts: Row[] = over.contacts ?? [
    { id: "bc1", show_id: "s-int", name: "גיא", wa_id: HOST, email: "guy@host.co.il" },
    { id: "bc2", show_id: "s-int", name: "מנהלת היומן", wa_id: "972541110003", email: null },
    { id: "bc3", show_id: "s-int", name: "אור", wa_id: BOTH, email: "or@host.co.il" },
    { id: "bc4", show_id: "s-client", name: "אור", wa_id: BOTH, email: "OR@host.co.il " },
  ];
  return fakeDb(
    {
      booking_requests: [{
        id: BOOKING, status: "approved", show_id: over.bookingShow ?? "s-int", calendar_event_id: EVENT_ID, calendar_write_status: "created",
      }],
      shows: [SHOW_CLIENT, SHOW_INTERNAL].map((s) => ({ ...s })),
      clients: [{ id: "c1", status: "active", morning_client_id: over.morningId === undefined ? "m1" : over.morningId }],
      // the embed the bot's lookup reads (booking_contacts -> shows)
      booking_contacts: contacts.map((c) => ({ ...c, shows: showOf(c.show_id as string) })),
      booking_links: [],
      client_registrations: [],
      wa_messages: [],
      wa_contact_prefs: [HOST, BOTH, STRANGER].map((wa_id) => ({ wa_id, lang: "he" })),
      registration_links: [],
      events: [],
    },
    { unique: REGISTRATION_UNIQUES }
  );
}

let morningCalls = 0;
let invited: string[][] = [];
const deps = (morning: { emails: string[]; ok: boolean }): InviteDeps => ({
  getClientEmails: async () => {
    morningCalls++;
    return morning;
  },
  invite: async (input) => {
    invited.push(input.emails);
    return { ok: true, dryRun: false };
  },
});
const reset = () => {
  morningCalls = 0;
  invited = [];
};

let n = 0;
const text = (waId: string, body: string): InboundMessage => {
  n++;
  return { wamid: `wamid.E22${n}`, waId, rawFrom: waId, type: "text", body, raw: { type: "text", text: { body } } as never };
};
type Msg = Row & { wa_id: string; template_name: string | null; body: string; type: string };

async function main() {
  process.env.CALENDAR_INVITE_CLIENTS = "true";

  section("0. the booker form (pure)");
  check("email: trimmed + lowercased", normalizeBookerEmail("  Guy@Host.CO.IL "), { ok: true, email: "guy@host.co.il" });
  check("email: empty / missing -> null (optional)", [normalizeBookerEmail(""), normalizeBookerEmail(null), normalizeBookerEmail(undefined)], [{ ok: true, email: null }, { ok: true, email: null }, { ok: true, email: null }]);
  check("email: malformed -> refused, not silently dropped", normalizeBookerEmail("guy@host"), { ok: false });
  check("a valid booker: phone normalised like everywhere else (toWaId)", validateBooker({ name: " גיא  ואור ", phone: "054-111-0001", email: "" }), { ok: true, value: { name: "גיא ואור", waId: HOST, email: null } });
  check("bad email -> the error is ON the email field", validateBooker({ name: "x", phone: "0541110001", email: "nope" }), { ok: false, field: "email", error: BOOKER_ERROR.email });
  check("bad phone -> on the phone field", (validateBooker({ name: "x", phone: "12", email: "" }) as { field: string }).field, "phone");
  check("no name -> on the name field", (validateBooker({ name: " ", phone: "0541110001" }) as { field: string }).field, "name");

  section("1. who may book (the bot's lookup)");
  {
    const { client } = world();
    check("a booker of the internal show sees it — no client needed", (await showsForNumber(client, HOST)).map((s) => s.showName), ["סדרת חינוך"]);
    check("a number with two shows (client + internal) sees both, sorted", (await showsForNumber(client, BOTH)).map((s) => s.showName), ["ואם נחיה לנצח", "סדרת חינוך"]);
    check("a number that is not authorised sees nothing", await showsForNumber(client, STRANGER), []);
  }

  section("2. the bot, end to end on the reply (flow off: the booking link)");
  {
    const { client, store } = world();
    await replyToInbound(client, new Request("https://app.example/api/wa/webhook"), text(HOST, "היי"));
    const out = (store.wa_messages as Msg[]).filter((m) => m.wa_id === HOST && !m.template_name);
    check("the internal show's booker gets the booking link, like any client", /https:\/\/app\.example\/b\/[A-Za-z0-9_-]{20,}/.test(out[0]?.body ?? ""), true);
    check("…a link row was minted for the INTERNAL show", store.booking_links.map((l) => l.show_id), ["s-int"]);
    check("…and nobody was told about an unknown number", (store.wa_messages as Msg[]).filter((m) => m.template_name === "bizi_unknown_contact").length, 0);
  }
  {
    const { client, store } = world();
    await replyToInbound(client, new Request("https://app.example/api/wa/webhook"), text(BOTH, "היי"));
    const out = (store.wa_messages as Msg[]).filter((m) => m.wa_id === BOTH && !m.template_name);
    check("two shows -> the picker (an interactive list), as today", out[0]?.type, "interactive");
  }
  {
    const { client, store } = world();
    await replyToInbound(client, new Request("https://app.example/api/wa/webhook"), text(STRANGER, "היי"));
    const out = (store.wa_messages as Msg[]).filter((m) => m.wa_id === STRANGER && !m.template_name);
    check("a number that is not authorised -> the neutral sentence + the owner's notice", [out[0]?.body, (store.wa_messages as Msg[]).some((m) => m.template_name === "bizi_unknown_contact")], [COPY.he.REPLY.neutral, true]);
  }

  section("3. auto-approval for the internal show, and nothing billed");
  {
    process.env.BOOKING_AUTO_APPROVE = "true";
    const pending = "4f1f5a9e-2b7c-4d3a-9f00-0000000000a1";
    const w = fakeDb(
      {
        shows: [{ ...SHOW_INTERNAL, first_booking_needs_approval: false }],
        booking_requests: [{
          id: pending, show_id: "s-int", status: "pending", studio: "גבעון", start_at: "2026-10-20T07:00:00+00:00", end_at: "2026-10-20T08:30:00+00:00",
          guest: null, note: null, decided_at: null, shows: { name: SHOW_INTERNAL.name, aliases: SHOW_INTERNAL.aliases },
        }],
        wa_messages: [],
        events: [],
      },
      { unique: REGISTRATION_UNIQUES }
    );
    const r = await autoApproveNewRequest(w.client, {
      bookingId: pending, showId: "s-int", showName: SHOW_INTERNAL.name, dateIsrael: "2026-10-20", startIsrael: "10:00", endIsrael: "11:30",
      studio: "גבעון", guest: null, durationTag: null,
      // a FIXED clock before the request (the morning of 20.10): without it the
      // suite read the real time, and from 20.10 10:00 on the request was in the
      // past and rightly refused ("past") — a stale test, not a bug (21.10)
      now: new Date("2026-10-19T09:00:00Z"),
    });
    delete process.env.BOOKING_AUTO_APPROVE;
    check("approved automatically — like an existing client", [r.approved, w.store.booking_requests[0].status], [true, "approved"]);
    check("the calendar event was written (dry run here)", w.store.booking_requests[0].calendar_write_status, "created");
    const touched = new Set(w.calls.filter((c) => c.op !== "select").map((c) => c.table));
    check("🔴 no document, no job, no invoice, no client row touched", ["pending_documents", "jobs", "invoices", "documents", "clients"].filter((t) => touched.has(t)), []);

    const { kind } = buildProductionInsert({
      show: { id: "s-int", name: SHOW_INTERNAL.name, client_id: null, billing_mode: "none", default_studio: "גבעון", camera_count: null, default_editor_id: null, has_episode: true, reels_count: 0 },
      contractId: null, recordDate: "2026-10-20", recordTime: "10:00", studio: "גבעון", guest: null,
      calendarUid: "x@google.com", eventTitle: "גיא ואור, גבעון", source: "sync", now: new Date("2026-10-20T03:00:00Z"),
    });
    check("the morning sync's production for it is kind=internal", kind, "internal");
    const e = checkEligibility({ id: "p", show_id: "s-int", client_id: null, kind, legacy: false, price_override: null, status: "הוקלט", studio_hours: null } as never, { id: "s-int", client_id: null, billing_mode: "none", default_rate: null } as never, null);
    check("…which billing treats as not applicable (no work order, no job)", [e.ok, (e as { applicable: boolean }).applicable], [false, false]);
  }

  section("4. the invitation (B26 + E22-5)");
  {
    const { client, store } = world({ bookingShow: "s-int" });
    reset();
    const r = await inviteClientsToBookingEvent(client, BOOKING, deps({ ok: true, emails: ["never@called.co"] }));
    check("internal show: the bookers WITH an email are invited", invited, [["guy@host.co.il", "or@host.co.il"]]);
    check("…🔴 Morning is NOT called for a show without a client", morningCalls, 0);
    check("…the outcome says so", r, { outcome: "sent", emails: 2, fromClient: 0, fromBookers: 2, clientSource: "no-client", dryRun: false });
    check("…the event row carries counts, no address", JSON.stringify(store.events[0]?.payload).includes("@"), false);
  }
  {
    const { client } = world({ bookingShow: "s-int", contacts: [{ id: "bc2", show_id: "s-int", name: "מנהלת היומן", wa_id: "972541110003", email: null }] });
    reset();
    const r = await inviteClientsToBookingEvent(client, BOOKING, deps({ ok: true, emails: [] }));
    check("internal show whose only booker has no email: skipped, nothing sent, Morning not called", [r, invited.length, morningCalls], [{ outcome: "skipped", reason: "no-email" }, 0, 0]);
  }
  {
    const { client } = world({ bookingShow: "s-client" });
    reset();
    const r = await inviteClientsToBookingEvent(client, BOOKING, deps({ ok: true, emails: ["mali@client.co.il", "or@host.co.il"] }));
    check("client show: the card's emails (Morning) + the bookers', duplicates removed", invited, [["mali@client.co.il", "or@host.co.il"]]);
    check("…Morning read once", morningCalls, 1);
    check("…counted apart", [(r as { fromClient: number }).fromClient, (r as { fromBookers: number }).fromBookers, (r as { clientSource: string }).clientSource], [2, 0, "morning"]);
  }
  {
    const { client } = world({ bookingShow: "s-client", contacts: [{ id: "bc9", show_id: "s-client", name: "עוזרת", wa_id: "972541110009", email: "assistant@client.co.il" }] });
    reset();
    const r = await inviteClientsToBookingEvent(client, BOOKING, deps({ ok: true, emails: ["mali@client.co.il"] }));
    check("client show with a booker who has a different email: both invited", [invited, (r as { fromBookers: number }).fromBookers], [[["mali@client.co.il", "assistant@client.co.il"]], 1]);
  }
  {
    const { client } = world({ bookingShow: "s-client", contacts: [{ id: "bc9", show_id: "s-client", name: "עוזרת", wa_id: "972541110009", email: "assistant@client.co.il" }] });
    reset();
    const r = await inviteClientsToBookingEvent(client, BOOKING, deps({ ok: false, emails: [] }));
    check("Morning unreachable: the bookers are still invited, and the row says why the client is missing", [invited, (r as { clientSource: string }).clientSource], [[["assistant@client.co.il"]], "morning-unreachable"]);
  }
  {
    process.env.CALENDAR_INVITE_CLIENTS = "false";
    const { client } = world({ bookingShow: "s-int" });
    reset();
    const r = await inviteClientsToBookingEvent(client, BOOKING, deps({ ok: true, emails: ["x@y.co"] }));
    check("switch off: nothing, not even a read of the bookers", [r, invited.length, morningCalls], [{ outcome: "skipped", reason: "switch-off" }, 0, 0]);
    process.env.CALENDAR_INVITE_CLIENTS = "true";
  }

  section("5. who edits, and where");
  {
    const route = readFileSync(join(__dirname, "..", "src/app/api/shows/[id]/bookers/route.ts"), "utf8");
    for (const m of ["GET", "POST", "PATCH", "DELETE"]) {
      const at = route.indexOf(`export async function ${m}(`);
      const firstAwait = route.indexOf("await ", at);
      check(`${m}: the first await is the studio_admin gate`, route.slice(firstAwait, firstAwait + 12), "await gate()");
    }
    check("the gate is canManageBookingContacts (studio_admin)", route.includes("if (!canManageBookingContacts(profile))"), true);
    check("a booker is edited only inside ITS show (PATCH/DELETE check show_id)", (route.match(/\.show_id !== params\.id/g) ?? []).length, 2);
    const page = readFileSync(join(__dirname, "..", "src/app/shows/page.tsx"), "utf8");
    check("the show screen draws the card only for studio_admin", page.includes("canManageBookers={canManageBookingContacts(profile)}"), true);
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
