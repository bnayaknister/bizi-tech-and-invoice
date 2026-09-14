import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionAndProfile } from "@/lib/profile";

/**
 * Status changes for one "רדיו ושונות" job — the write side of the kanban
 * (step 5). Until now the ONLY write path to misc_productions was the create
 * route; this is the second and, deliberately, the whole of it.
 *
 * ═══ WHY THIS ROUTE HAS TO EXIST AT ALL ═══
 * The productions board writes its status through the USER'S OWN client
 * (api/productions/[id]/route.ts:68 — `supabase.from("productions").update`),
 * leaning on RLS and on guard_production_stage_columns to decide whether the
 * write is allowed. Copying that here would not merely be less safe, it would
 * be BROKEN, and silently. Measured on this database 2026-09-11:
 *
 *   policies on misc_productions ............ SELECT only, can_view_stages()
 *   has_table_privilege(authenticated,UPDATE) false
 *   has_column_privilege(…,'status',UPDATE) . false
 *   triggers ................................ none
 *
 * 0074 wrote no UPDATE policy and granted no write privilege to any role, on
 * purpose: "every mutation is server-only after an explicit permission check",
 * the same rule production_addons (0031) and client_review_links (0029) follow.
 * A user-client UPDATE against that table matches ZERO rows — and PostgREST
 * reports a zero-row UPDATE as SUCCESS WITH NO ERROR. The card would slide to
 * the next column, the optimistic state would stick, and the row would never
 * have moved. That failure has a name in this codebase already: it is the one
 * misc-productions/route.ts:233-239 documents ("the job would be created, left
 * unlinked, and reported as billed").
 *
 * So: service role, after an explicit check, and the result is READ rather than
 * assumed — `.select()` on the update is what makes "did it actually match"
 * answerable at all.
 *
 * ═══ THE GATE IS can_edit_money, AND IT IS NOT THE SCREEN'S GATE ═══
 * /misc is readable at can_view_money (misc/page.tsx:107, owner 2026-09-08).
 * WRITING is a different question and the screen already answers it that way:
 * the "עבודה חדשה" button is gated on can_edit_money with a comment saying why
 * (page.tsx:196-201 — "a viewer who can read this screen but not write is a
 * real combination, and offering her a button whose only outcome is a 403 is a
 * lie told by the UI"). Dragging a card is writing. Same flag, same reason.
 * It is also what the create route already checks (route.ts:57-58).
 *
 * ═══ WHAT IT WILL NOT DO: CANCEL ═══
 * 'בוטל' is reachable through this route only in the sense that the enum
 * contains it — and it is REFUSED here, in the server, not merely absent from
 * the board. Two independent decisions say cancelling is not a status nudge:
 *
 *   · /productions took 'בוטל' off its kanban entirely (status.ts:6-16 lists
 *     nine states and not that one; "cancelled isn't even on the board"), and
 *     cancelling is its own route that REQUIRES a reason and returns 409
 *     needs_confirmation when documents were already issued.
 *   · 0074 gave this table cancel_reason and no cancelled_at, arguing that "a
 *     single status with a reason is the whole truth".
 *
 * A silent drag into 'בוטל' would empty both: no reason given, no warning that
 * a work order is already sitting in the approval queue, and cancel_reason NULL
 * forever on a row whose whole record of why it died is that column. Cancelling
 * misc work will be an explicit action with its own route; it is in the backlog
 * with the note that there is no equivalent of the 409 yet.
 *
 * The refusal lives HERE and not only in the board, because a board that omits
 * a column is a UI fact and this is a data rule.
 */

// The three states the board can move a row between. Named literally, never
// derived from the enum and never compared by order: 'בוטל' is LAST in
// misc_production_status, after every working state, so anything shaped like
// `status < 'בוטל'` reaching for "not cancelled" sweeps it in. That is the trap
// 0074's header spells out and 0060/0061/0062 each warn about in turn, and this
// is the third site to obey it after MiscClient's STATUS_TONE and
// modules/misc.ts's getMetric.
const BOARD_STATES = ["נפתח", "בעבודה", "הושלם"] as const;
type BoardState = (typeof BOARD_STATES)[number];

const isBoardState = (v: unknown): v is BoardState =>
  typeof v === "string" && (BOARD_STATES as readonly string[]).includes(v);

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const { user, profile } = await getSessionAndProfile();
  if (!user || !profile?.approved) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  if (!profile.can_edit_money) {
    return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { status?: unknown };

  if (body.status === undefined) return NextResponse.json({ error: "אין פעולה" }, { status: 400 });
  if (body.status === "בוטל") {
    return NextResponse.json(
      { error: "ביטול עבודה אינו שינוי סטטוס — הוא דורש סיבה, ואינו נעשה מהלוח" },
      { status: 400 }
    );
  }
  if (!isBoardState(body.status)) {
    return NextResponse.json({ error: "סטטוס לא מוכר" }, { status: 400 });
  }
  const next: BoardState = body.status;

  const admin = createAdminClient();

  // Read the current status FIRST, for two reasons that are not the same:
  //   · the event needs `from`. Without the board there is no way to
  //     reconstruct where a row came from, and "moved to בעבודה" answers half
  //     the question a journal is read for.
  //   · a row already sitting at 'בוטל' must not be dragged back into the
  //     pipeline. The board never renders it, so this cannot happen through the
  //     UI — which is exactly why the check belongs on the server, where a
  //     stale tab or a hand-made request also arrives.
  const { data: current, error: readErr } = await admin
    .from("misc_productions")
    .select("id,status,name")
    .eq("id", params.id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 400 });
  if (!current) return NextResponse.json({ error: "העבודה לא נמצאה" }, { status: 404 });

  const from = current.status as string;
  if (from === "בוטל") {
    return NextResponse.json(
      { error: "העבודה בוטלה — החזרתה לעבודה אינה שינוי סטטוס מהלוח" },
      { status: 409 }
    );
  }
  // Not an error and not a write: dropping a card back into the column it came
  // from is an ordinary miss with the mouse. Returning ok keeps the board from
  // flashing an error at someone who did nothing, and skipping the write keeps
  // the journal free of no-op entries.
  if (from === next) return NextResponse.json({ ok: true, status: next, unchanged: true });

  // No transition matrix, deliberately: /productions has none either — its
  // route validates only that the value is a known status
  // (api/productions/[id]/route.ts:42-44) and every drag between columns is
  // allowed, forwards and backwards. A rule invented here would be the first of
  // its kind in the app, applied to a table with no history to justify it.
  // What IS enforced is the pair above: cancelled is not a column, in either
  // direction.
  //
  // updated_at BY HAND, because misc_productions carries no trigger — verified,
  // the table has none — and the create route sets it the same way
  // (misc-productions/route.ts:242). A PATCH that omitted it would leave the
  // column reading the moment the row was created, silently, forever.
  //
  // `.eq("status", from)` is the concurrency guard, and it is the predicate
  // rather than a read-then-write: two people dragging the same card in two
  // tabs cannot both match, so the loser updates zero rows and is told so
  // instead of overwriting a decision it never saw.
  const { data: updated, error } = await admin
    .from("misc_productions")
    .update({ status: next, updated_at: new Date().toISOString(), updated_by: user.id })
    .eq("id", params.id)
    .eq("status", from)
    .select("id,status");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  // Zero rows is NOT success. PostgREST reports a zero-row UPDATE with no
  // error, so without this branch the board would show the card in its new
  // column while the database disagreed.
  if (!updated?.length) {
    return NextResponse.json(
      { error: "העבודה השתנתה בינתיים — רענן ונסה שוב" },
      { status: 409 }
    );
  }

  // entity_type 'misc_production' already exists on this table's rows
  // (misc-productions/route.ts:330), so the journal stays one stream per entity.
  // `from` AND `to`, unlike production_status_changed which records only `to`:
  // there the kanban and the drawer both show the pipeline, so the previous
  // stage is recoverable; here the board hides 'בוטל' and shows three of four
  // states, and a one-sided event would not survive the first question asked of
  // it. Best-effort: the status change is already committed and a journal write
  // that fails must not report the move as failed (rule 38).
  await admin.from("events").insert({
    entity_type: "misc_production",
    entity_id: params.id,
    event_type: "misc_status_changed",
    actor_id: user.id,
    payload: { from, to: next, name: current.name as string, via: "kanban" },
  });

  return NextResponse.json({ ok: true, status: next });
}
