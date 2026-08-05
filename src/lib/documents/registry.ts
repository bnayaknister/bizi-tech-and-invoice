import type { SupabaseClient } from "@supabase/supabase-js";
import { searchDocuments } from "@/lib/morning/client";
import { autoReconcile } from "@/lib/documents/reconcile";
import { backfillDocumentClients } from "@/lib/documents/backfill";

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
  bundle_job_ids?: string[] | null;
  // the recipients we asked Morning to email this document to (0048) — mirrored
  // here at issue so the registry shows them; omitted by the pull, so it never
  // clobbers a value we set.
  sent_to?: string[] | null;
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

export type PullSummary = { pulled: number; inserted: number; updated: number; unmatched: number; linked: number; backfilled: number; full: boolean; fromDate: string };

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// The account's own history reaches back to 2018; a "since forever" scan starts
// here. Cheap: ~1000 documents = ~11 paged requests, idempotent on upsert.
const ACCOUNT_START = "2015-01-01";

// Incremental overlap. This studio backdates invoices to the recording month
// and bills 2+ months late, so a document ISSUED today can carry a documentDate
// weeks in the past. A wide overlap catches that; anything older than this that
// still slips through is caught by the weekly full scan. NOT 1 day (the old
// value) — that assumed documentDate ≈ issue date, which is false here.
const INCREMENTAL_LOOKBACK_DAYS = 45;

// How often the safety net runs: a full unbounded scan that re-reads every
// Morning document and upserts anything missing, so no document can ever fall
// permanently outside the incremental window.
const FULL_SCAN_INTERVAL_MS = 7 * 24 * 3600_000;

// The document pull. Matches each Morning document to one of our clients and
// upserts into the registry. Read-only against Morning, so safe in DRY_RUN.
//
// Two modes, one code path:
//   • incremental (daily) — a rolling documentDate window since the last pull,
//     with a wide overlap. Light: only recent documents.
//   • full (weekly + first run + on demand) — from the account's start, so
//     every document is guaranteed to land regardless of its documentDate.
//     This is the "no document falls between the chairs" guarantee, since the
//     incremental window keys off documentDate and this business backdates.
//
// The cron auto-escalates to a full scan once a week (or if one never ran);
// callers can force one with { full: true }.
//
// Batched deliberately: a full scan is hundreds of documents. Per-document DB
// round-trips timed out (found in verification), so this does a fixed handful
// of queries regardless of volume — one client map, one existing-rows lookup,
// chunked upserts.
export async function runDocumentPull(admin: SupabaseClient, opts?: { full?: boolean }): Promise<PullSummary> {
  // Read both cursors; fall back if documents_last_full_scan_at (migration
  // 0042) isn't applied yet, so the pull keeps working pre-migration.
  let settings: { documents_pulled_at?: string | null; documents_last_full_scan_at?: string | null } | null = null;
  {
    const withFull = await admin
      .from("app_settings")
      .select("documents_pulled_at, documents_last_full_scan_at")
      .eq("id", true)
      .maybeSingle();
    if (withFull.error) {
      const { data } = await admin.from("app_settings").select("documents_pulled_at").eq("id", true).maybeSingle();
      settings = data;
    } else {
      settings = withFull.data;
    }
  }

  const lastFull = settings?.documents_last_full_scan_at
    ? new Date(settings.documents_last_full_scan_at).getTime()
    : 0;
  // Full scan when: explicitly asked, never pulled before, a full scan never
  // ran, or the weekly interval has elapsed.
  const isFull =
    opts?.full === true ||
    !settings?.documents_pulled_at ||
    !lastFull ||
    Date.now() - lastFull > FULL_SCAN_INTERVAL_MS;

  const since = isFull
    ? new Date(`${ACCOUNT_START}T00:00:00Z`)
    : new Date(new Date(settings!.documents_pulled_at as string).getTime() - INCREMENTAL_LOOKBACK_DAYS * 24 * 3600_000);
  const fromDate = since.toISOString().slice(0, 10);

  const now = new Date().toISOString();
  // Record the cursor. Always advance documents_pulled_at; on a full scan also
  // stamp documents_last_full_scan_at. That column ships in migration 0042 —
  // if it isn't applied yet the write is retried without it, so the pull still
  // works (the weekly-cadence tracking just stays dark until the migration
  // lands, exactly like every other not-yet-applied migration in this app).
  const stamp = async () => {
    if (isFull) {
      const { error } = await admin
        .from("app_settings")
        .update({ documents_pulled_at: now, documents_last_full_scan_at: now })
        .eq("id", true);
      if (!error) return;
    }
    await admin.from("app_settings").update({ documents_pulled_at: now }).eq("id", true);
  };

  const docs = await searchDocuments(fromDate);
  if (!docs.length) {
    await stamp();
    // even with nothing new pulled: sweep null-client docs against current
    // mappings (a client mapped since the last pull), then reconcile.
    const { resolved } = await backfillDocumentClients(admin);
    const { linked } = await autoReconcile(admin);
    return { pulled: 0, inserted: 0, updated: 0, unmatched: 0, linked, backfilled: resolved, full: isFull, fromDate };
  }

  // one query: Morning client id -> our client id (first by name wins when
  // several of ours share one Morning entity — legitimate, see 0026).
  //
  // merged_into is excluded, and that exclusion is the whole defence. On 3.8
  // seven rows retired by 0050 were re-mapped by hand, and this tie-break
  // handed them everything: it orders by NAME, and the '[' of the '[מוזג]'
  // prefix sorts before every Hebrew letter, so the retired row won every
  // time. The marker meant to take a row out of service is what put it first
  // in line. 14 documents moved before anyone noticed. A retired row must
  // never be a resolution target, whatever it is called.
  const { data: clients } = await admin
    .from("clients")
    .select("id,morning_client_id")
    .not("morning_client_id", "is", null)
    .is("merged_into", null)
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

  await stamp();

  // safety sweep: resolve any null-client doc whose Morning client is now
  // mapped (an old doc that predates the mapping) — not just what we just
  // pulled. THEN auto-match: link every certain 1:1 tax document to its red
  // job and close it (ambiguous matches are left for the gaps screen).
  const { resolved } = await backfillDocumentClients(admin);
  const { linked } = await autoReconcile(admin);

  return { pulled: docs.length, inserted, updated: docs.length - inserted, unmatched, linked, backfilled: resolved, full: isFull, fromDate };
}
