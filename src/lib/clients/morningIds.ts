import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * F10 — the ONE map from a Morning client id to one of ours.
 *
 * `clients.morning_client_id` is a single column, and one business can hold
 * several cards in Morning. Measured 2026-09-19: 59 Morning ids are claimed by
 * nobody across 275 documents, and סבטלנה ניקסון alone holds three —
 * `0b3b8274` (mapped), `90b369a5` (טל מדיקל גרופ) and `3236ef61` (Nikson
 * Mediconsult), 32 documents between them. Migration 0094 moved that
 * relationship into `client_morning_ids`, and this is the only place that
 * reads it.
 *
 * ═══ WHY A MODULE AND NOT A QUERY AT EACH CALL SITE ═══
 * Three spellings of one map is three chances to drift, and this codebase has
 * paid that bill more than once — `isPaidNoTax`, `due_date_for`,
 * `certainBillingMatchIn` all exist because the same question was being asked
 * in two places with two answers. The map decides which client a document
 * belongs to; two answers here means a document filed under the wrong client.
 *
 * ═══ THE READ SIDE ONLY ═══
 * ⚠️ This answers "which of our clients owns this Morning id". It is NOT the
 * answer to "which Morning id do we issue under" — that stays
 * `clients.morning_client_id`, which `trg_sync_primary_morning_id` keeps equal
 * to the row flagged `is_primary`. Keeping issuance on the column is what
 * makes the unmapping trap impossible rather than merely guarded: an alias is
 * history, and history must never make a deliberately-unmapped client look
 * issuable again. See P21 before changing that.
 */

/**
 * Two rules travel with this map, and both are load-bearing:
 *
 * 1. `merged_into is null`. A retired row must never be a resolution target.
 *    This is the copy that used to matter most: backfill runs the instant a
 *    client is mapped on the mapping screen, so a retired row that slipped
 *    back in would be handed documents inside that very request. 0094 also
 *    enforces it in the database (`trg_client_morning_ids_not_merged`), so
 *    this filter is now a belt beside a brace — kept because the brace is one
 *    migration away from someone's DROP TRIGGER.
 *
 * 2. ⚠️ TIE-BREAK: ordered by client NAME, first wins. This is not decoration.
 *    `2b73787f` is claimed by BOTH גל אורן and גל אורן לרנר — the only Morning
 *    id in the database that more than one of our clients claims (measured
 *    2026-09-19) — and sharing one is legitimate by owner decision of
 *    2026-07-20. The old code in registry.ts and backfill.ts resolved it by
 *    `.order("name")` and first-wins, and changing that would silently move
 *    documents between two clients that are probably the same business. That
 *    duplication is F16; until it is decided, this map must answer EXACTLY as
 *    it did before.
 */
export async function loadMorningIdMap(admin: SupabaseClient): Promise<Map<string, string>> {
  // Clients first, in name order — the order IS the tie-break, so it is read
  // from the database rather than sorted here, exactly as the two call sites
  // this replaces did.
  const { data: clients } = await admin
    .from("clients")
    .select("id,morning_client_id")
    .is("merged_into", null)
    .order("name");

  const live = (clients ?? []) as { id: string; morning_client_id: string | null }[];
  const byMorning = new Map<string, string>();

  // The alias table. If 0094 has not been applied the query errors, and we
  // fall back to the column alone — the same degrade-don't-blank shape the
  // registry uses for `bundle_job_ids` and the reconcile loader uses for
  // `cancelled_at`. The fallback is not hypothetical comfort: it is what keeps
  // a pull working if this code ships ahead of the migration.
  const { data: aliasRows, error } = await admin
    .from("client_morning_ids")
    .select("client_id,morning_client_id");

  if (error) {
    for (const c of live) {
      if (c.morning_client_id && !byMorning.has(c.morning_client_id)) byMorning.set(c.morning_client_id, c.id);
    }
    return byMorning;
  }

  const idsByClient = new Map<string, string[]>();
  for (const r of (aliasRows ?? []) as { client_id: string; morning_client_id: string }[]) {
    idsByClient.set(r.client_id, [...(idsByClient.get(r.client_id) ?? []), r.morning_client_id]);
  }

  // Walk clients in name order and claim ids first-come. A client that is live
  // but absent from the alias table still contributes its column value, so a
  // row written directly to `clients` between the sync trigger's installation
  // and this read can never vanish from the map.
  for (const c of live) {
    const ids = idsByClient.get(c.id) ?? [];
    if (c.morning_client_id && !ids.includes(c.morning_client_id)) ids.push(c.morning_client_id);
    for (const mid of ids) if (!byMorning.has(mid)) byMorning.set(mid, c.id);
  }

  return byMorning;
}

/**
 * Every Morning id a client owns — used by the matching engine, which needs a
 * job's client to expose all of them as `mid:` keys so a document billed to an
 * alias still shares a key with that client's jobs.
 *
 * Same two rules as above. Returned per client rather than flattened because
 * `makeKeyResolvers` asks the question that way.
 */
export async function loadMorningIdsByClient(admin: SupabaseClient): Promise<Map<string, string[]>> {
  const { data: clients } = await admin
    .from("clients")
    .select("id,morning_client_id")
    .is("merged_into", null)
    .order("name");
  const live = (clients ?? []) as { id: string; morning_client_id: string | null }[];

  const { data: aliasRows, error } = await admin
    .from("client_morning_ids")
    .select("client_id,morning_client_id");

  const out = new Map<string, string[]>();
  if (error) {
    for (const c of live) if (c.morning_client_id) out.set(c.id, [c.morning_client_id]);
    return out;
  }

  for (const r of (aliasRows ?? []) as { client_id: string; morning_client_id: string }[]) {
    out.set(r.client_id, [...(out.get(r.client_id) ?? []), r.morning_client_id]);
  }
  for (const c of live) {
    if (!c.morning_client_id) continue;
    const ids = out.get(c.id) ?? [];
    if (!ids.includes(c.morning_client_id)) out.set(c.id, [...ids, c.morning_client_id]);
  }
  return out;
}
