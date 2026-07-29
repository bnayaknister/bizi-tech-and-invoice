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
 * The per-doc-type DEFAULT selection:
 *   deal_invoice → client emails + accountant · tax_invoice/tax_receipt →
 *   accountant only · work_order → nobody.
 * The accountant is pinned FIRST so it survives the 3-address cap: a 3-email
 * client on a deal invoice keeps accountant + the first two client addresses.
 * It is only a default — the bookkeeper edits it in the picker before sending.
 */
export function resolveDefaultRecipients(
  docType: PendingDocType,
  clientEmails: string[],
  accountantEmail: string | null
): string[] {
  const acct = accountantEmail?.trim() ? [accountantEmail.trim()] : [];
  if (docType === "work_order") return [];
  if (docType === "tax_invoice" || docType === "tax_receipt") return sanitizeRecipients(acct);
  return sanitizeRecipients([...acct, ...clientEmails]); // deal_invoice
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
