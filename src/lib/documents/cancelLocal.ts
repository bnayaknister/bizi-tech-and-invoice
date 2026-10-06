import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT "CANCELLED LOCALLY" MEANS — one definition, two callers.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Extracted from `api/documents/[id]/cancel/route.ts` on 2026-10-06, unchanged
 * in behaviour, because a SECOND route now needs exactly the same effect:
 * `cancel-in-morning` closes the document at Morning and then has to leave our
 * own tables in the state the old route already produced.
 *
 * 🔴 WHY EXTRACTED RATHER THAN RE-WRITTEN. The effect is four writes across
 * four tables, and three of them exist because of a specific incident:
 *
 *   documents          cancelled_at / _by / cancel_reason — the visible part
 *   jobs.invoice_biz   cleared, so the job reads "not billed" and a corrected
 *                      invoice can be issued. ⚠️ ONLY when it points at THIS
 *                      document — never stomp a later one.
 *   invoices           the mirrored finance-registry row, removed
 *   pending_documents  the queue row moved off 'issued'. This is the one that
 *                      was MISSING and made a corrective document impossible:
 *                      `pending_documents_one_live_per_production` counted the
 *                      stale 'issued' row and refused the replacement with a
 *                      raw 23505. Verified by simulation; 0063 alone did not
 *                      help, because nothing ever moved the row.
 *
 * A second hand-written copy of that list would drift on the first of the four
 * that somebody forgets, and the forgotten one would be invisible until a
 * bookkeeper could not re-issue an invoice.
 *
 * ═══ WHAT THIS FUNCTION DELIBERATELY DOES NOT DO ═══
 *   · no permission check — both callers gate on `can_edit_money` first
 *   · no type / state validation — the callers' guards differ (the Morning
 *     route additionally refuses `source='pull'` and live tax children) and
 *     folding them in here would let each caller skip the other's rules
 *   · no Morning call, ever. This is the LOCAL half by definition.
 *   · no `document_cancelled` event — see `events` below.
 *
 * It writes the queue-row events, though, and that asymmetry is deliberate:
 * they are per-released-row, generated here, and the caller cannot know how
 * many there were.
 */

export type CancelLocalDoc = {
  id: string;
  morning_doc_id: string | null;
  morning_doc_number: string | null;
  type: number;
  job_id: string | null;
};

export type CancelLocalResult = {
  invoiceBizCleared: boolean;
  invoiceRowDeleted: boolean;
  queueRowReleased: boolean;
};

/**
 * Apply the local cancellation. Returns what actually moved, which both callers
 * put into their own event payload.
 *
 * `cancelledAt` is injected rather than taken from the clock so the two routes
 * can stamp `documents.cancelled_at` and `documents.updated_at` with the same
 * instant, and so a test can assert the value.
 */
export async function cancelDocumentLocally(
  admin: SupabaseClient<Database>,
  doc: CancelLocalDoc,
  input: { userId: string; reason: string; cancelledAt: string }
): Promise<CancelLocalResult> {
  const docNumber = doc.morning_doc_number ?? null;
  const jobId = doc.job_id ?? null;

  // ---- revert a linked job to its pre-invoice state ----------------------
  let invoiceBizCleared = false;
  let invoiceRowDeleted = false;
  if (jobId) {
    const { data: job } = await admin.from("jobs").select("id,invoice_biz").eq("id", jobId).maybeSingle();
    // only clear the flag if it points at THIS document (don't stomp a later one)
    if (job && docNumber && job.invoice_biz === docNumber) {
      await admin.from("jobs").update({ invoice_biz: null }).eq("id", jobId);
      invoiceBizCleared = true;
    }
    // remove the mirrored finance-registry row for this document
    const { data: del } = await admin
      .from("invoices")
      .delete()
      .eq("morning_doc_id", doc.morning_doc_id as string)
      .select("id");
    invoiceRowDeleted = (del?.length ?? 0) > 0;
  }

  // ---- the document itself ------------------------------------------------
  await admin
    .from("documents")
    .update({
      cancelled_at: input.cancelledAt,
      cancelled_by: input.userId,
      cancel_reason: input.reason,
      updated_at: input.cancelledAt,
    })
    .eq("id", doc.id);

  // ---- release the queue row ---------------------------------------------
  // Keyed on morning_doc_id, which is UNIQUE (0025), so exactly the document
  // being cancelled is released — never a sibling on the same production. The
  // status filter makes a repeated call a no-op rather than a second event, and
  // refuses to disturb a row that has since moved on.
  let queueRowReleased = false;
  if (doc.morning_doc_id) {
    const { data: released } = await admin
      .from("pending_documents")
      .update({ status: "cancelled" })
      .eq("morning_doc_id", doc.morning_doc_id)
      .eq("status", "issued")
      .select("id");
    queueRowReleased = (released?.length ?? 0) > 0;
    for (const r of released ?? []) {
      await admin.from("events").insert({
        entity_type: "pending_document",
        entity_id: r.id,
        event_type: "document_cancelled_in_queue",
        actor_id: input.userId,
        payload: {
          morning_doc_number: docNumber,
          doc_type: doc.type,
          reason: input.reason,
          previous_status: "issued",
        },
      });
    }
  }

  return { invoiceBizCleared, invoiceRowDeleted, queueRowReleased };
}

// ───────────────────────────────────────────────────────────────────────────
// The gates that belong to the MORNING route only — pure, so they are testable
// without a database (F19).
// ───────────────────────────────────────────────────────────────────────────

/** Approved copy, 2026-10-06. */
export const TAX_CHILD_REFUSAL =
  "על המסמך הזה כבר יצאה חשבונית מס, ולכן אי אפשר לבטל אותו. צריך להוציא חשבונית זיכוי במורנינג.";

/**
 * Approved copy, 2026-10-06 — the four sentences the Morning route answers with.
 *
 * Here and not in the route: a Next.js route module may export only its handler
 * and a few config fields, and `next build` rejects anything else ("MSG_SUCCESS
 * is not a valid Route export field") while `tsc` passes it. They also belong
 * with the rest of the approved copy, so a test can read them without importing
 * a route handler.
 */
export const MSG_SUCCESS = "המסמך נסגר במורנינג וסומן כמבוטל.";
export const MSG_DRY_RUN = "מצב בדיקה — המסמך לא נסגר במורנינג, רק סומן אצלנו.";
export const MSG_TIMEOUT =
  "מורנינג לא הגיב תוך 15 שניות — לא ידוע אם המסמך נסגר. בדקו במורנינג לפני ניסיון חוזר. לא בוצע שום שינוי אצלנו.";
export const msgFailed = (error: string) =>
  `הסגירה במורנינג נכשלה — ${error}. לא בוצע שום שינוי אצלנו.`;

/** The document types this feature may close at Morning. */
export const MORNING_CANCELLABLE_TYPES = [100, 300] as const;

/**
 * A child document as the live-tax-child check reads it.
 *
 * `parent_relation` is NOT optional, and that is the whole point of the type.
 */
export type TaxChildRow = {
  type: number;
  cancelled_at: string | null;
  parent_doc_numbers: string[] | null;
  parent_relation: string | null;
};

/**
 * Does a LIVE tax document stand on this deal invoice?
 *
 * 🔴 `parent_relation === "derived"` IS REQUIRED, AND OMITTING IT INVERTS THE
 * ANSWER ON THE ROWS WHERE IT MATTERS MOST.
 *
 * 0075 stores two different kinds of link in the same column and says so
 * explicitly: *"ANY consumer joining on parent_doc_numbers MUST filter on
 * parent_relation first. That is the whole reason the second column exists."*
 * Five rows in the account read "ביטול חשבונית מס / קבלה 60162" — a receipt
 * that CANCELS a tax receipt — and they carry the target's number in exactly
 * the position a derivation does. Unfiltered, such a row would be read as "a
 * tax invoice stands on this document" when it means the opposite: that one was
 * cancelled. The refusal would fire on precisely the document that is now free
 * to be cancelled.
 *
 * ⚠️ A CANCELLED CHILD DOES NOT BLOCK. `cancelled_at` is checked because a 305
 * that has itself been cancelled is not a tax invoice that "went out" in any
 * sense the owner means — it is a corrected mistake, and the 300 under it is
 * exactly the one that needs cancelling next.
 *
 * Types: 305 (tax invoice), 320 (tax invoice + receipt). 400 is a plain receipt
 * and is NOT here — it is not a tax document in the sense that requires a
 * credit note, and a receipt against a deal invoice is a payment, not a bill.
 */
export const LIVE_TAX_CHILD_TYPES = [305, 320] as const;

export function hasLiveTaxChild(docNumber: string | null, children: TaxChildRow[]): boolean {
  const number = (docNumber ?? "").trim();
  if (!number) return false;
  return (children ?? []).some(
    (c) =>
      LIVE_TAX_CHILD_TYPES.includes(c.type as (typeof LIVE_TAX_CHILD_TYPES)[number]) &&
      !c.cancelled_at &&
      c.parent_relation === "derived" &&
      (c.parent_doc_numbers ?? []).some((p) => String(p ?? "").trim() === number)
  );
}

/**
 * The job-side half of the same question: `jobs.invoice_tax` is stamped when a
 * tax document is recorded against the job. Asked IN ADDITION to the document
 * walk because the two can disagree — a pulled 305 may carry a parent number
 * our parser never saw, and reconcile writes the job flag from a different
 * route (`reconcile.ts:720`).
 *
 * ⚠️ Either one blocking is deliberate. Refusing too often costs the owner a
 * click and a manual cancellation in Morning; refusing too rarely closes a deal
 * invoice that a live tax invoice is still standing on, which is a VAT problem.
 */
export function jobBlocksCancel(job: { invoice_tax?: string | null } | null | undefined): boolean {
  const v = job?.invoice_tax;
  return typeof v === "string" && v.trim() !== "";
}

/**
 * 🔴 WHAT "ALREADY CLOSED AT MORNING" IS ALLOWED TO MEAN.
 *
 * Morning does not document what `close` answers for a document that is already
 * closed (checked 2026-10-06 — the path is documented and nothing else is), and
 * a 100 that fathered a 300 is closed as a matter of course: `parentOpenness`
 * reads status 1 as "נסגר אוטומטית".
 *
 * So the owner's rule, and it is the conservative direction: a non-2xx that
 * looks like "already closed" counts as SUCCESS only when OUR OWN row already
 * says the document is closed (status 1 or 2). Then the error is agreement, not
 * a problem. If our row still says 0 — or says nothing at all, which a document
 * issued since the last pull does — then we do not know what Morning did, and a
 * guess in either direction is worse than reporting it.
 *
 * `null` status is explicitly NOT acceptable: `registrySelection.ts:73` already
 * documents that a freshly issued document carries no status until the next
 * pull, so null means "unknown", never "closed".
 */
export function alreadyClosedIsSuccess(ourStatus: number | null | undefined): boolean {
  return ourStatus === 1 || ourStatus === 2;
}

// ───────────────────────────────────────────────────────────────────────────
// The chain offer: a deal invoice derived from a work order.
// ───────────────────────────────────────────────────────────────────────────

/** Approved copy, 2026-10-06. */
export const CHAIN_QUESTION = (workOrderNumber: string) =>
  `חשבון העסקה נגזר מהזמנת עבודה ${workOrderNumber}. לבטל גם אותה?`;
export const CHAIN_BOTH = "בטל את שניהם";
export const CHAIN_ONLY_DEAL = "בטל רק את חשבון העסקה";
export const CHAIN_DISMISS = "ביטול";

/** Approved copy, 2026-10-06. The two buttons, and the window. */
export const BTN_CANCEL_IN_MORNING = "בטל במורנינג";
export const BTN_MARK_LOCALLY = "סמן כמבוטל אצלנו";
export const REASON_LABEL = "סיבת הביטול (חובה)";
export const WINDOW_BODY =
  "הפעולה תסגור את המסמך במורנינג ואז תסמן אותו כמבוטל גם אצלנו. אם הסגירה במורנינג תיכשל — שום דבר לא ישתנה אצלנו.";

/** "ביטול {הזמנת העבודה / חשבון העסקה} {מספר} במורנינג" */
export const DOC_KIND_LABEL: Record<number, string> = {
  100: "הזמנת העבודה",
  300: "חשבון העסקה",
};
export function windowTitle(type: number, number: string | null): string {
  return `ביטול ${DOC_KIND_LABEL[type] ?? "המסמך"} ${number ?? ""} במורנינג`.replace(/\s+/g, " ").trim();
}

/** A registry row as the chain lookup reads it. */
export type ChainRow = {
  id: string;
  type: number;
  source: string | null;
  morning_doc_number: string | null;
  parent_doc_numbers: string[] | null;
  parent_relation: string | null;
  cancelled_at: string | null;
};

/**
 * The parent WORK ORDER this deal invoice was derived from, when cancelling it
 * too is a question worth asking — otherwise null.
 *
 * 🔴 NO SILENT CASCADE. The owner's rule: the window OFFERS the parent and the
 * person chooses. A cascade that fired on its own would cancel a work order
 * nobody mentioned, and a work order is the row a corrected document gets
 * issued against.
 *
 * Four conditions, and each one removes a case where the question is wrong:
 *   type 300            only a deal invoice has a work-order parent to offer
 *   parent_relation     'derived' and never 'cancellation' — see hasLiveTaxChild
 *                       for what the other value means and why 0075 insists
 *   the parent is 100   a 300's parent in this account is a work order; anything
 *                       else is not something this feature closes
 *   source='app'        the Morning route refuses a pulled document anyway, so
 *                       offering it would be offering a button that returns 400
 *   not cancelled       an already-cancelled parent needs nothing
 *
 * Exactly one match is required. Two work-order parents on one deal invoice is
 * not a case anybody has seen (23 multi-parent rows exist, per parentLink.ts,
 * and none of them is this shape) and "which one did you mean" is not a question
 * a confirmation dialog can ask honestly.
 */
export function parentWorkOrderFor(deal: ChainRow, allRows: ChainRow[]): ChainRow | null {
  if (deal.type !== 300) return null;
  if (deal.parent_relation !== "derived") return null;
  const numbers = (deal.parent_doc_numbers ?? []).map((p) => String(p ?? "").trim()).filter(Boolean);
  if (!numbers.length) return null;
  const matches = (allRows ?? []).filter(
    (r) =>
      r.type === 100 &&
      r.source === "app" &&
      !r.cancelled_at &&
      numbers.includes((r.morning_doc_number ?? "").trim())
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Is the "בטל במורנינג" button offered on this row?
 *
 * Mirrors the route's first two gates exactly, and deliberately not the rest: a
 * live tax child is a REFUSAL WITH A SENTENCE, not a hidden button. The owner
 * has to learn that a credit note is needed, and a button that quietly vanished
 * teaches nothing — the same reasoning 3ג-1 applied to the approve button it
 * removed rather than greyed out, in the opposite direction, for the opposite
 * reason.
 */
export function offersMorningCancel(row: { type: number; source: string | null; cancelled_at: string | null }): boolean {
  if (row.cancelled_at) return false;
  if (row.source !== "app") return false;
  return MORNING_CANCELLABLE_TYPES.includes(row.type as (typeof MORNING_CANCELLABLE_TYPES)[number]);
}

/**
 * The ORDER of a "cancel both" run, as a value a test can assert.
 *
 * 🔴 THE DEAL INVOICE GOES FIRST, AND ONLY ITS SUCCESS RELEASES THE SECOND
 * STEP. Reversed, a failure on the 300 would leave the work order closed under
 * a deal invoice that is still live — a work order that can no longer father
 * the corrected document, which is the thing the owner needs next.
 */
export function cancelBothOrder(deal: ChainRow, parent: ChainRow): string[] {
  return [deal.id, parent.id];
}
