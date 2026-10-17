import type { SupabaseClient } from "@supabase/supabase-js";

// ═══════════════════════════════════════════════════════════════════════════
// E13-6 — the red dot for a Drive file the client could not download
// (owner 17.10). Server-side only, service role.
// ═══════════════════════════════════════════════════════════════════════════
//
// LIGHT: the download route found the version's Drive file gone → it writes
// client_review_download_missing and lights productions.needs_attention.
//
// CLEAR, by itself (owner 17.10) — nothing in the app could clear it otherwise
// (review-ack answers client-note rounds only; the 0071 "red forever" lesson):
//   · a later download of the SAME version succeeds, or
//   · a new version is sent for the SAME item.
// Each clears its own "missing" entries by writing
// client_review_download_missing_resolved. The flag itself goes out only when
// NO missing entry is left on the production AND no client-note round is
// waiting for "קיבלתי" — the dot is shared with the client's notes, and a
// clear here must never hide a note the technician has not seen.
//
// The ledger is the events table itself: no new column, no migration. Every
// function here is best-effort — a failure is logged and never fails the
// download or the send (rule 38).

export const MISSING_EVENT = "client_review_download_missing";
export const RESOLVED_EVENT = "client_review_download_missing_resolved";

export type AttentionEvent = { event_type: string; created_at: string; payload: Record<string, unknown> | null };
export type MissingEntry = { versionId: string; itemId: string | null; at: string };

/** Pure: the missing entries not resolved since, one per version (latest wins). */
export function outstandingMissing(events: AttentionEvent[]): MissingEntry[] {
  const sorted = [...events].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const open = new Map<string, MissingEntry>();
  for (const e of sorted) {
    const p = e.payload ?? {};
    if (e.event_type === MISSING_EVENT && typeof p.version_id === "string") {
      open.set(p.version_id, { versionId: p.version_id, itemId: typeof p.item_id === "string" ? p.item_id : null, at: e.created_at });
    } else if (e.event_type === RESOLVED_EVENT && Array.isArray(p.version_ids)) {
      for (const v of p.version_ids) if (typeof v === "string") open.delete(v);
    }
  }
  return Array.from(open.values());
}

/** Pure: which entries a trigger resolves. A successful download resolves its version; a new version resolves its item. */
export function entriesResolvedBy(open: MissingEntry[], trigger: { versionId: string } | { itemId: string }): MissingEntry[] {
  return "versionId" in trigger ? open.filter((e) => e.versionId === trigger.versionId) : open.filter((e) => e.itemId === trigger.itemId);
}

export type LatestRound = { id: string; episode_response: string | null; reels_response: string | null } | null;

/** Pure: is a client-note round still waiting for "קיבלתי"? Same reading as review-current / review-ack. */
export function clientNotesUnacked(round: LatestRound, reviewAckLinkId: string | null): boolean {
  if (!round) return false;
  const revisions = round.episode_response === "revisions" || round.reels_response === "revisions";
  return revisions && reviewAckLinkId !== round.id;
}

/** Pure: may the flag go out? */
export function shouldClearFlag(remaining: MissingEntry[], notesUnacked: boolean): boolean {
  return remaining.length === 0 && !notesUnacked;
}

const warn = (tag: string, productionId: string, e: unknown) =>
  console.warn(JSON.stringify({ tag, production_id: productionId, error: e instanceof Error ? e.message : String(e) }));

/** The download route found the file gone: light the dot. The event itself is written by the route. */
export async function lightDownloadMissing(admin: SupabaseClient, productionId: string): Promise<void> {
  try {
    const { error } = await admin.from("productions").update({ needs_attention: true }).eq("id", productionId);
    if (error) throw new Error(error.message);
  } catch (e) {
    warn("review_download_missing_flag_failed", productionId, e);
  }
}

/**
 * A successful download of a version, or a new version sent for an item:
 * resolve the matching missing entries, and put the dot out if nothing else
 * keeps it lit. Cheap when there is nothing to resolve: one events read.
 */
export async function resolveDownloadMissing(
  admin: SupabaseClient,
  productionId: string,
  trigger: { versionId: string } | { itemId: string },
  cause: "download_ok" | "new_version"
): Promise<{ resolved: number; cleared: boolean }> {
  try {
    const { data: evs, error } = await admin
      .from("events")
      .select("event_type,created_at,payload")
      .eq("entity_type", "production")
      .eq("entity_id", productionId)
      .in("event_type", [MISSING_EVENT, RESOLVED_EVENT]);
    if (error) throw new Error(error.message);
    const open = outstandingMissing((evs ?? []) as AttentionEvent[]);
    const hit = entriesResolvedBy(open, trigger);
    if (!hit.length) return { resolved: 0, cleared: false };

    const { error: insErr } = await admin.from("events").insert({
      entity_type: "production",
      entity_id: productionId,
      event_type: RESOLVED_EVENT,
      payload: { version_ids: hit.map((h) => h.versionId), cause, ...trigger },
    });
    if (insErr) throw new Error(insErr.message);

    const remaining = open.filter((e) => !hit.includes(e));
    const [{ data: round }, { data: prod }] = await Promise.all([
      admin
        .from("client_review_links")
        .select("id,episode_response,reels_response")
        .eq("production_id", productionId)
        .not("responded_at", "is", null)
        .order("responded_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin.from("productions").select("needs_attention,review_ack_link_id").eq("id", productionId).maybeSingle(),
    ]);
    if (!prod?.needs_attention) return { resolved: hit.length, cleared: false };
    // E13-8c: a client comment / pin not yet acked ("קיבלתי") also keeps the
    // dot lit — the dot is shared, and this clear must never hide a comment
    const { data: itemRows } = await admin.from("client_review_items").select("id").eq("production_id", productionId);
    const itemIds = (itemRows ?? []).map((r) => r.id as string);
    let openComments = 0;
    if (itemIds.length) {
      const { count, error: cErr } = await admin
        .from("client_review_comments")
        .select("id", { count: "exact", head: true })
        .in("item_id", itemIds)
        .eq("author_kind", "client")
        .eq("is_backfill", false)
        .is("acked_at", null)
        .is("resolved_at", null);
      if (cErr) throw new Error(cErr.message);
      openComments = count ?? 0;
    }
    const notesWaiting = clientNotesUnacked((round ?? null) as LatestRound, (prod.review_ack_link_id as string | null) ?? null) || openComments > 0;
    if (!shouldClearFlag(remaining, notesWaiting)) {
      return { resolved: hit.length, cleared: false };
    }
    const { error: updErr } = await admin.from("productions").update({ needs_attention: false }).eq("id", productionId);
    if (updErr) throw new Error(updErr.message);
    return { resolved: hit.length, cleared: true };
  } catch (e) {
    warn("review_download_missing_resolve_failed", productionId, e);
    return { resolved: 0, cleared: false };
  }
}
