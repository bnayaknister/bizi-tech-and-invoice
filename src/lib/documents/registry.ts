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

export type PullSummary = { pulled: number; inserted: number; updated: number; unmatched: number };

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// The daily pull. Asks Morning for documents since the last successful pull
// (minus a day of overlap — cheap given the morning_doc_id upsert is
// idempotent, and it closes any boundary gap), matches each to one of our
// clients, and upserts. Read-only against Morning, so safe in DRY_RUN.
//
// Batched deliberately: a first run sweeps ~90 days, which can be hundreds of
// documents. Per-document DB round-trips timed out (found in verification),
// so this does a fixed handful of queries regardless of volume — one client
// map, one existing-rows lookup, chunked upserts.
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
  if (!docs.length) {
    await admin.from("app_settings").update({ documents_pulled_at: new Date().toISOString() }).eq("id", true);
    return { pulled: 0, inserted: 0, updated: 0, unmatched: 0 };
  }

  // one query: Morning client id -> our client id (first by name wins when
  // several of ours share one Morning entity)
  const { data: clients } = await admin
    .from("clients")
    .select("id,morning_client_id")
    .not("morning_client_id", "is", null)
    .order("name");
  const clientByMorning = new Map<string, string>();
  for (const c of clients ?? []) {
    if (!clientByMorning.has(c.morning_client_id as string)) clientByMorning.set(c.morning_client_id as string, c.id as string);
  }

  // one lookup (chunked in-lists): what we already hold for these ids, so we
  // don't downgrade an 'app' source or drop an already-resolved client
  const existing = new Map<string, { source: string; client_id: string | null }>();
  for (const ids of chunk(docs.map((d) => d.id), 200)) {
    const { data } = await admin.from("documents").select("morning_doc_id,source,client_id").in("morning_doc_id", ids);
    for (const r of data ?? []) existing.set(r.morning_doc_id as string, { source: r.source as string, client_id: (r.client_id as string | null) ?? null });
  }

  const now = new Date().toISOString();
  let inserted = 0;
  let unmatched = 0;
  const rows = docs.map((d) => {
    const matched = d.client?.id ? clientByMorning.get(d.client.id) ?? null : null;
    if (!matched) unmatched++;
    const ex = existing.get(d.id);
    if (!ex) inserted++;
    return {
      morning_doc_id: d.id,
      morning_doc_number: d.number ?? null,
      type: d.type,
      status: d.status ?? null,
      // preserve a stronger source and an already-resolved client
      source: ex?.source === "app" ? "app" : "pull",
      client_id: matched ?? ex?.client_id ?? null,
      morning_client_id: d.client?.id ?? null,
      morning_client_name: d.client?.name ?? null,
      amount: d.amount ?? null,
      currency: d.currency ?? "ILS",
      document_date: d.documentDate ?? null,
      pdf_url: d.url?.origin || d.url?.he || null,
      raw: d,
      updated_at: now,
    };
  });

  for (const batch of chunk(rows, 500)) {
    const { error } = await admin.from("documents").upsert(batch, { onConflict: "morning_doc_id" });
    if (error) throw new Error(error.message);
  }

  await admin.from("app_settings").update({ documents_pulled_at: now }).eq("id", true);

  return { pulled: docs.length, inserted, updated: docs.length - inserted, unmatched };
}
