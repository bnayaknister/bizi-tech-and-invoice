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

// Document-level VAT type (spec: 0 default / 1 exempt / 2 mixed).
export const VAT_TYPE_DEFAULT = 0;

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
