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
// ═══ THE TRIGGER IS THE APPROVAL ITSELF, NOT THE STATUS IT CAME FROM ═══
//
// The first version of this gated on the PREVIOUS status being אושר_ע"י_לקוח
// or הופץ, and it never fired once in production. Measured on חברת חשמל
// (3f2f5eef, 2026-09-16):
//
//   15.9 09:02  the client approved through an EPISODE-SCOPED link. applyResponse
//               computes approvedAll over the in-scope tracks only (links.ts:602),
//               so an episode-only link approving its one track IS "all" —
//               status went to אושר_ע"י_לקוח with the reels still unapproved.
//   16.9 11:42  dragged to ממתין_לתגובת_לקוח. THAT move left אושר_ע"י_לקוח and
//               is not a reopen target, so the one status that satisfied the old
//               condition was spent on a move the fix did not cover.
//   16.9 12:38  → נשלח_ללקוח · 12:41 → נערך · 12:42 → נשלח_ללקוח.
//               Every one of these started from a status that was no longer
//               אושר_ע"י_לקוח, so no reset ran — while
//               review_episode_approved was, and still is, true.
//
// PARTIAL APPROVAL is the general shape: an episode can be approved while the
// reels are not, and the production then sits anywhere on the board carrying a
// live approval flag. So the question is no longer "where did it come from"
// but "does this production still carry an approval that locks the notes" —
// which is exactly what the client page reads (ReviewClient.tsx:428-429).
//
// The two locks, and why only one of them is touched:
//   1. client_review_links.responded_at — kills that one link (links.ts:364).
//      DELIBERATE and untouched: a link answers exactly once, and a new round
//      has always meant a new link.
//   2. productions.review_episode_approved / review_reels_approved and
//      client_review_items.approved — sticky forever, on EVERY future link.
//      That is the bug.
//
// Spelled by NAME, never by enum position: a status inserted into
// `production_status` later would silently redraw a positional range.
// ממתין_לתגובת_לקוח is deliberately NOT here — it means "the link is out and
// we are waiting", which is not a reopening.
const REOPENS_NOTES = new Set(["בעריכה", "נערך", "נשלח_ללקוח"]);

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

    // The approval this production still carries. Read through the USER
    // client, so a row the caller cannot see reads as null and the update
    // below still answers 404 exactly as it did before this block existed.
    // `status` rides along for the event payload only — it no longer decides
    // anything (see the note above REOPENS_NOTES).
    const { data: current } = await supabase
      .from("productions")
      .select("status,review_episode_approved,review_reels_approved")
      .eq("id", id)
      .maybeSingle();

    // Only the service role can read client_review_items (RLS on, zero
    // policies), so it needs the admin client — and it is asked ONLY when the
    // two production flags are both clear, because either one already settles
    // the question. A production whose per-item rows were approved while the
    // track flag stayed false is the reels-approved-one-by-one case.
    const resetAdmin = createAdminClient();
    let approvalReset = false;
    if (current && REOPENS_NOTES.has(body.status)) {
      approvalReset = !!current.review_episode_approved || !!current.review_reels_approved;
      if (!approvalReset) {
        const { data: approvedItem } = await resetAdmin
          .from("client_review_items")
          .select("id")
          .eq("production_id", id)
          .eq("approved", true)
          .limit(1)
          .maybeSingle();
        approvalReset = !!approvedItem;
      }
    }

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
    // NO MONEY MOVES, re-measured against the live catalog on 2026-09-16 after
    // the condition widened: not one DB function mentions
    // review_episode_approved, review_reels_approved or client_review_items,
    // and client_review_items carries no trigger at all. On productions,
    // guard_client_approval_transition fires only on `new.status =
    // 'אושר_ע"י_לקוח'` and on_production_approved only on הוקלט or
    // אושר_ע"י_לקוח — and NONE of the three reopen targets is either of those,
    // so widening the condition cannot reach jobs, documents or
    // pending_documents.
    if (approvalReset) {
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
