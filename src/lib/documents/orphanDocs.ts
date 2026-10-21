
// ═══════════════════════════════════════════════════════════════════════════
// B38-3 — a document issued in Morning for a recording that did not happen.
// ═══════════════════════════════════════════════════════════════════════════
//
// The production was cancelled (or its calendar event vanished) AFTER its work
// order / deal invoice was issued. Nothing is ever deleted in Morning; a human
// closes the document. Until B38 the only trace was a radar count and an event
// (`issued_document_orphaned_by_cancel`) — 10354 and 10357 waited for someone
// to notice. Now:
//   · the moment it happens (the cancel route, the sync's "removed" flag): a
//     WhatsApp to the owner + the bookkeeper (bizi_ops_alert, audience
//     "billing" — the bookkeeper's number is WHATSAPP_BILLING_NOTIFY_NUMBERS)
//   · while it stays open in Morning: a card at the top of the approval queue,
//     with the existing "בטל ב-Morning" action (E11: POST /documents/{id}/close,
//     types 100 / 300 only — measured: Morning's own cancel IS a manual close)

/** Morning document status codes we read (registrySelection.parentOpenness): 0 = open */
export const MORNING_OPEN = 0;

export type OrphanPending = {
  id: string;
  doc_type: string;
  status: string;
  morning_doc_id: string | null;
  morning_doc_number: string | null;
  production_id: string | null;
};
export type OrphanProduction = {
  id: string;
  podcast_name: string | null;
  record_date: string | null;
  guest: string | null;
  status: string | null;
  cancelled_at: string | null;
  calendar_removed: boolean | null;
  merged_into: string | null;
};
export type OrphanRegistry = { id: string; morning_doc_id: string | null; status: number | null; cancelled_at: string | null; source: string | null };

export type OrphanDoc = {
  pendingId: string;
  docType: string;
  number: string | null;
  /** the registry row "בטל ב-Morning" acts on; null until the daily pull / write-through has it */
  registryId: string | null;
  /** Morning's status as last pulled; null = not pulled yet */
  morningStatus: number | null;
  reason: "cancelled" | "calendar_removed";
  showName: string | null;
  recordDate: string | null;
  guest: string | null;
};

/**
 * The issued work orders / deal invoices whose production is cancelled or gone
 * from the calendar, and which Morning does NOT already show as closed. PURE.
 */
export function findOrphans(pending: OrphanPending[], productions: OrphanProduction[], registry: OrphanRegistry[]): OrphanDoc[] {
  const prodById = new Map(productions.map((p) => [p.id, p]));
  const regByMorningId = new Map(registry.filter((r) => r.morning_doc_id).map((r) => [r.morning_doc_id as string, r]));
  const out: OrphanDoc[] = [];
  for (const d of pending) {
    if (d.status !== "issued" || !(d.doc_type === "work_order" || d.doc_type === "deal_invoice") || !d.production_id) continue;
    const p = prodById.get(d.production_id);
    if (!p || p.merged_into) continue;
    const cancelled = !!p.cancelled_at || p.status === "בוטל";
    if (!cancelled && !p.calendar_removed) continue;
    const reg = d.morning_doc_id ? regByMorningId.get(d.morning_doc_id) : undefined;
    // closed in Morning (status 1 / 2 / any other) or cancelled here: handled
    if (reg && (reg.cancelled_at || (reg.status !== null && reg.status !== MORNING_OPEN))) continue;
    out.push({
      pendingId: d.id,
      docType: d.doc_type,
      number: d.morning_doc_number,
      registryId: reg?.id ?? null,
      morningStatus: reg?.status ?? null,
      reason: cancelled ? "cancelled" : "calendar_removed",
      showName: p.podcast_name,
      recordDate: p.record_date,
      guest: p.guest,
    });
  }
  return out;
}

const DOC_LABEL: Record<string, string> = { work_order: "הזמנת עבודה", deal_invoice: "חשבון עסקה" };
const dm = (iso: string | null) => (iso ? `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}` : "");

/** "הזמנת עבודה 10357 · פודקאסט אילון לוי · 21.10 · Benny Gantz" */
export function orphanLine(o: Pick<OrphanDoc, "docType" | "number" | "showName" | "recordDate" | "guest">): string {
  return [`${DOC_LABEL[o.docType] ?? o.docType} ${o.number ?? ""}`.trim(), o.showName ?? "", dm(o.recordDate), o.guest ?? ""].filter(Boolean).join(" · ");
}

