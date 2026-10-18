import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { planResolve } from "@/lib/review/resolveComment";
import { MISSING_EVENT, RESOLVED_EVENT, outstandingMissing, type AttentionEvent } from "@/lib/review/downloadAttention";

// E13-9 — "טופל" / "בטל טופל" on one client comment (owner 18.10). Team with
// stage edit only, like "קיבלתי" (review-ack). The decision is pure
// (lib/review/resolveComment); this route reads, writes and journals.
//
// POST { resolved: true | false }
//   true  → resolved_at / resolved_by, and acked_* if nobody acked it yet.
//           The red dot goes out when nothing unread is left.
//   false → resolved_* cleared. The ack stays; the dot is not relit.
// Nothing is deleted: the comment stays in the history, the client's page and
// the markers export ("all").
//
// The comment must belong to THIS production — checked through its item; the
// table has no production_id, and the URL is the caller's claim.

export async function POST(request: Request, { params }: { params: { id: string; commentId: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_stages").eq("id", user.id).single();
  if (!profile?.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { resolved?: unknown };
  if (typeof body.resolved !== "boolean") return NextResponse.json({ error: "חסר resolved" }, { status: 400 });
  const resolved = body.resolved;

  const admin = createAdminClient();
  const { data: comment, error: cErr } = await admin
    .from("client_review_comments")
    .select("id,item_id,kind,pin_number,acked_at,resolved_at")
    .eq("id", params.commentId)
    .maybeSingle();
  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 400 });
  if (!comment) return NextResponse.json({ error: "ההערה לא נמצאה" }, { status: 404 });
  const { data: item, error: iErr } = await admin
    .from("client_review_items")
    .select("id,production_id")
    .eq("id", comment.item_id)
    .maybeSingle();
  if (iErr) return NextResponse.json({ error: iErr.message }, { status: 400 });
  if (!item || item.production_id !== params.id) return NextResponse.json({ error: "ההערה לא נמצאה" }, { status: 404 });

  // what else keeps the dot lit: other unread comments, the latest answered
  // round, and a Drive file the client could not download
  const { data: itemRows, error: irErr } = await admin.from("client_review_items").select("id").eq("production_id", params.id);
  if (irErr) return NextResponse.json({ error: irErr.message }, { status: 400 });
  const itemIds = (itemRows ?? []).map((r) => r.id as string);
  const [unreadRes, roundRes, prodRes, evRes] = await Promise.all([
    admin
      .from("client_review_comments")
      .select("id", { count: "exact", head: true })
      .in("item_id", itemIds)
      .neq("id", comment.id)
      .eq("author_kind", "client")
      .eq("is_backfill", false)
      .is("acked_at", null)
      .is("resolved_at", null),
    admin
      .from("client_review_links")
      .select("id,episode_response,reels_response,episode_note,reels_note")
      .eq("production_id", params.id)
      .not("responded_at", "is", null)
      .order("responded_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from("productions").select("id,review_ack_link_id").eq("id", params.id).maybeSingle(),
    admin
      .from("events")
      .select("event_type,created_at,payload")
      .eq("entity_type", "production")
      .eq("entity_id", params.id)
      .in("event_type", [MISSING_EVENT, RESOLVED_EVENT]),
  ]);
  const readErr = unreadRes.error ?? roundRes.error ?? prodRes.error ?? evRes.error;
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 400 });
  if (!prodRes.data) return NextResponse.json({ error: "ההפקה לא נמצאה" }, { status: 404 });

  const plan = planResolve({
    resolved,
    comment: { acked_at: comment.acked_at, resolved_at: comment.resolved_at },
    otherUnread: unreadRes.count ?? 0,
    latestRound: roundRes.data ?? null,
    prodAckLinkId: (prodRes.data.review_ack_link_id as string | null) ?? null,
    missingDownloads: outstandingMissing((evRes.data ?? []) as AttentionEvent[]).length,
  });

  // already in the asked state — a double click, not a second event
  if (plan.kind === "nothing") return NextResponse.json({ ok: true, already: true });

  const nowIso = new Date().toISOString();

  if (plan.kind === "unresolve") {
    const { error } = await admin
      .from("client_review_comments")
      .update({ resolved_at: null, resolved_by: null })
      .eq("id", comment.id)
      .not("resolved_at", "is", null);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  } else {
    // the guard on resolved_at makes a race a no-op: two clicks, one stamp
    const { data: hit, error } = await admin
      .from("client_review_comments")
      .update({ resolved_at: nowIso, resolved_by: user.id })
      .eq("id", comment.id)
      .is("resolved_at", null)
      .select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (!hit?.length) return NextResponse.json({ ok: true, already: true });
    if (plan.ack) {
      const { error: ackErr } = await admin
        .from("client_review_comments")
        .update({ acked_at: nowIso, acked_by: user.id })
        .eq("id", comment.id)
        .is("acked_at", null);
      if (ackErr) return NextResponse.json({ error: ackErr.message }, { status: 400 });
    }
    const patch: Record<string, unknown> = {};
    if (plan.ackRound && roundRes.data) {
      patch.review_ack_at = nowIso;
      patch.review_ack_by = user.id;
      patch.review_ack_link_id = roundRes.data.id;
    }
    if (plan.clearAttention) patch.needs_attention = false;
    if (Object.keys(patch).length) {
      const { error: pErr } = await admin.from("productions").update(patch).eq("id", params.id);
      if (pErr) return NextResponse.json({ error: pErr.message }, { status: 400 });
    }
  }

  // best-effort journal: the mark above is the anchor and it has landed
  const { error: evErr } = await admin.from("events").insert({
    entity_type: "production",
    entity_id: params.id,
    event_type: plan.kind === "resolve" ? "client_review_comment_resolved" : "client_review_comment_unresolved",
    actor_id: user.id,
    payload: {
      comment_id: comment.id,
      item_id: comment.item_id,
      kind: comment.kind,
      pin_number: comment.pin_number,
      ...(plan.kind === "resolve" ? { acked: plan.ack, round_acked: plan.ackRound, attention_cleared: plan.clearAttention } : {}),
    },
  });
  if (evErr) console.error("review-comment resolve: event insert failed", evErr.message);

  return NextResponse.json({
    ok: true,
    resolved: plan.kind === "resolve",
    ...(plan.kind === "resolve" ? { acked: plan.ack, round_acked: plan.ackRound, attention_cleared: plan.clearAttention } : {}),
  });
}
