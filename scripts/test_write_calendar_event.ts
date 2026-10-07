/**
 * lib/booking/writeCalendarEvent.ts — the shared orchestration BOTH
 * approve/route.ts and retry-calendar/route.ts call ("אותה לוגיקה", owner
 * step 4): the write, the columns it settles, the two audit events, and —
 * on a real success — the production (feat/calendar-write, 7.10, E8).
 *
 * `global.fetch` is mocked (so `createCalendarEvent`'s real control flow
 * runs, exactly as scripts/test_calendar_write.ts drives it) and the
 * Supabase admin client is a hand-built fake. NO real database, NO real
 * network, NO users — F19 is open; nothing here goes near it.
 *
 * Run: npx tsx scripts/test_write_calendar_event.ts
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateKeyPairSync } from "node:crypto";
import { writeBookingCalendarEvent, type BookingCalendarWriteInput } from "../src/lib/booking/writeCalendarEvent";
import type { ShowForProductionCreate } from "../src/lib/calendar/createProductionFromEvent";

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

// ── the fake admin: thenable at every step, calls recorded ──────────────────
type RecordedCall = { table: string; op: "insert" | "update" | "select"; payload: unknown; filters: [string, unknown][] };

function builder(resolveValue: unknown) {
  const obj: Record<string, unknown> = {
    eq(_col: string, _val: unknown) {
      return obj;
    },
    select(_cols?: string) {
      return obj;
    },
    single() {
      return Promise.resolve(resolveValue);
    },
    maybeSingle() {
      return Promise.resolve(resolveValue);
    },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(resolveValue).then(resolve, reject);
    },
  };
  return obj;
}

/**
 * `writeBookingCalendarEvent` delegates straight into the REAL
 * `enqueueDocument` (no deps seam — that seam belongs only to
 * `createProductionFromEvent`, and only for `enqueueDocument` itself, see its
 * own header note). So a production this fake creates must also read back as
 * a CLEAN, eligible 'client' production through enqueueDocument's real
 * eligibility gate (scripts/test_create_job_for_production.ts's own
 * checkEligibility rules) — otherwise every "success" run here would
 * silently fall through enqueueDocument's "blocked, no show/client
 * configured" branch and write a THIRD event nobody asked for. These two
 * rows exist to make that gate pass cleanly, not to test the gate itself —
 * checkEligibility already has its own suite.
 */
function makeFakeAdmin(opts: { productionId?: string; productionStatus?: string } = {}) {
  const productionId = opts.productionId ?? "prod-xyz";
  const productionStatus = opts.productionStatus ?? "עתיד_להתחיל";
  const calls: RecordedCall[] = [];

  const SHOW_ROW = { id: "show-1", client_id: "client-1", billing_mode: "per_episode", default_rate: 1000, pricing_model: "per_episode", hourly_rate: null };
  const CLIENT_ROW = { id: "client-1", name: "לקוח בדיקה", morning_client_id: "morning-1", billing_cadence: "per_episode" };

  const admin = {
    from(table: string) {
      return {
        insert(payload: unknown) {
          calls.push({ table, op: "insert", payload, filters: [] });
          if (table === "productions") return builder({ data: { id: productionId, status: productionStatus }, error: null });
          // enqueueDocument's own insert, reached through the SAME shared
          // path (createProductionFromEvent -> deps.enqueueDocument) every
          // sync-created production already goes through — not new code
          // this feature adds, so it is not part of what the owner's "two
          // events" count below is about.
          if (table === "pending_documents") return builder({ data: { id: "doc-1" }, error: null });
          return builder({ data: null, error: null });
        },
        update(payload: unknown) {
          const rec: RecordedCall = { table, op: "update", payload, filters: [] };
          calls.push(rec);
          const chain: Record<string, unknown> = {
            eq(col: string, val: unknown) {
              rec.filters.push([col, val]);
              return chain;
            },
            then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            },
          };
          return chain;
        },
        select(_cols: string) {
          calls.push({ table, op: "select", payload: null, filters: [] });
          if (table === "shows") return builder({ data: SHOW_ROW, error: null });
          if (table === "clients") return builder({ data: CLIENT_ROW, error: null });
          // contracts (billing_mode='contract' only) and production_addons
          // (deal_invoice only) — neither path this fixture takes
          return builder({ data: null, error: null });
        },
      };
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

// ── env + fetch mocking, same shape as test_calendar_write.ts ───────────────
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const SA_JSON = JSON.stringify({ client_email: "sa@test.iam.gserviceaccount.com", private_key: privateKey });
const jsonRes = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return run().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function withMockedFetch(
  handler: (url: string, init: RequestInit | undefined) => Promise<Response> | Response,
  run: () => Promise<void>
): Promise<void> {
  const original = global.fetch;
  // @ts-expect-error — test double, not the real fetch signature
  global.fetch = async (url: string, init?: RequestInit) => handler(String(url), init);
  return run().finally(() => {
    global.fetch = original;
  });
}

const show: ShowForProductionCreate = {
  id: "show-1",
  name: "דעה לא פופולרית",
  client_id: "client-1",
  billing_mode: "per_episode",
  default_studio: "חשמונאים",
  camera_count: 2,
  default_editor_id: null,
  has_episode: true,
  reels_count: 2,
};

function inputOf(over: Partial<BookingCalendarWriteInput> = {}): BookingCalendarWriteInput {
  return {
    bookingId: "booking-1",
    showId: show.id,
    show,
    studio: "גבעון",
    startAtIso: "2026-10-20T06:00:00.000Z",
    endAtIso: "2026-10-20T07:30:00.000Z",
    guest: "דנה לוי",
    note: null,
    title: "דעה לא פופולרית, אורח: דנה לוי, גבעון",
    dateIsrael: "2026-10-20",
    eventId: "0123456789abcdefghijklmnop",
    actorId: "owner-1",
    ...over,
  };
}

async function run() {
  console.log("\n=== 1. success — calendar_uid saved, the production created exactly once, the two NEW events ===");
  await withEnv(
    { CALENDAR_WRITE_DRY_RUN: "false", GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON, GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com" },
    async () => {
      await withMockedFetch((url, init) => {
        if (url.includes("oauth2.googleapis.com/token")) return jsonRes(200, { access_token: "tok" });
        if (url.endsWith("/events") && init?.method === "POST") {
          return jsonRes(200, { id: "0123456789abcdefghijklmnop", iCalUID: "ical-1@google.com", htmlLink: "https://calendar.google.com/x" });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }, async () => {
        const { admin, calls } = makeFakeAdmin({ productionId: "prod-1" });
        const result = await writeBookingCalendarEvent(admin, inputOf());

        check("result: created", result, { status: "created", error: null, htmlLink: "https://calendar.google.com/x", dryRun: false, productionId: "prod-1" });

        const bookingUpdates = calls.filter((c) => c.table === "booking_requests" && c.op === "update");
        check("exactly two booking_requests updates — the uid/status, then the production_id", bookingUpdates.length, 2);
        check("the first carries the REAL iCalUID, never the request's own id", bookingUpdates[0].payload, {
          calendar_event_uid: "ical-1@google.com",
          calendar_write_status: "created",
          calendar_write_error: null,
        });
        check("the second carries the production id", bookingUpdates[1].payload, { production_id: "prod-1" });

        check("exactly one production insert", calls.filter((c) => c.table === "productions" && c.op === "insert").length, 1);

        const allEvents = calls.filter((c) => c.table === "events" && c.op === "insert");
        // THREE fire in total: the two this feature adds (below), plus
        // document_queued — enqueueDocument's OWN event, written through the
        // exact same deps.enqueueDocument call every sync-created production
        // already goes through (G1: this function creates a production
        // "exactly as the sync would"). That third one is not new code this
        // feature introduces, which is what the owner's "two events" in the
        // spec is counting — the two asserted by name below.
        check("three events fire — the two new ones, plus enqueueDocument's own (pre-existing, not new code)", allEvents.length, 3);

        const bookingEvents = allEvents.filter((c) => (c.payload as { entity_type: string }).entity_type === "booking_request");
        check("exactly one booking_request-scoped event", bookingEvents.length, 1);
        check("it is entity_type 'booking_request' — NEVER 'production' (G3: keeps the sync's touchedIds clean)",
          (bookingEvents[0].payload as { entity_type: string }).entity_type, "booking_request");
        check("...and event_type booking_calendar_event_created", (bookingEvents[0].payload as { event_type: string }).event_type, "booking_calendar_event_created");

        const calendarCreatedEvents = allEvents.filter((c) => (c.payload as { event_type: string }).event_type === "calendar_created");
        check("exactly ONE calendar_created event — createProductionFromEvent's own, on the production, not duplicated", calendarCreatedEvents.length, 1);
        check("it is entity_type 'production'", (calendarCreatedEvents[0].payload as { entity_type: string }).entity_type, "production");

        check("the eligibility gate passed cleanly — no billing-block event among the three", allEvents.some((e) => (e.payload as { event_type: string }).event_type === "document_enqueue_blocked"), false);
      });
    }
  );

  console.log("\n=== 2. 409 (already exists) behaves exactly like a fresh success ===");
  await withEnv(
    { CALENDAR_WRITE_DRY_RUN: "false", GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON, GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com" },
    async () => {
      await withMockedFetch((url, init) => {
        if (url.includes("oauth2.googleapis.com/token")) return jsonRes(200, { access_token: "tok" });
        if (url.endsWith("/events") && init?.method === "POST") return jsonRes(409, { error: "exists" });
        if (url.endsWith("/events/0123456789abcdefghijklmnop")) {
          return jsonRes(200, { id: "0123456789abcdefghijklmnop", iCalUID: "ical-2@google.com", htmlLink: "https://calendar.google.com/y" });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }, async () => {
        const { admin, calls } = makeFakeAdmin({ productionId: "prod-2" });
        const result = await writeBookingCalendarEvent(admin, inputOf());
        check("409 -> status created, same as a fresh insert", result.status, "created");
        check("409 -> the production is STILL created, from the read-back iCalUID", result.productionId, "prod-2");
        check("409 -> exactly one production insert, not zero and not two", calls.filter((c) => c.table === "productions" && c.op === "insert").length, 1);
      });
    }
  );

  console.log("\n=== 3. failure — the approval stays, ZERO production, status='failed' ===");
  await withEnv(
    { CALENDAR_WRITE_DRY_RUN: "false", GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON, GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com" },
    async () => {
      await withMockedFetch((url) => {
        if (url.includes("oauth2.googleapis.com/token")) return jsonRes(200, { access_token: "tok" });
        return new Response("boom", { status: 500 });
      }, async () => {
        const { admin, calls } = makeFakeAdmin();
        const result = await writeBookingCalendarEvent(admin, inputOf());

        check("status: failed", result.status, "failed");
        check("a non-null error is carried for the owner's sentence", typeof result.error === "string" && result.error.length > 0, true);
        check("zero productions created", calls.filter((c) => c.table === "productions" && c.op === "insert").length, 0);
        check("zero production_id written back", calls.some((c) => c.table === "booking_requests" && c.op === "update" && "production_id" in (c.payload as object)), false);
        check("the one booking_requests update is the failure state", calls.find((c) => c.table === "booking_requests")?.payload, {
          calendar_write_status: "failed",
          calendar_write_error: result.error,
        });
        check("the audit event is booking_calendar_event_failed, on booking_request", (() => {
          const ev = calls.find((c) => c.table === "events")!.payload as { entity_type: string; event_type: string };
          return ev.entity_type === "booking_request" && ev.event_type === "booking_calendar_event_failed";
        })(), true);
      });
    }
  );

  console.log("\n=== 4. timeout — behaves like a failure, and a RETRY with the SAME eventId then succeeds ===");
  await withEnv(
    { CALENDAR_WRITE_DRY_RUN: "false", GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON, GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com" },
    async () => {
      const { admin, calls } = makeFakeAdmin({ productionId: "prod-3" });

      await withMockedFetch((url) => {
        if (url.includes("oauth2.googleapis.com/token")) return jsonRes(200, { access_token: "tok" });
        const err = new Error("aborted");
        err.name = "TimeoutError";
        throw err;
      }, async () => {
        const first = await writeBookingCalendarEvent(admin, inputOf());
        check("timeout -> status failed, not thrown", first.status, "failed");
        check("timeout -> zero production", calls.filter((c) => c.table === "productions" && c.op === "insert").length, 0);
      });

      // the retry route re-derives the SAME deterministic eventId and calls
      // this same function again — simulated here by calling it again with
      // an UNCHANGED `eventId`, now against a server that reports the event
      // already exists (as it would if the timed-out first attempt had, in
      // fact, gone through on Google's side).
      await withMockedFetch((url, init) => {
        if (url.includes("oauth2.googleapis.com/token")) return jsonRes(200, { access_token: "tok" });
        if (url.endsWith("/events") && init?.method === "POST") return jsonRes(409, { error: "exists" });
        if (url.endsWith("/events/0123456789abcdefghijklmnop")) {
          return jsonRes(200, { id: "0123456789abcdefghijklmnop", iCalUID: "ical-3@google.com", htmlLink: "https://calendar.google.com/z" });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }, async () => {
        const retried = await writeBookingCalendarEvent(admin, inputOf());
        check("retry with the SAME eventId succeeds", retried.status, "created");
        check("retry creates the production (it never got created on the timed-out attempt)", retried.productionId, "prod-3");
      });
    }
  );

  console.log("\n=== 5. dry-run — zero network calls, zero production, the dry message, no real uid saved ===");
  await withEnv({ CALENDAR_WRITE_DRY_RUN: "true" }, async () => {
    await withMockedFetch(() => {
      throw new Error("fetch must not be called in a dry run");
    }, async () => {
      const { admin, calls } = makeFakeAdmin();
      const result = await writeBookingCalendarEvent(admin, inputOf());

      check("dry-run result", result, { status: "created", error: null, htmlLink: null, dryRun: true, productionId: null });
      check("zero productions created in dry mode", calls.filter((c) => c.table === "productions" && c.op === "insert").length, 0);
      check("the booking_requests write carries NO real uid", calls.find((c) => c.table === "booking_requests")?.payload, {
        calendar_write_status: "created",
        calendar_write_error: null,
      });
      check("the audit event records dry_run:true", (calls.find((c) => c.table === "events")!.payload as { payload: { dry_run: boolean } }).payload.dry_run, true);
    });
  });

  console.log(failed === 0 ? `\n✅  ${passed}/${passed} assertions passed\n` : `\n❌  ${passed}/${passed + failed} assertions passed, ${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
