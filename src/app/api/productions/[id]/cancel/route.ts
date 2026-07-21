import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DOC_TYPE_LABEL, type PendingDocType } from "@/lib/morning/types";

// Cancel a production (owner spec 2026-07-21). Operational, not destructive:
// can_edit_stages (a technician may cancel — the cancellation happened in the
// real world). The row is kept; only its state changes.
//
// Downstream documents are handled by what already happened:
//   - a queued (pending/approved) document -> cancelled in the queue, nothing
//     ever reaches Morning
//   - an already-issued document -> left untouched in Morning (our rule: we
//     never delete there) and flagged; the radar's cancelled-with-document
//     alert (gap 2) surfaces it for manual closing
//
// When an issued document exists, the first call returns 409 needs_confirmation
// so the UI can warn ("הזמנת עבודה כבר הונפקה… הביטול יסמן אותה לסגירה ידנית");
// the confirmed retry proceeds. A pending-only cancel needs no confirmation.

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const id = params.id;
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { reason?: string; confirm?: boolean };
  const reason = (body.reason ?? "").trim();
  if (!reason) return NextResponse.json({ error: "חובה לציין סיבת ביטול" }, { status: 400 });

  const admin = createAdminClient();
  const { data: prod } = await admin
    .from("productions")
    .select("id,status,podcast_name,record_date")
    .eq("id", id)
    .maybeSingle();
  if (!prod) return NextResponse.json({ error: "ההפקה לא נמצאה" }, { status: 404 });
  if (prod.status === "בוטל") return NextResponse.json({ error: "ההפקה כבר בוטלה" }, { status: 409 });

  const { data: docs } = await admin
    .from("pending_documents")
    .select("id,doc_type,status,morning_doc_number")
    .eq("production_id", id);
  const pendingItems = (docs ?? []).filter((d) => d.status === "pending" || d.status === "approved");
  const issuedItems = (docs ?? []).filter((d) => d.status === "issued");

  // an issued document means a standing manual-closing task — warn first
  if (issuedItems.length && !body.confirm) {
    return NextResponse.json(
      {
        error: "מסמך כבר הונפק במורנינג",
        needs_confirmation: true,
        issued_docs: issuedItems.map((d) => ({
          type: DOC_TYPE_LABEL[d.doc_type as PendingDocType] ?? d.doc_type,
          number: d.morning_doc_number,
        })),
      },
      { status: 409 }
    );
  }

  // The state move itself, through the user's client so the can_edit_stages
  // guard (0010) is the real gate — a clean 403 if they can't.
  const { error: updErr } = await supabase
    .from("productions")
    .update({ status: "בוטל", cancelled_at: new Date().toISOString(), cancelled_by: user.id, cancel_reason: reason })
    .eq("id", id);
  if (updErr) {
    const denied = /הרשאת|רק בעל/.test(updErr.message);
    return NextResponse.json({ error: updErr.message }, { status: denied ? 403 : 400 });
  }

  // queued documents: cancel them — nothing went to Morning
  for (const d of pendingItems) {
    await admin.from("pending_documents").update({ status: "cancelled" }).eq("id", d.id);
    await admin.from("events").insert({
      entity_type: "pending_document",
      entity_id: d.id,
      event_type: "document_cancelled_on_production_cancel",
      actor_id: user.id,
      payload: { doc_type: d.doc_type, production_id: id },
    });
  }

  // issued documents: left in Morning, flagged for manual closing
  for (const d of issuedItems) {
    await admin.from("events").insert({
      entity_type: "pending_document",
      entity_id: d.id,
      event_type: "issued_document_orphaned_by_cancel",
      actor_id: user.id,
      payload: { doc_type: d.doc_type, morning_doc_number: d.morning_doc_number, production_id: id },
    });
  }

  await admin.from("events").insert({
    entity_type: "production",
    entity_id: id,
    event_type: "production_cancelled",
    actor_id: user.id,
    payload: {
      reason,
      cancelled_pending_documents: pendingItems.length,
      orphaned_issued_documents: issuedItems.length,
    },
  });

  return NextResponse.json({
    ok: true,
    cancelled_documents: pendingItems.length,
    flagged_documents: issuedItems.length,
  });
}
