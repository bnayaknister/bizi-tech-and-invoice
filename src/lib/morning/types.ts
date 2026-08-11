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

// The document types this app can queue. Maps 1:1 onto the pending_doc_type
// enum — four values in 0025, plus 'receipt' in 0053.
export type PendingDocType = "work_order" | "deal_invoice" | "tax_invoice" | "tax_receipt" | "receipt";

export const DOC_TYPE_TO_MORNING_CODE: Record<PendingDocType, number> = {
  work_order: MORNING_DOC_CODE.order,
  deal_invoice: MORNING_DOC_CODE.deal_invoice,
  tax_invoice: MORNING_DOC_CODE.tax_invoice,
  tax_receipt: MORNING_DOC_CODE.tax_receipt,
  receipt: MORNING_DOC_CODE.receipt,
};

export const DOC_TYPE_LABEL: Record<PendingDocType, string> = {
  work_order: "הזמנת עבודה",
  deal_invoice: "חשבון עסקה",
  tax_invoice: "חשבונית מס",
  tax_receipt: "חשבונית מס קבלה",
  receipt: "קבלה",
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

/**
 * The label that PRINTS at the head of a document's `description` — the bold
 * line above the item table on the PDF.
 *
 * Morning's vocabulary, for the same reason sourceRemark above uses it: the
 * remark a few lines further down the SAME page already says "חשבונית מס /
 * קבלה", and a page that names itself two ways is a page nobody can reconcile
 * against the books. DOC_TYPE_LABEL stays what our own SCREENS say and must not
 * reach a printed document.
 *
 * ONE source for the label, two callers — the builder (taxFromParent) and the
 * normalizer below. Neither composes the string itself. That is the whole point:
 * the bug this replaces was a description built once, at enqueue, from the type
 * the row happened to start as, while the variant is chosen much later.
 *
 * For 305 this returns the same bytes DOC_TYPE_LABEL did ("חשבונית מס",
 * verified byte-for-byte 2026-08-11), so moving the builder onto it moves no
 * existing row. 320 is the value that changes, and is the bug.
 */
export function docDescriptionLabel(docType: PendingDocType): string {
  return MORNING_DOC_NAME[DOC_TYPE_TO_MORNING_CODE[docType]];
}

/**
 * The separator between the label and the rest of a description, and the word
 * the bundled form inserts before it.
 *
 * Verified byte-for-byte against the builder (2026-08-11): SPACE, U+2014 EM
 * DASH, SPACE — `20 e2 80 94 20`. NOT a hyphen. If this constant and the
 * builder's template ever disagree, every row stops matching and the normalizer
 * silently does nothing, which is exactly the failure this comment exists to
 * prevent.
 */
const DESCRIPTION_SEPARATOR = " — ";
const DESCRIPTION_BUNDLE_MARK = "מאוגד";

/**
 * Every label a tax description could be carrying, longest FIRST.
 *
 * Longest-first is required, not cosmetic: "חשבונית מס" is a prefix of both
 * "חשבונית מס / קבלה" and "חשבונית מס קבלה", so a shortest-first scan would
 * match a 320's description on the 305 label, fail to recognize the remainder,
 * and declare a perfectly ordinary row hand-edited.
 *
 * DOC_TYPE_LABEL is in the set too. Nothing writes it into a description today
 * (the builder is moving off it in this same change), but recognizing it costs
 * nothing and means a row written by any past version is still normalizable.
 */
const TAX_DESCRIPTION_LABELS: string[] = Array.from(
  new Set(
    (["tax_invoice", "tax_receipt"] as PendingDocType[]).flatMap((t) => [
      MORNING_DOC_NAME[DOC_TYPE_TO_MORNING_CODE[t]],
      DOC_TYPE_LABEL[t],
    ])
  )
).sort((a, b) => b.length - a.length);

export type RelabelResult =
  | { ok: true; description: string; changed: boolean }
  | { ok: false };

/**
 * Swap the LABEL at the head of a description for the one the final type wants,
 * and change nothing else.
 *
 * Deliberately not a rebuild. The remainder — the client name, the bundle
 * count, whatever a human typed after the separator — is carried across
 * verbatim, so this never needs to know who the client is or how many sources
 * there were, and can never disagree with the builder about either.
 *
 * The two shapes the builder produces, and ONLY those, are recognized:
 *     "<label> — <rest>"
 *     "<label> מאוגד — <rest>"
 * Anything else is a sentence a person wrote. `ok: false` means "leave it
 * alone" — never "fail": a hand-edited description that no longer matches its
 * type is a thing to warn about, not a thing to overwrite.
 *
 * Idempotent by construction: a description already carrying the right label
 * comes back `changed: false`, so running it on every approval is a no-op on
 * every row that is already correct.
 */
export function relabelDocDescription(
  description: string | null | undefined,
  finalType: PendingDocType
): RelabelResult {
  if (typeof description !== "string" || description.trim() === "") return { ok: false };
  const target = docDescriptionLabel(finalType);
  if (!target) return { ok: false };

  for (const label of TAX_DESCRIPTION_LABELS) {
    if (!description.startsWith(label)) continue;
    const rest = description.slice(label.length);
    const shaped =
      rest.startsWith(DESCRIPTION_SEPARATOR) ||
      rest.startsWith(` ${DESCRIPTION_BUNDLE_MARK}${DESCRIPTION_SEPARATOR}`);
    // the longest matching label decides; a match whose remainder is not one of
    // the builder's shapes is hand-edited, not a reason to try a shorter one
    if (!shaped) return { ok: false };
    const next = target + rest;
    return { ok: true, description: next, changed: next !== description };
  }
  return { ok: false };
}

/**
 * The types that carry a `payment` block — money that actually moved.
 *
 *  320 חשבונית מס / קבלה — an invoice AND a receipt in one
 *  400 קבלה             — a receipt alone
 *
 * Everything else (100 / 300 / 305) declares a debt, not a payment, and must
 * NOT carry the block at all.
 *
 * Lives here, beside the document codes it is made of, because it is a fact
 * about Morning's document model — not about our reconciliation. The matcher in
 * lib/documents/reconcile.ts imports it from here; before 0053 it owned the
 * constant, which meant the issuance path had to reach into the after-the-fact
 * matching engine to learn what a receipt is.
 */
export const PAYMENT_TYPES: number[] = [MORNING_DOC_CODE.tax_receipt, MORNING_DOC_CODE.receipt];

/** Does a document of this Morning type require a `payment` block to be valid? */
export function requiresPayment(morningTypeCode: number): boolean {
  return PAYMENT_TYPES.includes(morningTypeCode);
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

/**
 * One line of the money side of a document — what was actually received.
 *
 * Read off 66 real payment lines across 5 tax-receipts and 61 receipts in the
 * account (2026-08-10), not from documentation:
 *
 *  • `price` and `amount` were EQUAL on all 278 lines, zero exceptions, and
 *    both are GROSS (the income lines are net; Morning adds the VAT). Write the
 *    same gross value into both — there is no case here where they diverge.
 *  • `type` is Morning's payment-method code. The five in use, by volume:
 *      4  העברה בנקאית   (222)
 *      0  ניכוי במקור     (31)
 *      2  צ׳ק            (19)
 *      10 אפליקציית תשלום (4)
 *      3  כרטיס אשראי     (2)
 *  • type 0 is NOT a payment method — it is withholding tax, and it appears as
 *    a SECOND line beside the real one: the bank transfer plus the withheld
 *    amount together make the document total. That is why this is an array,
 *    and why a validator must sum the lines rather than read the first.
 *
 * `currencyRate` is 1 for ILS. Kept explicit because Morning returns it.
 */
export type MorningPaymentRow = {
  type: number;
  date: string;
  /** gross. always equal to `amount` — see the note above */
  price: number;
  /** gross. always equal to `price` */
  amount: number;
  currency: string;
  currencyRate: number;
  description?: string;
};

/**
 * The payment methods this app accepts, in picker order — a closed ALLOW-LIST,
 * not a copy of Morning's code table.
 *
 * Counted off 278 real payment lines in the owner's own books (2026-08-10):
 *   4  העברה בנקאית   (222)   ← the default, and most of the account
 *   2  צ׳ק            (19)
 *   10 אפליקציית תשלום (4)
 *   3  כרטיס אשראי     (2)
 * A code we cannot read off a real document is a code we cannot label honestly,
 * so it is not here. Morning documents others; that is not sufficient.
 *
 * 0 (ניכוי במקור) is ABSENT and must stay absent — see MorningPaymentRow. It is
 * withholding, a SECOND line beside the real payment, never a payment on its
 * own. A receipt whose only line is code 0 declares that money arrived when
 * none did, and a receipt cannot be taken back.
 *
 * ONE list, two enforcers: the picker builds its options from it and the review
 * route refuses anything outside it. Removing a method here removes it from
 * both at once. It lives on the server side of the line because `type` became
 * client-supplied input the moment the picker offered a choice, and issue.ts
 * sends the payload to Morning verbatim — a rule the screen enforces and the
 * server does not is not a rule.
 */
export const PAYMENT_METHODS: readonly { code: number; label: string }[] = [
  { code: 4, label: "העברה בנקאית" },
  { code: 2, label: "צ׳ק" },
  { code: 3, label: "כרטיס אשראי" },
  { code: 10, label: "אפליקציית תשלום" },
];

/** Is this one of the methods above? Anything else is refused, including 0. */
export function isAllowedPaymentMethod(code: number): boolean {
  return PAYMENT_METHODS.some((m) => m.code === code);
}

/** The methods named the way the books name them, for an error message. */
export function paymentMethodsSentence(): string {
  return PAYMENT_METHODS.map((m) => `${m.label} (${m.code})`).join(", ");
}

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
  /**
   * OPTIONAL as of 0053, and only because a receipt (400) carries none: all 61
   * receipts in the account have zero income lines and a payment block instead.
   * Every other type still requires them — that pairing is enforced in the
   * review route before issuing, not by this type. A payload with neither is a
   * server-side refusal, not a compile error.
   */
  income?: MorningIncomeRow[];
  /**
   * The money side. Required on 320 and 400, forbidden on 100/300/305 — the
   * split `PAYMENT_TYPES` above draws. An array: withholding tax rides as a
   * second line (see MorningPaymentRow).
   */
  payment?: MorningPaymentRow[];
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
