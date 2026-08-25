import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { issuePendingDocument, type PendingRow } from "@/lib/documents/issue";
import { isDryRun, morningEnv } from "@/lib/morning/client";
import {
  DOC_TYPE_LABEL,
  DOC_TYPE_TO_MORNING_CODE,
  MORNING_DOC_CODE,
  isAllowedPaymentMethod,
  paymentMethodsSentence,
  relabelDocDescription,
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
 * Declared, not inherited (owner 2026-08-25).
 *
 * Nothing in this repo set maxDuration, so every function ran on whatever
 * Vercel's default happens to be — short, and free to change under us. That
 * default is load-bearing here: `MORNING_TIMEOUT_MS` (15s) is only useful if WE
 * abort before the platform kills the function, because the platform's kill
 * skips the catch in issue.ts and strands the row in 'approved'. Stating the
 * number here makes that ordering a property of the code instead of a fact
 * about a dashboard.
 *
 * 60 is room for a bulk approval of several documents at ~1.4s each, with slack
 * for one that times out. It is NOT a guarantee for a large batch of hanging
 * calls — N × 15s can still exceed it. That residue is exactly what the
 * 'approved' row on the queue screen is there to catch; the two fixes are
 * complementary and neither is claimed to close the hole alone.
 */
export const maxDuration = 60;

/**
 * The statuses a queued row may still be acted on from.
 *
 * Shared by approve AND reject, and that sharing is the point. Approve has
 * checked this since it was written; reject never did, which was invisible only
 * because the queue screen showed pending/failed and nothing else. Making
 * 'approved' visible (same owner decision) would have handed the bookkeeper a
 * "דחה" button on a row whose document may already exist in Morning — and
 * rejecting it would bury a real document behind a local status, with no trace
 * in Morning and nothing left on any screen to find it by. The guard goes in
 * the same change that makes the row visible, on the SERVER, because the UI
 * hiding a button is a decision the next caller does not inherit.
 */
const ACTIONABLE_STATUSES = ["pending", "failed"];

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
    // See ACTIONABLE_STATUSES. Refuse the whole request rather than reject the
    // eligible rows and skip the rest: a partial rejection reported as success
    // is how the one row that mattered gets lost.
    const blocked = rows.filter((r) => !ACTIONABLE_STATUSES.includes(r.status as string));
    if (blocked.length) {
      return NextResponse.json(
        {
          error: `לא ניתן לדחות מסמך בסטטוס ${blocked.map((r) => r.status).join(", ")} — ייתכן שהמסמך כבר נוצר במורנינג. בדקי שם לפני כל פעולה`,
        },
        { status: 409 }
      );
    }
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
    if (!ACTIONABLE_STATUSES.includes(r.status as string)) {
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
    // The parent's TYPE and NUMBER are not in the payload — only its Morning
    // ids are — so they are read back from `documents`, the registry of what
    // exists in Morning. If that lookup can't produce them, the flip is REFUSED
    // rather than issuing a document that names no parent (7d6136e).
    //
    // WHY `documents` AND NOT `pending_documents` (owner decision 2026-08-12,
    // production failure on 40291). The queue records what WE sent; the
    // registry records what EXISTS in Morning. A parent raised by hand in
    // Morning — which is most of this account's history, and the whole point of
    // the pull -> tax route — has no queue row at all, so the old lookup found
    // nothing and refused every pull-sourced flip. A parent the app issued sits
    // in BOTH tables under the same morning_doc_id (issue.ts write-through), so
    // the registry covers that case too: one lookup, both paths.
    //
    // Deliberately NO fallback to the queue. The one hole the registry could
    // have had was issue.ts discarding its write result — that is fixed at the
    // source in this same change (registry.ts), rather than papered over with a
    // second read path here.
    //
    // The type arrives as Morning's numeric CODE and stays one all the way into
    // sourceRemark. No reverse code -> PendingDocType map: the registry holds
    // types we never issue (quotes, credit notes), so such a map could only be
    // partial while looking total.
    if (body.tax_variant && TAX_VARIANTS.includes(r.doc_type as PendingDocType) && body.tax_variant !== r.doc_type) {
      const oldPayload = (r.payload ?? {}) as Record<string, unknown>;
      const linkedIds = Array.isArray(oldPayload.linkedDocumentIds)
        ? (oldPayload.linkedDocumentIds as string[])
        : [];
      const hasRemark = typeof oldPayload.remarks === "string" && oldPayload.remarks.trim() !== "";

      let newRemark: string | undefined;
      // per-parent audit trail — what the refusal event reports, and the only
      // way the NEXT failure gets diagnosed without a screenshot
      let lookup: Array<{ morning_doc_id: string; found: boolean; type: number | null; number: string | null }> = [];
      let readError: string | null = null;
      if (linkedIds.length) {
        const { data: parents, error: parentsErr } = await admin
          .from("documents")
          .select("morning_doc_id,type,morning_doc_number")
          .in("morning_doc_id", linkedIds);
        readError = parentsErr?.message ?? null;
        const byMorningId = new Map(
          ((parents ?? []) as { morning_doc_id: string; type: number | null; morning_doc_number: string | null }[]).map(
            (p) => [p.morning_doc_id, p]
          )
        );
        lookup = linkedIds.map((id) => {
          const p = byMorningId.get(id);
          const number = p?.morning_doc_number ? String(p.morning_doc_number).trim() : "";
          return { morning_doc_id: id, found: !!p, type: p?.type ?? null, number: number || null };
        });
        // every parent must be found, carry a number and a type, and be the
        // same type — the remark names the type once and lists the numbers
        const complete = lookup.length > 0 && lookup.every((p) => p.found && !!p.number && p.type !== null);
        const parentCodes = Array.from(new Set(lookup.map((p) => p.type).filter((t): t is number => t !== null)));
        if (complete && parentCodes.length === 1) {
          newRemark = sourceRemark(
            body.tax_variant,
            parentCodes[0],
            lookup.map((p) => p.number)
          );
        }
      }

      // no parent at all and no remark to contradict → a bare type flip is safe
      const parentless = linkedIds.length === 0 && !hasRemark;
      if (!parentless && !newRemark) {
        // Name the parents we could not resolve. A number when we hold one (the
        // bookkeeper recognises documents by number), the Morning id when we
        // don't — never a bare "not found" that doesn't say of what.
        const unresolved = lookup.filter((p) => !p.found || !p.number || p.type === null);
        const named = (unresolved.length ? unresolved : lookup)
          .map((p) => (p.number ? `#${p.number}` : p.morning_doc_id))
          .join(", ");
        const parentCodes = Array.from(new Set(lookup.map((p) => p.type).filter((t): t is number => t !== null)));
        const reason = readError
          ? "registry_read_failed"
          : !linkedIds.length
            ? "no_linked_ids"
            : unresolved.length
              ? "parent_not_in_registry"
              : parentCodes.length > 1
                ? "mixed_parent_types"
                : "unknown_parent_type";

        // The refusal used to be silent — no row written, no event, nothing to
        // read the next morning. Every 409 in this block now leaves a record
        // (owner rule 2026-08-12).
        await admin.from("events").insert({
          entity_type: "pending_document",
          entity_id: r.id,
          event_type: "tax_variant_switch_refused",
          actor_id: user.id,
          payload: {
            from: r.doc_type,
            to: body.tax_variant,
            reason,
            source_table: "documents",
            linked_document_ids: linkedIds,
            parents: lookup,
            parent_codes: parentCodes,
            has_remark: hasRemark,
            read_error: readError,
          },
        });

        // The old message said "cancel it and create it again". That was worse
        // than useless: a rebuild produces the identical row with the identical
        // linkedDocumentIds and fails at exactly this line, so it sent the
        // bookkeeper to delete a perfectly good document (owner, 2026-08-12).
        //
        // What is actually true is said instead: the row is fine, approving it
        // as it stands issues a correct document, and the block is our bug and
        // not something she can fix. The CURRENT type is named from the row —
        // the flip runs in both directions and telling her "approve as 305"
        // while she is holding a 320 would be a new wrong instruction.
        const currentType = r.doc_type as PendingDocType;
        const nameType = (t: PendingDocType) => `${DOC_TYPE_LABEL[t]} (${DOC_TYPE_TO_MORNING_CODE[t]})`;
        const why =
          reason === "registry_read_failed"
            ? `קריאת מרשם המסמכים נכשלה (${readError})`
            : reason === "no_linked_ids"
              ? "לשורה יש הערת מקור אך אין מסמכי מקור מקושרים"
              : reason === "mixed_parent_types"
                ? `מסמכי המקור ${named} אינם מאותו סוג`
                : reason === "unknown_parent_type"
                  ? `סוג מסמך המקור ${named} אינו מוכר`
                  : `מסמך המקור ${named} לא נמצא במרשם המסמכים`;

        return NextResponse.json(
          {
            error:
              `לא ניתן להחליף ל${nameType(body.tax_variant)}: ${why}, ולכן לא ניתן לבנות את הערת המקור. ` +
              `השורה עצמה תקינה — אפשר לאשר אותה כ${nameType(currentType)} והמסמך ייצא נכון. ` +
              "החסימה היא תקלה בקוד ולא משהו שצריך לתקן בשורה — דווחי עליה.",
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

    // ---- the printed label on the description -------------------------------
    // `description` is the BOLD line above the item table on the PDF, and it
    // opens with the document's own name. It was built once, when the row was
    // queued — always as 305, the only thing this app creates — so a row
    // approved as 320 went out saying "חשבונית מס" at the top of a page titled
    // "חשבונית מס / קבלה", contradicting both its own title and the remark
    // below the totals. 320 cannot be corrected afterwards.
    //
    // Runs OUTSIDE the flip block above, on every tax approval, on purpose. A
    // row already flipped to 320 by an earlier attempt that then failed to issue
    // is sitting in the queue as 320 with the old label; approving it again does
    // not re-enter the flip block, and the bug would survive there untouched.
    // Idempotent — a description already carrying the right label reports
    // `changed: false` and nothing is written.
    //
    // Only the LABEL is swapped. The remainder (client name, bundle count) is
    // carried across verbatim, so this never re-derives anything the builder
    // decided and can never disagree with it.
    if (TAX_VARIANTS.includes(row.doc_type as PendingDocType)) {
      const currentDesc = row.payload?.description;
      const relabelled = relabelDocDescription(currentDesc, row.doc_type as PendingDocType);
      if (relabelled.ok && relabelled.changed) {
        const relabelledPayload: MorningDocumentRequest = {
          ...row.payload,
          description: relabelled.description,
        };
        await admin.from("pending_documents").update({ payload: relabelledPayload }).eq("id", r.id);
        await admin.from("events").insert({
          entity_type: "pending_document",
          entity_id: r.id,
          event_type: "document_description_relabeled",
          actor_id: user.id,
          payload: { doc_type: row.doc_type, from: currentDesc ?? null, to: relabelled.description },
        });
        // what reaches Morning is THIS object, not the row in the table — the
        // update above is the audit trail, the line below is the document
        row = { ...row, payload: relabelledPayload as unknown as PendingRow["payload"] };
      } else if (!relabelled.ok && typeof currentDesc === "string" && currentDesc.trim() !== "") {
        // a description nobody's builder produced = a human wrote it. Left
        // exactly as written — overwriting a person's sentence to fix a label is
        // the worse mistake — and recorded, so a page whose label disagrees with
        // its type is explainable later. The modal warns before the click.
        await admin.from("events").insert({
          entity_type: "pending_document",
          entity_id: r.id,
          event_type: "document_description_not_relabeled",
          actor_id: user.id,
          payload: { doc_type: row.doc_type, description: currentDesc },
        });
      }
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
    // ---- the method allow-list ---------------------------------------------
    // Input validation, and it belongs HERE rather than only in the picker:
    // `type` became client-supplied the moment the modal offered a choice, and
    // issue.ts sends this payload to Morning verbatim. A rule only the screen
    // enforces is not a rule — the same pattern that let a 305's printed label
    // reach a 320.
    //
    // Runs before the arithmetic below and is independent of it: this decides
    // whether the METHOD is one we recognize, never how much money it is.
    const methodCode = Number(p.type);
    if (!isAllowedPaymentMethod(methodCode)) {
      // 0 gets its own sentence. It is the code most likely to arrive by
      // mistake, and "unsupported" would be a misleading way to describe it: it
      // is a real Morning code that means something specific and dangerous here.
      if (methodCode === 0) {
        return {
          ok: false,
          status: 400,
          error:
            `שורת תקבול ${i + 1}: ניכוי במקור אינו אמצעי תשלום אלא הפרש, ` +
            "והוא נרשם כשורה שנייה לצד התקבול עצמו. מסמך עם ניכוי אינו ניתן להנפקה מהמסך הזה.",
        };
      }
      return {
        ok: false,
        status: 400,
        error:
          `שורת תקבול ${i + 1}: אמצעי תשלום ${methodCode} אינו נתמך. ` +
          `האמצעים הנתמכים: ${paymentMethodsSentence()}.`,
      };
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
