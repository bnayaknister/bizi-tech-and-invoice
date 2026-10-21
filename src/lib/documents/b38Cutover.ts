import { hasBeenPerformed } from "@/lib/productions/status";

// ═══════════════════════════════════════════════════════════════════════════
// B38-4 — the cut-over day. PURE (the script does the reads and the writes).
// ═══════════════════════════════════════════════════════════════════════════
//
// When WORK_ORDER_ON_RECORDED is turned on, the work orders the 06:00 sync
// already queued that morning are still sitting in the queue for recordings
// that have not happened yet. Owner decision 6 (21.10): cancel them; each is
// born again when its recording is marked done (enqueueWorkOrderWhenPerformed
// treats a 'cancelled' order as no order).
//
// Exactly these rows: a WORK ORDER, status 'pending' (nothing has gone to
// Morning — 'approved' is mid-issue and is never touched, 'accrued' is a
// monthly client, unchanged by B38), on a client production that is NOT
// performed, NOT cancelled, NOT merged. Everything else is left alone.

export type CutoverRow = {
  id: string;
  doc_type: string;
  status: string;
  production_id: string | null;
  amount: number | string | null;
};
export type CutoverProduction = {
  id: string;
  kind: string | null;
  status: string | null;
  cancelled_at: string | null;
  merged_into: string | null;
  podcast_name: string | null;
  record_date: string | null;
};

export function planCutover(rows: CutoverRow[], productions: CutoverProduction[]): { toCancel: (CutoverRow & { production: CutoverProduction })[]; kept: number } {
  const byId = new Map(productions.map((p) => [p.id, p]));
  const toCancel: (CutoverRow & { production: CutoverProduction })[] = [];
  let kept = 0;
  for (const r of rows) {
    const p = r.production_id ? byId.get(r.production_id) : undefined;
    const take =
      r.doc_type === "work_order" &&
      r.status === "pending" &&
      !!p &&
      p.kind === "client" &&
      !p.cancelled_at &&
      !p.merged_into &&
      !hasBeenPerformed(p.status, p.cancelled_at);
    if (take && p) toCancel.push({ ...r, production: p });
    else kept++;
  }
  return { toCancel, kept };
}
