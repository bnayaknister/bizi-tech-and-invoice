/**
 * B26 — the client's Google Calendar invitation after a booking.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_booking_invite.ts
 *
 * ═══ F19 ═══
 * No database, no network. The database is scripts/_fake_db.ts. Google is a
 * local `fetch` stub that answers the token and Calendar endpoints and
 * RECORDS every request; any other URL throws. Morning is an injected stub —
 * the real getClientEmails is never reached. The service-account key is
 * generated here, in memory, for this run only.
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDb, type Row } from "./_fake_db";
import {
  calendarEventIdFor,
  calendarImpersonationSubject,
  createCalendarEvent,
  deleteSystemCalendarEvent,
  inviteAttendeesBody,
  inviteAttendeesToSystemEvent,
} from "../src/lib/calendar/write";
import {
  cleanInviteEmails,
  inviteClientsToBookingEvent,
  scheduleBookingInvite,
  setInviteRunnerForTests,
  type InviteDeps,
} from "../src/lib/booking/invite";
import { writeBookingCalendarEvent } from "../src/lib/booking/writeCalendarEvent";

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

// ── a throwaway key and the Google stub ─────────────────────────────────────
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "bizi-booking@test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});
process.env.GOOGLE_CALENDAR_ID = "studio-calendar@test";

type Seen = { url: string; method: string; body: string };
let seen: Seen[] = [];
let calendarStatus = 200;
global.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
  const u = String(url);
  seen.push({ url: u, method: init?.method ?? "GET", body: String(init?.body ?? "") });
  if (u === "https://oauth2.googleapis.com/token") {
    return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
  }
  if (u.startsWith("https://www.googleapis.com/calendar/v3/")) {
    if (calendarStatus !== 200) return new Response('{"error":{"message":"Forbidden"}}', { status: calendarStatus });
    return new Response(JSON.stringify({ id: "x", iCalUID: "x@google.com", htmlLink: "https://cal/x" }), { status: 200 });
  }
  throw new Error("F19: unexpected fetch " + u);
}) as unknown as typeof fetch;

const jwtClaims = (s: Seen) => {
  const assertion = new URLSearchParams(s.body).get("assertion") ?? "";
  return JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
};

// ── the world ───────────────────────────────────────────────────────────────
const BOOKING = "233bbf8b-25db-475c-afdd-dab396b5d99d";
const EVENT_ID = calendarEventIdFor(BOOKING);
function world(over: { client?: Partial<Row>; booking?: Partial<Row>; regs?: Row[] } = {}) {
  return fakeDb(
    {
      booking_requests: [{ id: BOOKING, status: "approved", show_id: "s1", calendar_event_id: EVENT_ID, calendar_write_status: "created", ...over.booking }],
      shows: [{ id: "s1", client_id: "c1" }],
      clients: [{ id: "c1", status: "active", morning_client_id: "m1", ...over.client }],
      client_registrations: over.regs ?? [],
      events: [],
    },
    { unique: [] }
  );
}
let morningCalls = 0;
const deps = (morning: { emails: string[]; ok: boolean }): InviteDeps => ({
  getClientEmails: async () => {
    morningCalls++;
    return morning;
  },
  invite: inviteAttendeesToSystemEvent,
});
const evs = (store: Record<string, Row[]>) => store.events.map((e) => [e.event_type, (e.payload as { outcome?: string; reason?: string }).reason ?? (e.payload as { outcome?: string }).outcome]);
const patches = () => seen.filter((s) => s.method === "PATCH");

async function main() {
  process.env.CALENDAR_WRITE_DRY_RUN = "false";
  process.env.CALENDAR_INVITE_CLIENTS = "true";

  section("0. pure");
  check("emails: trimmed, lowercased, de-duplicated, malformed dropped", cleanInviteEmails([" Mali@Example.com ", "mali@example.com", "not-an-email", "b@x.co", 7, ""]), ["mali@example.com", "b@x.co"]);
  check("the PATCH body: attendees + three guest permissions off, nothing else", inviteAttendeesBody(["a@x.co"]), {
    attendees: [{ email: "a@x.co" }], guestsCanModify: false, guestsCanInviteOthers: false, guestsCanSeeOtherGuests: false,
  });

  section("1. impersonation (Domain-Wide Delegation)");
  delete process.env.GOOGLE_CALENDAR_IMPERSONATE;
  seen = [];
  await createCalendarEvent({ eventId: EVENT_ID, title: "t", startIso: "2026-10-28T11:30:00Z", endIso: "2026-10-28T13:00:00Z" });
  check("empty GOOGLE_CALENDAR_IMPERSONATE: no `sub` — the behaviour before B26", [calendarImpersonationSubject(), "sub" in jwtClaims(seen[0])], [null, false]);
  process.env.GOOGLE_CALENDAR_IMPERSONATE = " studio@bi-zi.co.il ";
  seen = [];
  await createCalendarEvent({ eventId: EVENT_ID, title: "t", startIso: "2026-10-28T11:30:00Z", endIso: "2026-10-28T13:00:00Z" });
  check("set: the JWT carries sub = that user (trimmed)", jwtClaims(seen[0]).sub, "studio@bi-zi.co.il");
  const insert = JSON.parse(seen[1].body);
  check("🔴 the INSERT is unchanged: no attendees, no sendUpdates", ["attendees" in insert, seen[1].url.includes("sendUpdates")], [false, false]);

  section("2. a client with two emails");
  {
    const { client, store } = world();
    seen = [];
    morningCalls = 0;
    const r = await inviteClientsToBookingEvent(client, BOOKING, deps({ ok: true, emails: ["mali@example.com", " Office@Example.com", "mali@example.com"] }));
    check("sent, 2 addresses, from Morning", r, { outcome: "sent", emails: 2, fromClient: 2, fromBookers: 0, clientSource: "morning", dryRun: false });
    const p = patches()[0];
    check("ONE PATCH, to this booking's own event, with sendUpdates=all", [patches().length, p?.url.endsWith(`/events/${EVENT_ID}?sendUpdates=all`)], [1, true]);
    check("…attendees + guest permissions off", JSON.parse(p.body), {
      attendees: [{ email: "mali@example.com" }, { email: "office@example.com" }],
      guestsCanModify: false, guestsCanInviteOthers: false, guestsCanSeeOtherGuests: false,
    });
    check("…the title and the description are not touched", /summary|description/.test(p.body), false);
    check("an event row: sent — and it holds the COUNT, not the addresses", [evs(store), JSON.stringify(store.events[0].payload).includes("@")], [[["booking_calendar_invite_sent", "sent"]], false]);
  }

  section("3. a client with no email");
  {
    const { client, store } = world();
    seen = [];
    const r = await inviteClientsToBookingEvent(client, BOOKING, deps({ ok: true, emails: [] }));
    check("skipped: no-email, no PATCH, logged", [r, patches().length, evs(store)], [{ outcome: "skipped", reason: "no-email" }, 0, [["booking_calendar_invite_skipped", "no-email"]]]);
  }
  {
    const { client } = world({ regs: [{ id: "r1", client_id: "c1", status: "approved", emails: ["new@client.co"], decided_at: "2026-10-12" }] });
    seen = [];
    const r = await inviteClientsToBookingEvent(client, BOOKING, deps({ ok: true, emails: [] }));
    check("/join: none in Morning yet -> the approved registration's emails", r, { outcome: "sent", emails: 1, fromClient: 1, fromBookers: 0, clientSource: "registration", dryRun: false });
  }

  section("4. Morning does not answer");
  {
    const { client, store } = world({ regs: [{ id: "r1", client_id: "c1", status: "approved", emails: ["x@y.co"], decided_at: "2026-10-12" }] });
    seen = [];
    const r = await inviteClientsToBookingEvent(client, BOOKING, deps({ ok: false, emails: [] }));
    check("failed: morning-unreachable, no PATCH (no guessing from an old copy)", [r.outcome, (r as { reason: string }).reason, patches().length], ["failed", "morning-unreachable", 0]);
    check("…logged", evs(store), [["booking_calendar_invite_failed", "morning-unreachable"]]);
    check("…the booking row is untouched", store.booking_requests[0].calendar_write_status, "created");
  }

  section("5. Google answers 403");
  {
    const { client, store } = world();
    seen = [];
    calendarStatus = 403;
    const r = await inviteClientsToBookingEvent(client, BOOKING, deps({ ok: true, emails: ["a@x.co"] }));
    calendarStatus = 200;
    check("failed: google, with the status in the error", [r.outcome, (r as { reason: string }).reason, String((r as { error: string }).error).includes("403")], ["failed", "google", true]);
    check("…logged; the event and the booking stay as they were", [evs(store), store.booking_requests[0].calendar_write_status], [[["booking_calendar_invite_failed", "google"]], "created"]);
  }

  section("6. the switch is off");
  {
    process.env.CALENDAR_INVITE_CLIENTS = "false";
    const { client, store } = world();
    seen = [];
    morningCalls = 0;
    const tasks: unknown[] = [];
    setInviteRunnerForTests((t) => tasks.push(t));
    check("nothing scheduled", scheduleBookingInvite(client, BOOKING), false);
    const r = await inviteClientsToBookingEvent(client, BOOKING, deps({ ok: true, emails: ["a@x.co"] }));
    check("…and called directly: Morning NOT called, no PATCH, no event row", [r, morningCalls, patches().length, store.events.length], [{ outcome: "skipped", reason: "switch-off" }, 0, 0, 0]);
    check("unset is off too", (delete process.env.CALENDAR_INVITE_CLIENTS, scheduleBookingInvite(client, BOOKING)), false);
    check("…zero tasks queued", tasks.length, 0);
    setInviteRunnerForTests(null);
    process.env.CALENDAR_INVITE_CLIENTS = "true";
  }

  section("7. a pending / declined booking invites nobody");
  for (const status of ["pending", "declined", "cancelled"]) {
    const { client } = world({ booking: { status } });
    seen = [];
    morningCalls = 0;
    const r = await inviteClientsToBookingEvent(client, BOOKING, deps({ ok: true, emails: ["a@x.co"] }));
    check(`${status}: skipped, Morning not called`, [r, morningCalls], [{ outcome: "skipped", reason: "not-created" }, 0]);
  }
  {
    const r = await inviteAttendeesToSystemEvent({ bookingId: BOOKING, calendarEventId: "someone-elses-event", calendarWriteStatus: "created", emails: ["a@x.co"] });
    check("the guard: an event id this code did not mint is refused before any network", r, { ok: false, refused: true, reason: "id-mismatch" });
  }

  section("8. cancel and move: the delete tells the guests");
  {
    seen = [];
    const r = await deleteSystemCalendarEvent({ bookingId: BOOKING, calendarEventId: EVENT_ID, calendarWriteStatus: "created" });
    const d = seen.find((s) => s.method === "DELETE");
    check("cancel: DELETE with sendUpdates=all", [r.ok, d?.url.endsWith(`/events/${EVENT_ID}?sendUpdates=all`)], [true, true]);
    const decide = readFileSync(join(__dirname, "..", "src/lib/booking/decide.ts"), "utf8");
    check("move: the replaced recording goes through the same removeBookingCalendarEvent", decide.includes("removeBookingCalendarEvent(admin, original"), true);
  }

  section("9. the new event of an approval / a move / a retry is scheduled for the invite");
  {
    const { client } = world();
    const tasks: (() => Promise<unknown>)[] = [];
    setInviteRunnerForTests((t) => tasks.push(t));
    seen = [];
    const w = await writeBookingCalendarEvent(client, { bookingId: BOOKING, startAtIso: "2026-10-28T11:30:00Z", endAtIso: "2026-10-28T13:00:00Z", note: null, title: "t", eventId: EVENT_ID, actorId: null });
    check("real creation: the write answers 'created' with the task only QUEUED, not awaited", [w.status, tasks.length, patches().length], ["created", 1, 0]);

    calendarStatus = 500;
    tasks.length = 0;
    const f = await writeBookingCalendarEvent(client, { bookingId: BOOKING, startAtIso: "2026-10-28T11:30:00Z", endAtIso: "2026-10-28T13:00:00Z", note: null, title: "t", eventId: EVENT_ID, actorId: null });
    calendarStatus = 200;
    check("a failed creation schedules nothing", [f.status, tasks.length], ["failed", 0]);

    process.env.CALENDAR_WRITE_DRY_RUN = "true";
    tasks.length = 0;
    const d = await writeBookingCalendarEvent(client, { bookingId: BOOKING, startAtIso: "2026-10-28T11:30:00Z", endAtIso: "2026-10-28T13:00:00Z", note: null, title: "t", eventId: EVENT_ID, actorId: null });
    process.env.CALENDAR_WRITE_DRY_RUN = "false";
    check("a calendar dry run schedules nothing (no real event to invite to)", [d.dryRun, tasks.length], [true, 0]);
    setInviteRunnerForTests(null);

    const retry = readFileSync(join(__dirname, "..", "src/app/api/bookings/[id]/retry-calendar/route.ts"), "utf8");
    const decide = readFileSync(join(__dirname, "..", "src/lib/booking/decide.ts"), "utf8");
    check("retry-calendar and the approval (incl. a move's new event) both write through writeBookingCalendarEvent", [retry.includes("writeBookingCalendarEvent("), decide.includes("writeBookingCalendarEvent(admin")], [true, true]);
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
