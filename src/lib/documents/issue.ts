import type { SupabaseClient } from "@supabase/supabase-js";
import { createDocument, MorningError, isDryRun, morningEnv } from "@/lib/morning/client";
import { DOC_TYPE_TO_MORNING_CODE, type MorningDocumentRequest, type PendingDocType } from "@/lib/morning/types";
import { upsertDocument } from "@/lib/documents/registry";

// Turning an APPROVED queue row into a real document. This is the only
// place in the app that causes a document to exist in Morning.
//
// Iron rules (owner, 2026-07-19), each mapped to code below:
//  1. morning_doc_id UNIQUE — checked BEFORE the call (don't issue twice)
//     and AFTER it (don't record twice). A duplicate document against the
//     tax authority is a real-world problem, not a data blemish.
//  2. All or nothing — a failed call writes NO local document row. The
//     queue row goes to 'failed' with the error and stays re-runnable.
//  4. Every call is evented: what was sent, what came back, who approved.

export type IssueOutcome =
  | { ok: true; morningDocId: string; docNumber: string; pdfUrl: string | null; dryRun: boolean }
  | { ok: false; error: string; alreadyIssued?: boolean };

export type PendingRow = {
  id: string;
  doc_type: PendingDocType;
  production_id: string | null;
  job_id: string | null;
  client_id: string | null;
  amount: number | null;
  payload: MorningDocumentRequest;
  status: string;
  morning_doc_id: string | null;
  attempts: number | null;
};

// invoices.type is the two-value enum ('עסקה','מס'). A work order is not an
// invoice and gets no registry row — it lives in pending_documents only.
// (The full 5-tab document screen is where that widens; until then this
// keeps the finance registry meaning exactly what it means today.)
function registryType(docType: PendingDocType): "עסקה" | "מס" | null {
  if (docType === "deal_invoice") return "עסקה";
  if (docType === "tax_invoice" || docType === "tax_receipt") return "מס";
  return null;
}

export async function issuePendingDocument(
  admin: SupabaseClient,
  row: PendingRow,
  actorId: string
): Promise<IssueOutcome> {
  // ---- iron rule 1, before ------------------------------------------------
  if (row.morning_doc_id) {
    return { ok: false, error: "המסמך כבר הונפק", alreadyIssued: true };
  }
  if (row.status === "issued") {
    return { ok: false, error: "המסמך כבר הונפק", alreadyIssued: true };
  }

  const sent = row.payload;
  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: row.id,
    event_type: "morning_call_started",
    actor_id: actorId,
    payload: { doc_type: row.doc_type, env: morningEnv(), dry_run: isDryRun(), sent },
  });

  let result;
  let dryRun = false;
  try {
    const res = await createDocument(sent);
    result = res.result;
    dryRun = res.dryRun;
  } catch (e) {
    const err = e instanceof MorningError ? e : null;
    const message = e instanceof Error ? e.message : "שגיאה לא ידועה מול מורנינג";
    // iron rule 2: nothing local is written. The row records the failure and
    // remains eligible for another attempt.
    await admin
      .from("pending_documents")
      .update({
        status: "failed",
        last_error: message,
        attempts: (row.attempts ?? 0) + 1,
      })
      .eq("id", row.id);
    await admin.from("events").insert({
      entity_type: "pending_document",
      entity_id: row.id,
      event_type: "morning_call_failed",
      actor_id: actorId,
      payload: { doc_type: row.doc_type, error: message, status: err?.status ?? null, body: err?.body ?? null, sent },
    });
    return { ok: false, error: message };
  }

  const morningDocId = result.id;
  const docNumber = String(result.number ?? "");
  const pdfUrl = result.url?.origin || result.url?.he || null;

  // ---- iron rule 1, after -------------------------------------------------
  // The id Morning just returned must not already exist locally. If it does,
  // this document was recorded by another path (a retry that actually
  // succeeded, the daily pull) — stop rather than write a second row.
  const { data: clash } = await admin
    .from("pending_documents")
    .select("id")
    .eq("morning_doc_id", morningDocId)
    .neq("id", row.id)
    .maybeSingle();
  const { data: invClash } = await admin
    .from("invoices")
    .select("id")
    .eq("morning_doc_id", morningDocId)
    .maybeSingle();

  if (clash || invClash) {
    await admin.from("events").insert({
      entity_type: "pending_document",
      entity_id: row.id,
      event_type: "morning_duplicate_detected",
      actor_id: actorId,
      payload: { morning_doc_id: morningDocId, clash_pending: clash?.id ?? null, clash_invoice: invClash?.id ?? null },
    });
    return { ok: false, error: `מסמך ${morningDocId} כבר רשום במערכת — לא נרשם פעמיים`, alreadyIssued: true };
  }

  const issuedAt = new Date().toISOString();

  // The queue row is the source of truth for the issuance itself.
  const { error: updErr } = await admin
    .from("pending_documents")
    .update({
      status: "issued",
      morning_doc_id: morningDocId,
      morning_doc_number: docNumber,
      pdf_url: pdfUrl,
      issued_at: issuedAt,
      last_error: null,
    })
    .eq("id", row.id);
  if (updErr) {
    return { ok: false, error: `המסמך הונפק (${morningDocId}) אך רישומו נכשל: ${updErr.message}` };
  }

  // Write-through to the documents registry (all types, incl. work orders
  // and receipts) so an app-issued document shows on the 5-tab screen at
  // once, not only after the next daily pull. Same morning_doc_id the pull
  // upserts on, so the two never duplicate.
  await upsertDocument(admin, {
    morning_doc_id: morningDocId,
    morning_doc_number: docNumber || null,
    type: DOC_TYPE_TO_MORNING_CODE[row.doc_type],
    client_id: row.client_id,
    amount: row.amount,
    document_date: issuedAt.slice(0, 10),
    pdf_url: pdfUrl,
    source: "app",
    production_id: row.production_id,
    job_id: row.job_id,
    raw: result,
  });

  // Invoices (not work orders) also land in the finance registry, so the
  // existing finance screen keeps showing every document that exists.
  const regType = registryType(row.doc_type);
  if (regType && row.client_id) {
    await admin.from("invoices").insert({
      client_id: row.client_id,
      job_id: row.job_id,
      type: regType,
      doc_number: docNumber,
      morning_doc_id: morningDocId,
      amount: row.amount ?? 0,
      issued_at: issuedAt,
      source: "morning_api",
      issued_by: actorId,
      pdf_url: pdfUrl,
    });
  }

  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: row.id,
    event_type: dryRun ? "morning_document_issued_dryrun" : "morning_document_issued",
    actor_id: actorId,
    payload: {
      doc_type: row.doc_type,
      env: morningEnv(),
      dry_run: dryRun,
      morning_doc_id: morningDocId,
      doc_number: docNumber,
      pdf_url: pdfUrl,
      // owner rule 2026-07-19: a tax-authority failure must be visible
      tax_authority_last_error: result.taxAuthorityConfirmationLastError ?? null,
      tax_authority_initiated: result.taxAuthorityConfirmationInitiated ?? null,
      returned: result,
    },
  });

  return { ok: true, morningDocId, docNumber, pdfUrl, dryRun };
}
