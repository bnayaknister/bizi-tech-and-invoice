import type { SupabaseClient } from "@supabase/supabase-js";
import { recordBookingNotification } from "@/lib/whatsapp/notify";
import { findOrphans, orphanLine, type OrphanDoc, type OrphanPending, type OrphanProduction, type OrphanRegistry } from "./orphanDocs";

// B38-3 — the server half of ./orphanDocs.ts (the reads and the WhatsApp). The
// pure half is imported by the client card, so nothing here may reach it.

export async function loadOrphanDocs(admin: SupabaseClient): Promise<OrphanDoc[]> {
  const { data: pending } = await admin
    .from("pending_documents")
    .select("id,doc_type,status,morning_doc_id,morning_doc_number,production_id")
    .eq("status", "issued")
    .in("doc_type", ["work_order", "deal_invoice"])
    .not("production_id", "is", null);
  const prodIds = Array.from(new Set((pending ?? []).map((d) => d.production_id as string)));
  if (prodIds.length === 0) return [];
  const prods: OrphanProduction[] = [];
  for (let i = 0; i < prodIds.length; i += 200) {
    const { data } = await admin
      .from("productions")
      .select("id,podcast_name,record_date,guest,status,cancelled_at,calendar_removed,merged_into")
      .in("id", prodIds.slice(i, i + 200))
      .or("cancelled_at.not.is.null,calendar_removed.eq.true");
    prods.push(...((data ?? []) as OrphanProduction[]));
  }
  const gone = new Set(prods.map((p) => p.id));
  const candidates = ((pending ?? []) as OrphanPending[]).filter((d) => d.production_id && gone.has(d.production_id));
  const morningIds = candidates.map((d) => d.morning_doc_id).filter(Boolean) as string[];
  const { data: registry } = morningIds.length
    ? await admin.from("documents").select("id,morning_doc_id,status,cancelled_at,source").in("morning_doc_id", morningIds)
    : { data: [] };
  return findOrphans(candidates, prods, (registry ?? []) as OrphanRegistry[]);
}

/**
 * The WhatsApp the moment a document is orphaned — to the owner + the
 * bookkeeper. Once per document (the notification's own de-dup key). Never
 * throws: the cancellation already happened; a failed alert leaves the card.
 */
export async function notifyOrphanDoc(
  admin: SupabaseClient,
  o: Pick<OrphanDoc, "pendingId" | "docType" | "number" | "showName" | "recordDate" | "guest" | "reason">
): Promise<void> {
  try {
    await recordBookingNotification(admin as never, {
      kind: "ops-alert",
      subjectId: `orphan:${o.pendingId}`,
      audience: "billing",
      title: o.reason === "cancelled" ? "הקלטה בוטלה אחרי שהופק מסמך במורנינג" : "אירוע נמחק מהיומן אחרי שהופק מסמך במורנינג",
      details: orphanLine(o),
      action: "לסגור את המסמך במורנינג — במסך המסמכים לאישור יש כפתור \"בטל ב-Morning\"",
    });
  } catch (e) {
    console.error("orphan-doc: ההתראה זרקה", e);
  }
}
