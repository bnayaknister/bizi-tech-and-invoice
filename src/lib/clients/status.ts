import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A client's lifecycle status (0107, E17). The one place the three values and
 * the rule "only `active` is a client" are written down.
 *
 * ═══ THE RULE ═══
 *   · `active`   — every client that existed before 0107, and every
 *                  registration a studio_admin approved. The only status that
 *                  is listed, picked, matched, synced or billed.
 *   · `pending`  — a self-registration waiting for Bnaya or Eli. Visible in ONE
 *                  place: the "ממתינים לאישור" tab of /clients, to a
 *                  studio_admin. Nowhere else.
 *   · `rejected` — visible nowhere, ever. Its registration row is purged 30
 *                  days after the rejection (E17-5).
 *   · `merged`   — retired by a client merge (B24, 0109). `merged_into` names
 *                  the survivor, and a CHECK ties the two together. Visible
 *                  only where a merged row is shown ON PURPOSE: the "מוזגו"
 *                  tab of /clients and the locked row of the Morning mapping
 *                  screen. Never picked, matched, synced or billed.
 *
 * ═══ WHY AN EXPLICIT `.eq("status", ACTIVE_CLIENT)` ON EVERY LIST ═══
 * and not a view or an RLS policy: 0107 is applied and this ticket carries no
 * migration. Most list reads run on the service role, which RLS would not see
 * anyway. So the filter is written at each read, and
 * `scripts/test_client_status_filter.ts` scans every `.from("clients")` in
 * src/ and fails on one that neither filters nor says, in a
 * `clients-status:` comment, why it does not (a lookup by id whose caller
 * already holds a client it was given, a write, …).
 *
 * ⚠️ A STATUS THAT IS ABSENT IS NOT ACTIVE. `isActiveClient(undefined)` is
 * false. A select that forgot the column must refuse, not wave a pending
 * client through to Morning.
 */
export const ACTIVE_CLIENT = "active" as const;
export const PENDING_CLIENT = "pending" as const;
export const REJECTED_CLIENT = "rejected" as const;
export const MERGED_CLIENT = "merged" as const;
export type ClientStatus = typeof ACTIVE_CLIENT | typeof PENDING_CLIENT | typeof REJECTED_CLIENT | typeof MERGED_CLIENT;

export function isActiveClient(status: string | null | undefined): boolean {
  return status === ACTIVE_CLIENT;
}

/** The refusal every issuance path returns for a client that is not active. */
export function inactiveClientMessage(name: string | null | undefined, status: string | null | undefined): string {
  const who = name ? `הלקוח '${name}'` : "הלקוח";
  if (status === PENDING_CLIENT) return `${who} ממתין לאישור הרשמה — לא ניתן להנפיק לו מסמכים`;
  return `${who} אינו לקוח פעיל — לא ניתן להנפיק לו מסמכים`;
}

/**
 * Of these client ids, the ones that are NOT active, with name and status.
 * An empty map means every one of them is active.
 *
 * 🔴 THROWS ON A FAILED READ. Same rule as `findCancelledWork` (rule 46): a
 * lookup that cannot answer is not evidence that the answer is "active", and
 * the caller — the last wall before Morning — turns the throw into a refusal.
 * An id that does not come back at all is reported too (status null): a
 * document addressed to a client row that is gone is not a document to issue.
 */
export async function findInactiveClients(
  admin: SupabaseClient,
  clientIds: (string | null | undefined)[]
): Promise<Map<string, { name: string | null; status: string | null }>> {
  const ids = Array.from(new Set(clientIds.filter((x): x is string => !!x)));
  const out = new Map<string, { name: string | null; status: string | null }>();
  if (ids.length === 0) return out;
  // clients-status: reads the status itself, by id — this IS the check
  const { data, error } = await admin.from("clients").select("id,name,status").in("id", ids);
  if (error) throw new Error(`בדיקת סטטוס הלקוח נכשלה: ${error.message}`);
  const seen = new Map<string, { name: string | null; status: string | null }>();
  for (const r of (data ?? []) as { id: string; name: string | null; status: string | null }[]) {
    seen.set(r.id, { name: r.name, status: r.status });
  }
  for (const id of ids) {
    const r = seen.get(id);
    if (!r) out.set(id, { name: null, status: null });
    else if (!isActiveClient(r.status)) out.set(id, r);
  }
  return out;
}

/**
 * The calendar sync's half of the rule: a show whose client is not active is
 * not matched, so a recording on its alias creates no production. A show with
 * no client (internal) is untouched. Pure, so the suite can pin it.
 */
export function excludeShowsOfInactiveClients<T extends { client_id: string | null }>(
  shows: T[],
  inactiveClientIds: Set<string>
): T[] {
  return shows.filter((s) => !s.client_id || !inactiveClientIds.has(s.client_id));
}
