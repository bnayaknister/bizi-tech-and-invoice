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
import { todayInIsrael } from "@/lib/dates";

// The generic parent -> tax-child builder (owner spec 2026-08-06). Creates ONE
// pending tax document on the basis of N already-issued parents, linked to them
// in Morning so they close there by themselves.
//
// Modelled line for line on createDealInvoiceFromWorkOrder (bundle.ts) — same
// shape, same brakes, same "inherit, never recompute" rule. That function stays
// exactly as it is and keeps owning 100 -> 300; this one owns 305/320 only.
//
// Deliberately NOT built on enqueueDocument: that path is production-anchored
// (it needs show_id, runs checkEligibility, derives a price from the show's
// default_rate). A tax document is built on a parent DOCUMENT, inherits its
// frozen income lines, and has no production of its own.
//
// Nothing here reaches Morning. It enqueues a 'pending' row that flows through
// the existing approval -> issue path, with the same human gate and the same
// DRY_RUN brake.

const LIVE_STATUSES = ["pending", "approved", "issued"];

/**
 * What the row is created as. The bookkeeper flips it to 320 in the approval
 * modal (tax_variant), which also rebuilds `remarks` — the two must never
 * disagree, because a document that says "חשבונית מס / קבלה" while being a 305
 * cannot be corrected once issued.
 *
 * 305 is the default because the two mistakes are not equal in cost (owner
 * 2026-08-09). A 320 is an invoice AND a receipt: issuing one declares to the
 * tax authority that the money came in. Approve without touching the selector
 * and a receipt goes out for money that may never have arrived — irreversible,
 * and there is no PUT on documents. The opposite mistake is ordinary: a 305
 * that turns out to be paid is closed by a separate receipt.
 *
 * So the default is the one that is safe to be wrong about, and collecting the
 * money is a deliberate act.
 */
export const DEFAULT_TAX_VARIANT: PendingDocType = "tax_invoice";

/** The tax children this builder can produce. 100 -> 300 is not one of them. */
const TAX_CHILD_CODES: number[] = [MORNING_DOC_CODE.tax_invoice, MORNING_DOC_CODE.tax_receipt];

export type ChildRule = {
  code: number;
  /**
   * false = allowed by our policy but NOT built. 400 (קבלה) needs a `payment`
   * block; MorningDocumentRequest has no such field and the pending_doc_type
   * enum has no 'receipt' value. Declared here so the refusal can say "not
   * implemented" rather than "forbidden" — the two are different answers.
   */
  implemented: boolean;
  /** which function produces it; this file only ever produces `tax_from_parent` */
  via: "tax_from_parent" | "create_deal_invoice_from_work_order";
};

/**
 * OUR allow-list, declared explicitly and never derived from Morning's `ref`.
 *
 * Morning is more permissive than we are — its ref on an open 100 is
 * [200,300,305,320,400], which would let a work order raise a receipt directly.
 * We refuse that: every document must sit on the rung below it. credit_invoice
 * (330) is absent on purpose and is never issued from this app.
 *
 * The check is DOUBLE: a combination must be in this table AND in the parent's
 * live ref. When the table refuses something ref allows, the message says so —
 * the bookkeeper must not go looking for a Morning limitation that isn't there.
 */
export const ALLOWED_CHILDREN: Partial<Record<PendingDocType, ChildRule[]>> = {
  work_order: [
    { code: MORNING_DOC_CODE.deal_invoice, implemented: true, via: "create_deal_invoice_from_work_order" },
    { code: MORNING_DOC_CODE.tax_invoice, implemented: true, via: "tax_from_parent" },
    { code: MORNING_DOC_CODE.tax_receipt, implemented: true, via: "tax_from_parent" },
  ],
  deal_invoice: [
    { code: MORNING_DOC_CODE.tax_invoice, implemented: true, via: "tax_from_parent" },
    { code: MORNING_DOC_CODE.tax_receipt, implemented: true, via: "tax_from_parent" },
  ],
  tax_invoice: [
    // policy-allowed, not built — see ChildRule.implemented
    { code: MORNING_DOC_CODE.receipt, implemented: false, via: "tax_from_parent" },
  ],
  // tax_receipt is a leaf: it is invoice+receipt in one and closes on birth,
  // so it never has a ref to give and can never be a parent.
};

export function childRule(parent: PendingDocType, childCode: number): ChildRule | null {
  return (ALLOWED_CHILDREN[parent] ?? []).find((r) => r.code === childCode) ?? null;
}

export type TaxBuildResult =
  | {
      ok: true;
      id: string;
      docType: PendingDocType;
      amount: number;
      lines: number;
      sourceNumbers: string[];
      /**
       * true = we could not tell whether the parents are still open in Morning
       * (no documents row yet, or one whose raw carries no `ref`). The UI shows
       * this as a warning; it is not a failure. An app-issued parent looks like
       * this until the next daily pull overwrites its raw.
       */
      parentOpennessUnknown: boolean;
    }
  | { ok: false; status: number; error: string };

type SourceRow = {
  id: string;
  doc_type: PendingDocType;
  status: string;
  client_id: string | null;
  amount: number | null;
  payload: MorningDocumentRequest | null;
  morning_doc_id: string | null;
  morning_doc_number: string | null;
  job_id: string | null;
};

/** How a source is named in an error message — always the most human id we hold. */
function nameOf(r: SourceRow): string {
  if (r.morning_doc_number) return `#${r.morning_doc_number}`;
  if (r.morning_doc_id) return r.morning_doc_id;
  return r.id;
}

/**
 * The three-state openness read.
 *
 * `ref` is Morning's list of document types still issuable against a document.
 * It is NOT a column: it arrives inside the search item that the daily pull
 * stores whole in documents.raw. A document the app issued carries the POST
 * response there instead, which may have no `ref` at all until the next pull
 * overwrites it — so "missing" has to mean unknown, never closed.
 */
type Openness =
  | { state: "unknown" }
  | { state: "closed" }
  | { state: "open"; allowedCodes: number[] };

function readOpenness(raw: unknown): Openness {
  if (!raw || typeof raw !== "object") return { state: "unknown" };
  if (!("ref" in (raw as Record<string, unknown>))) return { state: "unknown" };
  const ref = (raw as Record<string, unknown>).ref;
  // anything that isn't an array is a shape we don't understand — unknown, so
  // a human decides, rather than a silent pass or a wrong refusal
  if (!Array.isArray(ref)) return { state: "unknown" };
  if (ref.length === 0) return { state: "closed" };
  // tolerate numbers or numeric strings; a non-numeric entry is simply dropped
  const codes = ref.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  return { state: "open", allowedCodes: codes };
}

/**
 * Build ONE tax document (305/320) on the basis of N issued parents.
 *
 * `sourceIds` are pending_documents.id — a source without a queue row is out of
 * scope by design (a document raised by hand in Morning has no frozen payload
 * to inherit, and inheriting is what keeps the child's total honest).
 *
 * Every gate below refuses the WHOLE request on a single bad source. Building
 * from "the valid ones" would hand the client a document covering part of the
 * debt while the operator believes it closed all of it — and once it is in
 * Morning there is no PUT to fix it.
 */
export async function createTaxFromParents(
  admin: SupabaseClient,
  sourceIds: string[],
  actorId: string | null,
  variant: PendingDocType = DEFAULT_TAX_VARIANT
): Promise<TaxBuildResult> {
  const ids = Array.from(new Set((sourceIds ?? []).filter(Boolean)));
  if (!ids.length) return { ok: false, status: 400, error: "לא נבחרו מסמכי מקור" };

  if (!TAX_CHILD_CODES.includes(DOC_TYPE_TO_MORNING_CODE[variant])) {
    return { ok: false, status: 400, error: "הבנאי הזה יוצר חשבונית מס או חשבונית מס קבלה בלבד" };
  }
  const childCode = DOC_TYPE_TO_MORNING_CODE[variant];

  const { data, error } = await admin
    .from("pending_documents")
    .select("id,doc_type,status,client_id,amount,payload,morning_doc_id,morning_doc_number,job_id")
    .in("id", ids);
  if (error) return { ok: false, status: 400, error: error.message };
  const rows = (data ?? []) as unknown as SourceRow[];
  // never act on a partial set — the operator's intent no longer matches what
  // we hold (same rule as the review route)
  if (rows.length !== ids.length) {
    return {
      ok: false,
      status: 409,
      error: `נמצאו ${rows.length} מסמכי מקור מתוך ${ids.length} — רענני את המסך ונסי שוב`,
    };
  }

  // ---- gate: parent type, and no mixing -----------------------------------
  for (const r of rows) {
    if (!ALLOWED_CHILDREN[r.doc_type]) {
      return {
        ok: false,
        status: 400,
        error: `${nameOf(r)}: לא ניתן להנפיק מסמך מס על סמך ${DOC_TYPE_LABEL[r.doc_type] ?? r.doc_type}`,
      };
    }
  }
  const parentTypes = Array.from(new Set(rows.map((r) => r.doc_type)));
  if (parentTypes.length !== 1) {
    return {
      ok: false,
      status: 400,
      error: "כל מסמכי המקור חייבים להיות מאותו סוג — אין לערבב הזמנת עבודה וחשבון עסקה",
    };
  }
  const parentType = parentTypes[0];

  // ---- gate: our policy, before anything is read from Morning -------------
  const rule = childRule(parentType, childCode);
  if (!rule) {
    return {
      ok: false,
      status: 400,
      error:
        `אנחנו לא מנפיקים ${MORNING_DOC_NAME[childCode]} על סמך ${MORNING_DOC_NAME[DOC_TYPE_TO_MORNING_CODE[parentType]]}. ` +
        "זו החלטה שלנו, לא מגבלת מורנינג.",
    };
  }
  if (!rule.implemented) {
    return {
      ok: false,
      status: 400,
      error: `${MORNING_DOC_NAME[childCode]} על סמך ${MORNING_DOC_NAME[DOC_TYPE_TO_MORNING_CODE[parentType]]} מותר, אך אינו ממומש בגרסה זו`,
    };
  }

  // ---- gate: every parent must really exist in Morning --------------------
  for (const r of rows) {
    if (r.status !== "issued") {
      const why =
        r.status === "pending" || r.status === "approved"
          ? "טרם הונפק — אשרי אותו קודם"
          : r.status === "accrued"
            ? "מסוכם וטרם נפדה"
            : `במצב ${r.status} — לא ניתן להנפיק על סמכו`;
      return { ok: false, status: 409, error: `${nameOf(r)}: ${why}` };
    }
    if (!r.morning_doc_id) {
      return { ok: false, status: 409, error: `${nameOf(r)}: לא קיים במורנינג` };
    }
    // a dry-run issuance mints a synthetic id that is not a real Morning
    // document; sending it as a link would produce a confusing rejection
    if (r.morning_doc_id.startsWith("dry-")) {
      return {
        ok: false,
        status: 409,
        error: `${nameOf(r)}: הונפק במצב הרצה יבשה — אין מסמך אמיתי במורנינג לקשר אליו`,
      };
    }
    // the number is what gets PRINTED on the child (remarks). Missing it means
    // a document that never names its parent — refuse, never omit quietly.
    if (!r.morning_doc_number || !String(r.morning_doc_number).trim()) {
      return {
        ok: false,
        status: 409,
        error: `${r.morning_doc_id}: אין מספר מסמך — לא ניתן לציין אותו בהערת המקור`,
      };
    }
    if (r.amount === null || r.amount === undefined) {
      return { ok: false, status: 409, error: `${nameOf(r)}: אין סכום — לא ניתן לסכם את מסמכי המקור` };
    }
    const income = r.payload?.income ?? [];
    if (!r.payload?.client?.id || income.length === 0) {
      return { ok: false, status: 400, error: `${nameOf(r)}: נתוני המקור חסרים — לא ניתן לבנות מסמך מס` };
    }
  }

  // ---- gate: one client across all sources --------------------------------
  const morningClientIds = Array.from(new Set(rows.map((r) => r.payload!.client!.id as string)));
  if (morningClientIds.length !== 1) {
    return { ok: false, status: 400, error: "כל מסמכי המקור חייבים להיות של אותו לקוח" };
  }
  const localClientIds = Array.from(new Set(rows.map((r) => r.client_id).filter(Boolean)));
  if (localClientIds.length > 1) {
    return { ok: false, status: 400, error: "מסמכי המקור משויכים ליותר מלקוח אחד באפליקציה" };
  }

  // ---- gate: the parents are still open in Morning ------------------------
  const morningIds = rows.map((r) => r.morning_doc_id as string);
  const { data: docRows } = await admin.from("documents").select("morning_doc_id,raw").in("morning_doc_id", morningIds);
  const rawById = new Map<string, unknown>();
  for (const d of (docRows ?? []) as { morning_doc_id: string; raw: unknown }[]) rawById.set(d.morning_doc_id, d.raw);

  let parentOpennessUnknown = false;
  for (const r of rows) {
    const openness = readOpenness(rawById.get(r.morning_doc_id as string));
    if (openness.state === "unknown") {
      // no documents row at all, or one whose raw has no ref — allow, and hand
      // the caller a flag so the screen can warn before anyone approves
      parentOpennessUnknown = true;
      continue;
    }
    if (openness.state === "closed") {
      return {
        ok: false,
        status: 409,
        error: `${nameOf(r)}: כבר סגור במורנינג — לא ניתן להנפיק על סמכו`,
      };
    }
    if (!openness.allowedCodes.includes(childCode)) {
      return {
        ok: false,
        status: 409,
        error: `${nameOf(r)}: מורנינג אינה מתירה להנפיק על סמכו ${MORNING_DOC_NAME[childCode]}`,
      };
    }
  }

  // ---- gate: idempotency --------------------------------------------------
  // A live tax row already carrying this parent's Morning id means the document
  // was already built. Local and immediate; Morning's own closure only reaches
  // us on the next pull. NOTE: payload has no GIN index, so this scans the
  // queue once per source — fine at today's volume, worth watching as it grows.
  for (const r of rows) {
    const { data: already } = await admin
      .from("pending_documents")
      .select("id,status,morning_doc_number")
      .in("doc_type", ["tax_invoice", "tax_receipt"])
      .in("status", LIVE_STATUSES)
      .contains("payload", { linkedDocumentIds: [r.morning_doc_id as string] });
    if (already && already.length) {
      return { ok: false, status: 409, error: `${nameOf(r)}: כבר קיים מסמך מס על סמכו` };
    }
  }

  // ---- the jobs this document bills ---------------------------------------
  // bundle_job_ids is what makes issue.ts stamp invoice_tax on every one of
  // them. Read tolerantly (0044 shipped the column; issue.ts reads it the same
  // way) and fall back to each source's own job_id.
  //
  // Empty means REFUSE, not warn — same reasoning as bundle.ts:289-295: a tax
  // document that stamps invoice_tax on nothing leaves the jobs looking unbilled
  // while the client holds a real document, and it cannot be undone.
  const jobIds = new Set<string>();
  {
    const { data: bundleRows, error: bundleErr } = await admin
      .from("pending_documents")
      .select("id,bundle_job_ids")
      .in("id", ids);
    if (!bundleErr) {
      for (const b of (bundleRows ?? []) as { id: string; bundle_job_ids: string[] | null }[]) {
        for (const j of b.bundle_job_ids ?? []) jobIds.add(j);
      }
    }
  }
  for (const r of rows) {
    if (r.job_id) jobIds.add(r.job_id);
  }
  if (jobIds.size === 0) {
    return {
      ok: false,
      status: 409,
      error: "לא נמצאו עבודות מקושרות למסמכי המקור — מסמך מס חייב לסמן את העבודות שהוא סוגר",
    };
  }

  // ---- the payload --------------------------------------------------------
  const { data: clientRow } = localClientIds.length
    ? await admin.from("clients").select("name").eq("id", localClientIds[0] as string).maybeSingle()
    : { data: null };
  const clientName = ((clientRow?.name as string | null) ?? rows[0].payload?.client?.name ?? "").trim();

  // inherited verbatim, in source order: the child must total exactly what its
  // parents did. Nothing is recomputed anywhere on this path.
  const income = rows.flatMap((r) => r.payload!.income);
  const amount = rows.reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
  const sourceNumbers = rows.map((r) => String(r.morning_doc_number));

  // The two halves of "created on the basis of", and they do different jobs:
  // linkedDocumentIds CLOSES the parents in Morning, remarks is what the client
  // reads on the page. Morning fills the remark itself only for documents
  // raised in its own UI — through the API it leaves it null (bundle.ts:302).
  const remark = sourceRemark(variant, parentType, sourceNumbers);
  if (!remark) {
    // unreachable: every number was checked above. Refuse rather than send a
    // document that names no parent.
    return { ok: false, status: 500, error: "לא ניתן לבנות את הערת המקור" };
  }

  const description =
    rows.length === 1
      ? `${DOC_TYPE_LABEL[variant]} — ${clientName}`.trim()
      : `${DOC_TYPE_LABEL[variant]} מאוגד — ${clientName} (${rows.length} מסמכי מקור)`.trim();

  const payload: MorningDocumentRequest = {
    type: childCode,
    lang: "he",
    currency: "ILS",
    vatType: VAT_TYPE_DEFAULT,
    date: todayInIsrael(), // issuance date; issue.ts re-stamps at the real moment
    description,
    client: { id: morningClientIds[0], name: rows[0].payload?.client?.name, add: false },
    income,
    // linkType is deliberately absent. It is not required for 100 -> 300
    // (verified live 2026-08-02); whether Morning wants it on 300 -> 320 is
    // UNVERIFIED — if a call fails, this is the first thing to test.
    linkedDocumentIds: morningIds,
    remarks: remark,
  };

  const { data: inserted, error: insErr } = await admin
    .from("pending_documents")
    .insert({
      doc_type: variant,
      production_id: null,
      job_id: null,
      bundle_job_ids: Array.from(jobIds),
      client_id: localClientIds[0] ?? null,
      amount,
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
      doc_type: variant,
      via: "tax_from_parent",
      parent_doc_type: parentType,
      source_pending_ids: ids,
      linked_morning_doc_ids: morningIds,
      linked_morning_doc_numbers: sourceNumbers,
      client_id: localClientIds[0] ?? null,
      amount,
      lines: income.length,
      job_ids: Array.from(jobIds),
      parent_openness_unknown: parentOpennessUnknown,
    },
  });

  return {
    ok: true,
    id: inserted.id,
    docType: variant,
    amount,
    lines: income.length,
    sourceNumbers,
    parentOpennessUnknown,
  };
}
