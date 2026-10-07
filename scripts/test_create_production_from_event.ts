/**
 * lib/calendar/createProductionFromEvent.ts — the production-creation path
 * extracted out of calendar/sync/route.ts's `toCreate` loop
 * (feat/calendar-write, 7.10, gate G1). `buildProductionInsert` is pure;
 * `createProductionFromEvent` is exercised against a hand-built fake
 * Supabase client and an injected fake `enqueueDocument` — NO real database,
 * NO network, NO users. F19 is open; nothing here goes near it.
 *
 * ⚠️ THE SYNC IS THE ONLY CALLER (owner correction, 7.10). The extraction
 * was done for a second one — the booking-approval route — which was an
 * unapproved recommendation and is gone; an approval creates no production
 * (scripts/test_write_calendar_event.ts asserts that, and
 * scripts/test_calendar_write.ts enforces it on the source text). What this
 * suite still buys: the kind derivation and the studio fallback are testable
 * at all, which they were not while they lived inline in a 500-line route.
 *
 * Run: npx tsx scripts/test_create_production_from_event.ts
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildProductionInsert,
  createProductionFromEvent,
  type ProductionCreateInput,
  type ShowForProductionCreate,
} from "../src/lib/calendar/createProductionFromEvent";
import type { EnqueueResult, ProductionForBilling, ShowForBilling } from "../src/lib/documents/enqueue";

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

const NOW = new Date("2026-10-20T06:00:00.000Z");

const showOf = (over: Partial<ShowForProductionCreate> = {}): ShowForProductionCreate => ({
  id: "show-1",
  name: "דעה לא פופולרית",
  client_id: "client-1",
  billing_mode: "per_episode",
  default_studio: "חשמונאים",
  camera_count: 2,
  default_editor_id: null,
  has_episode: true,
  reels_count: 2,
  ...over,
});

const inputOf = (over: Partial<ProductionCreateInput> = {}): ProductionCreateInput => ({
  show: showOf(),
  contractId: null,
  recordDate: "2026-10-20",
  recordTime: "09:00",
  studio: "גבעון",
  guest: "דנה לוי",
  calendarUid: "uid-abc@google.com",
  eventTitle: "דעה לא פופולרית, אורח: דנה לוי, גבעון",
  source: "sync",
  now: NOW,
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== 1. buildProductionInsert — kind derivation (the SAME rule sync uses) ===");
{
  check(
    "contract billing_mode -> kind 'contract', regardless of client_id",
    buildProductionInsert(inputOf({ show: showOf({ billing_mode: "contract", client_id: null }) })).kind,
    "contract"
  );
  check(
    "per_episode + a client_id -> kind 'client'",
    buildProductionInsert(inputOf({ show: showOf({ billing_mode: "per_episode", client_id: "c1" }) })).kind,
    "client"
  );
  check(
    "per_episode with NO client_id -> kind 'internal', not 'client'",
    buildProductionInsert(inputOf({ show: showOf({ billing_mode: "per_episode", client_id: null }) })).kind,
    "internal"
  );
  check(
    "any other billing_mode -> kind 'internal'",
    buildProductionInsert(inputOf({ show: showOf({ billing_mode: "none", client_id: "c1" }) })).kind,
    "internal"
  );
  check(
    "the insert's own kind column agrees with the returned kind",
    (() => {
      const { kind, insert } = buildProductionInsert(inputOf({ show: showOf({ billing_mode: "contract" }) }));
      return kind === insert.kind;
    })(),
    true
  );
}

console.log("\n=== 2. buildProductionInsert — the studio fallback (and ONLY the studio fallback) ===");
{
  check(
    "an explicit studio wins over the show's default",
    buildProductionInsert(inputOf({ studio: "גבעון", show: showOf({ default_studio: "חשמונאים" }) })).insert.studio,
    "גבעון"
  );
  check(
    "no studio -> the show's default_studio",
    buildProductionInsert(inputOf({ studio: null, show: showOf({ default_studio: "חשמונאים" }) })).insert.studio,
    "חשמונאים"
  );
  check(
    "no studio and no default -> null, not a crash",
    buildProductionInsert(inputOf({ studio: null, show: showOf({ default_studio: null }) })).insert.studio,
    null
  );
  check(
    "record_time passes through untouched, including null (no instant to read one from)",
    buildProductionInsert(inputOf({ recordTime: null })).insert.record_time,
    null
  );
  check("guest passes through untouched", buildProductionInsert(inputOf({ guest: "דנה לוי" })).insert.guest, "דנה לוי");
  check(
    "calendar_uid is exactly the input's calendarUid — this is what G2 depends on",
    buildProductionInsert(inputOf({ calendarUid: "uid-xyz@google.com" })).insert.calendar_uid,
    "uid-xyz@google.com"
  );
  check(
    "has_episode/reels_count are copied from the show (0055) — editing the show later never touches this row",
    (() => {
      const { insert } = buildProductionInsert(inputOf({ show: showOf({ has_episode: false, reels_count: 0 }) }));
      return insert.has_episode === false && insert.reels_count === 0;
    })(),
    true
  );
  check("legacy is always false for a calendar-born production", buildProductionInsert(inputOf()).insert.legacy, false);
  check(
    "contract_id carries the caller's resolved contract (0056) — an attribution, never a charge",
    buildProductionInsert(inputOf({ contractId: "contract-9" })).insert.contract_id,
    "contract-9"
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// A minimal fake Supabase client — thenable at every step, so `.insert(x)`
// works both bare (awaited directly, as the `events` insert is) and chained
// through `.select(...).single()` (as the `productions` insert is). Calls
// are recorded so the test can assert WHAT was written and HOW OFTEN,
// without a database.
// ═══════════════════════════════════════════════════════════════════════════
type RecordedCall = { table: string; op: "insert" | "update"; payload: unknown; filters: [string, unknown][] };

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
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(resolveValue).then(resolve, reject);
    },
  };
  return obj;
}

function makeFakeAdmin(opts: { productionId?: string; productionStatus?: string } = {}) {
  const productionId = opts.productionId ?? "prod-xyz";
  const productionStatus = opts.productionStatus ?? "עתיד_להתחיל";
  const calls: RecordedCall[] = [];

  const admin = {
    from(table: string) {
      return {
        insert(payload: unknown) {
          calls.push({ table, op: "insert", payload, filters: [] });
          if (table === "productions") {
            return builder({ data: { id: productionId, status: productionStatus }, error: null });
          }
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
      };
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

function fakeEnqueue(result: EnqueueResult = { status: "queued", id: "doc-1" }) {
  const calls: { production: ProductionForBilling; docType: string }[] = [];
  const fn = async (
    _admin: SupabaseClient,
    docType: string,
    production: ProductionForBilling,
    _opts?: unknown
  ): Promise<EnqueueResult> => {
    calls.push({ production, docType });
    return result;
  };
  return { fn: fn as unknown as typeof import("../src/lib/documents/enqueue").enqueueDocument, calls };
}

async function run() {
  console.log("\n=== 3. createProductionFromEvent — the insert, the event, the enqueue, exactly once each ===");
  {
    const { admin, calls } = makeFakeAdmin({ productionId: "prod-1", productionStatus: "עתיד_להתחיל" });
    const { fn, calls: enqCalls } = fakeEnqueue();
    const result = await createProductionFromEvent(admin, inputOf(), { enqueueDocument: fn });

    check("the production id comes back from the fake insert", result.productionId, "prod-1");
    check("the status is READ BACK from the row, never re-derived", result.status, "עתיד_להתחיל");
    check("exactly one insert into productions", calls.filter((c) => c.table === "productions" && c.op === "insert").length, 1);
    check("exactly one insert into events", calls.filter((c) => c.table === "events" && c.op === "insert").length, 1);
    check(
      "the event is a calendar_created event, carrying its source",
      (() => {
        const ev = calls.find((c) => c.table === "events")!.payload as { event_type: string; payload: { source: string } };
        return ev.event_type === "calendar_created" && ev.payload.source === "sync";
      })(),
      true
    );
    check("the event's entity_type is 'production' — never 'booking_request' here (that distinction is G3's, one layer up)",
      (calls.find((c) => c.table === "events")!.payload as { entity_type: string }).entity_type, "production");
    check("enqueueDocument was called exactly once", enqCalls.length, 1);
    check("the enqueue is for 'work_order'", enqCalls[0]?.docType, "work_order");
    check(
      "the enqueued production carries the column enqueueDocument actually needs (status, for the per_hour branch)",
      enqCalls[0]?.production.status,
      "עתיד_להתחיל"
    );
    check("no stages update — this show has no default_editor_id", calls.some((c) => c.table === "stages"), false);
  }

  console.log("\n=== 4. createProductionFromEvent — 'עורך קבוע': the default editor is auto-assigned, ONLY when set ===");
  {
    const { admin, calls } = makeFakeAdmin({ productionId: "prod-2" });
    const { fn } = fakeEnqueue();
    await createProductionFromEvent(admin, inputOf({ show: showOf({ default_editor_id: "editor-7" }) }), { enqueueDocument: fn });

    const stagesCall = calls.find((c) => c.table === "stages");
    check("the stages row is updated when a default editor exists", Boolean(stagesCall), true);
    check("it is scoped to THIS production's edit step, not every step", stagesCall?.filters, [
      ["production_id", "prod-2"],
      ["step", "edit"],
    ]);
    check("the assignee is the show's default editor", (stagesCall?.payload as { assignee_id: string }).assignee_id, "editor-7");
  }

  console.log("\n=== 5. createProductionFromEvent — a production whose insert fails throws, rather than silently enqueueing nothing ===");
  {
    const admin = {
      from(table: string) {
        return {
          insert(_payload: unknown) {
            if (table === "productions") return builder({ data: null, error: { message: "boom" } });
            return builder({ data: null, error: null });
          },
        };
      },
    } as unknown as SupabaseClient;
    const { fn, calls: enqCalls } = fakeEnqueue();

    let threw = false;
    try {
      await createProductionFromEvent(admin, inputOf(), { enqueueDocument: fn });
    } catch {
      threw = true;
    }
    check("the error propagates", threw, true);
    check("nothing was enqueued for a production that was never created", enqCalls.length, 0);
  }

  console.log("\n=== 6. the extraction changed NOTHING about what the sync writes (gate G1) ===");
  {
    // The column set the sync's inline insert wrote before the extraction,
    // listed here by hand from that code. A column silently dropped by the
    // move is the one failure mode a behaviour test cannot see — every value
    // would still be "correct", just absent.
    const EXPECTED_COLUMNS = [
      "calendar_synced_at",
      "calendar_uid",
      "camera_count",
      "client_id",
      "contract_id",
      "guest",
      "has_episode",
      "kind",
      "legacy",
      "podcast_name",
      "record_date",
      "record_time",
      "reels_count",
      "show_id",
      "studio",
    ];
    const { insert } = buildProductionInsert(inputOf());
    check("exactly the columns the sync wrote inline — none added, none lost", Object.keys(insert).sort(), EXPECTED_COLUMNS);
    check("and the count is asserted too, so a rename cannot slip through as a swap", Object.keys(insert).length, EXPECTED_COLUMNS.length);

    // pure: same input, same output, no hidden clock or state
    check("pure — the same input twice gives the identical payload", buildProductionInsert(inputOf()).insert, buildProductionInsert(inputOf()).insert);
    check("`now` is the ONLY source of the timestamp — an explicit parameter, never a hidden new Date()",
      buildProductionInsert(inputOf()).insert.calendar_synced_at, NOW.toISOString());
  }

  console.log(failed === 0 ? `\n✅  ${passed}/${passed} assertions passed\n` : `\n❌  ${passed}/${passed + failed} assertions passed, ${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
