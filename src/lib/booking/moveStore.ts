import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

// ═══════════════════════════════════════════════════════════════════════════
// Every read and write of 0105's columns and functions — in ONE file (E9-5).
// ═══════════════════════════════════════════════════════════════════════════
//
// The TYPED client. 0105 was applied on 2026-10-11 and `database.types.ts`
// regenerated against it, so the three columns and the two functions below are
// vouched for by the drift check. This file shipped on the untyped client for
// exactly one commit — the window between writing the migration and the owner
// applying it — and was written to tolerate that window (a failed read meant
// "replaces nothing"). The same failure handling stays: a read that fails is
// still a plain approval, never a guessed move.

type Admin = SupabaseClient<Database>;

/** The request this one replaces, or null. */
export async function readReplaces(admin: Admin, id: string): Promise<string | null> {
  try {
    const { data, error } = await admin
      .from("booking_requests")
      .select("replaces_request_id")
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return null;
    return data.replaces_request_id;
  } catch {
    return null;
  }
}

/** Link a freshly inserted move request to the recording it replaces. */
export async function setReplaces(admin: Admin, id: string, replacesId: string): Promise<boolean> {
  try {
    const { error } = await admin
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

/** 0105's CHECK on `calendar_delete_status`, as a closed list. */
export const DELETE_STATUSES = ["deleted", "failed", "not_ours", "dry_run"] as const;
export type DeleteStatus = (typeof DELETE_STATUSES)[number];

/** The column is plain text to the generated types; this narrows it to the CHECK's four. */
export function asDeleteStatus(v: string | null): DeleteStatus | null {
  return (DELETE_STATUSES as readonly string[]).includes(v ?? "") ? (v as DeleteStatus) : null;
}

export async function recordDeleteOutcome(
  admin: Admin,
  id: string,
  status: DeleteStatus,
  error: string | null
): Promise<void> {
  try {
    const { error: e } = await admin
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

/** For the /bookings screen: 0105's three columns per row, or an empty map on a failed read. */
export async function readMoveFacts(admin: Admin, ids: string[]): Promise<Map<string, MoveFacts>> {
  const out = new Map<string, MoveFacts>();
  if (ids.length === 0) return out;
  try {
    const { data, error } = await admin
      .from("booking_requests")
      .select("id,replaces_request_id,calendar_delete_status,calendar_delete_error")
      .in("id", ids);
    if (error) return out;
    for (const r of data ?? []) {
      out.set(r.id, {
        replacesId: r.replaces_request_id,
        calendarDeleteStatus: asDeleteStatus(r.calendar_delete_status),
        calendarDeleteError: r.calendar_delete_error,
      });
    }
  } catch {
    // the screen renders without them
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
  admin: Admin,
  input: { newId: string; oldId: string; now: Date; actorId: string | null }
): Promise<{ ok: true; result: "swapped" | "approved-only" } | { ok: false; code: string | null; message: string }> {
  const { data, error } = await admin.rpc("booking_approve_replacing", {
    p_new: input.newId,
    p_old: input.oldId,
    p_now: input.now.toISOString(),
    // ⚠️ the one cast: the generated types make every function argument
    // non-null, but p_actor is a plain uuid parameter that takes NULL — and
    // NULL is the record of an automatic approval (decided_by, see decide.ts).
    p_actor: input.actorId as string,
  });
  if (error) return { ok: false, code: error.code ?? null, message: error.message };
  return { ok: true, result: data === "swapped" ? "swapped" : "approved-only" };
}

/** 0105's atomic revert: the new one back to pending, the old one back to approved. */
export async function revertReplacing(
  admin: Admin,
  input: { newId: string; oldId: string }
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await admin.rpc("booking_revert_replacing", { p_new: input.newId, p_old: input.oldId });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}
