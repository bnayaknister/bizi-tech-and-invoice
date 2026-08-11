import { MORNING_DOC_CODE, type MorningIncomeRow } from "@/lib/morning/types";

// The pull -> tax-source mapper (owner spec 2026-08-11). Turns a `documents`
// row whose raw came from the daily pull into the SourceRow shape the tax
// builder (taxFromParent.ts) inherits from — so a document raised by hand in
// Morning can father a 305/320 exactly like one the app issued.
//
// ⚠️ UNREACHABLE BY DESIGN, stage 1 of a staged rollout: no route calls this
// and no button reaches it. Stage 2 wires it into createTaxFromParents behind
// the same gates; until then the only caller is the read-only eligibility
// report in scripts/report_pull_tax_eligibility.ts. Same discipline as the
// receipt builder before its review gate existed.
//
// Everything here is PURE and read-only: the caller fetches the row, this file
// judges and maps it. Nothing is persisted — deliberately. The rejected
// alternative was a "shadow" pending_documents row built from raw, and it was
// rejected because pending_documents.payload records what we actually sent to
// Morning; a synthesized payload stored there is a lie that every consumer of
// issued rows (radar, accrued, parentGross) would read as truth.
//
// THE ONE MISTAKE THIS FILE EXISTS TO PREVENT: sending gross where Morning
// expects net. raw.income lines carry both `price` (net, per unit) and
// `amountTotal` (gross); the outgoing income line carries only `price`, and
// Morning adds VAT on top of whatever it receives. Map the wrong field and the
// client is billed VAT on top of VAT — and there is no PUT on documents to fix
// it. Hence the three-layer arithmetic gate below: the mapped net must agree
// with Morning's own amountExcludeVat, two independent derivations of the same
// number.

/**
 * Net-amount ceiling for the pull path, in ILS.
 *
 * POLICY, NOT A TECHNICAL LIMIT (owner decision 2026-08-11): a document an
 * order of magnitude above the studio's routine sizes does not go through a
 * route this young — it is issued by hand in Morning. The largest routine
 * document is 2,400 ₪ net; 10,000 leaves comfortable room for a legitimate
 * outlier while still catching the real case that prompted this (40258,
 * 250,000 ₪ net). Raising it is a deliberate owner decision — never a tweak
 * "so that a document passes".
 */
export const PULL_NET_CEILING = 10_000;

// Rounding tolerance for the arithmetic gates. Morning stores agorot, so a
// single comparison can be off by half an agora each side; document-level sums
// scale with the line count.
const LINE_TOL = 0.011;
const docTol = (lines: number) => LINE_TOL * Math.max(1, lines);

/**
 * What the mapper needs from a `documents` row. A subset of the table, named
 * here so the stage-2 caller and the report script select the same columns.
 */
export type PullDocRow = {
  id: string;
  morning_doc_id: string | null;
  morning_doc_number: string | null;
  type: number;
  source: string;
  client_id: string | null;
  job_id: string | null;
  /** gross for a pulled doc (raw.amount) — used to CHECK the mapping, never as the mapped amount */
  amount: number | null;
  cancelled_at: string | null;
  archived_at: string | null;
  raw: unknown;
};

/**
 * The mapped source, shaped to slot into the builder's SourceRow in stage 2.
 * `id` is documents.id, NOT a pending_documents id — the stage-2 seam must
 * keep the two id spaces apart (the builder's bundle_job_ids lookup and its
 * event payloads key on pending ids today).
 */
export type MappedPullSource = {
  id: string;
  doc_type: "deal_invoice";
  /** by construction: a document the pull returned exists in Morning, issued */
  status: "issued";
  client_id: string | null;
  /** NET, summed from the mapped income lines — NEVER documents.amount (gross for pull docs) */
  amount: number;
  income: MorningIncomeRow[];
  morning_client_id: string;
  morning_client_name: string | null;
  morning_doc_id: string;
  morning_doc_number: string;
  job_id: string | null;
};

export type PullMapResult = { ok: true; source: MappedPullSource } | { ok: false; error: string };

type IncomeResult = { ok: true; income: MorningIncomeRow[]; net: number } | { ok: false; error: string };

/** How a document is named in a refusal — the printed number when we hold one. */
function nameOf(d: PullDocRow): string {
  if (d.morning_doc_number) return `#${d.morning_doc_number}`;
  return d.morning_doc_id ?? d.id;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The three-state openness read — third copy, after taxFromParent.ts and
 * receiptFromTaxInvoice.ts, duplicated on the same grounds those two give:
 * each proven caller keeps its own, rather than refactoring live code to share
 * ~15 lines. What DIFFERS here is the verdict on "unknown", and it follows the
 * receipt builder, not the tax builder: a PULLED document's raw is the search
 * item and always carries `ref` — one without it is a shape we don't
 * understand, and this path reads income out of that same raw, so a raw we
 * cannot read is a document we cannot price. Refuse; the pending path's
 * "unknown = warn" exists for app-issued rows awaiting their first pull, a
 * state a pull-sourced document is never in.
 */
function readOpenness(raw: unknown): { state: "unknown" } | { state: "closed" } | { state: "open"; allowedCodes: number[] } {
  const r = asRecord(raw);
  if (!r || !("ref" in r)) return { state: "unknown" };
  const ref = r.ref;
  if (!Array.isArray(ref)) return { state: "unknown" };
  if (ref.length === 0) return { state: "closed" };
  const codes = ref.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  return { state: "open", allowedCodes: codes };
}

/**
 * Map raw.income to the outgoing MorningIncomeRow[] and prove, arithmetically,
 * that what was mapped is the NET.
 *
 * Field by field (owner-approved 2026-08-11):
 *   description ← description   verbatim — it is what prints on the child
 *   quantity    ← quantity      verbatim — price is per unit
 *   price       ← price         NET per unit. Never `amount`, never `amountTotal`
 *   currency    ← currency      copied; non-ILS is a refusal (the outgoing
 *                               payload pins the document to ILS)
 *   vatType     ← vatType       copied from the LINE, never hard-wired 0: an
 *                               exempt line (vatType 1) mapped to 0 would get
 *                               VAT the parent never charged — irreversible
 * Dropped: vat, vatRate, amount, amountTotal (Morning recomputes at issuance —
 * which also means a VAT-rate change between parent and child legitimately
 * shifts the child's GROSS; the net is the commitment), currencyRate (1 for
 * ILS), itemId/catalogNum (empty across the account).
 *
 * The gate has three layers, all refusals:
 *  1. per line:     price×quantity + vat = amountTotal — proves `price` is the
 *                   net field on THIS line (on an exempt line the two mappings
 *                   coincide, and so do their outcomes — nothing to catch)
 *  2. per document: Σ(price×quantity) = raw.amountExcludeVat — our derivation
 *                   of the net against Morning's own declaration of it; and
 *                   Σ amountTotal = raw.amount = documents.amount — proves we
 *                   read the document we think we read
 *  3. belt:         net ≈ documents.amount while raw.vat > 0 is the exact
 *                   signature of "gross mapped as net" — refuse even if the
 *                   layers above were edited away
 */
export function mapPullIncome(raw: unknown, docAmount: number | null): IncomeResult {
  const r = asRecord(raw);
  if (!r) return { ok: false, error: "raw אינו אובייקט — לא ניתן לקרוא את שורות ההכנסה" };
  const lines = Array.isArray(r.income) ? r.income : null;
  if (!lines || lines.length === 0) {
    return { ok: false, error: "אין שורות הכנסה במסמך שנמשך — לא ניתן לבנות מסמך מס" };
  }

  const income: MorningIncomeRow[] = [];
  let net = 0;
  let grossSum = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = asRecord(lines[i]);
    const at = `שורה ${i + 1}`;
    if (!line) return { ok: false, error: `${at}: אינה אובייקט` };

    const description = typeof line.description === "string" ? line.description.trim() : "";
    if (!description) return { ok: false, error: `${at}: אין תיאור — השורה מודפסת על המסמך ואינה יכולה להיות ריקה` };

    const quantity = num(line.quantity);
    const price = num(line.price);
    const vat = num(line.vat);
    const amountTotal = num(line.amountTotal);
    if (quantity === null || price === null || vat === null || amountTotal === null) {
      return { ok: false, error: `${at}: חסר אחד מהשדות quantity/price/vat/amountTotal — לא ניתן לאמת את הנטו` };
    }

    const currency = typeof line.currency === "string" ? line.currency : "";
    if (currency !== "ILS") return { ok: false, error: `${at}: מטבע ${currency || "חסר"} — מסלול זה מנפיק בשקלים בלבד` };

    const vatType = num(line.vatType);
    if (vatType !== 0 && vatType !== 1) {
      return { ok: false, error: `${at}: vatType ${line.vatType} אינו מוכר (0 רגיל / 1 פטור בלבד)` };
    }

    // layer 1: this line's `price` really is the net
    if (Math.abs(price * quantity + vat - amountTotal) > LINE_TOL) {
      return {
        ok: false,
        error: `${at}: price×quantity+vat (${price}×${quantity}+${vat}) אינו שווה ל-amountTotal (${amountTotal}) — לא ניתן להוכיח שהמחיר נטו`,
      };
    }

    income.push({ description, quantity, price, currency, vatType });
    net += price * quantity;
    grossSum += amountTotal;
  }

  const tol = docTol(lines.length);

  // layer 2a: our net vs Morning's declared net — the two independent derivations
  const amountExcludeVat = num(r.amountExcludeVat);
  if (amountExcludeVat === null || Math.abs(net - amountExcludeVat) > tol) {
    return {
      ok: false,
      error: `סכום הנטו הממופה (${net.toFixed(2)}) אינו שווה ל-amountExcludeVat של מורנינג (${amountExcludeVat ?? "חסר"}) — המיפוי לא מוכח`,
    };
  }

  // layer 2b: the grosses agree — we are reading the document we think we are
  const rawAmount = num(r.amount);
  if (rawAmount === null || Math.abs(grossSum - rawAmount) > tol) {
    return { ok: false, error: `סכום הברוטו של השורות (${grossSum.toFixed(2)}) אינו שווה ל-raw.amount (${rawAmount ?? "חסר"})` };
  }
  if (docAmount !== null && Math.abs(grossSum - docAmount) > tol) {
    return { ok: false, error: `סכום הברוטו של השורות (${grossSum.toFixed(2)}) אינו שווה לסכום המסמך ברישום (${docAmount})` };
  }

  // layer 3, the belt: the exact signature of gross-mapped-as-net
  const rawVat = num(r.vat) ?? 0;
  if (rawVat > 0 && docAmount !== null && Math.abs(net - docAmount) <= tol) {
    return { ok: false, error: "הנטו הממופה שווה לברוטו של המסמך למרות שיש מע״מ — נשלח ברוטו במקום נטו" };
  }

  return { ok: true, income, net: Math.round(net * 100) / 100 };
}

/**
 * Judge one `documents` row and map it to a builder-ready source.
 *
 * `childCode` is what the caller intends to raise (305 by default — the
 * variant flip to 320 happens at approval, and the builder re-checks the live
 * ref then). Every refusal covers the WHOLE document; there is no partial map.
 *
 * NOT gated here, deliberately:
 *  • the job link — that rule belongs to the builder's jobs gate ("a tax
 *    document must stamp the jobs it closes"), which stage 2 points at
 *    documents.job_id for this source. The mapper reports job_id and the
 *    screen disables the button up front rather than serving a 409.
 *  • idempotency and one-morning-doc-per-request — the builder owns both, and
 *    they are table-agnostic (keyed on morning_doc_id).
 */
export function mapPullDocToSource(
  doc: PullDocRow,
  childCode: number = MORNING_DOC_CODE.tax_invoice
): PullMapResult {
  // Only pulled documents. An app-issued document has a real pending row with
  // the payload we actually sent — that path must win, never this
  // reconstruction (stage-2 rule: the pending row beats the raw).
  if (doc.source !== "pull") {
    return { ok: false, error: `${nameOf(doc)}: מקורו ${doc.source} ולא מהמשיכה — מסמך שהאפליקציה הנפיקה נבנה משורת התור שלו` };
  }

  // v1 scope: deal invoices only. Work orders (100) can father a 305 by the
  // allow-list, but every open pull parent today is a 300 — widen deliberately,
  // not by default.
  if (doc.type !== MORNING_DOC_CODE.deal_invoice) {
    return { ok: false, error: `${nameOf(doc)}: מסלול המשיכה בונה על חשבון עסקה בלבד בשלב זה (התקבל type ${doc.type})` };
  }

  // The registry hides buttons on cancelled/archived rows; the server refuses
  // them regardless — the pending-path builder never needed this gate because
  // those states live only on `documents`.
  if (doc.cancelled_at) return { ok: false, error: `${nameOf(doc)}: סומן כמבוטל — לא ניתן להנפיק על סמכו` };
  if (doc.archived_at) return { ok: false, error: `${nameOf(doc)}: מאורכב — לא ניתן להנפיק על סמכו` };

  if (!doc.morning_doc_id) return { ok: false, error: `${doc.id}: אין מזהה מורנינג — לא ניתן לקשר אליו` };
  // the number is what gets PRINTED on the child (remarks) — refuse, never omit
  if (!doc.morning_doc_number || !String(doc.morning_doc_number).trim()) {
    return { ok: false, error: `${doc.morning_doc_id}: אין מספר מסמך — לא ניתן לציין אותו בהערת המקור` };
  }

  // both halves of the client identity: ours (so the child row is attributed
  // and the local-client gate in the builder holds) and Morning's (it goes
  // into the outgoing payload).
  if (!doc.client_id) {
    return { ok: false, error: `${nameOf(doc)}: הלקוח אינו משויך באפליקציה — שייכי אותו במסך הלקוחות קודם` };
  }
  const rawRec = asRecord(doc.raw);
  const rawClient = asRecord(rawRec?.client);
  const morningClientId = typeof rawClient?.id === "string" ? rawClient.id : "";
  if (!morningClientId) {
    return { ok: false, error: `${nameOf(doc)}: אין מזהה לקוח מורנינג במסמך שנמשך — לא ניתן לבנות מסמך מס` };
  }

  // document-level VAT mode: the outgoing payload pins vatType 0; a parent in
  // any other mode (exempt business, mixed) is out of this route's scope.
  const docVatType = num(rawRec?.vatType);
  if (docVatType !== 0) {
    return { ok: false, error: `${nameOf(doc)}: vatType ${rawRec?.vatType} ברמת המסמך — מסלול זה תומך במסמכי מע״מ רגיל בלבד` };
  }
  const docCurrency = typeof rawRec?.currency === "string" ? rawRec.currency : "";
  if (docCurrency !== "ILS") {
    return { ok: false, error: `${nameOf(doc)}: מטבע ${docCurrency || "חסר"} — מסלול זה מנפיק בשקלים בלבד` };
  }

  // openness, from the same raw the income comes from
  const openness = readOpenness(doc.raw);
  if (openness.state === "unknown") {
    return { ok: false, error: `${nameOf(doc)}: לא ניתן לקרוא את מצב המסמך ממורנינג (אין ref) — רענני את המשיכה ונסי שוב` };
  }
  if (openness.state === "closed") {
    return { ok: false, error: `${nameOf(doc)}: כבר סגור במורנינג — לא ניתן להנפיק על סמכו` };
  }
  if (!openness.allowedCodes.includes(childCode)) {
    return { ok: false, error: `${nameOf(doc)}: מורנינג אינה מתירה להנפיק על סמכו מסמך מסוג ${childCode}` };
  }

  const mapped = mapPullIncome(doc.raw, num(doc.amount));
  if (!mapped.ok) return { ok: false, error: `${nameOf(doc)}: ${mapped.error}` };

  // the ceiling — policy, see PULL_NET_CEILING
  if (mapped.net > PULL_NET_CEILING) {
    return {
      ok: false,
      error: `${nameOf(doc)}: סכום חריג למסלול זה (${mapped.net.toLocaleString("he-IL")} ₪ נטו, מעל תקרת ${PULL_NET_CEILING.toLocaleString("he-IL")} ₪) — יש להנפיק ידנית במורנינג`,
    };
  }

  return {
    ok: true,
    source: {
      id: doc.id,
      doc_type: "deal_invoice",
      status: "issued",
      client_id: doc.client_id,
      amount: mapped.net,
      income: mapped.income,
      morning_client_id: morningClientId,
      morning_client_name: typeof rawClient?.name === "string" ? rawClient.name : null,
      morning_doc_id: doc.morning_doc_id,
      morning_doc_number: String(doc.morning_doc_number),
      job_id: doc.job_id,
    },
  };
}
