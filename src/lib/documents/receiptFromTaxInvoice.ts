import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DOC_TYPE_LABEL,
  DOC_TYPE_TO_MORNING_CODE,
  MORNING_DOC_CODE,
  MORNING_DOC_NAME,
  VAT_TYPE_DEFAULT,
  sourceRemark,
  type MorningDocumentRequest,
  type PendingDocType,
} from "@/lib/morning/types";
import { childRule } from "@/lib/documents/taxFromParent";
import { todayInIsrael } from "@/lib/dates";

// The last rung of the chain: a receipt (400) raised on a tax invoice (305).
//
// 100 -> 300 -> 305 -> 400, each document created "on the basis of" the one
// below it and closing it in Morning through linkedDocumentIds.
//
// WHY THIS IS NOT A BRANCH IN taxFromParent.ts, which builds 305/320:
// a receipt is a different KIND of document, not another variant. Verified on
// all 61 receipts in the account (2026-08-10): every one carries a `payment`
// block and ZERO income lines. So three of that builder's gates are wrong here
// — it refuses an empty income (correct there, backwards here), it inherits
// income lines verbatim (there are none to inherit), and it refuses when no job
// is linked (a receipt is not an invoice: registryType returns null for it, so
// it writes no invoices row and stamps nothing on jobs).
//
// The rest of the gates ARE the same, and they are duplicated here on purpose
// rather than extracted into a shared helper: taxFromParent runs in production
// and is proven, and refactoring it to serve a second caller would put that at
// risk to save ~90 lines. The allow-list is the one thing genuinely shared —
// it is imported, so there is a single source of truth for what may be built on
// what.
//
// Nothing here reaches Morning. It enqueues a 'pending' row that flows through
// the existing approval -> issue path.
//
// ⚠️ THE PAYLOAD THIS PRODUCES IS DELIBERATELY INCOMPLETE: it carries no
// `payment` block, because the money details (method, amount, date) are chosen
// by the bookkeeper at approval time, not days earlier when the row is built.
// The review route injects them and refuses to issue a 400 without them. Until
// that gate exists, this builder must stay unreachable — no route, no button.

const LIVE_STATUSES = ["pending", "approved", "issued"];

/** The only child this file produces. */
const RECEIPT_VARIANT: PendingDocType = "receipt";
/** The only parent it accepts. */
const PARENT_VARIANT: PendingDocType = "tax_invoice";

export type ReceiptBuildResult =
  | {
      ok: true;
      id: string;
      /** gross — see the note on the insert below */
      amount: number;
      sourceNumbers: string[];
    }
  | { ok: false; status: number; error: string };

type SourceRow = {
  id: string;
  doc_type: PendingDocType;
  status: string;
  client_id: string | null;
  payload: MorningDocumentRequest | null;
  morning_doc_id: string | null;
  morning_doc_number: string | null;
};

/** How a source is named in an error message — always the most human id we hold. */
function nameOf(r: SourceRow): string {
  if (r.morning_doc_number) return `#${r.morning_doc_number}`;
  if (r.morning_doc_id) return r.morning_doc_id;
  return r.id;
}

/**
 * The three-state openness read — identical to the one in taxFromParent.ts, and
 * the decision taken on it is the OPPOSITE.
 *
 * `ref` is Morning's list of document types still issuable against a document.
 * It is not a column: it arrives inside the search item that the daily pull
 * stores whole in documents.raw. A document the app issued carries the POST
 * response there instead, which has no `ref` — and no `amount` either.
 *
 * That second absence is why "unknown" is a REFUSAL here. The tax builder can
 * tolerate it because its amount comes from the queue row; this one reads the
 * gross out of the same `raw`, so a raw we cannot read is a document we cannot
 * price. Waiting for the nightly pull is the honest answer, and the message
 * says so.
 */
type Openness =
  | { state: "unknown" }
  | { state: "closed" }
  | { state: "open"; allowedCodes: number[] };

function readOpenness(raw: unknown): Openness {
  if (!raw || typeof raw !== "object") return { state: "unknown" };
  if (!("ref" in (raw as Record<string, unknown>))) return { state: "unknown" };
  const ref = (raw as Record<string, unknown>).ref;
  if (!Array.isArray(ref)) return { state: "unknown" };
  if (ref.length === 0) return { state: "closed" };
  const codes = ref.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  return { state: "open", allowedCodes: codes };
}

/** The gross Morning itself computed for the parent, out of its pulled raw. */
function grossFromRaw(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const v = (raw as Record<string, unknown>).amount;
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build ONE receipt (400) on the basis of N issued tax invoices (305).
 *
 * `sourceIds` are pending_documents.id. A source without a queue row is out of
 * scope, same as the tax builder: we link to what we issued and can account for.
 *
 * Takes an array even though v1 raises one receipt per invoice — the shape
 * matches its sibling, sourceRemark already lists several numbers after one
 * type name, and a single-source signature would have to be widened later.
 *
 * Every gate refuses the WHOLE request on a single bad source. Building from
 * "the valid ones" would hand the client a receipt covering part of what was
 * paid while the operator believes it closed all of it — and once it is in
 * Morning there is no PUT to fix it.
 */
export async function createReceiptFromTaxInvoices(
  admin: SupabaseClient,
  sourceIds: string[],
  actorId: string | null
): Promise<ReceiptBuildResult> {
  const ids = Array.from(new Set((sourceIds ?? []).filter(Boolean)));
  if (!ids.length) return { ok: false, status: 400, error: "לא נבחרו מסמכי מקור" };

  const childCode = DOC_TYPE_TO_MORNING_CODE[RECEIPT_VARIANT];

  const { data, error } = await admin
    .from("pending_documents")
    .select("id,doc_type,status,client_id,payload,morning_doc_id,morning_doc_number")
    .in("id", ids);
  if (error) return { ok: false, status: 400, error: error.message };
  const rows = (data ?? []) as unknown as SourceRow[];
  if (rows.length !== ids.length) {
    return {
      ok: false,
      status: 409,
      error: `נמצאו ${rows.length} מסמכי מקור מתוך ${ids.length} — רענני את המסך ונסי שוב`,
    };
  }

  // ---- gate: one Morning document per request -----------------------------
  // The Set above dedupes a repeated id; this catches two DIFFERENT local rows
  // pointing at the same Morning document, which would double the amount while
  // sourceRemark quietly collapsed the repeated number — a correct-looking
  // remark over a doubled total. Same reasoning as taxFromParent (ba5123d).
  {
    const seenMorningIds = new Set<string>();
    for (const r of rows) {
      const mid = (r.morning_doc_id ?? "").trim();
      if (!mid) continue;
      if (seenMorningIds.has(mid)) {
        return {
          ok: false,
          status: 400,
          error: `${nameOf(r)}: אותו מסמך מורנינג נבחר יותר מפעם אחת — הסכום היה נכפל`,
        };
      }
      seenMorningIds.add(mid);
    }
  }

  // ---- gate: the parent must be a tax invoice -----------------------------
  for (const r of rows) {
    if (r.doc_type !== PARENT_VARIANT) {
      return {
        ok: false,
        status: 400,
        error: `${nameOf(r)}: קבלה נוצרת על סמך ${DOC_TYPE_LABEL[PARENT_VARIANT]} בלבד, לא על סמך ${DOC_TYPE_LABEL[r.doc_type] ?? r.doc_type}`,
      };
    }
  }

  // ---- gate: our policy ---------------------------------------------------
  // Read from the shared allow-list in taxFromParent.ts rather than a second
  // copy here, so there is one place that says what may be built on what.
  const rule = childRule(PARENT_VARIANT, childCode);
  if (!rule || !rule.implemented) {
    return {
      ok: false,
      status: 400,
      error: `${MORNING_DOC_NAME[childCode]} על סמך ${MORNING_DOC_NAME[MORNING_DOC_CODE.tax_invoice]} אינו מותר כרגע`,
    };
  }

  // ---- gate: every parent must really exist in Morning --------------------
  for (const r of rows) {
    if (r.status !== "issued") {
      const why =
        r.status === "pending" || r.status === "approved"
          ? "טרם הונפק — אשרי אותו קודם"
          : `במצב ${r.status} — לא ניתן להנפיק על סמכו`;
      return { ok: false, status: 409, error: `${nameOf(r)}: ${why}` };
    }
    if (!r.morning_doc_id) {
      return { ok: false, status: 409, error: `${nameOf(r)}: לא קיים במורנינג` };
    }
    if (r.morning_doc_id.startsWith("dry-")) {
      return {
        ok: false,
        status: 409,
        error: `${nameOf(r)}: הונפק במצב הרצה יבשה — אין מסמך אמיתי במורנינג לקשר אליו`,
      };
    }
    // the number is what gets PRINTED on the receipt (remarks). Missing it means
    // a document that never names its parent — refuse, never omit quietly.
    if (!r.morning_doc_number || !String(r.morning_doc_number).trim()) {
      return {
        ok: false,
        status: 409,
        error: `${r.morning_doc_id}: אין מספר מסמך — לא ניתן לציין אותו בהערת המקור`,
      };
    }
    if (!r.payload?.client?.id) {
      return { ok: false, status: 400, error: `${nameOf(r)}: נתוני המקור חסרים — לא ניתן לבנות קבלה` };
    }
  }
  // NOTE: no income gate. A 305 has lines and a 400 does not inherit them, so
  // whether the parent carries any is irrelevant here — unlike in the tax
  // builder, where an empty income is a refusal.

  // ---- gate: one client across all sources --------------------------------
  const morningClientIds = Array.from(new Set(rows.map((r) => r.payload!.client!.id as string)));
  if (morningClientIds.length !== 1) {
    return { ok: false, status: 400, error: "כל מסמכי המקור חייבים להיות של אותו לקוח" };
  }
  const localClientIds = Array.from(new Set(rows.map((r) => r.client_id).filter(Boolean)));
  if (localClientIds.length > 1) {
    return { ok: false, status: 400, error: "מסמכי המקור משויכים ליותר מלקוח אחד באפליקציה" };
  }

  // ---- gate: openness AND the gross, from the same raw ---------------------
  const morningIds = rows.map((r) => r.morning_doc_id as string);
  const { data: docRows } = await admin.from("documents").select("morning_doc_id,raw").in("morning_doc_id", morningIds);
  const rawById = new Map<string, unknown>();
  for (const d of (docRows ?? []) as { morning_doc_id: string; raw: unknown }[]) rawById.set(d.morning_doc_id, d.raw);

  let gross = 0;
  for (const r of rows) {
    const raw = rawById.get(r.morning_doc_id as string);
    const openness = readOpenness(raw);

    // THE difference from taxFromParent: unknown is a refusal, not a warning.
    // A raw without `ref` is a raw without `amount`, and the receipt has no
    // other source for its total.
    if (openness.state === "unknown") {
      return {
        ok: false,
        status: 409,
        error: `${nameOf(r)}: המסמך טרם נמשך ממורנינג. הקבלה תיבנה אחרי הסנכרון הבא.`,
      };
    }
    if (openness.state === "closed") {
      return { ok: false, status: 409, error: `${nameOf(r)}: כבר סגור במורנינג — לא ניתן להנפיק על סמכו` };
    }
    if (!openness.allowedCodes.includes(childCode)) {
      return {
        ok: false,
        status: 409,
        error: `${nameOf(r)}: מורנינג אינה מתירה להנפיק על סמכו ${MORNING_DOC_NAME[childCode]}`,
      };
    }

    const amount = grossFromRaw(raw);
    if (amount === null) {
      return {
        ok: false,
        status: 409,
        error: `${nameOf(r)}: אין סכום במסמך שנמשך ממורנינג — לא ניתן לבנות קבלה`,
      };
    }
    gross += amount;
  }

  // ---- gate: idempotency --------------------------------------------------
  // A live receipt already carrying this invoice's Morning id means it was
  // already built. Local and immediate; Morning's own closure only reaches us
  // on the next pull.
  for (const r of rows) {
    const { data: already } = await admin
      .from("pending_documents")
      .select("id,status,morning_doc_number")
      .eq("doc_type", RECEIPT_VARIANT)
      .in("status", LIVE_STATUSES)
      .contains("payload", { linkedDocumentIds: [r.morning_doc_id as string] });
    if (already && already.length) {
      return { ok: false, status: 409, error: `${nameOf(r)}: כבר קיימת קבלה על סמכו` };
    }
  }

  // NOTE: no jobs gate. registryType (issue.ts) returns null for a receipt, so
  // issuing one writes no invoices row and stamps nothing on jobs — there is
  // nothing for bundle_job_ids to carry, and requiring it would refuse perfectly
  // good receipts. The money side of the job is closed by the payment
  // reconciliation, which reads 400s from the pull.

  // ---- the payload --------------------------------------------------------
  const { data: clientRow } = localClientIds.length
    ? await admin.from("clients").select("name").eq("id", localClientIds[0] as string).maybeSingle()
    : { data: null };
  const clientName = ((clientRow?.name as string | null) ?? rows[0].payload?.client?.name ?? "").trim();

  const sourceNumbers = rows.map((r) => String(r.morning_doc_number));

  // linkedDocumentIds closes the invoice in Morning; remarks is what the client
  // reads on the page. Morning fills the remark itself only for documents raised
  // in its own UI — through the API it leaves it null.
  const remark = sourceRemark(RECEIPT_VARIANT, PARENT_VARIANT, sourceNumbers);
  if (!remark) {
    // unreachable: every number was checked above
    return { ok: false, status: 500, error: "לא ניתן לבנות את הערת המקור" };
  }

  const description =
    rows.length === 1
      ? `${DOC_TYPE_LABEL[RECEIPT_VARIANT]} — ${clientName}`.trim()
      : `${DOC_TYPE_LABEL[RECEIPT_VARIANT]} מאוגדת — ${clientName} (${rows.length} חשבוניות)`.trim();

  const payload: MorningDocumentRequest = {
    type: childCode,
    lang: "he",
    currency: "ILS",
    vatType: VAT_TYPE_DEFAULT,
    date: todayInIsrael(), // issuance date; issue.ts re-stamps at the real moment
    description,
    client: { id: morningClientIds[0], name: rows[0].payload?.client?.name, add: false },
    // no `income`: a receipt carries none (0 of 61 in the account do). Omitted,
    // not an empty array — an empty array is a claim that there are zero lines,
    // absence is the correct shape.
    //
    // no `payment` either, and that is the one thing missing before this can be
    // issued: the method, amount and date are chosen at approval. The review
    // route injects them and refuses a 400 without them.
    linkedDocumentIds: morningIds,
    remarks: remark,
  };

  const { data: inserted, error: insErr } = await admin
    .from("pending_documents")
    .insert({
      doc_type: RECEIPT_VARIANT,
      production_id: null,
      job_id: null,
      client_id: localClientIds[0] ?? null,
      // GROSS — and this column is NET for every other doc_type in the table.
      //
      // The reason is not a convention we chose: Morning receives a receipt in
      // gross and does NOT compute VAT on a 400. An invoice sends net lines and
      // Morning adds the tax on top; a receipt states money that already moved,
      // tax included. So the number that has to reach it is the gross, and the
      // only trustworthy source for that gross is what Morning itself computed
      // on the parent — documents.raw->'amount' of the 305, read above.
      //
      // Deliberately NOT documents.amount (it holds our net until the next pull
      // overwrites it with the gross — a moving target) and deliberately NOT
      // derived from income x vatRate (that would put Morning's own tax rate
      // into our issuance path).
      amount: gross,
      payload,
      status: "pending",
    })
    .select("id")
    .single();
  if (insErr) return { ok: false, status: 400, error: insErr.message };

  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: inserted.id,
    event_type: "document_queued",
    actor_id: actorId,
    payload: {
      doc_type: RECEIPT_VARIANT,
      via: "receipt_from_tax_invoice",
      source_pending_ids: ids,
      linked_morning_doc_ids: morningIds,
      linked_morning_doc_numbers: sourceNumbers,
      client_id: localClientIds[0] ?? null,
      amount_gross: gross,
      awaiting_payment_block: true,
    },
  });

  return { ok: true, id: inserted.id, amount: gross, sourceNumbers };
}
