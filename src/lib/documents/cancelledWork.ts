import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Is the work a queued document bills for CANCELLED?
 *
 * ═══ WHY THIS EXISTS ═══
 * A queue row outlives the thing it bills. Cancel the work and the row keeps
 * sitting at 'pending', visible on the approval screen, one click from
 * Morning — and a tax document issued against cancelled work is not undoable,
 * only creditable. Nothing in the 889 lines of the approval route checked this
 * for ANY document type before now; there was no liveness test to extend.
 *
 * ═══ ⚠️ WHY IT COVERS /productions TOO, WHICH LOOKS REDUNDANT ═══
 * It is not redundant, and the reason must survive or the next reader will
 * delete half this file.
 *
 * On the productions side the door really is shut: `status: "בוטל"` is written
 * in exactly ONE place in the whole app (productions/[id]/cancel:101 — checked,
 * it is the only writer), and the generic status route refuses the value
 * outright because STATUSES omits it (productions/[id]/route.ts:12-22). So a
 * production cannot reach 'בוטל' without going through the route that cancels
 * its queue rows.
 *
 * But THAT cancelling is a write nobody reads:
 *
 *     await admin.from("pending_documents").update({ status: "cancelled" })
 *       .eq("id", d.id);                      // cancel/route.ts:112-121
 *
 * No error is checked, and PostgREST reports a zero-row UPDATE as success. If
 * that write fails or matches nothing, the production is cancelled and its work
 * order is still 'pending' — silently, with nothing on any screen to say so.
 * The coverage here is not a second lock on a locked door; it is the floor
 * under a door whose lock is never tested.
 *
 * Measured on live data 2026-09-14, before this shipped: of 87 queue rows, 4
 * are in a blockable status and NONE of them bills cancelled work. Four rows do
 * sit on cancelled productions and all four are already 'cancelled' or
 * 'rejected' — the cancel route did its job every time so far. This wall is
 * built before anyone has walked into the doorway, not after.
 *
 * ═══ THE TWO ANCHORS ═══
 * A queue row points at its work through one of two columns, never both:
 *   production_id — a podcast episode
 *   job_id        — everything else, including a "רדיו ושונות" work order,
 *                   which is written with production_id NULL (0074 keeps misc
 *                   work in its own table, so there is no production to point
 *                   at)
 * So misc is matched through the job, which is the only link its rows have.
 *
 * A bundled row (production_id null, job_id null, bundle_job_ids set) matches
 * neither and is never blocked. That is correct rather than a gap: a bundle
 * covers several episodes and "the work was cancelled" is not a statement that
 * can be made about it as a whole. Cancelling one member of a bundle is a
 * different problem and is not this one.
 */
export type CancelledWork = {
  /** 'production' | 'misc' — which table said so, for the message and the log */
  kind: "production" | "misc";
  /** what the operator will recognise: the episode or the job's own name */
  name: string | null;
};

/**
 * Returns a map of queue-row id -> the cancelled work it bills, for the rows
 * that bill cancelled work. Rows absent from the map are fine to issue.
 *
 * Batched rather than per-row: the approval route checks a whole selection at
 * once and must refuse the SET, not approve the good half — the same rule its
 * reject branch already follows ("a partial rejection reported as success is
 * how the one row that mattered gets lost", review/route.ts:205-207).
 *
 * ⚠️ FAILS CLOSED IS NOT AN OPTION HERE, AND FAILS OPEN IS NOT EITHER — so it
 * THROWS. A lookup that cannot answer is not evidence that the answer is no
 * (rule 46: "an unreadable link table must not become a silent pass on an
 * irreversible action"), and silently treating a failed read as "nothing is
 * cancelled" is exactly the swallow that rule names. The callers turn the throw
 * into a refusal; neither of them lets it through.
 */
export async function findCancelledWork(
  admin: SupabaseClient,
  rows: { id: string; production_id: string | null; job_id: string | null }[]
): Promise<Map<string, CancelledWork>> {
  const out = new Map<string, CancelledWork>();
  if (!rows.length) return out;

  const productionIds = Array.from(new Set(rows.map((r) => r.production_id).filter(Boolean) as string[]));
  const jobIds = Array.from(new Set(rows.map((r) => r.job_id).filter(Boolean) as string[]));

  // Both flags, not just the status. cancelled_at is the column the schema's
  // own triggers test (0060, 0061, 0064) and status is what the screens read;
  // they are written together by the one cancel path and today all 15 cancelled
  // rows carry both — but the belt costs one OR and the day they disagree is
  // the day this has to be right. Named literally, never ranged: 'בוטל' is the
  // LAST value of production_status, so any ordinal test sweeps it the wrong
  // way (0060/0061/0062 each warn about this in turn).
  const cancelledProductions = new Map<string, string | null>();
  if (productionIds.length) {
    const { data, error } = await admin
      .from("productions")
      .select("id,status,cancelled_at,podcast_name")
      .in("id", productionIds);
    if (error) throw new Error(`בדיקת הפקות מבוטלות נכשלה: ${error.message}`);
    for (const p of data ?? []) {
      if ((p.status as string) === "בוטל" || p.cancelled_at) {
        cancelledProductions.set(p.id as string, (p.podcast_name as string | null) ?? null);
      }
    }
  }

  // misc_productions has no cancelled_at at all — 0074 decided a single status
  // plus its reason is the whole truth there — so status is the only test, and
  // it is named rather than ordered for the same reason as above.
  const cancelledMisc = new Map<string, string | null>();
  if (jobIds.length) {
    const { data, error } = await admin
      .from("misc_productions")
      .select("job_id,status,name")
      .in("job_id", jobIds);
    if (error) throw new Error(`בדיקת עבודות מבוטלות נכשלה: ${error.message}`);
    for (const m of data ?? []) {
      if ((m.status as string) === "בוטל" && m.job_id) {
        cancelledMisc.set(m.job_id as string, (m.name as string | null) ?? null);
      }
    }
  }

  for (const r of rows) {
    if (r.production_id && cancelledProductions.has(r.production_id)) {
      out.set(r.id, { kind: "production", name: cancelledProductions.get(r.production_id) ?? null });
      continue;
    }
    if (r.job_id && cancelledMisc.has(r.job_id)) {
      out.set(r.id, { kind: "misc", name: cancelledMisc.get(r.job_id) ?? null });
    }
  }
  return out;
}

/** The one sentence both walls say, so the API and the screen cannot drift. */
export const CANCELLED_WORK_MESSAGE =
  "העבודה בוטלה — לא ניתן להנפיק מסמך עבורה. בטלי את השורה בתור, או החזירי את העבודה לפעילה";

/** The short form, for a badge beside the row. */
export const CANCELLED_WORK_BADGE = "העבודה בוטלה — לא ניתן להנפיק";
