/**
 * lib/calendar/write.ts — the ONE place this codebase writes to Google
 * Calendar (feat/calendar-write, 7.10, E8). Pure where it can be (the
 * eventId, the dry-run flag) and `global.fetch`-mocked everywhere else —
 * NO real network call, NO googleapis, NO database. F19 is open; this file
 * never goes near it.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_calendar_write.ts
 *
 * ═══ WHY TWO OF THESE CHECKS READ SOURCE TEXT, NOT A RETURN VALUE ═══
 * The owner's 🔴 gate is "this code must never call events.patch/delete" —
 * that is a property of which methods the file's text calls, not of any
 * value `createCalendarEvent` could return. A mocked-fetch test can only
 * prove the paths it happens to exercise; a source read is the one check
 * that holds even for a code path nobody wrote a test for yet. Same pattern
 * as scripts/test_create_job_for_production.ts's G2 checks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import {
  isCalendarDryRun,
  calendarEventIdFor,
  createCalendarEvent,
} from "../src/lib/calendar/write";

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

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== 1. calendarEventIdFor — deterministic, base32hex, Google's length ===");
{
  const a = "0f1e2d3c-4b5a-6978-8899-aabbccddeeff";
  const b = "ffffffff-ffff-ffff-ffff-ffffffffffff";

  check("same id twice is the same string", calendarEventIdFor(a), calendarEventIdFor(a));
  check("26 characters — well inside Google's 5–1024", calendarEventIdFor(a).length, 26);
  check("only a–v and 0–9 — Google's base32hex alphabet", /^[0-9a-v]{26}$/.test(calendarEventIdFor(a)), true);
  check("a different UUID yields a different id", calendarEventIdFor(a) !== calendarEventIdFor(b), true);
  check("an all-0xff UUID still fits the alphabet", /^[0-9a-v]{26}$/.test(calendarEventIdFor(b)), true);
  check("upper-case UUID text is accepted the same as lower-case", calendarEventIdFor(a.toUpperCase()), calendarEventIdFor(a));

  let threw = false;
  try {
    calendarEventIdFor("not-a-uuid");
  } catch {
    threw = true;
  }
  check("a malformed id throws rather than silently truncating", threw, true);

  let threwShort = false;
  try {
    calendarEventIdFor("0f1e2d3c-4b5a-6978-8899-aabbccddeef"); // one hex digit short
  } catch {
    threwShort = true;
  }
  check("a UUID missing a digit throws", threwShort, true);
}

console.log("\n=== 2. isCalendarDryRun — defaults ON (rule 40, the same shape as Morning's isDryRun) ===");
{
  const saved = process.env.CALENDAR_WRITE_DRY_RUN;
  try {
    delete process.env.CALENDAR_WRITE_DRY_RUN;
    check("unset -> dry (missing env can never start writing for real)", isCalendarDryRun(), true);
    process.env.CALENDAR_WRITE_DRY_RUN = "true";
    check('"true" -> dry', isCalendarDryRun(), true);
    process.env.CALENDAR_WRITE_DRY_RUN = "anything-else";
    check("a typo -> STILL dry — only the literal \"false\" turns it off", isCalendarDryRun(), true);
    process.env.CALENDAR_WRITE_DRY_RUN = "false";
    check('the literal "false" -> real', isCalendarDryRun(), false);
  } finally {
    if (saved === undefined) delete process.env.CALENDAR_WRITE_DRY_RUN;
    else process.env.CALENDAR_WRITE_DRY_RUN = saved;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// createCalendarEvent — real control flow, `global.fetch` mocked. A real RSA
// keypair is generated once (a VALID key is required for node:crypto's
// createSign(...).sign to succeed at all) and handed to the function as the
// service-account's own key; nothing it signs is ever sent anywhere real.
// ═══════════════════════════════════════════════════════════════════════════
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

type FetchCall = { url: string; init: RequestInit | undefined };

function withMockedFetch(
  handler: (url: string, init: RequestInit | undefined, calls: FetchCall[]) => Promise<Response> | Response,
  run: (calls: FetchCall[]) => Promise<void>
): Promise<void> {
  const calls: FetchCall[] = [];
  const original = global.fetch;
  // @ts-expect-error — test double, not the real fetch signature
  global.fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls);
  };
  return run(calls).finally(() => {
    global.fetch = original;
  });
}

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

const SA_JSON = JSON.stringify({ client_email: "sa@test.iam.gserviceaccount.com", private_key: privateKey });

const jsonRes = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const INPUT = {
  eventId: "0123456789abcdefghijklmnop",
  title: "דעה לא פופולרית, אורח: דנה לוי, גבעון",
  startIso: "2026-10-20T06:00:00.000Z",
  endIso: "2026-10-20T07:30:00.000Z",
  description: "הערה",
};

async function run() {
  console.log("\n=== 3. createCalendarEvent — dry-run: ZERO network calls ===");
  await withEnv({ CALENDAR_WRITE_DRY_RUN: "true" }, async () => {
    await withMockedFetch(
      () => {
        throw new Error("fetch must not be called in a dry run");
      },
      async (calls) => {
        const result = await createCalendarEvent(INPUT);
        check("dry-run result", result, { ok: true, dryRun: true });
        check("zero fetch calls", calls.length, 0);
      }
    );
  });

  console.log("\n=== 4. createCalendarEvent — success ===");
  await withEnv(
    { CALENDAR_WRITE_DRY_RUN: "false", GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON, GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com" },
    async () => {
      await withMockedFetch(
        (url, init) => {
          if (url.includes("oauth2.googleapis.com/token")) return jsonRes(200, { access_token: "tok-123" });
          if (url.endsWith("/events") && init?.method === "POST") {
            return jsonRes(200, { id: INPUT.eventId, iCalUID: `${INPUT.eventId}@google.com`, htmlLink: "https://calendar.google.com/event?eid=abc" });
          }
          throw new Error(`unexpected fetch: ${url}`);
        },
        async (calls) => {
          const result = await createCalendarEvent(INPUT);
          check("success result", result, {
            ok: true,
            dryRun: false,
            id: INPUT.eventId,
            iCalUID: `${INPUT.eventId}@google.com`,
            htmlLink: "https://calendar.google.com/event?eid=abc",
          });
          check("exactly two calls — token, then insert", calls.length, 2);
          check("the insert carries the deterministic id", (JSON.parse(String(calls[1].init?.body)) as { id: string }).id, INPUT.eventId);
        }
      );
    }
  );

  console.log("\n=== 5. createCalendarEvent — 409 (already exists) is SUCCESS, not a conflict ===");
  await withEnv(
    { CALENDAR_WRITE_DRY_RUN: "false", GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON, GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com" },
    async () => {
      await withMockedFetch(
        (url, init) => {
          if (url.includes("oauth2.googleapis.com/token")) return jsonRes(200, { access_token: "tok-123" });
          if (url.endsWith("/events") && init?.method === "POST") return jsonRes(409, { error: "already exists" });
          if (url.endsWith(`/events/${INPUT.eventId}`)) {
            return jsonRes(200, { id: INPUT.eventId, iCalUID: `${INPUT.eventId}@google.com`, htmlLink: "https://calendar.google.com/event?eid=xyz" });
          }
          throw new Error(`unexpected fetch: ${url}`);
        },
        async (calls) => {
          const result = await createCalendarEvent(INPUT);
          check("409 reads the existing event back as a real success", result, {
            ok: true,
            dryRun: false,
            id: INPUT.eventId,
            iCalUID: `${INPUT.eventId}@google.com`,
            htmlLink: "https://calendar.google.com/event?eid=xyz",
          });
          check("three calls — token, the 409 insert, the read-back GET", calls.length, 3);
        }
      );
    }
  );

  console.log("\n=== 6. createCalendarEvent — failure (not a timeout) ===");
  await withEnv(
    { CALENDAR_WRITE_DRY_RUN: "false", GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON, GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com" },
    async () => {
      await withMockedFetch(
        (url) => {
          if (url.includes("oauth2.googleapis.com/token")) return jsonRes(200, { access_token: "tok-123" });
          return new Response("internal error", { status: 500 });
        },
        async () => {
          const result = await createCalendarEvent(INPUT);
          check("failure is reported, not thrown", result.ok, false);
          check("the status is carried through", !result.ok && result.status, 500);
        }
      );
    }
  );

  console.log("\n=== 7. createCalendarEvent — timeout is 'unknown', mapped the same way lib/morning/client.ts maps one ===");
  await withEnv(
    { CALENDAR_WRITE_DRY_RUN: "false", GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON, GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com" },
    async () => {
      await withMockedFetch(
        (url) => {
          if (url.includes("oauth2.googleapis.com/token")) return jsonRes(200, { access_token: "tok-123" });
          const err = new Error("The operation was aborted");
          err.name = "TimeoutError";
          throw err;
        },
        async () => {
          const result = await createCalendarEvent(INPUT);
          check("a timeout is reported as a failure, never thrown", result.ok, false);
          check("status 504 — 'unknown', not 'rejected'", !result.ok && result.status, 504);

          // ⚠️ the test that matters most: retrying with the EXACT SAME
          // eventId after a timeout must behave exactly like a fresh call —
          // nothing here is allowed to remember "we already tried this one"
          // and refuse a second attempt.
          const retried = await createCalendarEvent(INPUT);
          check("a retry with the same input after a timeout is attempted again, not short-circuited", retried.ok, false);
          check("and gets the same mapping", !retried.ok && retried.status, 504);
        }
      );
    }
  );

  console.log("\n=== 8. createCalendarEvent — missing GOOGLE_CALENDAR_ID is a reported failure, not a throw ===");
  await withEnv({ CALENDAR_WRITE_DRY_RUN: "false", GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON, GOOGLE_CALENDAR_ID: undefined }, async () => {
    await withMockedFetch(
      () => {
        throw new Error("fetch must not be called with no calendar id to write to");
      },
      async (calls) => {
        const result = await createCalendarEvent(INPUT);
        check("reported, not thrown", result.ok, false);
        check("zero network calls — there is nowhere to send them", calls.length, 0);
      }
    );
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 🔴 ENFORCEMENT — read the files' own text. See the header note on why a
  // mocked-fetch test cannot be the thing that guarantees this.
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n=== 9. 🔴 enforcement: this code never writes PATCH or DELETE to Google Calendar ===");
  {
    const FILES = [
      "src/lib/calendar/write.ts",
      "src/lib/booking/writeCalendarEvent.ts",
      "src/app/api/bookings/[id]/approve/route.ts",
      "src/app/api/bookings/[id]/retry-calendar/route.ts",
    ];
    const BANNED = /events\.patch|events\.delete|method:\s*["']PATCH["']|method:\s*["']DELETE["']/i;
    for (const rel of FILES) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      check(`${rel}: zero PATCH/DELETE-shaped calls`, BANNED.test(code), false);
    }
  }

  console.log("\n=== 10. 🔴 enforcement: no path to Morning or pending_documents OUTSIDE the shared creation function ===");
  {
    // The shared path IS lib/calendar/createProductionFromEvent.ts, which is
    // allowed to call enqueueDocument (lib/documents/enqueue.ts) — that is the
    // ONE door to pending_documents this whole feature is built to reuse,
    // never duplicate (owner: "לשימוש חוזר ב-POST /api/morning/clients קיים",
    // same discipline carried over from feat/client-morning-mapping).
    const FILES = [
      "src/lib/calendar/write.ts",
      "src/lib/booking/writeCalendarEvent.ts",
      "src/app/api/bookings/[id]/approve/route.ts",
      "src/app/api/bookings/[id]/retry-calendar/route.ts",
    ];
    const BANNED = /pending_documents|lib\/morning|morningRequest|issuePendingDocument/;
    for (const rel of FILES) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      check(`${rel}: zero direct Morning/pending_documents references`, BANNED.test(code), false);
    }
    // createProductionFromEvent.ts is the one file ALLOWED to import
    // enqueueDocument — confirm it does (the work-order enqueue is not
    // accidentally missing) and that it STILL never names Morning or
    // pending_documents directly.
    const shared = readFileSync(join(process.cwd(), "src/lib/calendar/createProductionFromEvent.ts"), "utf8");
    const sharedCode = shared.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    check("the shared function DOES call enqueueDocument — the work order is not silently skipped", /deps\.enqueueDocument\(/.test(sharedCode), true);
    check("…but still never names Morning or pending_documents directly", BANNED.test(sharedCode), false);
  }

  console.log(failed === 0 ? `\n✅  ${passed}/${passed} assertions passed\n` : `\n❌  ${passed}/${passed + failed} assertions passed, ${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
