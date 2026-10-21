import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueDocument, type EnqueueResult, type ProductionForBilling } from "./enqueue";
import { hasBeenPerformed } from "@/lib/productions/status";

// ═══════════════════════════════════════════════════════════════════════════
// B38 — the work order is born when the recording is DONE, with the job.
// ═══════════════════════════════════════════════════════════════════════════
//
// Until B38 the 06:00 calendar sync queued a per_episode client's work order
// the moment the production was created — before anything was recorded. Twice
// (10354 on 18.10, 10357 on 21.10) the order was approved and issued in the
// morning for a session cancelled the same day. Owner decision 21.10: the
// order is queued when the production becomes "performed" (the technician
// finishes "פרק · הקלטה" → 'הוקלט'), the same moment the job is born.
//
// THE SWITCH: WORK_ORDER_ON_RECORDED=true makes the sync and the manual
// "new production" route stop queueing per_episode orders (they still run the
// eligibility gate, so a 🟡 still shows the same morning). Off = exactly the
// old behaviour at creation. This function itself runs regardless of the
// switch: with the switch off the order already exists and it answers
// "has-order"; on, it is the order's birth.
//
// WHERE IT IS CALLED — every app path that moves a production INTO a
// performed status: a stage update (the drawer / board), a manual status
// change or a board drag (/api/productions/[id]), a client's approval through
// a review link. And (B38-2) the 21:00 sweep, which catches anything a path
// missed. Hourly shows are NOT queued here: their amount needs the hours, and
// /api/productions/[id]/hours queues them the moment the hours are typed.
//
// IDEMPOTENT: any work order that is live or decided (pending, approved,
// issued, accrued, consolidated, rejected, failed) means "has-order" — a
// rejected order is a human's decision not to bill, and is not re-queued. The
// unique index pending_documents_one_live_per_production is the database's own
// guard behind this one. A cancelled order (production cancelled, or the B38-4
// cut-over) does not count, so a production recorded after the cut-over gets
// its order then.

export function isWorkOrderOnRecordedOn(): boolean {
  return process.env.WORK_ORDER_ON_RECORDED === "true";
}

/** statuses of an existing work order that mean "nothing to queue" */
export const WORK_ORDER_PRESENT = ["pending", "approved", "issued", "accrued", "consolidated", "rejected", "failed"] as const;

export type OnRecordedResult =
  | EnqueueResult
  | { status: "skipped"; reason: "not-found" | "not-performed" | "not-billable" | "has-order" | "hours-pending" };

/** A move INTO a performed status (from one that is not). PURE. */
export function becamePerformed(before: string | null | undefined, after: string | null | undefined): boolean {
  return !hasBeenPerformed(before) && hasBeenPerformed(after);
}

export async function enqueueWorkOrderWhenPerformed(admin: SupabaseClient, productionId: string): Promise<OnRecordedResult> {
  const { data: p } = await admin
    .from("productions")
    // the columns enqueueDocument's ProductionForBilling reads (guest prints;
    // status + studio_hours decide an hourly amount), plus the three gates
    .select("id,kind,legacy,client_id,show_id,podcast_name,record_date,guest,price_override,status,studio_hours,cancelled_at,merged_into")
    .eq("id", productionId)
    .maybeSingle();
  if (!p) return { status: "skipped", reason: "not-found" };
  if (p.merged_into || !hasBeenPerformed(p.status as string, p.cancelled_at as string | null)) {
    return { status: "skipped", reason: "not-performed" };
  }
  // internal / contract / legacy never queue a work order (checkEligibility);
  // answered here so a stage tick on them costs nothing and writes nothing
  if (p.kind !== "client" || p.legacy) return { status: "skipped", reason: "not-billable" };

  const { data: existing } = await admin
    .from("pending_documents")
    .select("id")
    .eq("production_id", p.id)
    .eq("doc_type", "work_order")
    .in("status", [...WORK_ORDER_PRESENT])
    .limit(1);
  if (existing && existing.length > 0) return { status: "skipped", reason: "has-order" };

  // an hourly show is queued by the hours route, once the hours exist
  if (p.studio_hours == null && p.price_override == null) {
    const { data: show } = await admin.from("shows").select("pricing_model").eq("id", p.show_id ?? "").maybeSingle();
    if ((show as { pricing_model?: string } | null)?.pricing_model === "per_hour") {
      return { status: "skipped", reason: "hours-pending" };
    }
  }

  // the job is created by the database in the same status update; the order
  // carries it from birth (0077 stamps only orders that exist BEFORE the job)
  const { data: link } = await admin
    .from("job_productions")
    .select("job_id")
    .eq("production_id", p.id)
    .limit(1)
    .maybeSingle();
  return enqueueDocument(admin, "work_order", p as ProductionForBilling, { jobId: (link as { job_id?: string } | null)?.job_id ?? null });
}
