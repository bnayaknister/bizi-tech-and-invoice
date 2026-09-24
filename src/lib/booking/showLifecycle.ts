import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

// ═══════════════════════════════════════════════════════════════════════════
// What deleting or merging a show must do about its bookings.
// ═══════════════════════════════════════════════════════════════════════════
//
// ═══ WHY THIS FILE EXISTS — MEASURED 23.9 ═══
// The app deletes `shows` in four places, and until now not one of them knew
// `booking_links` or `booking_requests` existed:
//
//   api/shows/[id]/route.ts:31      direct delete — guarded on productions only
//   api/shows/merge/route.ts:63     merge — no guard at all
//   lib/approvals/execute.ts:55     approved delete — guarded on productions only
//   lib/approvals/execute.ts:80     approved merge — no guard at all
//
// 0096's foreign keys make that dangerous in two different directions.
// `booking_links.show_id` and `booking_requests.show_id` are both ON DELETE
// CASCADE, while `booking_requests.link_id` is ON DELETE RESTRICT — and
// PostgreSQL documents RESTRICT as non-deferrable, checked the moment the
// referenced row would go. So deleting a show that has a link with requests
// either aborts with a raw `foreign_key_violation` the owner cannot act on, or
// — depending on which cascade fires first — silently destroys the audit trail
// that RESTRICT was written to protect. Neither is acceptable and neither was
// guarded.
//
// The guard below is in the APPLICATION, in front of all four call sites,
// exactly like the productions guard that already sits there. No migration.

/** Approved copy, 24.9. */
export const SHOW_HAS_BOOKINGS =
  "לתוכנית יש בקשות הקלטה, ולכן אי אפשר למחוק אותה. אפשר לארכב.";

/**
 * Pure. `count` is what a `head: true` count of booking_requests for this show
 * returned; a null count reads as "we do not know", and we do not delete on a
 * number we do not have.
 *
 * ⚠️ EVERY STATUS COUNTS, declined included. A declined request is an audit
 * record of a decision the owner made, and 0096 made `link_id` RESTRICT
 * specifically so that history cannot be swept away by deleting something
 * else. Counting only pending rows would let a show with fifty decided
 * requests be deleted and take all fifty with it.
 */
export function showDeleteBlockedByBookings(count: number | null | undefined): boolean {
  return count === null || count === undefined || count > 0;
}

// ─── merge ──────────────────────────────────────────────────────────────────

/**
 * The two booking writes a merge needs, as an injected pair.
 *
 * An interface rather than a Supabase client, so the ORDER and the failure
 * messages below are assertable without a database — F19 is open and this is
 * code that deletes a row when it finishes.
 */
export type BookingMergeOps = {
  /** Revoke the source's live links, THEN repoint all of its links at the target. */
  moveLinks: (sourceId: string, targetId: string, userId: string | null) => Promise<{ error: string | null }>;
  /** Repoint the source's requests at the target. */
  moveRequests: (sourceId: string, targetId: string) => Promise<{ error: string | null }>;
};

export const MERGE_LINKS_FAILED =
  "העברת קישורי ההזמנה לתוכנית היעד נכשלה. תוכנית המקור לא נמחקה ושום דבר לא אבד — נסו שוב.";
export const MERGE_REQUESTS_FAILED =
  "קישורי ההזמנה הועברו אבל העברת בקשות ההקלטה נכשלה. תוכנית המקור לא נמחקה — הריצו את המיזוג שוב.";

export type MergeBookingsResult = { ok: true } | { ok: false; error: string };

/**
 * Move a source show's bookings onto the target, before the source is deleted.
 *
 * 🔴 THERE IS NO TRANSACTION. supabase-js issues one HTTP request per
 * statement, so these two writes and the DELETE that follows them are three
 * independent statements. Wrapping them would mean a Postgres function, which
 * is a schema change, and this stage has none. So the ORDER is the guarantee
 * instead, and it is chosen so that every point at which this can stop leaves
 * a state that is recoverable by running the merge again:
 *
 *   1. links     nothing has moved yet; a failure here changes nothing at all
 *   2. requests  links have moved; the source still exists, so a re-run
 *                finishes the job (both updates are idempotent — they target
 *                rows BY source id, and a re-run simply finds fewer)
 *   3. delete    only reached when both moves succeeded
 *
 * The caller must not delete the source unless this returns ok.
 *
 * ⚠️ WHY THE SOURCE'S LIVE LINKS ARE REVOKED RATHER THAN CARRIED OVER.
 * `booking_links_one_active_per_show` is a UNIQUE index on (show_id) WHERE
 * revoked_at IS NULL. If the target already has a live link — the common case —
 * then repointing a live source link at it violates that index and the merge
 * dies on a constraint the owner has no way to interpret. Revoking first is
 * what makes the move possible at all, and it is also the right outcome: the
 * merged-away show's clients should be sent the surviving show's link, not keep
 * booking through a name that no longer exists.
 */
export async function mergeBookingsInto(
  ops: BookingMergeOps,
  input: { sourceId: string; targetId: string; userId: string | null }
): Promise<MergeBookingsResult> {
  const links = await ops.moveLinks(input.sourceId, input.targetId, input.userId);
  if (links.error) return { ok: false, error: MERGE_LINKS_FAILED };

  const requests = await ops.moveRequests(input.sourceId, input.targetId);
  if (requests.error) return { ok: false, error: MERGE_REQUESTS_FAILED };

  return { ok: true };
}

/**
 * The real ops, over a service-role client.
 *
 * `moveLinks` is TWO statements in a fixed order for the reason above: revoke
 * the live ones while they still belong to the source, then move them all.
 * Doing it the other way round is what the unique index refuses.
 */
export function supabaseMergeOps(admin: SupabaseClient<Database>): BookingMergeOps {
  return {
    moveLinks: async (sourceId, targetId, userId) => {
      const revoked = await admin
        .from("booking_links")
        .update({ revoked_at: new Date().toISOString(), revoked_by: userId })
        .eq("show_id", sourceId)
        .is("revoked_at", null);
      if (revoked.error) return { error: revoked.error.message };

      const moved = await admin
        .from("booking_links")
        .update({ show_id: targetId })
        .eq("show_id", sourceId);
      return { error: moved.error?.message ?? null };
    },
    moveRequests: async (sourceId, targetId) => {
      const moved = await admin
        .from("booking_requests")
        .update({ show_id: targetId })
        .eq("show_id", sourceId);
      return { error: moved.error?.message ?? null };
    },
  };
}
