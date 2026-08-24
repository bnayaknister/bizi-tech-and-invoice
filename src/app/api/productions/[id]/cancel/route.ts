import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DOC_TYPE_LABEL, type PendingDocType } from "@/lib/morning/types";
import { hasBeenPerformed } from "@/lib/productions/status";

// Cancel a production (owner spec 2026-07-21). Operational, not destructive:
// can_edit_stages (a technician may cancel — the cancellation happened in the
// real world). The row is kept; only its state changes.
//
// Downstream documents are handled by what already happened:
//   - a queued (pending/approved) document -> cancelled in the queue, nothing
//     ever reaches Morning
//   - an accrued work order (frozen by the client's billing_cadence, 0046) ->
//     cancelled the same way. It is a LIVE row that never left the building:
//     leaving it would fold a cancelled episode into the client's next
//     redemption bundle and bill work that was never done. Counted separately
//     from the pending ones so neither counter's meaning drifts over time.
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
    .select("id,status,podcast_name,record_date,cancelled_at")
    .eq("id", id)
    .maybeSingle();
  if (!prod) return NextResponse.json({ error: "ההפקה לא נמצאה" }, { status: 404 });
  if (prod.status === "בוטל") return NextResponse.json({ error: "ההפקה כבר בוטלה" }, { status: 409 });

  // Two cancellations look the same and are not (owner 2026-08-25). Before the
  // recording nothing was produced and — since 0061 — no job exists: a
  // scheduling change, and the technician is the person who knows. After it,
  // the work was done and a job exists, so cancelling writes off a debt. That
  // is a money decision.
  //
  // The DATABASE is the real wall (0062, guard_production_cancellation) —
  // productions_update lets a can_edit_stages holder write any column, so a
  // check that lived only here would be bypassed by every other writer. This
  // exists so the operator gets a sentence instead of a raw postgres
  // exception, and so the refusal happens before any of the work below.
  const performed = hasBeenPerformed(prod.status as string, prod.cancelled_at as string | null);
  if (performed) {
    const { data: perms } = await supabase
      .from("profiles")
      .select("can_manage_users")
      .eq("id", user.id)
      .single();
    if (!perms?.can_manage_users) {
      return NextResponse.json(
        { error: "ביטול פרק שהוקלט הוא החלטה כספית — נדרשת הרשאת אדמין" },
        { status: 403 }
      );
    }
  }

  const { data: docs } = await admin
    .from("pending_documents")
    .select("id,doc_type,status,morning_doc_number")
    .eq("production_id", id);
  const pendingItems = (docs ?? []).filter((d) => d.status === "pending" || d.status === "approved");
  const accruedItems = (docs ?? []).filter((d) => d.status === "accrued");
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

  // queued AND accrued documents: cancel them — nothing went to Morning
  for (const d of [...pendingItems, ...accruedItems]) {
    await admin.from("pending_documents").update({ status: "cancelled" }).eq("id", d.id);
    await admin.from("events").insert({
      entity_type: "pending_document",
      entity_id: d.id,
      event_type: "document_cancelled_on_production_cancel",
      actor_id: user.id,
      // previous_status distinguishes a pending/approved row from an accrued
      // one at the ROW level: without it only the aggregate counters on
      // production_cancelled know which kind was cancelled, and a single event
      // read back months later cannot tell the two apart.
      payload: { doc_type: d.doc_type, production_id: id, previous_status: d.status },
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

  // ---- the job the episode created (only reachable since 0060) ------------
  // Before 0060 a job was born at client approval, so a cancelled episode
  // could never own one and this route had nothing to say about jobs. Now a
  // job is born at הוקלט, and cancelling afterwards leaves it behind: still
  // paid='לא', still counted as open debt on /finance and the radar, pointing
  // at work that will never be billed.
  //
  // Dismissal, not deletion — 0041 built the soft-hide precisely so a money
  // record is never destroyed, and it is reversible from the finance screen.
  // The write goes through the service role, so guard_job_dismissal (which
  // demands can_manage_users) passes; that is not a policy bypass here,
  // because the gate above already proved this caller is an admin whenever the
  // episode was recorded.
  //
  // A BILLED OR PAID JOB IS NEVER TOUCHED. If it carries invoice_biz or
  // invoice_tax, or the money already arrived, then the cancellation came
  // AFTER the work was charged — hiding it would erase a real debt or a real
  // payment from the books. That case gets the same treatment an
  // already-issued document gets a few lines above: left visible, flagged with
  // its own event, handled by a human.
  const { data: jobLinks } = await admin
    .from("job_productions")
    .select("job_id")
    .eq("production_id", id);
  const jobIds = (jobLinks ?? []).map((r) => r.job_id as string);
  let dismissedJobs = 0;
  let orphanedJobs = 0;
  if (jobIds.length) {
    const { data: jobRows } = await admin
      .from("jobs")
      .select("id,campaign,amount,invoice_biz,invoice_tax,paid,dismissed")
      .in("id", jobIds);
    for (const j of (jobRows ?? []) as {
      id: string; campaign: string | null; amount: number | null;
      invoice_biz: string | null; invoice_tax: string | null; paid: string | null; dismissed: boolean;
    }[]) {
      const billed = !!(j.invoice_biz ?? "").trim() || !!(j.invoice_tax ?? "").trim();
      if (billed || j.paid === "כן") {
        orphanedJobs++;
        await admin.from("events").insert({
          entity_type: "job",
          entity_id: j.id,
          event_type: "job_orphaned_by_cancel",
          actor_id: user.id,
          payload: {
            production_id: id,
            campaign: j.campaign,
            amount: j.amount,
            invoice_biz: j.invoice_biz,
            invoice_tax: j.invoice_tax,
            paid: j.paid,
            reason,
          },
        });
        continue;
      }
      if (j.dismissed) continue; // already hidden — nothing to do, nothing to log
      await admin
        .from("jobs")
        .update({
          dismissed: true,
          dismiss_reason: `ההפקה בוטלה: ${reason}`,
          dismissed_by: user.id,
          dismissed_at: new Date().toISOString(),
        })
        .eq("id", j.id);
      dismissedJobs++;
      // the same event the finance screen writes, so the job's own history
      // reads identically however it was hidden
      await admin.from("events").insert({
        entity_type: "job",
        entity_id: j.id,
        event_type: "job_dismissed",
        actor_id: user.id,
        payload: { reason: `ההפקה בוטלה: ${reason}`, amount: j.amount, via: "production_cancel", production_id: id },
      });
    }
  }

  await admin.from("events").insert({
    entity_type: "production",
    entity_id: id,
    event_type: "production_cancelled",
    actor_id: user.id,
    payload: {
      reason,
      cancelled_pending_documents: pendingItems.length,
      cancelled_accrued_documents: accruedItems.length,
      orphaned_issued_documents: issuedItems.length,
      dismissed_jobs: dismissedJobs,
      orphaned_jobs: orphanedJobs,
    },
  });

  return NextResponse.json({
    ok: true,
    cancelled_pending_documents: pendingItems.length,
    cancelled_accrued_documents: accruedItems.length,
    orphaned_issued_documents: issuedItems.length,
    dismissed_jobs: dismissedJobs,
    orphaned_jobs: orphanedJobs,
  });
}
