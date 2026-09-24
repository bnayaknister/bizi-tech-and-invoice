import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  mergeBookingsInto,
  showDeleteBlockedByBookings,
  supabaseMergeOps,
  SHOW_HAS_BOOKINGS,
} from "@/lib/booking/showLifecycle";

// The destructive-action executors. These run ONLY from the approval-review
// route, and ONLY with the service-role (admin) client, and ONLY after a
// user-manager has approved the request (owner decision 2026-07-18: "the
// action itself runs only on approve, with admin rights"). A technician
// never reaches this code — they file a request, a manager approves, and
// the manager's route calls this.
//
// Each executor is idempotent-ish and returns a clean {ok|error}; the
// review route turns an error into a 400 so the manager sees why (e.g. a
// show that still has productions can't be hard-deleted).

export type ExecResult = { ok: true; detail?: Record<string, unknown> } | { ok: false; error: string };

export const APPROVAL_ACTIONS = [
  "show_delete",
  "show_archive",
  "show_merge",
  "production_delete",
  "client_delete",
  "bulk_show_archive",
] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export function isApprovalAction(s: string): s is ApprovalAction {
  return (APPROVAL_ACTIONS as readonly string[]).includes(s);
}

export async function executeApproval(
  admin: SupabaseClient,
  action: ApprovalAction,
  entityId: string | null,
  payload: Record<string, unknown>,
  /**
   * The MANAGER who approved this request — stamped onto `revoked_by` when a
   * merge revokes the source show's booking links (24.9).
   *
   * Optional, and null is a legitimate value rather than a missing one: the
   * column is nullable, and "a merge revoked this link" is true whether or not
   * we know who pressed the button. Making it required would have meant
   * touching every existing call site for a field only one branch reads.
   */
  actorId: string | null = null
): Promise<ExecResult> {
  switch (action) {
    case "show_archive": {
      if (!entityId) return { ok: false, error: "חסר מזהה תוכנית" };
      const { error } = await admin.from("shows").update({ active: false }).eq("id", entityId);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    }

    case "show_delete": {
      if (!entityId) return { ok: false, error: "חסר מזהה תוכנית" };
      // a show with productions can't be hard-deleted (FK) — the honest
      // answer to the manager is "archive it or merge it instead"
      const { count } = await admin
        .from("productions")
        .select("id", { count: "exact", head: true })
        .eq("show_id", entityId);
      if ((count ?? 0) > 0) {
        return { ok: false, error: `לתוכנית יש ${count} הפקות — אי אפשר למחוק, אפשר לארכב או למזג` };
      }
      // ⚠️ the same booking guard as the direct route (24.9). 0096's
      // link_id RESTRICT is non-deferrable, so a show with requests either
      // aborts on a raw FK error or loses its decision history — see
      // showDeleteBlockedByBookings.
      const bookings = await admin
        .from("booking_requests")
        .select("id", { count: "exact", head: true })
        .eq("show_id", entityId);
      if (showDeleteBlockedByBookings(bookings.count)) {
        return { ok: false, error: SHOW_HAS_BOOKINGS };
      }
      const { error } = await admin.from("shows").delete().eq("id", entityId);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    }

    case "show_merge": {
      const sourceId = entityId;
      const targetId = payload.target_id as string | undefined;
      if (!sourceId || !targetId || sourceId === targetId) {
        return { ok: false, error: "צריך תוכנית מקור ותוכנית יעד שונות" };
      }
      const { data: rows } = await admin
        .from("shows")
        .select("id,name,aliases")
        .in("id", [sourceId, targetId]);
      const source = rows?.find((s) => s.id === sourceId);
      const target = rows?.find((s) => s.id === targetId);
      if (!source || !target) return { ok: false, error: "המקור או היעד לא נמצאו" };
      const newAliases = Array.from(
        new Set([...(target.aliases ?? []), source.name, ...(source.aliases ?? [])])
      ).filter((a: string) => a !== target.name);
      const { error: aliasErr } = await admin.from("shows").update({ aliases: newAliases }).eq("id", targetId);
      if (aliasErr) return { ok: false, error: aliasErr.message };
      const { error: repointErr } = await admin.from("productions").update({ show_id: targetId }).eq("show_id", sourceId);
      if (repointErr) return { ok: false, error: repointErr.message };
      // ⚠️ THE BOOKINGS MOVE BEFORE THE DELETE, AND THE DELETE IS SKIPPED IF
      // THEY DO NOT. There is no transaction here — supabase-js is one request
      // per statement — so the order is the guarantee: links, then requests,
      // then the delete, each step leaving a state a re-run can finish. See
      // mergeBookingsInto.
      const moved = await mergeBookingsInto(
        supabaseMergeOps(admin as SupabaseClient<Database>),
        { sourceId, targetId, userId: actorId }
      );
      if (!moved.ok) return { ok: false, error: moved.error };
      const { error: delErr } = await admin.from("shows").delete().eq("id", sourceId);
      if (delErr) return { ok: false, error: delErr.message };
      return { ok: true, detail: { target_aliases: newAliases } };
    }

    case "production_delete": {
      if (!entityId) return { ok: false, error: "חסר מזהה הפקה" };
      // stages cascade on delete (0001 FK on delete cascade)
      const { error } = await admin.from("productions").delete().eq("id", entityId);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    }

    case "client_delete": {
      if (!entityId) return { ok: false, error: "חסר מזהה לקוח" };
      // block if anything still points at the client (shows/productions/jobs)
      for (const [table] of [["shows"], ["productions"], ["jobs"]] as const) {
        const { count } = await admin.from(table).select("id", { count: "exact", head: true }).eq("client_id", entityId);
        if ((count ?? 0) > 0) return { ok: false, error: `ללקוח יש רשומות מקושרות ב-${table} — נתק אותן קודם` };
      }
      const { error } = await admin.from("clients").delete().eq("id", entityId);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    }

    case "bulk_show_archive": {
      const ids = (payload.ids as string[] | undefined) ?? [];
      if (ids.length === 0) return { ok: false, error: "אין רשומות בבקשה" };
      const { error } = await admin.from("shows").update({ active: false }).in("id", ids);
      if (error) return { ok: false, error: error.message };
      return { ok: true, detail: { archived: ids.length } };
    }
  }
}
