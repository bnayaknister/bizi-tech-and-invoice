import type { SupabaseClient } from "@supabase/supabase-js";

// Back-fill client_id on registry documents whose Morning client IS mapped to
// one of ours, but that were pulled BEFORE that mapping existed (owner spec
// 2026-07-27). The pull is incremental — it only fetches recent documents — so
// an old document never gets re-touched, and a client mapped later never
// reaches it. That is the real bug behind most "לא משויך" documents: the client
// is known, the link just never got applied retroactively.
//
// Run in three places so it can't drift out of date:
//   - the moment a client is mapped on the mapping screen (scoped to that
//     Morning client) → old documents get the mapping immediately
//   - at the end of every daily pull (all nulls) → a safety sweep
//   - the manual "resolve mappings" endpoint (all nulls) → run on demand
export async function backfillDocumentClients(
  admin: SupabaseClient,
  opts?: { morningClientId?: string }
): Promise<{ resolved: number }> {
  // Morning client id -> our client id (first by name wins, same tie-break as
  // the pull, so a Morning client shared by several of ours resolves the same)
  //
  // …and the same merged_into exclusion, for the same reason. This copy is the
  // more dangerous of the two: it runs the instant a client is mapped on the
  // mapping screen (see the three call sites above), so a retired row that
  // slipped back into a mapping would be handed documents in that very
  // request, without waiting for a pull.
  const { data: clients } = await admin
    .from("clients")
    .select("id,morning_client_id")
    .not("morning_client_id", "is", null)
    .is("merged_into", null)
    .order("name");
  const byMorning = new Map<string, string>();
  for (const c of clients ?? []) {
    const m = c.morning_client_id as string;
    if (!byMorning.has(m)) byMorning.set(m, c.id as string);
  }

  // don't resurrect archived history: an archived doc stays archived even if its
  // client later gets mapped (restore is manual). archived_at ships in 0045 — if
  // it isn't applied yet, fall back to the unfiltered query.
  const baseSelect = () => {
    let q = admin.from("documents").select("id,morning_client_id").is("client_id", null).not("morning_client_id", "is", null);
    if (opts?.morningClientId) q = q.eq("morning_client_id", opts.morningClientId);
    return q;
  };
  let docs: { id: string; morning_client_id: string }[] | null;
  {
    const withArchive = await baseSelect().is("archived_at", null);
    docs = (withArchive.error ? (await baseSelect()).data : withArchive.data) as typeof docs;
  }

  const byClient = new Map<string, string[]>();
  for (const d of docs ?? []) {
    const cid = byMorning.get(d.morning_client_id as string);
    if (cid) byClient.set(cid, [...(byClient.get(cid) ?? []), d.id as string]);
  }

  let resolved = 0;
  const now = new Date().toISOString();
  for (const [clientId, ids] of Array.from(byClient.entries())) {
    const { error } = await admin.from("documents").update({ client_id: clientId, updated_at: now }).in("id", ids);
    if (error) continue;
    resolved += ids.length;
    await admin.from("events").insert({
      entity_type: "client",
      entity_id: clientId,
      event_type: "documents_client_backfilled",
      payload: { count: ids.length, doc_ids: ids, morning_client_id: opts?.morningClientId ?? null },
    });
  }
  return { resolved };
}
