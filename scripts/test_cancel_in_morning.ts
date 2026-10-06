/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ביטול מסמך במורנינג מתוך המערכת — E11.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Run:  npx tsx --tsconfig tsconfig.scripts.json scripts/test_cancel_in_morning.ts
 *
 * ⛔ F19 + THE MORNING RULE. No database, no server, no network, and **no call
 * to Morning's live API** — `closeDocument` is replaced by a fake in every
 * single test below, and the Supabase client is a recording stub. The live
 * account holds the very documents this feature acts on (EY's 40339, measured
 * 6.10) and a suite that could reach them would be a suite that could close one.
 *
 * ═══ 🔵 THE MEASUREMENT THIS WHOLE FEATURE RESTS ON ═══
 * Morning's API has no cancel endpoint. The owner measured what its UI does
 * instead: deal invoice 40339, cancelled through Morning's own interface, came
 * back at **status 2 — "נסגר ידנית"** with no credit note. So `close` is the
 * same operation, not an approximation. That is why this exists, and it is also
 * the boundary: for 305/320/400 a cancellation is a credit note (330), and those
 * types are refused.
 *
 * SECTIONS
 *   1. the gates — what may never reach Morning at all
 *   2. the live tax child, and the parent_relation trap 0075 warns about
 *   3. "already closed" — decided on OUR status, conservatively
 *   4. the local effect: success / failure / timeout / dryRun
 *   5. the chain — the offer, its conditions, and the gated order
 *   6. the copy, verbatim
 *   7. regression: the OLD route still does exactly what it did
 *   8. enforcement — the suite itself may not reach Morning
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BTN_CANCEL_IN_MORNING,
  BTN_MARK_LOCALLY,
  CHAIN_BOTH,
  CHAIN_DISMISS,
  CHAIN_ONLY_DEAL,
  CHAIN_QUESTION,
  LIVE_TAX_CHILD_TYPES,
  MSG_DRY_RUN,
  MSG_SUCCESS,
  MSG_TIMEOUT,
  MORNING_CANCELLABLE_TYPES,
  REASON_LABEL,
  TAX_CHILD_REFUSAL,
  WINDOW_BODY,
  alreadyClosedIsSuccess,
  cancelBothOrder,
  cancelDocumentLocally,
  hasLiveTaxChild,
  jobBlocksCancel,
  msgFailed,
  offersMorningCancel,
  parentWorkOrderFor,
  windowTitle,
  type ChainRow,
  type TaxChildRow,
} from "../src/lib/documents/cancelLocal";

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail?: string) {
  checks++;
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = join(__dirname, "..");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// ═══════════════════════════════════════════════════════════════════════════
// THE STUBS. A recording Supabase client, and a fake Morning.
// ═══════════════════════════════════════════════════════════════════════════
type Op = { table: string; verb: string; payload?: unknown };

/**
 * Enough of the supabase-js chain for `cancelDocumentLocally` to run, recording
 * every table and verb it touches in order.
 *
 * ⚠️ IT RECORDS RATHER THAN SIMULATES. The assertions below are about WHAT the
 * function writes and in what order — not about what Postgres would answer —
 * because the thing that can regress is a forgotten write, and a forgotten write
 * is visible exactly here.
 */
function makeAdmin(opts: { job?: { id: string; invoice_biz: string | null } | null; invoicesDeleted?: number; queueReleased?: string[] } = {}) {
  const ops: Op[] = [];
  const api = {
    from(table: string) {
      const chain = {
        _filters: {} as Record<string, unknown>,
        select(_cols?: string) {
          return chain;
        },
        eq(k: string, v: unknown) {
          chain._filters[k] = v;
          return chain;
        },
        async maybeSingle() {
          if (table === "jobs") return { data: opts.job ?? null };
          return { data: null };
        },
        update(payload: unknown): unknown {
          ops.push({ table, verb: "update", payload });
          return {
            eq: () => ({
              eq: () => ({
                select: async () => ({ data: (opts.queueReleased ?? []).map((id) => ({ id })) }),
              }),
              select: async () => ({ data: (opts.queueReleased ?? []).map((id) => ({ id })) }),
              then: undefined,
            }),
          };
        },
        delete(): unknown {
          ops.push({ table, verb: "delete" });
          return {
            eq: () => ({
              select: async () => ({
                data: Array.from({ length: opts.invoicesDeleted ?? 0 }, (_, i) => ({ id: `inv-${i}` })),
              }),
            }),
          };
        },
        async insert(payload: unknown) {
          ops.push({ table, verb: "insert", payload });
          return { data: null, error: null };
        },
      };
      return chain;
    },
    ops,
  };
  return api;
}

/** The fake Morning. `mode` is what the route would see. */
type CloseMode = { kind: "ok" } | { kind: "dryRun" } | { kind: "fail"; status: number; message: string } | { kind: "timeout" };
function makeCloseDocument(mode: CloseMode) {
  const calls: string[] = [];
  const fn = async (morningDocId: string): Promise<{ dryRun: boolean }> => {
    calls.push(morningDocId);
    if (mode.kind === "dryRun") return { dryRun: true };
    if (mode.kind === "ok") return { dryRun: false };
    if (mode.kind === "timeout") {
      const e = new Error("מורנינג לא הגיב בזמן") as Error & { status: number };
      e.status = 504;
      throw e;
    }
    const e = new Error(mode.message) as Error & { status: number };
    e.status = mode.status;
    throw e;
  };
  return { fn, calls };
}

/**
 * The route's decision logic, re-expressed over the injected pieces.
 *
 * ⚠️ THIS IS A MODEL OF THE ROUTE, NOT THE ROUTE. The route is an HTTP handler
 * that reads `createClient()` and `createAdminClient()` from module scope, so it
 * cannot be called without a server and a database — F19 forbids both. What is
 * asserted here is the ORDER and the BRANCHING, which is where the money risk
 * is; section 8 then pins the route's text so the model and the code cannot
 * silently diverge on the facts that matter (local write only after a successful
 * close, the four event names, the 504 branch).
 */
async function runRoute(input: {
  doc: { id: string; type: number; source: string | null; cancelled_at: string | null; status: number | null; morning_doc_id: string | null; morning_doc_number: string | null; job_id: string | null };
  close: (id: string) => Promise<{ dryRun: boolean }>;
  admin: ReturnType<typeof makeAdmin>;
  taxChildren?: TaxChildRow[];
  job?: { invoice_tax?: string | null } | null;
}): Promise<{ status: number; error?: string; ok?: boolean; dryRun?: boolean; events: string[] }> {
  const events: string[] = [];
  const d = input.doc;
  if (d.source !== "app") return { status: 400, error: "source", events };
  if (!MORNING_CANCELLABLE_TYPES.includes(d.type as (typeof MORNING_CANCELLABLE_TYPES)[number])) {
    return { status: 400, error: "type", events };
  }
  if (d.cancelled_at) return { status: 409, error: "already cancelled", events };
  if (!d.morning_doc_id) return { status: 400, error: "no morning id", events };
  if (d.type === 300) {
    if (hasLiveTaxChild(d.morning_doc_number, input.taxChildren ?? [])) {
      return { status: 409, error: TAX_CHILD_REFUSAL, events };
    }
    if (jobBlocksCancel(input.job)) return { status: 409, error: TAX_CHILD_REFUSAL, events };
  }

  events.push("morning_cancel_requested");
  let dryRun = false;
  try {
    const r = await input.close(d.morning_doc_id);
    dryRun = r.dryRun;
  } catch (e) {
    const status = (e as { status?: number }).status ?? 0;
    const message = (e as Error).message;
    if (status === 504) {
      events.push("morning_cancel_unknown");
      return { status: 504, error: message, events };
    }
    if (!alreadyClosedIsSuccess(d.status)) {
      events.push("morning_cancel_failed");
      return { status: 502, error: message, events };
    }
    events.push("morning_cancel_already_closed");
  }

  await cancelDocumentLocally(
    input.admin as never,
    {
      id: d.id,
      morning_doc_id: d.morning_doc_id,
      morning_doc_number: d.morning_doc_number,
      type: d.type,
      job_id: d.job_id,
    },
    { userId: "u1", reason: "טעות במחיר", cancelledAt: "2026-10-06T09:00:00.000Z" }
  );
  events.push("morning_cancel_succeeded");
  return { status: 200, ok: true, dryRun, events };
}

const DEAL = {
  id: "d-300",
  type: 300,
  source: "app",
  cancelled_at: null,
  status: 0 as number | null,
  morning_doc_id: "m-300",
  morning_doc_number: "40339",
  job_id: "j1",
};

/**
 * Wrapped in a main() because tsx compiles this suite to CJS, where top-level
 * await is not available — and most assertions here are about the ORDER of
 * awaited calls, so they cannot be made synchronous.
 */
async function main() {
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n=== 1. השערים — מה לא מגיע למורנינג בכלל ===");
  {
    const close = makeCloseDocument({ kind: "ok" });
    const r = await runRoute({ doc: { ...DEAL, source: "pull" }, close: close.fn, admin: makeAdmin() });
    check("source='pull' → נדחה", r.status === 400, String(r.status));
    check("  ...ו-closeDocument לא נקרא אף פעם", close.calls.length === 0, String(close.calls.length));
    check("  ...ואף אירוע לא נכתב", r.events.length === 0, r.events.join(","));
  }
  {
    const close = makeCloseDocument({ kind: "ok" });
    const r = await runRoute({ doc: { ...DEAL, type: 305 }, close: close.fn, admin: makeAdmin() });
    check("type 305 → נדחה", r.status === 400, String(r.status));
    check("  ...ו-closeDocument לא נקרא", close.calls.length === 0);
  }
  for (const t of [320, 400, 330, 10]) {
    const close = makeCloseDocument({ kind: "ok" });
    const r = await runRoute({ doc: { ...DEAL, type: t }, close: close.fn, admin: makeAdmin() });
    check(`type ${t} → נדחה, בלי קריאה למורנינג`, r.status === 400 && close.calls.length === 0);
  }
  for (const t of [100, 300]) {
    const close = makeCloseDocument({ kind: "ok" });
    const r = await runRoute({ doc: { ...DEAL, type: t }, close: close.fn, admin: makeAdmin() });
    check(`type ${t} → מותר`, r.status === 200 && close.calls.length === 1);
  }
  {
    const close = makeCloseDocument({ kind: "ok" });
    const r = await runRoute({ doc: { ...DEAL, cancelled_at: "2026-10-01" }, close: close.fn, admin: makeAdmin() });
    check("מסמך שכבר מבוטל אצלנו → 409, בלי קריאה", r.status === 409 && close.calls.length === 0);
  }
  {
    const close = makeCloseDocument({ kind: "ok" });
    const r = await runRoute({ doc: { ...DEAL, morning_doc_id: null }, close: close.fn, admin: makeAdmin() });
    check("בלי morning_doc_id → נדחה, בלי קריאה", r.status === 400 && close.calls.length === 0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n=== 2. מסמך מס חי, והמלכודת ש-0075 מזהירה עליה ===");
  {
    const live: TaxChildRow = { type: 305, cancelled_at: null, parent_doc_numbers: ["40339"], parent_relation: "derived" };
    const close = makeCloseDocument({ kind: "ok" });
    const r = await runRoute({ doc: DEAL, close: close.fn, admin: makeAdmin(), taxChildren: [live] });
    check("300 עם 305 חי → נדחה", r.status === 409, String(r.status));
    check("  ...בנוסח המאושר", r.error === TAX_CHILD_REFUSAL, r.error);
    check("  ...ו-closeDocument לא נקרא", close.calls.length === 0);
    check("  ...ואף אירוע לא נכתב", r.events.length === 0);
  }
  {
    // 🔴 THE TRAP. A 400 that CANCELS a tax receipt carries the number in exactly
    // the same place. parent_relation is the only thing that tells them apart, and
    // without it the refusal would fire on the document that is now free.
    const cancellation: TaxChildRow = {
      type: 305,
      cancelled_at: null,
      parent_doc_numbers: ["40339"],
      parent_relation: "cancellation",
    };
    check(
      "🔴 parent_relation='cancellation' אינו חוסם — זו המלכודת של 0075",
      !hasLiveTaxChild("40339", [cancellation])
    );
    const close = makeCloseDocument({ kind: "ok" });
    const r = await runRoute({ doc: DEAL, close: close.fn, admin: makeAdmin(), taxChildren: [cancellation] });
    check("  ...ולכן הביטול מתאפשר", r.status === 200 && close.calls.length === 1);
  }
  {
    const cancelledChild: TaxChildRow = {
      type: 305,
      cancelled_at: "2026-10-02",
      parent_doc_numbers: ["40339"],
      parent_relation: "derived",
    };
    check("305 שבוטל בעצמו אינו חוסם", !hasLiveTaxChild("40339", [cancelledChild]));
  }
  {
    const otherDoc: TaxChildRow = { type: 305, cancelled_at: null, parent_doc_numbers: ["40300"], parent_relation: "derived" };
    check("305 של מסמך אחר אינו חוסם", !hasLiveTaxChild("40339", [otherDoc]));
  }
  {
    const r400: TaxChildRow = { type: 400, cancelled_at: null, parent_doc_numbers: ["40339"], parent_relation: "derived" };
    check("400 (קבלה) אינו חוסם — זה תשלום, לא חיוב", !hasLiveTaxChild("40339", [r400]));
    check("  ...והטיפוסים החוסמים הם 305 ו-320 בלבד", LIVE_TAX_CHILD_TYPES.join(",") === "305,320");
  }
  {
    const r320: TaxChildRow = { type: 320, cancelled_at: null, parent_doc_numbers: ["40339"], parent_relation: "derived" };
    check("320 חוסם", hasLiveTaxChild("40339", [r320]));
  }
  check("מסמך בלי מספר — אין על מה להצטרף, לא חוסם", !hasLiveTaxChild(null, []));
  check("מספר ריק אחרי trim — לא חוסם", !hasLiveTaxChild("   ", []));
  // the job-side half
  check("jobs.invoice_tax מוגדר → חוסם", jobBlocksCancel({ invoice_tax: "50070" }));
  check("jobs.invoice_tax ריק → אינו חוסם", !jobBlocksCancel({ invoice_tax: "" }));
  check("jobs.invoice_tax null → אינו חוסם", !jobBlocksCancel({ invoice_tax: null }));
  check("אין job בכלל → אינו חוסם", !jobBlocksCancel(null));
  {
    const close = makeCloseDocument({ kind: "ok" });
    const r = await runRoute({ doc: DEAL, close: close.fn, admin: makeAdmin(), job: { invoice_tax: "50070" } });
    check("300 שה-job שלו נושא invoice_tax → נדחה בנוסח המאושר", r.status === 409 && r.error === TAX_CHILD_REFUSAL);
    check("  ...בלי קריאה למורנינג", close.calls.length === 0);
  }
  {
    // a WORK ORDER is not asked the tax question at all — it can have no tax child
    const close = makeCloseDocument({ kind: "ok" });
    const live: TaxChildRow = { type: 305, cancelled_at: null, parent_doc_numbers: ["10339"], parent_relation: "derived" };
    const r = await runRoute({
      doc: { ...DEAL, type: 100, morning_doc_number: "10339" },
      close: close.fn,
      admin: makeAdmin(),
      taxChildren: [live],
      job: { invoice_tax: "50070" },
    });
    check("100 אינו נשאל על מסמך מס — הוא עובר", r.status === 200 && close.calls.length === 1);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n=== 3. \"כבר סגור\" — מוכרע לפי ה-status שלנו, בכיוון השמרני ===");
  check("status 1 (נסגר אוטומטית) → כבר-סגור נחשב הצלחה", alreadyClosedIsSuccess(1));
  check("status 2 (נסגר ידנית) → הצלחה", alreadyClosedIsSuccess(2));
  check("status 0 (פתוח) → לא הצלחה", !alreadyClosedIsSuccess(0));
  check("🔴 status null → לא הצלחה: null הוא 'לא ידוע', לא 'סגור'", !alreadyClosedIsSuccess(null));
  check("status undefined → לא הצלחה", !alreadyClosedIsSuccess(undefined));
  check("status 4 (בוטל) → לא נחשב להצלחה כאן", !alreadyClosedIsSuccess(4));
  {
    const close = makeCloseDocument({ kind: "fail", status: 409, message: "document already closed" });
    const admin = makeAdmin();
    const r = await runRoute({ doc: { ...DEAL, status: 2 }, close: close.fn, admin });
    check("כשל + status 2 אצלנו → ממשיך לעדכון המקומי", r.status === 200, String(r.status));
    check("  ...ורושם already_closed ולא failed", r.events.includes("morning_cancel_already_closed") && !r.events.includes("morning_cancel_failed"));
    check("  ...והעדכון המקומי אכן רץ", admin.ops.some((o) => o.table === "documents" && o.verb === "update"));
  }
  {
    const close = makeCloseDocument({ kind: "fail", status: 409, message: "document already closed" });
    const admin = makeAdmin();
    const r = await runRoute({ doc: { ...DEAL, status: 0 }, close: close.fn, admin });
    check("🔴 אותו כשל + status 0 אצלנו → נכשל, לא מנחש", r.status === 502, String(r.status));
    check("  ...ואפס עדכון מקומי", admin.ops.length === 0, String(admin.ops.length));
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n=== 4. האפקט המקומי: הצלחה / כשל / timeout / dryRun ===");
  {
    const close = makeCloseDocument({ kind: "ok" });
    const admin = makeAdmin({ job: { id: "j1", invoice_biz: "40339" }, invoicesDeleted: 1, queueReleased: ["q1"] });
    const r = await runRoute({ doc: DEAL, close: close.fn, admin });
    check("הצלחה → 200", r.status === 200);
    check("  ...closeDocument נקרא פעם אחת בדיוק", close.calls.length === 1, String(close.calls.length));
    const docUpdates = admin.ops.filter((o) => o.table === "documents" && o.verb === "update");
    check("  🔴 העדכון המקומי של documents רץ פעם אחת בדיוק", docUpdates.length === 1, String(docUpdates.length));
    check("  ...jobs.invoice_biz נוקה", admin.ops.some((o) => o.table === "jobs" && o.verb === "update"));
    check("  ...שורת invoices נמחקה", admin.ops.some((o) => o.table === "invoices" && o.verb === "delete"));
    check("  ...שורת התור שוחררה", admin.ops.some((o) => o.table === "pending_documents" && o.verb === "update"));
    check("  🔴 שני אירועים: requested ואז succeeded", r.events.join(",") === "morning_cancel_requested,morning_cancel_succeeded", r.events.join(","));
    check("  ...וה-requested קודם לקריאה", r.events[0] === "morning_cancel_requested");
  }
  {
    const close = makeCloseDocument({ kind: "fail", status: 400, message: "לא ניתן לסגור" });
    const admin = makeAdmin({ job: { id: "j1", invoice_biz: "40339" }, invoicesDeleted: 1, queueReleased: ["q1"] });
    const r = await runRoute({ doc: DEAL, close: close.fn, admin });
    check("כשל → 502", r.status === 502, String(r.status));
    check("  🔴 אפס עדכון מקומי — אף טבלה לא נגעה", admin.ops.length === 0, JSON.stringify(admin.ops.map((o) => o.table)));
    check("  ...אירוע failed", r.events.includes("morning_cancel_failed"));
    check("  ...ובלי succeeded", !r.events.includes("morning_cancel_succeeded"));
    check("  ...והשגיאה של מורנינג נשמרת", r.error === "לא ניתן לסגור", r.error);
  }
  {
    const close = makeCloseDocument({ kind: "timeout" });
    const admin = makeAdmin({ job: { id: "j1", invoice_biz: "40339" }, invoicesDeleted: 1, queueReleased: ["q1"] });
    const r = await runRoute({ doc: DEAL, close: close.fn, admin });
    check("timeout → 504", r.status === 504, String(r.status));
    check("  🔴 אפס עדכון מקומי", admin.ops.length === 0);
    check("  ...אירוע unknown ולא failed", r.events.includes("morning_cancel_unknown") && !r.events.includes("morning_cancel_failed"));
    check("  ...ובלי succeeded", !r.events.includes("morning_cancel_succeeded"));
  }
  {
    const close = makeCloseDocument({ kind: "dryRun" });
    const admin = makeAdmin({ job: { id: "j1", invoice_biz: "40339" }, invoicesDeleted: 1, queueReleased: ["q1"] });
    const r = await runRoute({ doc: DEAL, close: close.fn, admin });
    check("dryRun → 200", r.status === 200);
    check("  ...והעדכון המקומי כן רץ", admin.ops.some((o) => o.table === "documents" && o.verb === "update"));
    check("  ...ו-dryRun מדווח כדי שהמסך יאמר זאת", r.dryRun === true);
    check("  ...ושני האירועים נכתבו", r.events.join(",") === "morning_cancel_requested,morning_cancel_succeeded");
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n=== 5. השרשרת — ההצעה, תנאיה, והסדר המגודר ===");
  const dealRow: ChainRow = {
    id: "d-300",
    type: 300,
    source: "app",
    morning_doc_number: "40339",
    parent_doc_numbers: ["10339"],
    parent_relation: "derived",
    cancelled_at: null,
  };
  const woRow: ChainRow = {
    id: "d-100",
    type: 100,
    source: "app",
    morning_doc_number: "10339",
    parent_doc_numbers: null,
    parent_relation: null,
    cancelled_at: null,
  };
  check("300 שנגזר מ-100 → ההורה מוצע", parentWorkOrderFor(dealRow, [dealRow, woRow])?.id === "d-100");
  check("  ...והסדר הוא 300 ואז 100", cancelBothOrder(dealRow, woRow).join(",") === "d-300,d-100");
  check(
    "parent_relation='cancellation' → לא מוצע",
    parentWorkOrderFor({ ...dealRow, parent_relation: "cancellation" }, [dealRow, woRow]) === null
  );
  check(
    "הורה שאינו מהמערכת (source='pull') → לא מוצע",
    parentWorkOrderFor(dealRow, [dealRow, { ...woRow, source: "pull" }]) === null
  );
  check(
    "הורה שכבר מבוטל → לא מוצע",
    parentWorkOrderFor(dealRow, [dealRow, { ...woRow, cancelled_at: "2026-10-01" }]) === null
  );
  check("בלי parent_doc_numbers → לא מוצע", parentWorkOrderFor({ ...dealRow, parent_doc_numbers: null }, [dealRow, woRow]) === null);
  check("ההורה אינו בטבלה → לא מוצע", parentWorkOrderFor(dealRow, [dealRow]) === null);
  check("100 עצמו אינו מציע הורה", parentWorkOrderFor(woRow, [dealRow, woRow]) === null);
  check(
    "שני הורים 100 תואמים → לא מוצע, כי 'איזה מהם' אינה שאלה לדיאלוג",
    parentWorkOrderFor({ ...dealRow, parent_doc_numbers: ["10339", "10340"] }, [
      dealRow,
      woRow,
      { ...woRow, id: "d-100b", morning_doc_number: "10340" },
    ]) === null
  );
  {
    // 🔴 "בטל את שניהם": ה-300 נכשל → ה-100 לא נוגע
    const close = makeCloseDocument({ kind: "fail", status: 400, message: "סירוב" });
    const adminDeal = makeAdmin();
    const adminWo = makeAdmin();
    const first = await runRoute({ doc: DEAL, close: close.fn, admin: adminDeal });
    const second = first.ok
      ? await runRoute({ doc: { ...DEAL, id: "d-100", type: 100, morning_doc_id: "m-100" }, close: close.fn, admin: adminWo })
      : null;
    check("🔴 שרשרת: ה-300 נכשל", !first.ok);
    check("  ...ולכן ה-100 לא נוגע בכלל", second === null);
    check("  ...ואפס עדכון מקומי על שניהם", adminDeal.ops.length === 0 && adminWo.ops.length === 0);
    check("  ...ו-closeDocument נקרא פעם אחת בלבד", close.calls.length === 1, String(close.calls.length));
  }
  {
    // ההצלחה המלאה: שניהם
    const close = makeCloseDocument({ kind: "ok" });
    const adminDeal = makeAdmin({ job: { id: "j1", invoice_biz: "40339" } });
    const adminWo = makeAdmin();
    const first = await runRoute({ doc: DEAL, close: close.fn, admin: adminDeal });
    const second = first.ok
      ? await runRoute({ doc: { ...DEAL, id: "d-100", type: 100, morning_doc_id: "m-100", job_id: null }, close: close.fn, admin: adminWo })
      : null;
    check("שרשרת מוצלחת: שני המסמכים נסגרו", first.ok === true && second?.ok === true);
    check("  ...ו-closeDocument נקרא פעמיים, בסדר הזה", close.calls.join(",") === "m-300,m-100", close.calls.join(","));
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n=== 6. הנוסחים, מילה במילה ===");
  check("כפתור חדש", BTN_CANCEL_IN_MORNING === "בטל במורנינג", BTN_CANCEL_IN_MORNING);
  check("כפתור קיים", BTN_MARK_LOCALLY === "סמן כמבוטל אצלנו", BTN_MARK_LOCALLY);
  check("כותרת — חשבון עסקה", windowTitle(300, "40339") === "ביטול חשבון העסקה 40339 במורנינג", windowTitle(300, "40339"));
  check("כותרת — הזמנת עבודה", windowTitle(100, "10339") === "ביטול הזמנת העבודה 10339 במורנינג", windowTitle(100, "10339"));
  check(
    "גוף החלון",
    WINDOW_BODY ===
      "הפעולה תסגור את המסמך במורנינג ואז תסמן אותו כמבוטל גם אצלנו. אם הסגירה במורנינג תיכשל — שום דבר לא ישתנה אצלנו."
  );
  check("שדה סיבה", REASON_LABEL === "סיבת הביטול (חובה)", REASON_LABEL);
  check(
    "שאלת השרשרת",
    CHAIN_QUESTION("10339") === "חשבון העסקה נגזר מהזמנת עבודה 10339. לבטל גם אותה?",
    CHAIN_QUESTION("10339")
  );
  check("כפתורי השרשרת", [CHAIN_BOTH, CHAIN_ONLY_DEAL, CHAIN_DISMISS].join(" / ") === "בטל את שניהם / בטל רק את חשבון העסקה / ביטול");
  check(
    "סירוב מסמך מס",
    TAX_CHILD_REFUSAL === "על המסמך הזה כבר יצאה חשבונית מס, ולכן אי אפשר לבטל אותו. צריך להוציא חשבונית זיכוי במורנינג."
  );
  {
    // read as VALUES now, not as text in the route: a Next.js route may not
    // export extra constants (next build refuses it, tsc does not), so the copy
    // lives in cancelLocal.ts beside the rest of it.
    check("הצלחה", MSG_SUCCESS === "המסמך נסגר במורנינג וסומן כמבוטל.", MSG_SUCCESS);
    check("DRY_RUN", MSG_DRY_RUN === "מצב בדיקה — המסמך לא נסגר במורנינג, רק סומן אצלנו.", MSG_DRY_RUN);
    check(
      "timeout",
      MSG_TIMEOUT ===
        "מורנינג לא הגיב תוך 15 שניות — לא ידוע אם המסמך נסגר. בדקו במורנינג לפני ניסיון חוזר. לא בוצע שום שינוי אצלנו.",
      MSG_TIMEOUT
    );
    check(
      "כשל",
      msgFailed("סירוב") === "הסגירה במורנינג נכשלה — סירוב. לא בוצע שום שינוי אצלנו.",
      msgFailed("סירוב")
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n=== 7. רגרסיה: הראוט הישן מתנהג בדיוק כמו קודם ===");
  {
    const old = readFileSync(join(ROOT, "src/app/api/documents/[id]/cancel/route.ts"), "utf8");
    check("הראוט הישן קורא לפונקציה המשותפת", old.includes("cancelDocumentLocally("));
    check("🔴 ואינו קורא למורנינג", !old.includes("closeDocument") && !old.includes("@/lib/morning/client"));
    check("  ...וההצהרה 'This does NOT call Morning' נשארה", old.includes("does NOT call Morning"));
    check("השערים שלו לא שונו — 100/300", old.includes("if (doc.type !== 300 && doc.type !== 100)"));
    check("  ...וגם לא שער 'כבר מבוטל'", old.includes("if (doc.cancelled_at) return"));
    check("  🔴 ואינו בודק source — זה היה שינוי התנהגות", !/doc\.source/.test(old));
    check("האירוע שלו נשאר document_cancelled", old.includes('event_type: "document_cancelled"'));
    check("ואינו כותב אירועי מורנינג", !old.includes("morning_cancel_"));
    // the four writes still happen — now in one place, asserted by behaviour
    const admin = makeAdmin({ job: { id: "j1", invoice_biz: "40339" }, invoicesDeleted: 1, queueReleased: ["q1"] });
    const res = await cancelDocumentLocally(
      admin as never,
      { id: "d1", morning_doc_id: "m1", morning_doc_number: "40339", type: 300, job_id: "j1" },
      { userId: "u1", reason: "טעות", cancelledAt: "2026-10-06T09:00:00.000Z" }
    );
    check("הפונקציה המשותפת: ארבע הכתיבות", res.invoiceBizCleared && res.invoiceRowDeleted && res.queueRowReleased);
    const tables = admin.ops.filter((o) => o.verb !== "insert").map((o) => `${o.table}.${o.verb}`);
    check(
      "  ...ובאותו סדר: jobs → invoices → documents → pending_documents",
      tables.join(" ") === "jobs.update invoices.delete documents.update pending_documents.update",
      tables.join(" ")
    );
    check("  ...ואירוע שחרור התור נכתב", admin.ops.some((o) => o.table === "events" && o.verb === "insert"));
    // the guard that must never regress
    const admin2 = makeAdmin({ job: { id: "j1", invoice_biz: "40999" }, invoicesDeleted: 0, queueReleased: [] });
    const res2 = await cancelDocumentLocally(
      admin2 as never,
      { id: "d1", morning_doc_id: "m1", morning_doc_number: "40339", type: 300, job_id: "j1" },
      { userId: "u1", reason: "טעות", cancelledAt: "2026-10-06T09:00:00.000Z" }
    );
    check(
      "🔴 invoice_biz שמצביע למסמך אחר — לא נוקה",
      !res2.invoiceBizCleared && !admin2.ops.some((o) => o.table === "jobs" && o.verb === "update")
    );
    check("  ...והמסמך עצמו כן סומן", admin2.ops.some((o) => o.table === "documents" && o.verb === "update"));
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n=== 8. אכיפה ===");
  {
    /**
     * ⚠️ THE SUITE SCANS ITSELF UP TO THIS SECTION AND NO FURTHER, and the cut
     * is not a loophole — it is the only way the question can be asked. The
     * assertions below name the very strings they forbid ("fetch(",
     * "createAdminClient"), so scanning the whole file would find them inside
     * their own checks and fail on a clean suite. The sentinel is the section
     * header, so everything that actually RUNS the tests is covered.
     */
    const whole = readFileSync(join(ROOT, "scripts/test_cancel_in_morning.ts"), "utf8");
    const SENTINEL = "=== 8. אכיפה ===";
    // comments stripped as well — the doc comment on `runRoute` names
    // `createClient()`/`createAdminClient()` in order to explain why the route
    // cannot be called here, and prose about the rule must not trip the rule.
    // Same idiom as test_contract_quota.ts:329.
    const suite = stripComments(whole.slice(0, whole.indexOf(SENTINEL)));
    check("הסנטינל נמצא — הסריקה אינה על קובץ ריק", suite.length > 1000, String(suite.length));
    // asked on the IMPORT LINES and not on the body: section 7 legitimately
    // names "@/lib/morning/client" inside a `.includes()` argument, in order to
    // assert that the OLD route does not import it. An import is the only way
    // this suite could actually reach Morning, so that is where to look.
    const importLines = stripComments(whole).split("\n").filter((l) => /^import\b/.test(l.trim())).join("\n");
    check("⛔ הסוויטה אינה מייבאת את לקוח מורנינג", !importLines.includes("morning"), importLines);
    check("⛔ אפס fetch(", !suite.includes("fetch("));
    check("⛔ אפס createAdminClient", !suite.includes("createAdminClient"));
    check("⛔ אפס createClient(", !suite.includes("createClient("));
    check("closeDocument מדומה בלבד", suite.includes("makeCloseDocument"));
    check("  ...ו-closeDocument האמיתי אינו מיובא", !importLines.includes("closeDocument"));

    const client = readFileSync(join(ROOT, "src/lib/morning/client.ts"), "utf8");
    const fn = client.slice(client.indexOf("export async function closeDocument"));
    check("closeDocument מכבד isDryRun קודם כל", /isDryRun\(\)\) return \{ dryRun: true \}/.test(fn.slice(0, 200)));
    check("  ...ופונה ל-POST /documents/{id}/close", fn.includes("/close`, { method: \"POST\" }"));
    check("  ...ובלי גוף בקשה — אין שדה מתועד", !/\/close[\s\S]{0,120}body:/.test(fn));
    check("  ...ועם encodeURIComponent על המזהה", fn.includes("encodeURIComponent(morningDocId)"));
    check("הדדליין נשאר 15 שניות", client.includes("MORNING_TIMEOUT_MS = 15_000"));

    const route = readFileSync(join(ROOT, "src/app/api/documents/[id]/cancel-in-morning/route.ts"), "utf8");
    check("הראוט מוגן ב-can_edit_money", route.includes("can_edit_money"));
    check("הראוט דורש source='app'", route.includes('doc.source !== "app"'));
    check("🔴 העדכון המקומי אחרי הקריאה, לא לפניה", route.indexOf("closeDocument(") < route.indexOf("cancelDocumentLocally("));
    for (const ev of ["morning_cancel_requested", "morning_cancel_succeeded", "morning_cancel_failed", "morning_cancel_unknown"]) {
      check(`האירוע ${ev} קיים בראוט`, route.includes(ev));
    }
    check("ה-requested נכתב לפני הקריאה", route.indexOf("morning_cancel_requested") < route.indexOf("closeDocument("));
    check("מסלול 504 קיים", route.includes("status === 504"));
    check("הראוט מסנן parent_relation דרך hasLiveTaxChild", route.includes("hasLiveTaxChild("));

    const lib = readFileSync(join(ROOT, "src/lib/documents/cancelLocal.ts"), "utf8");
    check("⛔ cancelLocal אינו מייבא את מורנינג", !lib.includes("morning/client"));
    check("  ...ואינו מכיל fetch(", !lib.includes("fetch("));
    check("hasLiveTaxChild דורש parent_relation='derived'", lib.includes('c.parent_relation === "derived"'));

    const reg = readFileSync(join(ROOT, "src/app/documents/registry/RegistryClient.tsx"), "utf8");
    check("⛔ אפס מופעים של הנוסח הישן 'סמן כמבוטל' בלי 'אצלנו'", !/"סמן כמבוטל"/.test(reg));
    check("המסך משתמש ב-offersMorningCancel", reg.includes("offersMorningCancel(r)"));
    check("  ...וקורא לראוט החדש", reg.includes("/cancel-in-morning"));
    check("  ...ועדיין לראוט הישן", reg.includes("/cancel`"));
  }

}

main().then(() => {
  console.log(`\n${failures === 0 ? "✅" : "❌"}  ${checks - failures}/${checks}`);
  process.exit(failures === 0 ? 0 : 1);
});
