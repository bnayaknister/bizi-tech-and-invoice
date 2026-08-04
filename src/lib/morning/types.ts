// Morning (Green Invoice) document type codes.
//
// Verified 2026-07-19 against the official OpenAPI spec served at
// developers.morning.co/docs/openapi.bundled.json (morning API v2.0.0) —
// NOT from an SDK. The widely-linked Apiary docs are dead (404) and the
// public SDKs still document a retired `/account/token` auth flow, so
// anything sourced from them is suspect.
//
// Owner decision 2026-07-19: Morning has no "הזמנת עבודה" document type.
// The closest real type is 100 "הזמנה", and that is what a work order maps
// to. (500 "הזמנת רכש" is a purchase order — a document you send to your
// OWN supplier, the opposite direction — and is deliberately unused.)
export const MORNING_DOC_CODE = {
  price_quote: 10,
  order: 100, // ← "הזמנת עבודה" for our purposes
  deal_invoice: 300, // חשבון עסקה — non-tax, reversible
  tax_invoice: 305, // חשבונית מס
  tax_receipt: 320, // חשבונית מס / קבלה
  credit_invoice: 330, // חשבונית זיכוי — NEVER issued from this app
  receipt: 400,
} as const;

// The four document types this app can queue. Maps 1:1 onto the
// pending_doc_type enum in migration 0025.
export type PendingDocType = "work_order" | "deal_invoice" | "tax_invoice" | "tax_receipt";

export const DOC_TYPE_TO_MORNING_CODE: Record<PendingDocType, number> = {
  work_order: MORNING_DOC_CODE.order,
  deal_invoice: MORNING_DOC_CODE.deal_invoice,
  tax_invoice: MORNING_DOC_CODE.tax_invoice,
  tax_receipt: MORNING_DOC_CODE.tax_receipt,
};

export const DOC_TYPE_LABEL: Record<PendingDocType, string> = {
  work_order: "הזמנת עבודה",
  deal_invoice: "חשבון עסקה",
  tax_invoice: "חשבונית מס",
  tax_receipt: "חשבונית מס קבלה",
};

/**
 * What MORNING calls each type — its vocabulary, not ours, and the two differ.
 * Morning has no "הזמנת עבודה": 100 prints as "הזמנה" on the page, and 320 as
 * "חשבונית מס / קבלה" with the slashes. DOC_TYPE_LABEL above is what WE show
 * in our own screens; this is what the owner's books already say.
 *
 * Read off 1,000 real documents in the account (2026-08-04): every remark
 * Morning generates for itself is built from exactly these names, so anything
 * we write has to use them or the archive ends up saying the same thing two
 * ways. Keyed by Morning's numeric code, not by PendingDocType, because a
 * SOURCE document can be a type we never issue (a quote, a credit note).
 */
export const MORNING_DOC_NAME: Record<number, string> = {
  [MORNING_DOC_CODE.price_quote]: "הצעת מחיר",
  [MORNING_DOC_CODE.order]: "הזמנה",
  [MORNING_DOC_CODE.deal_invoice]: "חשבון עסקה",
  [MORNING_DOC_CODE.tax_invoice]: "חשבונית מס",
  [MORNING_DOC_CODE.tax_receipt]: "חשבונית מס / קבלה",
  [MORNING_DOC_CODE.credit_invoice]: "חשבונית זיכוי",
  [MORNING_DOC_CODE.receipt]: "קבלה",
};

/**
 * The provenance line for a document created ON THE BASIS OF others — e.g.
 * "חשבון עסקה עבור הזמנה 10306". Belongs in `remarks`.
 *
 * Why this exists at all: `linkedDocumentIds` CLOSES the source in Morning, it
 * does not DESCRIBE it. Nothing about the link reaches the printed page —
 * verified 2026-08-04 by pulling the PDFs: 40303 names its 2,000 ₪ line and
 * its client and never once says 10306. `remarks` is the slot that prints,
 * below the totals, and Morning fills it itself for documents raised in its
 * own UI (285 in the books read "חשבון עסקה עבור הזמנה NNNNN") but NOT for
 * ones raised through the API — 40303 and 10306 both carry a link and both
 * came back with remarks null. So we write it, in Morning's own words.
 *
 * The plural form is Morning's too: the source TYPE is named once and the
 * numbers follow, comma-separated — "חשבונית מס / קבלה עבור חשבון עסקה
 * 40277, 40275". 22 documents in the account are shaped that way.
 *
 * Returns undefined when there is no source, so a caller can spread the result
 * and have the field simply not appear: a parentless document (the manual
 * bundle, an order raised from the registry) must never carry one.
 */
export function sourceRemark(
  docType: PendingDocType,
  sourceType: PendingDocType,
  sourceNumbers: readonly (string | number | null | undefined)[]
): string | undefined {
  const numbers = Array.from(
    new Set(sourceNumbers.map((n) => String(n ?? "").trim()).filter((n) => n !== ""))
  );
  if (numbers.length === 0) return undefined;
  const self = MORNING_DOC_NAME[DOC_TYPE_TO_MORNING_CODE[docType]];
  const source = MORNING_DOC_NAME[DOC_TYPE_TO_MORNING_CODE[sourceType]];
  return `${self} עבור ${source} ${numbers.join(", ")}`;
}

// Document-level VAT type (spec: 0 default / 1 exempt / 2 mixed).
export const VAT_TYPE_DEFAULT = 0;

// The five registry tabs (owner spec 2026-07-19), keyed by Morning type
// code. Anything else a pull turns up (credit notes 330, quotes 10, …) falls
// into "other" so nothing is ever dropped from the registry.
export type RegistryTab = "work_order" | "deal_invoice" | "tax_invoice" | "tax_receipt" | "receipt" | "other";

export function registryTabForType(type: number): RegistryTab {
  switch (type) {
    case MORNING_DOC_CODE.order:
      return "work_order";
    case MORNING_DOC_CODE.deal_invoice:
      return "deal_invoice";
    case MORNING_DOC_CODE.tax_invoice:
      return "tax_invoice";
    case MORNING_DOC_CODE.tax_receipt:
      return "tax_receipt";
    case MORNING_DOC_CODE.receipt:
      return "receipt";
    default:
      return "other";
  }
}

export const REGISTRY_TAB_LABEL: Record<RegistryTab, string> = {
  work_order: "הזמנות עבודה",
  deal_invoice: "חשבוניות עסקה",
  tax_invoice: "חשבוניות מס",
  tax_receipt: "חשבוניות מס קבלה",
  receipt: "קבלות",
  other: "אחר",
};

export type MorningIncomeRow = {
  description: string;
  quantity: number;
  price: number;
  currency: string;
  vatType: number;
};

export type MorningDocumentRequest = {
  type: number;
  lang: string;
  currency: string;
  vatType: number;
  date?: string;
  dueDate?: string;
  description?: string;
  remarks?: string;
  // "Create based on" (Morning OpenAPI): the ids of the documents this one
  // derives from. Passing the source id here is what makes Morning close the
  // original — e.g. a deal invoice issued against a work order (type 100).
  // Declared here only; no caller sets them yet.
  linkedDocumentIds?: string[];
  linkType?: string;
  client: {
    id?: string;
    name?: string;
    emails?: string[];
    // Never let Morning auto-create a client from a document (owner rule
    // 2026-07-19). If we don't already hold a morning_client_id we refuse
    // to issue at all, so `add` is hard-wired false at the call site.
    add: false;
  };
  income: MorningIncomeRow[];
};

// POST /documents -> 201
export type MorningDocumentResponse = {
  id: string;
  number: number;
  type: number;
  dueDate?: string;
  signed?: boolean;
  lang?: string;
  vatRate?: number;
  url?: { he?: string; en?: string; origin?: string };
  // 0 means no error. Surfaced into events because a tax-authority rejection
  // that nobody sees is exactly the kind of silence this system exists to
  // prevent (owner rule 2026-07-19).
  taxAuthorityConfirmationInitiated?: boolean;
  taxAuthorityConfirmationLastError?: number;
};
