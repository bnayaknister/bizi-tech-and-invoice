import type { SupabaseClient } from "@supabase/supabase-js";
import { getClientEmails } from "@/lib/morning/client";
import type { PendingDocType } from "@/lib/morning/types";

// Recipient resolution for document emailing (owner spec 2026-07-29).
//
// Morning emails a document only at creation, to the addresses in the request's
// client.emails, and caps a client at 3 addresses (error 2200). So we choose the
// recipients at issue time, cap at 3, and record what we asked for (Morning has
// no send-log API — see 0048 sent_to). The accountant address is held locally
// (app_settings.accountant_email) because Morning's business settings are not
// API-readable.

export const RECIPIENT_CAP = 3;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** trim, drop invalid, dedupe case-insensitively, cap to Morning's 3 max. */
export function sanitizeRecipients(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list ?? []) {
    const e = (raw ?? "").trim();
    if (!e || !EMAIL_RE.test(e)) continue;
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= RECIPIENT_CAP) break;
  }
  return out;
}

/**
 * The per-doc-type DEFAULT selection (owner correction 2026-07-29):
 *   deal_invoice / tax_invoice / tax_receipt → all the CLIENT's emails (up to
 *   the 3-address cap, in order) · work_order → nobody.
 * Morning returns the client's emails unlabelled, so we can't tell contact from
 * the client's own bookkeeper — the bookkeeper unchecks whoever is irrelevant.
 * Our accountant copy (app_settings.accountant_email) is NOT a default; it's an
 * extra checkbox in the picker, off unless the bookkeeper ticks it.
 */
export function resolveDefaultRecipients(docType: PendingDocType, clientEmails: string[]): string[] {
  if (docType === "work_order") return [];
  return sanitizeRecipients(clientEmails); // deal_invoice / tax_* → client emails, capped in order
}

export async function getAccountantEmail(admin: SupabaseClient): Promise<string | null> {
  const { data } = await admin.from("app_settings").select("accountant_email").eq("id", true).maybeSingle();
  const e = (data as { accountant_email?: string } | null)?.accountant_email ?? null;
  return e && e.trim() ? e.trim() : null;
}

/** live client emails for a pending row's client, via its morning_client_id. */
export async function fetchClientEmails(
  admin: SupabaseClient,
  clientId: string | null
): Promise<{ emails: string[]; ok: boolean }> {
  if (!clientId) return { emails: [], ok: true };
  const { data } = await admin.from("clients").select("morning_client_id").eq("id", clientId).maybeSingle();
  const mid = (data as { morning_client_id?: string } | null)?.morning_client_id;
  if (!mid) return { emails: [], ok: true };
  return getClientEmails(mid);
}
