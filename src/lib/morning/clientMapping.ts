import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

// ═══════════════════════════════════════════════════════════════════════════
// Persisting "our client X is Morning client Y" — and refusing to persist a
// synthetic Y. B23.
// ═══════════════════════════════════════════════════════════════════════════
//
// In MORNING_DRY_RUN, `createMorningClient` makes no call and returns
// `dry-client-<uuid>` (morning/client.ts). That id used to be written straight
// into `clients.morning_client_id` — and from there, by 0094's trigger, into
// `client_morning_ids`. The same family as B21: a preview or local server that
// is wired to the PRODUCTION database (and dry-run is the default, rule 40)
// glues a fake Morning id onto a real client. Then the issuance gate
// (`enqueue.ts`: `if (!client.morning_client_id)`) lets that client through,
// and a REAL issuance later sends Morning a client id that does not exist.
//
// So a dry run maps NOTHING. The response says so (`dry_run: true`), and the
// event still records what would have happened.
//
// ⚠️ DOCUMENTS ARE A DIFFERENT, DELIBERATE CASE and are not touched here:
// `issue.ts` writes `dry-…` into `pending_documents` / `invoices` /
// `documents.morning_doc_id` on purpose (a "tagged shadow ledger" every reader
// filters by the prefix — see the note above `dry_run_jobs_stamp_skipped`).

/** The prefix every synthetic Morning id carries (documents and clients). */
export const SYNTHETIC_MORNING_ID_PREFIX = "dry-";

export function isSyntheticMorningId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(SYNTHETIC_MORNING_ID_PREFIX);
}

export type MappingDecision = { write: true } | { write: false; reason: "dry-run" | "synthetic-id" };

/**
 * May this Morning id be written onto a client? PURE.
 *
 * Two locks, deliberately redundant: the dry-run flag from the call that
 * produced the id, AND the id's own shape — so a future caller that forgets
 * the flag still cannot persist a synthetic id.
 */
export function mappingDecision(input: { morningId: string; dryRun: boolean }): MappingDecision {
  if (input.dryRun) return { write: false, reason: "dry-run" };
  if (isSyntheticMorningId(input.morningId)) return { write: false, reason: "synthetic-id" };
  return { write: true };
}

/**
 * Write the mapping — or, when `mappingDecision` refuses, touch NOTHING: the
 * admin client is not even called (the suite asserts it).
 */
export async function persistMorningMapping(
  admin: SupabaseClient<Database>,
  input: { clientId: string; morningId: string; dryRun: boolean }
): Promise<
  | { written: true }
  | { written: false; reason: "dry-run" | "synthetic-id" }
  | { written: false; reason: "error"; code: string | null; message: string }
> {
  const d = mappingDecision(input);
  if (!d.write) return { written: false, reason: d.reason };
  // clients-status: a write by id — callers gate on status first
  const { error } = await admin.from("clients").update({ morning_client_id: input.morningId }).eq("id", input.clientId);
  if (error) return { written: false, reason: "error", code: error.code ?? null, message: error.message };
  return { written: true };
}
