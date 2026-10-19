import type { SupabaseClient } from "@supabase/supabase-js";

// B28 (minimal, owner 19.10): the one billing path with no double-billing
// guard. bundle-from-show bills "N episodes of show X" with no productions, so
// there is nothing to dedupe against per episode — the guard is per SHOW:
//   · a bundle order for this show still in the queue → refused (409). That
//     covers a second tab, a second user, a retried request.
//   · one ISSUED in the last BUNDLE_RECENT_DAYS → refused unless the caller
//     says explicitly "this is a different period" (confirmDifferentPeriod).
// Which pending_documents rows are this show's bundles: the route's own
// `document_queued` event (via=bundle_from_show, show_id) is the only record
// of the show — the row's payload goes to Morning, so no show id lives there.

export const BUNDLE_RECENT_DAYS = 30;

/**
 * Still able to become a document: waiting, approved, or failed (a failed row
 * is re-runnable — issue.ts retries it — so it is as live as a pending one).
 */
const LIVE_STATUSES = ["pending", "approved", "failed"];

export type ShowBundle = {
  id: string;
  status: string;
  created_at: string;
  issued_at: string | null;
  morning_doc_number: string | null;
  quantity: number | null;
};

export type BundleConflict =
  | { kind: "live_in_queue"; bundle: ShowBundle }
  | { kind: "recent_issued"; bundle: ShowBundle }
  | null;

export async function loadShowBundles(admin: SupabaseClient, showId: string): Promise<ShowBundle[]> {
  const { data: evs, error: evErr } = await admin
    .from("events")
    .select("entity_id,payload")
    .eq("event_type", "document_queued")
    .eq("payload->>via", "bundle_from_show")
    .eq("payload->>show_id", showId);
  if (evErr) throw new Error(evErr.message);
  const qtyById = new Map<string, number | null>();
  for (const e of (evs ?? []) as { entity_id: string; payload: { quantity?: unknown } | null }[]) {
    const q = Number(e.payload?.quantity);
    qtyById.set(e.entity_id, Number.isFinite(q) ? q : null);
  }
  if (!qtyById.size) return [];
  const { data: rows, error } = await admin
    .from("pending_documents")
    .select("id,status,created_at,issued_at,morning_doc_number")
    .in("id", Array.from(qtyById.keys()));
  if (error) throw new Error(error.message);
  return ((rows ?? []) as Omit<ShowBundle, "quantity">[]).map((r) => ({ ...r, quantity: qtyById.get(r.id) ?? null }));
}

/** Pure: the first conflict that applies, live before recent. */
export function bundleConflict(bundles: ShowBundle[], now: Date): BundleConflict {
  const live = bundles.find((b) => LIVE_STATUSES.includes(b.status));
  if (live) return { kind: "live_in_queue", bundle: live };
  const since = now.getTime() - BUNDLE_RECENT_DAYS * 24 * 60 * 60 * 1000;
  const recent = bundles
    .filter((b) => b.status === "issued" && b.issued_at && Date.parse(b.issued_at) >= since)
    .sort((a, b) => Date.parse(b.issued_at!) - Date.parse(a.issued_at!))[0];
  if (recent) return { kind: "recent_issued", bundle: recent };
  return null;
}

export const LIVE_IN_QUEUE_MESSAGE = "יש כבר הזמנה מרוכזת לתוכנית הזו בתור — יש לאשר או לדחות אותה קודם";
