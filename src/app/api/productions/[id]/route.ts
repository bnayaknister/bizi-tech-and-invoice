import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueDocument, getClientCadence } from "@/lib/documents/enqueue";

// Productions board actions (screens-spec §2). The DB is the wall:
//  - any status move requires can_edit_stages (trg_guard_production_stages)
//  - the move INTO 'אושר_ע"י_לקוח' requires can_edit_money and fires billing
//    (trg_guard_client_approval + trg_on_production_approved) — 0010/0002.
// This route just turns a raw DB exception into a clean message and writes
// the audit event.
const STATUSES = new Set([
  "עתיד_להתחיל",
  "בהקלטה",
  "הוקלט",
  "בעריכה",
  "נערך",
  "נשלח_ללקוח",
  "ממתין_לתגובת_לקוח",
  'אושר_ע"י_לקוח',
  "הופץ",
]);

// ---- B10: rolling the board back reopens the client's notes --------------
//
// Client approval closes note-writing on the review link. It does so through
// two INDEPENDENT locks, and until now a rollback on the board reset neither:
//
//   1. client_review_links.responded_at — kills that one link (links.ts:364).
//      DELIBERATE and untouched here: a link answers exactly once, and a new
//      round has always meant a new link. Rolling back does NOT revive the old
//      link; the team still sends a fresh one.
//   2. productions.review_episode_approved / review_reels_approved and
//      client_review_items.approved — sticky forever. ReviewClient derives
//      `pending` from them (ReviewClient.tsx:428-429), so an approved block
//      renders locked ✓ with no buttons and no textarea — on EVERY future
//      link. That is the bug, and it is what these two sets fix.
//
// Both sets are spelled by NAME, never by enum position. `production_status`
// happens to order אושר_ע"י_לקוח at 8 and הופץ at 9, but a status inserted
// into the enum later would silently redraw a positional range.
const APPROVED_OR_LATER = new Set(['אושר_ע"י_לקוח', "הופץ"]);
const REOPENS_NOTES = new Set(["בעריכה", "נשלח_ללקוח"]);

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const id = params.id;
  const body = (await request.json()) as {
    status?: string;
    hold?: { on: boolean; reason?: string };
    needs_attention?: boolean;
  };

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  let patch: Record<string, unknown> = {};
  let eventType = "";
  let eventPayload: Record<string, unknown> = {};

  if (body.status !== undefined) {
    if (!STATUSES.has(body.status)) {
      return NextResponse.json({ error: "סטטוס לא מוכר" }, { status: 400 });
    }

    // The status we are leaving — the only way to tell a rollback from an
    // ordinary forward move. Read through the USER client, so a row the caller
    // cannot see reads as null and the update below still answers 404 exactly
    // as it did before this block existed.
    const { data: current } = await supabase
      .from("productions")
      .select("status")
      .eq("id", id)
      .maybeSingle();
    const approvalReset =
      !!current && APPROVED_OR_LATER.has(current.status as string) && REOPENS_NOTES.has(body.status);

    // ---- ORDER IS THE CONTRACT: the items reset GATES the status move ------
    //
    // `client_review_items` has RLS on with ZERO policies, so only the service
    // role can touch it — hence the admin client here while the status update
    // below stays on the user client and keeps its permission wall
    // (trg_guard_production_stages → can_edit_stages).
    //
    // It runs BEFORE the status update on purpose: a failed reset must leave
    // the board where it was, because a production that reads "בעריכה" while
    // its items are still locked ✓ is the exact bug this fixes, made silent.
    //
    // The two flags on `productions` need no such ordering — they ride in the
    // SAME update statement as the status, so they land together or not at all.
    //
    // ⚠️ The remaining window is items-reset-then-status-failed. It is the safe
    // direction: nothing on the board changes, and the worst case is that a
    // future link reopens notes for a production still marked approved.
    //
    // NO MONEY MOVES, and that was measured rather than assumed (2026-09-17):
    // not one DB function mentions review_episode_approved,
    // review_reels_approved or client_review_items, and client_review_items
    // carries no trigger at all. The only job-writing trigger on productions,
    // on_production_approved, fires on `new.status = X and old.status is
    // distinct from X` for הוקלט and אושר_ע"י_לקוח — a rollback moves AWAY
    // from both, so neither branch is entered. Nothing here reaches jobs,
    // documents or pending_documents.
    if (approvalReset) {
      const resetAdmin = createAdminClient();
      const { error: itemsErr } = await resetAdmin
        .from("client_review_items")
        .update({ approved: false, approved_at: null })
        .eq("production_id", id);
      if (itemsErr) {
        return NextResponse.json(
          { error: `איפוס אישור הפריטים נכשל, הסטטוס לא שונה: ${itemsErr.message}` },
          { status: 500 }
        );
      }
    }

    patch = approvalReset
      ? {
          status: body.status,
          review_episode_approved: false,
          review_reels_approved: false,
          // same three the revisions branch clears (links.ts:612-614): an ack
          // answered the PREVIOUS round, and this is a new one
          review_ack_at: null,
          review_ack_by: null,
          review_ack_link_id: null,
        }
      : { status: body.status };
    eventType = "production_status_changed";
    eventPayload = approvalReset
      ? { to: body.status, from: current!.status, approval_reset: true }
      : { to: body.status };
  } else if (body.hold !== undefined) {
    patch = body.hold.on
      ? {
          on_hold: true,
          on_hold_reason: body.hold.reason?.trim() || null,
          on_hold_since: new Date().toISOString(),
          on_hold_by: user.id,
        }
      : { on_hold: false, on_hold_reason: null, on_hold_since: null, on_hold_by: null };
    eventType = body.hold.on ? "production_held" : "production_unheld";
    eventPayload = { reason: body.hold.reason ?? null };
  } else if (body.needs_attention !== undefined) {
    patch = { needs_attention: body.needs_attention };
    eventType = "production_attention_toggled";
    eventPayload = { needs_attention: body.needs_attention };
  } else {
    return NextResponse.json({ error: "אין פעולה" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("productions")
    .update(patch)
    .eq("id", id)
    .select("id,status,on_hold,on_hold_reason,on_hold_since,needs_attention")
    .single();

  if (error) {
    // DB guard rejections (permission) surface here as a clean 403
    const isGuard = /הרשאת|רק בעל/.test(error.message);
    return NextResponse.json({ error: error.message }, { status: isGuard ? 403 : 400 });
  }
  if (!updated) {
    return NextResponse.json({ error: "ההפקה לא נמצאה או שאין הרשאה" }, { status: 404 });
  }

  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: "production",
    entity_id: id,
    event_type: eventType,
    actor_id: user.id,
    payload: eventPayload,
  });

  // Client approval owes a deal invoice (חשבון עסקה) — queued for the
  // bookkeeper, never issued here (owner spec 2026-07-19). The DB trigger
  // trg_on_production_approved has already created the job by this point,
  // so we look it up and attach it; the queue row is what links the two.
  let queued: string | null = null;
  if (body.status === 'אושר_ע"י_לקוח') {
    const { data: prod } = await admin
      .from("productions")
      // `guest` is read, not merely typed: it reaches the printed line via
      // buildLineItemText, and an omitted column would silently produce the
      // guestless form on a session that had one.
      // 0067: `status` and `studio_hours` are read for the same reason —
      // an hourly show's amount is hours × rate, and a missing status would
      // make checkEligibility read "no hours yet" as a 🟡 on a production that
      // has, by definition, already been recorded and approved.
      .select("id,kind,legacy,client_id,show_id,podcast_name,record_date,guest,price_override,status,studio_hours")
      .eq("id", id)
      .maybeSingle();
    if (prod) {
      const { data: link } = await admin
        .from("job_productions")
        .select("job_id")
        .eq("production_id", id)
        .limit(1)
        .maybeSingle();
      // Cadence brake (owner spec 2026-07-28): a monthly / every_n client's
      // deal invoice is NOT enqueued on approval — it waits for redemption,
      // when all accrued episodes become one consolidated invoice. The job
      // (created by the trigger) sits in "לא חויב" until then. per_episode
      // enqueues immediately, as always.
      const cadence = await getClientCadence(admin, prod.client_id);
      if (cadence === "per_episode") {
        const res = await enqueueDocument(admin, "deal_invoice", prod, { jobId: link?.job_id ?? null });
        queued = res.status;
      } else {
        queued = "accrued";
      }
    }
  }

  return NextResponse.json({ ok: true, production: updated, document_queued: queued });
}
