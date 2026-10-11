import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

// ═══════════════════════════════════════════════════════════════════════════
// Every read and write of 0105's columns and functions — in ONE file (E9-5).
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ THE UNTYPED CLIENT, DELIBERATELY. 0105 is applied by hand and
// `database.types.ts` is regenerated only afterwards; a types entry for a
// column that does not exist yet would fail the drift check on the dangerous
// "-" side. Same window, same choice, as every table before it (0101, 0103,
// 0104). This file goes typed in the commit that follows the apply.
//
// 🔴 AND IT IS TOLERANT OF THAT WINDOW, because unlike 0104 these columns sit
// on `booking_requests` — the table every approval and every cancellation
// touches. The push deploys before the apply, so:
//   · `readReplaces` failing = "replaces nothing" = a plain approval, exactly
//     as before E9-5. No move request can exist before the apply anyway (the
//     bot's move path is behind WHATSAPP_BOOKING_MANAGE, and `setReplaces`
//     below fails without the column, which refuses the move).
//   · `recordDeleteOutcome` failing is LOGGED: the deletion itself still
//     happened (or not), and the cancel response still reports it; only the
//     persisted "failed — retry" state is missing until the apply.
//   · the two RPCs are only ever called for a row that replaces another,
//     which, by the two lines above, cannot exist before the apply.

/** Either factory's client — this file reads through the untyped view anyway. */
type AnyClient = SupabaseClient<Database> | SupabaseClient;
const untyped = (admin: AnyClient) => admin as unknown as SupabaseClient;

/** The request this one replaces, or null — null also when 0105 is not applied. */
export async function readReplaces(admin: AnyClient, id: string): Promise<string | null> {
  try {
    const { data, error } = await untyped(admin)
      .from("booking_requests")
      .select("replaces_request_id")
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    const v = (data as { replaces_request_id: string | null }).replaces_request_id;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Link a freshly inserted move request to the recording it replaces. */
export async function setReplaces(admin: AnyClient, id: string, replacesId: string): Promise<boolean> {
  try {
    const { error } = await untyped(admin)
      .from("booking_requests")
      .update({ replaces_request_id: replacesId })
      .eq("id", id)
      .eq("status", "pending");
    if (error) {
      console.error("booking/move: קישור ההזזה נכשל", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error("booking/move: קישור ההזזה זרק", e);
    return false;
  }
}

export type DeleteStatus = "deleted" | "failed" | "not_ours" | "dry_run";

export async function recordDeleteOutcome(
  admin: AnyClient,
  id: string,
  status: DeleteStatus,
  error: string | null
): Promise<void> {
  try {
    const { error: e } = await untyped(admin)
      .from("booking_requests")
      .update({ calendar_delete_status: status, calendar_delete_error: error })
      .eq("id", id);
    if (e) console.error("booking/delete: רישום תוצאת המחיקה נכשל", e.message);
  } catch (e) {
    console.error("booking/delete: רישום תוצאת המחיקה זרק", e);
  }
}

export type MoveFacts = {
  replacesId: string | null;
  calendarDeleteStatus: DeleteStatus | null;
  calendarDeleteError: string | null;
};

/** For the /bookings screen: 0105's three columns per row, or an empty map. */
export async function readMoveFacts(admin: AnyClient, ids: string[]): Promise<Map<string, MoveFacts>> {
  const out = new Map<string, MoveFacts>();
  if (ids.length === 0) return out;
  try {
    const { data, error } = await untyped(admin)
      .from("booking_requests")
      .select("id,replaces_request_id,calendar_delete_status,calendar_delete_error")
      .in("id", ids);
    if (error) return out;
    for (const r of (data ?? []) as {
      id: string;
      replaces_request_id: string | null;
      calendar_delete_status: DeleteStatus | null;
      calendar_delete_error: string | null;
    }[]) {
      out.set(r.id, {
        replacesId: r.replaces_request_id,
        calendarDeleteStatus: r.calendar_delete_status,
        calendarDeleteError: r.calendar_delete_error,
      });
    }
  } catch {
    // the screen renders without them, exactly as before 0105
  }
  return out;
}

/**
 * 0105's atomic swap: the old one cancelled and the new one approved in ONE
 * transaction. Returns the function's answer, or the Postgres error code —
 * 23P01 (the EXCLUDE refused the new slot) and P0002 (the new one is no
 * longer pending) are the two the caller maps.
 */
export async function approveReplacing(
  admin: AnyClient,
  input: { newId: string; oldId: string; now: Date; actorId: string | null }
): Promise<{ ok: true; result: "swapped" | "approved-only" } | { ok: false; code: string | null; message: string }> {
  const { data, error } = await untyped(admin).rpc("booking_approve_replacing", {
    p_new: input.newId,
    p_old: input.oldId,
    p_now: input.now.toISOString(),
    p_actor: input.actorId,
  });
  if (error) return { ok: false, code: (error as { code?: string }).code ?? null, message: error.message };
  return { ok: true, result: data === "swapped" ? "swapped" : "approved-only" };
}

/** 0105's atomic revert: the new one back to pending, the old one back to approved. */
export async function revertReplacing(
  admin: AnyClient,
  input: { newId: string; oldId: string }
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await untyped(admin).rpc("booking_revert_replacing", { p_new: input.newId, p_old: input.oldId });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}
