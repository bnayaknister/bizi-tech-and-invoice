import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { planReviewAck, type AckComment } from "@/lib/review/reviewAck";

// "קיבלתי, מטפל" — the technician's answer to a client's correction round
// (0071). The gap it closes: a revisions response lights productions
// .needs_attention (links.ts:407) and the only thing that ever cleared it was
// the same client coming back through a live link and approving everything
// (links.ts:403). This route is the human "received" step.
//
// Four columns are written: the three ack columns, and needs_attention off.
// They stay SEPARATE columns for the reason 0071's header gives ("WHY
// needs_attention SURVIVES AS A SEPARATE COLUMN") — the flag is a generic
// board signal with its own manual route, and merging it into review_ack_at
// would weld the board's only "look at this" mechanism to one feature. This
// route moves both because acknowledging a note IS the moment the board should
// stop shouting: with the dot still lit the production sat in "דורש טיפול" and
// "בעבודה עכשיו" at the same time.
//
// ═══ WHY THE ROUND IS IDENTIFIED, NOT ASSUMED ═══
// The ack is per-round — that is what review_ack_link_id is for. The caller
// sends the link_id it was looking at, and this route refuses if a newer
// answered round has arrived since: a tab left open yesterday must not
// extinguish a dot that was lit this morning (0071:58-61). The claim that the
// link belongs to this production, and that it is the latest one, has no
// constraint behind it in the DB (0071:213-216) — it is made here or nowhere.

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_stages").eq("id", user.id).single();
  if (!profile?.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  // E13-8c: link_id may be null (pins on a live link, no answered round yet);
  // up_to is the newest comment the window SHOWED (lib/review/reviewAck).
  const body = (await request.json().catch(() => ({}))) as { link_id?: unknown; up_to?: unknown };
  const requestedLinkId = typeof body.link_id === "string" && body.link_id ? body.link_id : null;
  const upTo = typeof body.up_to === "string" && !Number.isNaN(Date.parse(body.up_to)) ? body.up_to : null;
  if (!requestedLinkId && !upTo) {
    return NextResponse.json({ error: "חסר מזהה סבב" }, { status: 400 });
  }

  const admin = createAdminClient();

  // The latest ANSWERED round, scoped to this production. responded_at, not
  // created_at: an unanswered link is not a round (the same rule 0071's
  // partial index and rounds view are built on), and the link that carries the
  // note is by definition one that responded_at has already closed
  // (links.ts:176 — it is not, and must not be, a "live" link).
  const { data: latestRound, error: roundErr } = await admin
    .from("client_review_links")
    .select("id,responded_at,episode_response,reels_response")
    .eq("production_id", params.id)
    .not("responded_at", "is", null)
    .order("responded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (roundErr) return NextResponse.json({ error: roundErr.message }, { status: 400 });

  const { data: prod, error: prodErr } = await admin
    .from("productions")
    .select("id,review_ack_link_id")
    .eq("id", params.id)
    .maybeSingle();
  if (prodErr) return NextResponse.json({ error: prodErr.message }, { status: 400 });
  if (!prod) return NextResponse.json({ error: "ההפקה לא נמצאה" }, { status: 404 });

  // the client's comments the team has not acknowledged yet (E13-8c)
  const { data: itemRows, error: itemErr } = await admin.from("client_review_items").select("id").eq("production_id", params.id);
  if (itemErr) return NextResponse.json({ error: itemErr.message }, { status: 400 });
  const itemIds = (itemRows ?? []).map((r) => r.id as string);
  const { data: openComments, error: cErr } = itemIds.length
    ? await admin
        .from("client_review_comments")
        .select("id,created_at")
        .in("item_id", itemIds)
        .eq("author_kind", "client")
        .eq("is_backfill", false)
        .is("acked_at", null)
        .is("resolved_at", null)
    : { data: [], error: null };
  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 400 });

  const plan = planReviewAck({
    requestedLinkId,
    upTo,
    latestRound: latestRound ?? null,
    prodAckLinkId: (prod.review_ack_link_id as string | null) ?? null,
    unackedComments: (openComments ?? []) as AckComment[],
  });

  // A newer round answered while this screen was open. Refused with the id it
  // should have been acking, so the caller can refresh onto the real one.
  if (plan.kind === "stale_round") {
    return NextResponse.json(
      {
        error: "יש סבב חדש יותר — רענן ונסה שוב",
        status: "stale_round",
        latest_link_id: plan.latestLinkId,
      },
      { status: 409 }
    );
  }

  // Already acknowledged — a double click, not a second event. Nothing is
  // written: re-stamping review_ack_at would move the moment someone actually
  // received the note.
  if (plan.kind === "nothing") {
    return NextResponse.json({ ok: true, already: true });
  }

  const nowIso = new Date().toISOString();

  // ═══ 1a. THE COMMENTS (E13-8c) — acked, never hidden ═══════════════════════
  if (plan.commentIds.length) {
    const { error: ackErr } = await admin
      .from("client_review_comments")
      .update({ acked_at: nowIso, acked_by: user.id })
      .in("id", plan.commentIds)
      .is("acked_at", null);
    if (ackErr) return NextResponse.json({ error: ackErr.message }, { status: 400 });
  }

  // ═══ 1b. THE ROUND + THE DOT ══════════════════════════════════════════════
  const patch: Record<string, unknown> = {};
  if (plan.ackRound && latestRound) {
    patch.review_ack_at = nowIso;
    patch.review_ack_by = user.id;
    patch.review_ack_link_id = latestRound.id;
  }
  // the red dot goes out only when nothing unread is left. Leaving it lit when
  // all is read put the production in two places at once — "דורש טיפול" and
  // "בעבודה עכשיו". status is NOT touched: the client's response already set it.
  if (plan.clearAttention) patch.needs_attention = false;
  const PROD_COLS = "id,review_ack_at,review_ack_by,review_ack_link_id,needs_attention";
  const { data: updated, error: updErr } = Object.keys(patch).length
    ? await admin.from("productions").update(patch).eq("id", params.id).select(PROD_COLS).single()
    : await admin.from("productions").select(PROD_COLS).eq("id", params.id).single();
  if (updErr || !updated) {
    return NextResponse.json({ error: "ההפקה לא נמצאה או שאין הרשאה" }, { status: 404 });
  }

  // ═══ 2. THE JOURNAL ═══════════════════════════════════════════════════════
  // Through the USER's client, not the admin one: production_log's insert
  // policy is `can_edit_stages() and author_id = auth.uid()` (0040:68-69), and
  // under the service role auth.uid() is null — the row would be refused. Same
  // division as hours/route.ts:197, for the same reason.
  //
  // Best-effort: the ack above is the anchor and it has already landed. A
  // failed journal line must not turn a successful acknowledgement into an
  // error the technician will answer by clicking again.
  const { error: logErr } = await supabase.from("production_log").insert({
    production_id: params.id,
    kind: "ack",
    author_id: user.id,
    note: null,
  });
  if (logErr) console.error("review-ack: production_log insert failed", logErr.message);

  return NextResponse.json({
    ok: true,
    review_ack_at: updated.review_ack_at,
    review_ack_by: updated.review_ack_by,
    review_ack_link_id: updated.review_ack_link_id,
    needs_attention: updated.needs_attention,
    acked_comments: plan.commentIds.length,
    newer_unacked: plan.newerUnacked,
  });
}
