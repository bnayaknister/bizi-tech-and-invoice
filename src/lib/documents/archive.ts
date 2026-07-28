import type { SupabaseClient } from "@supabase/supabase-js";

// Archiving unassigned registry documents (owner spec). Reversible: archived_at
// is the only flag, restore clears it. Never touched by the pull.
//
// The auto-archive criterion (ALL must hold): the document's Morning client is
// NOT mapped to any client of ours (so it doesn't exist in the app), the
// document is older than 90 days, and it is not linked to a job. That is
// history outside the pipeline — safe to tuck away.

export const ARCHIVE_AGE_DAYS = 90;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const AUTO_REASON = "אוטומטי: לקוח מורנינג לא קיים באפליקציה + ישן מ-90 יום + אין job מקושר";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// The set of Morning client ids that ARE mapped to one of our clients.
async function mappedMorningIds(admin: SupabaseClient): Promise<Set<string>> {
  const { data } = await admin.from("clients").select("morning_client_id").not("morning_client_id", "is", null);
  return new Set((data ?? []).map((c) => c.morning_client_id as string));
}

// Find every unassigned document that qualifies for auto-archive. Returns the
// ids (so a caller can count first, then archive on approval).
export async function findAutoArchivable(admin: SupabaseClient): Promise<string[]> {
  const cutoff = new Date(Date.now() - ARCHIVE_AGE_DAYS * 86400_000).toISOString().slice(0, 10);
  const mapped = await mappedMorningIds(admin);
  // client_id null (unassigned) + not cancelled + not already archived + no job
  // + document_date strictly older than the cutoff (a null date is excluded by
  // .lt, which matches "must be provably old")
  const { data: docs } = await admin
    .from("documents")
    .select("id,morning_client_id")
    .is("client_id", null)
    .is("cancelled_at", null)
    .is("archived_at", null)
    .is("job_id", null)
    .lt("document_date", cutoff);
  return (docs ?? [])
    .filter((d) => !(d.morning_client_id && mapped.has(d.morning_client_id as string)))
    .map((d) => d.id as string);
}

// Archive every qualifying unassigned document. Reversible; one summary event.
export async function autoArchiveUnassigned(admin: SupabaseClient, actorId: string | null): Promise<{ archived: number }> {
  const ids = await findAutoArchivable(admin);
  if (!ids.length) return { archived: 0 };
  const now = new Date().toISOString();
  for (const batch of chunk(ids, 500)) {
    const { error } = await admin
      .from("documents")
      .update({ archived_at: now, archived_by: actorId, archive_reason: AUTO_REASON, updated_at: now })
      .in("id", batch);
    if (error) throw new Error(error.message);
  }
  await admin.from("events").insert({
    entity_type: "documents_archive",
    entity_id: NIL_UUID,
    event_type: "documents_auto_archived",
    actor_id: actorId,
    payload: { count: ids.length, criterion: "unmapped_client + older_than_90d + no_job" },
  });
  return { archived: ids.length };
}
