import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { issuePendingDocument, type PendingRow } from "@/lib/documents/issue";
import { isDryRun, morningEnv } from "@/lib/morning/client";
import type { PendingDocType } from "@/lib/morning/types";

// Approve / reject queued documents. Approving is what makes a document
// real, so this route is the last gate before Morning.
//
// Two human gates, both enforced HERE and not only in the UI (owner rule
// 2026-07-19: "לחיצה אחת לא מספיקה. לעולם."):
//   1. can_edit_money
//   2. for a TAX document (חשבונית מס / מס קבלה) the request must carry
//      confirmed:true — the second modal. A client that forgets it gets a
//      412 telling it to confirm, never an issued tax document.
// Bulk approval is allowed for work orders and deal invoices (the busy-day
// case the owner asked for) and REFUSED for tax documents: each one needs
// its own confirmation.

const TAX_TYPES: PendingDocType[] = ["tax_invoice", "tax_receipt"];

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
  const taxRows = rows.filter((r) => TAX_TYPES.includes(r.doc_type as PendingDocType));
  if (taxRows.length) {
    if (rows.length > 1) {
      return NextResponse.json(
        { error: "מסמך מס מאושר אחד-אחד בלבד — אישור מרוכז אינו אפשרי" },
        { status: 400 }
      );
    }
    if (!body.confirmed) {
      // 412: the caller must show the confirmation modal and come back.
      const r = taxRows[0];
      return NextResponse.json(
        {
          error: "מסמך מס דורש אישור נוסף",
          needs_confirmation: true,
          document: { id: r.id, doc_type: r.doc_type, amount: r.amount, payload: r.payload },
        },
        { status: 412 }
      );
    }
  }

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
    if (body.tax_variant && TAX_TYPES.includes(r.doc_type as PendingDocType) && body.tax_variant !== r.doc_type) {
      const { DOC_TYPE_TO_MORNING_CODE } = await import("@/lib/morning/types");
      const newPayload = { ...(r.payload as object), type: DOC_TYPE_TO_MORNING_CODE[body.tax_variant] };
      await admin
        .from("pending_documents")
        .update({ doc_type: body.tax_variant, payload: newPayload })
        .eq("id", r.id);
      row = { ...row, doc_type: body.tax_variant, payload: newPayload as PendingRow["payload"] };
    }

    await admin
      .from("pending_documents")
      .update({ status: "approved", approved_by: user.id, approved_at: new Date().toISOString() })
      .eq("id", r.id);

    const outcome = await issuePendingDocument(admin, row, user.id);
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
