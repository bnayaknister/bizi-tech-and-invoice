import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { issuePendingDocument, type PendingRow } from "@/lib/documents/issue";
import { isDryRun, morningEnv } from "@/lib/morning/client";
import {
  DOC_TYPE_LABEL,
  DOC_TYPE_TO_MORNING_CODE,
  MORNING_DOC_CODE,
  requiresPayment,
  sourceRemark,
  type MorningDocumentRequest,
  type MorningPaymentRow,
  type PendingDocType,
} from "@/lib/morning/types";
import {
  fetchClientEmails,
  resolveDefaultRecipients,
  sanitizeRecipients,
} from "@/lib/documents/recipients";
import { sumParentGross } from "@/lib/documents/parentGross";

// Approve / reject queued documents. Approving is what makes a document
// real, so this route is the last gate before Morning.
//
// Two human gates, both enforced HERE and not only in the UI (owner rule
// 2026-07-19: "לחיצה אחת לא מספיקה. לעולם."):
//   1. can_edit_money
//   2. for anything in REQUIRES_CONFIRMATION (חשבונית מס / מס קבלה / קבלה) the
//      request must carry confirmed:true — the second modal. A client that
//      forgets it gets a 412 telling it to confirm, never an issued document.
// Bulk approval is allowed for work orders and deal invoices (the busy-day
// case the owner asked for) and REFUSED for those three: each one needs its own
// confirmation.
//
// A receipt joined that set on 2026-08-11. Nothing could reach Morning without
// confirmation before then either — the payment gate refuses a 400 with no
// payment block, and only the modal sends one — but that made the rule depend
// on the client, and this rule is not allowed to.

/**
 * The types that may not go out on one click: both human gates below apply to
 * them, and only to them.
 *
 * Named for the CRITERION, not for a property of the document. A deal invoice
 * is nearly irreversible too — undoing one means acting inside Morning — and it
 * is still fine to approve in bulk. What these three share is that a mistake is
 * a mistake against the tax authority, which is what earns the second click.
 */
const REQUIRES_CONFIRMATION: PendingDocType[] = ["tax_invoice", "tax_receipt", "receipt"];

/**
 * The two types that are the SAME document in two forms, and the only pair the
 * approval modal's selector switches between.
 *
 * Deliberately NOT the set above. A receipt is not a variant of anything: if it
 * were in this list, a request carrying tax_variant would silently rewrite a
 * 400 into a 320 — turning a receipt into a tax invoice without anyone asking.
 */
const TAX_VARIANTS: PendingDocType[] = ["tax_invoice", "tax_receipt"];

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    ids?: string[];
    action?: "approve" | "reject";
    reason?: string;
    confirmed?: boolean;
    // tax documents only: which of the two the bookkeeper chose in the modal
    tax_variant?: "tax_invoice" | "tax_receipt";
    // single-approve only: the recipients the bookkeeper chose in the picker.
    // For bulk (>1) we ignore this and apply the per-doc-type defaults instead.
    recipients?: string[];
    // 320 / 400 only: the money that actually moved, chosen at approval rather
    // than when the row was built. An array — withholding tax rides as a second
    // line beside the transfer (see MorningPaymentRow).
    payment?: MorningPaymentRow[];
  };

  // Dedupe first. The tax-document guard below counts documents, and a
  // caller repeating one id would otherwise make two requested documents
  // look like one fetched row — a single confirmation covering more than
  // one tax document is exactly what must never happen.
  const ids = Array.from(new Set((body.ids ?? []).filter(Boolean)));
  if (!ids.length) return NextResponse.json({ error: "לא נבחרו מסמכים" }, { status: 400 });
  if (body.action !== "approve" && body.action !== "reject") {
    return NextResponse.json({ error: "פעולה לא מוכרת" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("pending_documents")
    .select("id,doc_type,production_id,job_id,client_id,amount,payload,status,morning_doc_id,attempts")
    .in("id", ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!rows?.length) return NextResponse.json({ error: "המסמכים לא נמצאו" }, { status: 404 });
  // Never act on a partial set: if an id vanished between the screen and
  // here, the operator's intent no longer matches what we hold.
  if (rows.length !== ids.length) {
    return NextResponse.json(
      { error: `נמצאו ${rows.length} מסמכים מתוך ${ids.length} — רענן את המסך ונסה שוב` },
      { status: 409 }
    );
  }

  // ---- reject -------------------------------------------------------------
  if (body.action === "reject") {
    const reason = (body.reason ?? "").trim();
    if (!reason) return NextResponse.json({ error: "חובה לציין סיבת דחייה" }, { status: 400 });
    for (const r of rows) {
      await admin
        .from("pending_documents")
        .update({ status: "rejected", reject_reason: reason, approved_by: user.id, approved_at: new Date().toISOString() })
        .eq("id", r.id);
      await admin.from("events").insert({
        entity_type: "pending_document",
        entity_id: r.id,
        event_type: "document_rejected",
        actor_id: user.id,
        payload: { doc_type: r.doc_type, reason },
      });
    }
    return NextResponse.json({ ok: true, rejected: rows.length });
  }

  // ---- approve ------------------------------------------------------------
  const guardedRows = rows.filter((r) => REQUIRES_CONFIRMATION.includes(r.doc_type as PendingDocType));
  if (guardedRows.length) {
    if (rows.length > 1) {
      return NextResponse.json(
        { error: "מסמך מס או קבלה מאושר אחד-אחד בלבד — אישור מרוכז אינו אפשרי" },
        { status: 400 }
      );
    }
    if (!body.confirmed) {
      // 412: the caller must show the confirmation modal and come back.
      const r = guardedRows[0];
      return NextResponse.json(
        {
          error: "מסמך מס או קבלה דורש אישור נוסף",
          needs_confirmation: true,
          document: { id: r.id, doc_type: r.doc_type, amount: r.amount, payload: r.payload },
        },
        { status: 412 }
      );
    }
  }

  // Recipients (owner spec 2026-07-29). A single approve carries the picker's
  // explicit choice; a bulk approve has no picker, so each row falls back to its
  // per-doc-type default = the client's live emails (accountant is not a
  // default). A failed email read degrades to sending to nobody — never blocks.
  const providedRecipients =
    ids.length === 1 && Array.isArray(body.recipients) ? sanitizeRecipients(body.recipients) : null;

  const results: Array<{ id: string; ok: boolean; detail: string }> = [];
  for (const r of rows) {
    if (r.status !== "pending" && r.status !== "failed") {
      results.push({ id: r.id, ok: false, detail: `סטטוס ${r.status} — לא ניתן לאשר` });
      continue;
    }

    let row = r as unknown as PendingRow;

    // The modal lets the bookkeeper switch between מס קבלה and מס. Honour
    // that choice by rewriting the type on both the row and its payload
    // before issuing, so what goes out matches what she confirmed.
    //
    // `remarks` MUST be rebuilt with it. The remark names the document in
    // Morning's own words ("חשבונית מס / קבלה עבור חשבון עסקה 40277"), so
    // flipping only the type would print a 305 that calls itself a 320 — a
    // contradiction on a PDF that cannot be corrected afterwards (there is no
    // PUT on documents; a fix means cancel + re-issue).
    //
    // The parent's TYPE and NUMBERS are not in the payload — only its Morning
    // ids are — so they are read back from the queue rows those ids belong to.
    // If that lookup can't produce them, the flip is REFUSED rather than
    // issuing a document that names no parent (the failure fixed in 7d6136e).
    if (body.tax_variant && TAX_VARIANTS.includes(r.doc_type as PendingDocType) && body.tax_variant !== r.doc_type) {
      const oldPayload = (r.payload ?? {}) as Record<string, unknown>;
      const linkedIds = Array.isArray(oldPayload.linkedDocumentIds)
        ? (oldPayload.linkedDocumentIds as string[])
        : [];
      const hasRemark = typeof oldPayload.remarks === "string" && oldPayload.remarks.trim() !== "";

      let newRemark: string | undefined;
      if (linkedIds.length) {
        const { data: parents } = await admin
          .from("pending_documents")
          .select("doc_type,morning_doc_id,morning_doc_number")
          .in("morning_doc_id", linkedIds);
        const byMorningId = new Map(
          ((parents ?? []) as { doc_type: string; morning_doc_id: string; morning_doc_number: string | null }[]).map(
            (p) => [p.morning_doc_id, p]
          )
        );
        // every parent must be found, carry a number, and be the same type —
        // the remark names the type once and lists the numbers after it
        const resolved = linkedIds.map((id) => byMorningId.get(id));
        const complete =
          resolved.length > 0 &&
          resolved.every((p) => !!p && !!p.morning_doc_number && String(p.morning_doc_number).trim() !== "");
        const parentTypes = Array.from(new Set(resolved.map((p) => p?.doc_type).filter(Boolean)));
        if (complete && parentTypes.length === 1) {
          newRemark = sourceRemark(
            body.tax_variant,
            parentTypes[0] as PendingDocType,
            resolved.map((p) => p!.morning_doc_number)
          );
        }
      }

      // no parent at all and no remark to contradict → a bare type flip is safe
      const parentless = linkedIds.length === 0 && !hasRemark;
      if (!parentless && !newRemark) {
        return NextResponse.json(
          {
            error:
              "לא ניתן להחליף את סוג המסמך: לא נמצאו סוג ומספרי מסמך המקור, והערת המקור הייתה יוצאת שגויה. " +
              "אשרי את המסמך כפי שהוא, או בטלי אותו וצרי אותו מחדש.",
          },
          { status: 409 }
        );
      }

      const newPayload: Record<string, unknown> = {
        ...oldPayload,
        type: DOC_TYPE_TO_MORNING_CODE[body.tax_variant],
        ...(newRemark ? { remarks: newRemark } : {}),
      };
      await admin
        .from("pending_documents")
        .update({ doc_type: body.tax_variant, payload: newPayload })
        .eq("id", r.id);
      await admin.from("events").insert({
        entity_type: "pending_document",
        entity_id: r.id,
        event_type: "tax_variant_switched",
        actor_id: user.id,
        payload: { from: r.doc_type, to: body.tax_variant, remarks: newRemark ?? null },
      });
      row = { ...row, doc_type: body.tax_variant, payload: newPayload as unknown as PendingRow["payload"] };
    }

    // ---- the payment gate ---------------------------------------------------
    // Runs AFTER the variant flip (so the final type is known) and BEFORE the
    // row is marked approved (so a refusal leaves it exactly as it was —
    // 'pending', re-approvable, with nothing sent to Morning).
    //
    // Since `income` became optional in 0053, the type no longer guarantees that
    // a document declares anything at all. This gate is that guarantee now, and
    // it is a three-way split rather than a yes/no:
    //
    //   100 / 300 / 305   income required · payment FORBIDDEN — a debt, not money
    //   320               income required · payment required  — invoice AND receipt
    //   400               income forbidden · payment required — money only
    //
    // A payload carrying neither fails all three.
    {
      const gate = await checkPaymentShape(admin, row, body.payment);
      if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
      if (gate.payload) {
        await admin.from("pending_documents").update({ payload: gate.payload }).eq("id", r.id);
        row = { ...row, payload: gate.payload as unknown as PendingRow["payload"] };
      }
    }

    await admin
      .from("pending_documents")
      .update({ status: "approved", approved_by: user.id, approved_at: new Date().toISOString() })
      .eq("id", r.id);

    // resolve recipients for THIS row (its doc_type may have just been rewritten
    // by the tax-variant switch above, so read row.doc_type, not r.doc_type)
    let recipients: string[];
    if (providedRecipients) {
      recipients = providedRecipients;
    } else {
      const { emails } = await fetchClientEmails(admin, row.client_id);
      recipients = resolveDefaultRecipients(row.doc_type, emails);
    }

    const outcome = await issuePendingDocument(admin, row, user.id, recipients);
    results.push({
      id: r.id,
      ok: outcome.ok,
      detail: outcome.ok ? `${outcome.docNumber} (${outcome.morningDocId})` : outcome.error,
    });
  }

  return NextResponse.json({
    ok: results.every((r) => r.ok),
    dry_run: isDryRun(),
    env: morningEnv(),
    results,
  });
}

// ---------------------------------------------------------------------------
// the payment gate
// ---------------------------------------------------------------------------

/**
 * Rounding slack on the money comparison, in shekels.
 *
 * It exists for ONE reason: both sides are floats that travelled through JSON,
 * so 2360 can arrive as 2359.9999999999995. A hundredth of a shekel is wider
 * than any such artefact and narrower than any real error.
 *
 * It is NOT slack for a VAT difference, and must never be widened into one. A
 * payment that misses the document total by the tax — the classic net-instead-
 * of-gross mistake, 2000 against 2360 — is 360 shekels out and has to be
 * stopped, loudly, every time. If this number ever needs to grow to make a
 * document go through, the document is wrong, not the tolerance.
 */
const AMOUNT_EPSILON = 0.01;

type GateResult =
  | { ok: true; payload?: MorningDocumentRequest }
  | { ok: false; status: number; error: string };

/**
 * Validate — and, when the caller supplied one, inject — the payment block.
 *
 * Returns a rewritten payload only when something changed, so the common path
 * (an invoice, no payment) writes nothing.
 */
async function checkPaymentShape(
  admin: ReturnType<typeof createAdminClient>,
  row: PendingRow,
  supplied: MorningPaymentRow[] | undefined
): Promise<GateResult> {
  const code = DOC_TYPE_TO_MORNING_CODE[row.doc_type];
  const payload = { ...(row.payload as unknown as MorningDocumentRequest) };
  const needsPayment = requiresPayment(code);
  const isReceipt = code === MORNING_DOC_CODE.receipt;

  // the caller's block wins over whatever the row carried — the money is chosen
  // at approval, and a stale block from an earlier attempt must not survive
  if (supplied !== undefined) payload.payment = supplied;
  const paymentRows = Array.isArray(payload.payment) ? payload.payment : [];
  const incomeRows = Array.isArray(payload.income) ? payload.income : [];

  // ---- payment: forbidden where it does not belong ------------------------
  if (!needsPayment && paymentRows.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `${DOC_TYPE_LABEL[row.doc_type]} אינו נושא שורות תקבול — הוא מצהיר על חוב, לא על כסף שהתקבל`,
    };
  }

  // ---- income: required except on a receipt -------------------------------
  if (isReceipt && incomeRows.length > 0) {
    return { ok: false, status: 400, error: "קבלה אינה נושאת שורות הכנסה" };
  }
  if (!isReceipt && incomeRows.length === 0) {
    return {
      ok: false,
      status: 400,
      error: `${DOC_TYPE_LABEL[row.doc_type]} בלי שורות הכנסה — אין מה להנפיק`,
    };
  }

  if (!needsPayment) return { ok: true, payload: supplied !== undefined ? payload : undefined };

  // ---- payment: required, and shaped ---------------------------------------
  if (paymentRows.length === 0) {
    return {
      ok: false,
      status: 400,
      error: `${DOC_TYPE_LABEL[row.doc_type]} מצהיר שהכסף התקבל, ולכן חייב שורת תקבול. יש למלא אמצעי, סכום ותאריך.`,
    };
  }
  for (let i = 0; i < paymentRows.length; i++) {
    const p = paymentRows[i];
    const amount = Number(p?.amount);
    if (!Number.isFinite(amount)) {
      return { ok: false, status: 400, error: `שורת תקבול ${i + 1}: סכום לא תקין` };
    }
    if (!Number.isFinite(Number(p?.type))) {
      return { ok: false, status: 400, error: `שורת תקבול ${i + 1}: חסר אמצעי תשלום` };
    }
    if (!p?.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.date))) {
      return { ok: false, status: 400, error: `שורת תקבול ${i + 1}: תאריך לא תקין` };
    }
    // verified on all 278 payment lines in the account: price always equals
    // amount. A row where they diverge is a caller bug, not a case we support.
    if (p.price !== undefined && Math.abs(Number(p.price) - amount) > AMOUNT_EPSILON) {
      return { ok: false, status: 400, error: `שורת תקבול ${i + 1}: price ו-amount חייבים להיות זהים` };
    }
  }

  // ---- the sum, against the gross Morning itself computed on the parent ----
  // One source for both 320 and 400: documents.raw->'amount' of the parents
  // named in linkedDocumentIds. Not the queue row's own amount — that column is
  // net for a 320 and gross only for a 400 — and not income x a VAT rate, which
  // would put Morning's tax settings inside our issuance path.
  const linkedIds = Array.isArray(payload.linkedDocumentIds) ? payload.linkedDocumentIds : [];
  if (linkedIds.length === 0) {
    return {
      ok: false,
      status: 409,
      error: `${DOC_TYPE_LABEL[row.doc_type]} בלי מסמך מקור — לא ניתן לאמת את סכום התקבול`,
    };
  }

  // Same read the queue screen uses to prefill the amount — see parentGross.ts.
  // One implementation on purpose: a modal showing one figure while the server
  // enforced another would be worse than no prefill at all.
  const parents = await sumParentGross(admin, linkedIds);
  if (!parents.ok) return { ok: false, status: 409, error: parents.error };
  const gross = parents.gross;

  const paid = paymentRows.reduce((sum, p) => sum + Number(p.amount), 0);
  if (Math.abs(paid - gross) > AMOUNT_EPSILON) {
    return {
      ok: false,
      status: 400,
      error:
        `סכום התקבול (${paid.toFixed(2)}) אינו תואם את סכום המסמך (${gross.toFixed(2)}). ` +
        "סכום כל שורות התקבול, כולל ניכוי במקור, חייב להיות שווה לסכום המסמך ברוטו.",
    };
  }

  return { ok: true, payload };
}
