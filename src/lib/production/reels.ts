import type { SupabaseClient } from "@supabase/supabase-js";

// productions.reels_count is the single source of truth for "how many reels
// does this production owe" (0055). It starts as the show's figure, copied at
// creation, and rises when a reels add-on is APPROVED — approved, not merely
// proposed, because a proposed line is an offer the client can still decline.
//
// This reverses 0036, which made the add-on rows the counter ("no separate
// reels_count to drift"). That reasoning held only while there was no plan
// number; now there is one, and the two answer different questions: the count
// is how much work the reels line covers, the add-on is the money record for
// the extra. The add-on rows are never summed for display any more.
//
// Called from both approval paths — the money editor's manual approve
// (/api/productions/[id]/addons) and the client's approval on the review link
// (lib/review/links.ts) — so the number cannot depend on which door was used.
//
// Runs on the service role: production_addons' price columns are revoked from
// the shared role (0031), and the caller has already done its permission check.
export async function bumpReelsCountForAddons(
  admin: SupabaseClient,
  productionId: string,
  addonIds: string[]
): Promise<number> {
  if (addonIds.length === 0) return 0;

  const { data: rows } = await admin
    .from("production_addons")
    .select("id,quantity,is_reels_addon")
    .eq("production_id", productionId)
    .in("id", addonIds)
    .eq("is_reels_addon", true);

  const extra = (rows ?? []).reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
  if (extra <= 0) return 0;

  const { data: prod } = await admin
    .from("productions")
    .select("reels_count")
    .eq("id", productionId)
    .maybeSingle();
  if (!prod) return 0;

  const before = Number(prod.reels_count) || 0;
  const after = before + extra;

  // The DB guard (trg_guard_production_composition, 0055) blocks a change that
  // crosses the zero boundary — that is what adds or removes the reels stage
  // line, and the stage rows were already seeded. Raising a count that is
  // already > 0 is always allowed; a production with no reels line at all is
  // left alone rather than silently gaining a line it has no stages for.
  if (before === 0) return 0;

  const { error } = await admin.from("productions").update({ reels_count: after }).eq("id", productionId);
  if (error) return 0;

  await admin.from("events").insert({
    entity_type: "production",
    entity_id: productionId,
    event_type: "reels_count_changed",
    payload: { from: before, to: after, reason: "addon_approved", addon_ids: addonIds },
  });
  return extra;
}
