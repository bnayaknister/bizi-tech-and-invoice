import type { SupabaseClient } from "@supabase/supabase-js";

// The gross total Morning itself computed on a document, read back out of the
// registry — the one number a payment block has to match.
//
// Extracted so the approval gate and the screen that fills the form read it the
// same way. Two implementations of "what does the parent total?" would mean the
// modal showing one figure while the server enforced another, which is the
// class of drift this codebase keeps paying for elsewhere.
//
// WHY THIS SOURCE and not another:
//   • NOT pending_documents.amount — that column is net for every doc_type
//     except a receipt, where the builder writes gross. A moving meaning.
//   • NOT documents.amount — our net until the nightly pull overwrites it with
//     the gross. A moving value.
//   • NOT income x a VAT rate — that puts Morning's own tax settings inside our
//     issuance path.
//   raw->'amount' is what Morning returned for that exact document. It only
//   arrives with the pull (the POST response carries no amount at all), and
//   when it has not arrived yet the honest answer is "not yet", not a guess.

export type ParentGrossResult =
  | { ok: true; gross: number }
  | { ok: false; error: string };

/**
 * Sum the gross of the documents named by their Morning ids.
 *
 * A single missing amount fails the whole read: a partial sum would be a
 * smaller number that looks perfectly plausible, and it would be enforced
 * against a payment that is actually correct.
 */
export async function sumParentGross(
  admin: SupabaseClient,
  linkedDocumentIds: string[]
): Promise<ParentGrossResult> {
  const { data: parents } = await admin
    .from("documents")
    .select("morning_doc_id,morning_doc_number,raw")
    .in("morning_doc_id", linkedDocumentIds);
  const byId = new Map(
    ((parents ?? []) as { morning_doc_id: string; morning_doc_number: string | null; raw: unknown }[]).map((d) => [
      d.morning_doc_id,
      d,
    ])
  );

  let gross = 0;
  for (const id of linkedDocumentIds) {
    const parent = byId.get(id);
    const raw = parent?.raw;
    const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>).amount : undefined;
    const amount = value === null || value === undefined ? NaN : Number(value);
    if (!Number.isFinite(amount)) {
      // the parent exists in Morning but our copy of it predates the nightly
      // pull, so the gross it computed has not reached us yet
      const label = parent?.morning_doc_number ? `#${parent.morning_doc_number}` : id;
      return {
        ok: false,
        error: `${label}: מסמך המקור טרם נמשך ממורנינג ואין לנו את הסכום שחושב בו. נסי אחרי הסנכרון הבא.`,
      };
    }
    gross += amount;
  }

  return { ok: true, gross };
}
