/**
 * lib/booking/writeCalendarEvent.ts — the shared orchestration BOTH
 * approve/route.ts and retry-calendar/route.ts call ("אותה לוגיקה", owner
 * step 4): the calendar write, the `booking_requests` columns it settles,
 * and the audit event.
 *
 * ═══ 🔴 WHAT THIS SUITE NOW GUARDS (owner correction, 7.10) ═══
 * An approval creates NO production. The feat/calendar-write prompt stated
 * "הפקה נוצרת מיד באישור (מתווה א׳)" as an owner decision; it was an
 * unapproved recommendation. Productions enter through the morning sync
 * alone, over events of THAT SAME DAY — so an approval three weeks out
 * would otherwise put a production on the board three weeks early, times
 * every future booking.
 *
 * Every success path below therefore asserts a ZERO: zero productions,
 * zero pending_documents, zero work-order enqueue, zero `production_id`
 * write. Absences are exactly what a suite that only checks return values
 * cannot see, so they are counted, and scripts/test_calendar_write.ts
 * additionally reads this file's source text.
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

// ── the fake admin: thenable at every step, every call recorded ─────────────
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
 * ⚠️ This fake answers EVERY table, including the ones a production write
 * would need (`productions`, `pending_documents`, `shows`, `clients`). That
 * is deliberate: if the production path were ever reintroduced it would run
 * happily here rather than crashing, and the zero-counts below are what
 * would catch it. A fake that threw on `productions` would turn a real
 * regression into an unrelated-looking stack trace.
 */
function makeFakeAdmin() {
  const calls: RecordedCall[] = [];

  const admin = {
    from(table: string) {
      return {
        insert(payload: unknown) {
          calls.push({ table, op: "insert", payload, filters: [] });
          if (table === "productions") return builder({ data: { id: "prod-would-be", status: "עתיד_להתחיל" }, error: null });
          if (table === "pending_documents") return builder({ data: { id: "doc-would-be" }, error: null });
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
          return builder({ data: null, error: null });
        },
      };
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

/** every table that only a production write would ever touch */
const PRODUCTION_TABLES = ["productions", "pending_documents", "stages", "contracts", "shows", "clients", "production_addons"];

function assertNoProductionWork(label: string, calls: RecordedCall[]) {
  for (const table of PRODUCTION_TABLES) {
    check(`${label}: zero ${table} calls`, calls.filter((c) => c.table === table).length, 0);
  }
  check(
    `${label}: zero production_id written to booking_requests`,
    calls.some((c) => c.table === "booking_requests" && c.op === "update" && "production_id" in (c.payload as object)),
    false
  );
  check(
    `${label}: zero calendar_created event (that is the SYNC's event, not ours)`,
    calls.some((c) => c.table === "events" && (c.payload as { event_type?: string }).event_type === "calendar_created"),
    false
  );
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

const REAL_ENV = {
  CALENDAR_WRITE_DRY_RUN: "false",
  GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON,
  GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com",
};

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

const EVENT_ID = "0123456789abcdefghijklmnop";

function inputOf(over: Partial<BookingCalendarWriteInput> = {}): BookingCalendarWriteInput {
  return {
    bookingId: "booking-1",
    startAtIso: "2026-10-20T06:00:00.000Z",
    endAtIso: "2026-10-20T07:30:00.000Z",
    note: null,
    title: "דעה לא פופולרית, אורח: דנה לוי, גבעון",
    eventId: EVENT_ID,
    actorId: "owner-1",
    ...over,
  };
}

async function run() {
  console.log("\n=== 1. success — the uid is saved, and NOTHING else happens ===");
  await withEnv(REAL_ENV, async () => {
    await withMockedFetch((url, init) => {
      if (url.includes("oauth2.googleapis.com/token")) return jsonRes(200, { access_token: "tok" });
      if (url.endsWith("/events") && init?.method === "POST") {
        return jsonRes(200, { id: EVENT_ID, iCalUID: "ical-1@google.com", htmlLink: "https://calendar.google.com/x" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }, async () => {
      const { admin, calls } = makeFakeAdmin();
      const result = await writeBookingCalendarEvent(admin, inputOf());

      check("result: created, with Google's link, no dry-run", result, {
        status: "created",
        error: null,
        htmlLink: "https://calendar.google.com/x",
        dryRun: false,
      });

      const bookingUpdates = calls.filter((c) => c.table === "booking_requests" && c.op === "update");
      check("exactly ONE booking_requests update (there is no second one for a production)", bookingUpdates.length, 1);
      check("it carries the REAL iCalUID, never the request's own id", bookingUpdates[0].payload, {
        calendar_event_uid: "ical-1@google.com",
        calendar_write_status: "created",
        calendar_write_error: null,
      });
      check("scoped to this booking", bookingUpdates[0].filters, [["id", "booking-1"]]);

      const events = calls.filter((c) => c.table === "events" && c.op === "insert");
      check("exactly ONE event", events.length, 1);
      check("entity_type 'booking_request' — never 'production'", (events[0].payload as { entity_type: string }).entity_type, "booking_request");
      check("event_type booking_calendar_event_created", (events[0].payload as { event_type: string }).event_type, "booking_calendar_event_created");

      assertNoProductionWork("success", calls);
    });
  });

  console.log("\n=== 2. 409 (already exists) — same success, still zero production ===");
  await withEnv(REAL_ENV, async () => {
    await withMockedFetch((url, init) => {
      if (url.includes("oauth2.googleapis.com/token")) return jsonRes(200, { access_token: "tok" });
      if (url.endsWith("/events") && init?.method === "POST") return jsonRes(409, { error: "exists" });
      if (url.endsWith(`/events/${EVENT_ID}`)) {
        return jsonRes(200, { id: EVENT_ID, iCalUID: "ical-2@google.com", htmlLink: "https://calendar.google.com/y" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }, async () => {
      const { admin, calls } = makeFakeAdmin();
      const result = await writeBookingCalendarEvent(admin, inputOf());
      check("409 -> created, same as a fresh insert", result.status, "created");
      check("409 -> the read-back iCalUID is the one stored", (calls.find((c) => c.table === "booking_requests")!.payload as { calendar_event_uid: string }).calendar_event_uid, "ical-2@google.com");
      assertNoProductionWork("409", calls);
    });
  });

  console.log("\n=== 3. failure — the approval stays, status='failed', zero production ===");
  await withEnv(REAL_ENV, async () => {
    await withMockedFetch((url) => {
      if (url.includes("oauth2.googleapis.com/token")) return jsonRes(200, { access_token: "tok" });
      return new Response("boom", { status: 500 });
    }, async () => {
      const { admin, calls } = makeFakeAdmin();
      const result = await writeBookingCalendarEvent(admin, inputOf());

      check("status: failed", result.status, "failed");
      check("a non-null error is carried for the owner's sentence", typeof result.error === "string" && result.error.length > 0, true);
      check("no link on a failure", result.htmlLink, null);
      check("the one booking_requests update is the failure state", calls.find((c) => c.table === "booking_requests")?.payload, {
        calendar_write_status: "failed",
        calendar_write_error: result.error,
      });
      check("🔴 the APPROVAL itself is never touched — no status/decided_at write", calls.some((c) => {
        const p = (c.payload ?? {}) as Record<string, unknown>;
        return "status" in p || "decided_at" in p || "decided_by" in p;
      }), false);
      check("the audit event is booking_calendar_event_failed, on booking_request", (() => {
        const ev = calls.find((c) => c.table === "events")!.payload as { entity_type: string; event_type: string };
        return ev.entity_type === "booking_request" && ev.event_type === "booking_calendar_event_failed";
      })(), true);
      assertNoProductionWork("failure", calls);
    });
  });

  console.log("\n=== 4. timeout — like a failure, and a retry with the SAME eventId then succeeds ===");
  await withEnv(REAL_ENV, async () => {
    const { admin, calls } = makeFakeAdmin();

    await withMockedFetch((url) => {
      if (url.includes("oauth2.googleapis.com/token")) return jsonRes(200, { access_token: "tok" });
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    }, async () => {
      const first = await writeBookingCalendarEvent(admin, inputOf());
      check("timeout -> status failed, not thrown", first.status, "failed");
      assertNoProductionWork("timeout", calls);
    });

    // the retry route re-derives the SAME deterministic eventId and calls this
    // same function again — simulated by an UNCHANGED `eventId` against a
    // server that now reports the event already exists, as it would if the
    // timed-out attempt had in fact gone through on Google's side.
    await withMockedFetch((url, init) => {
      if (url.includes("oauth2.googleapis.com/token")) return jsonRes(200, { access_token: "tok" });
      if (url.endsWith("/events") && init?.method === "POST") return jsonRes(409, { error: "exists" });
      if (url.endsWith(`/events/${EVENT_ID}`)) {
        return jsonRes(200, { id: EVENT_ID, iCalUID: "ical-3@google.com", htmlLink: "https://calendar.google.com/z" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }, async () => {
      const retried = await writeBookingCalendarEvent(admin, inputOf());
      check("retry with the SAME eventId succeeds", retried.status, "created");
      check("and still creates nothing but the event", calls.filter((c) => c.table === "productions").length, 0);
    });
  });

  console.log("\n=== 5. dry-run — zero network calls, no uid stored, zero production ===");
  await withEnv({ CALENDAR_WRITE_DRY_RUN: "true" }, async () => {
    await withMockedFetch(() => {
      throw new Error("fetch must not be called in a dry run");
    }, async () => {
      const { admin, calls } = makeFakeAdmin();
      const result = await writeBookingCalendarEvent(admin, inputOf());

      check("dry-run result", result, { status: "created", error: null, htmlLink: null, dryRun: true });
      check("the booking_requests write carries NO uid", calls.find((c) => c.table === "booking_requests")?.payload, {
        calendar_write_status: "created",
        calendar_write_error: null,
      });
      check("the audit event records dry_run:true", (calls.find((c) => c.table === "events")!.payload as { payload: { dry_run: boolean } }).payload.dry_run, true);
      assertNoProductionWork("dry-run", calls);
    });
  });

  console.log(failed === 0 ? `\n✅  ${passed}/${passed} assertions passed\n` : `\n❌  ${passed}/${passed + failed} assertions passed, ${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
