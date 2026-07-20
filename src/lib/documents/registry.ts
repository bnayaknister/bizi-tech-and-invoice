import type { SupabaseClient } from "@supabase/supabase-js";
import { searchDocuments } from "@/lib/morning/client";

// The documents registry: one row per Morning document, written from two
// directions (app issuance write-through, and the daily pull of documents
// issued directly in Morning). morning_doc_id is the shared key, so both
// paths upsert on it and a document is never recorded twice.

export type UpsertDoc = {
  morning_doc_id: string;
  morning_doc_number?: string | null;
  type: number;
  status?: number | null;
  client_id?: string | null;
  morning_client_id?: string | null;
  morning_client_name?: string | null;
  amount?: number | null;
  currency?: string | null;
  document_date?: string | null;
  pdf_url?: string | null;
  source: "app" | "pull" | "manual";
  production_id?: string | null;
  job_id?: string | null;
  raw?: unknown;
};

export async function upsertDocument(admin: SupabaseClient, doc: UpsertDoc) {
  // On conflict, refresh the mutable fields but never downgrade source from
  // 'app' to 'pull': a document we issued and already attributed shouldn't
  // lose that when the daily pull later sees the same id.
  const { data: existing } = await admin
    .from("documents")
    .select("id,source,client_id")
    .eq("morning_doc_id", doc.morning_doc_id)
    .maybeSingle();

  const row = {
    ...doc,
    currency: doc.currency ?? "ILS",
    updated_at: new Date().toISOString(),
    // keep the stronger source and an already-resolved client if the pull
    // (which may be ambiguous) can't improve on it
    source: existing?.source === "app" ? "app" : doc.source,
    client_id: doc.client_id ?? existing?.client_id ?? null,
  };

  if (existing) {
    await admin.from("documents").update(row).eq("id", existing.id);
    return { inserted: false };
  }
  await admin.from("documents").insert(row);
  return { inserted: true };
}

// resolve a Morning client id to one of OUR clients. Several of ours can map
// to one Morning entity (brands of one payer), so this is deterministic-first
// match; null when none of ours map (the "unmatched" case the registry keeps
// in its own tab).
async function matchOurClient(admin: SupabaseClient, morningClientId: string | null | undefined): Promise<string | null> {
  if (!morningClientId) return null;
  const { data } = await admin
    .from("clients")
    .select("id")
    .eq("morning_client_id", morningClientId)
    .order("name")
    .limit(1);
  return data?.[0]?.id ?? null;
}

export type PullSummary = { pulled: number; inserted: number; updated: number; unmatched: number };

// The daily pull. Asks Morning for documents since the last successful pull
// (minus a day of overlap — cheap given the morning_doc_id upsert is
// idempotent, and it closes any boundary gap), upserts each, and matches the
// client. Read-only against Morning, so safe in DRY_RUN.
export async function runDocumentPull(admin: SupabaseClient): Promise<PullSummary> {
  const { data: settings } = await admin
    .from("app_settings")
    .select("documents_pulled_at")
    .eq("id", true)
    .maybeSingle();

  const since = settings?.documents_pulled_at
    ? new Date(new Date(settings.documents_pulled_at).getTime() - 24 * 3600_000)
    : new Date(Date.now() - 90 * 24 * 3600_000); // first run: last 90 days
  const fromDate = since.toISOString().slice(0, 10);

  const docs = await searchDocuments(fromDate);

  let inserted = 0;
  let updated = 0;
  let unmatched = 0;
  for (const d of docs) {
    const clientId = await matchOurClient(admin, d.client?.id);
    if (!clientId) unmatched++;
    const res = await upsertDocument(admin, {
      morning_doc_id: d.id,
      morning_doc_number: d.number ?? null,
      type: d.type,
      status: d.status ?? null,
      client_id: clientId,
      morning_client_id: d.client?.id ?? null,
      morning_client_name: d.client?.name ?? null,
      amount: d.amount ?? null,
      currency: d.currency ?? "ILS",
      document_date: d.documentDate ?? null,
      pdf_url: d.url?.origin || d.url?.he || null,
      source: "pull",
      raw: d,
    });
    if (res.inserted) inserted++;
    else updated++;
  }

  await admin.from("app_settings").update({ documents_pulled_at: new Date().toISOString() }).eq("id", true);

  return { pulled: docs.length, inserted, updated, unmatched };
}
