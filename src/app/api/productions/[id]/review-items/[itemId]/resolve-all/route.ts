import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { planResolveMany } from "@/lib/review/resolveComment";
import { MISSING_EVENT, RESOLVED_EVENT, outstandingMissing, type AttentionEvent } from "@/lib/review/downloadAttention";

// E13-9 "✓ סמן הכול כטופל" (owner 18.10) — the open comments of ONE item's
// latest version, marked "טופל" in one go. Same permission and the same rule
// as one mark (review-comments/[commentId]/resolve, lib/review/resolveComment):
// every comment gets its own resolved_by / resolved_at (and acked_* where
// nobody acked it), the red dot goes out under the same rule, and one event
// says how many. "בטל טופל" stays per comment.
//
// POST { comment_ids: string[] } — the ids the confirm window counted ("לסמן N
// הערות כטופלו?"). The server marks only the ids that are STILL open on the
// item's latest version: a comment that arrived after the window opened is
// not swallowed by a confirm that never showed it.

export async function POST(request: Request, { params }: { params: { id: string; itemId: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_stages").eq("id", user.id).single();
  if (!profile?.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { comment_ids?: unknown };
  const asked = Array.isArray(body.comment_ids) ? body.comment_ids.filter((x): x is string => typeof x === "string") : [];
  if (!asked.length) return NextResponse.json({ error: "חסרות הערות לסימון" }, { status: 400 });

  const admin = createAdminClient();
  const { data: item, error: iErr } = await admin.from("client_review_items").select("id,production_id").eq("id", params.itemId).maybeSingle();
  if (iErr) return NextResponse.json({ error: iErr.message }, { status: 400 });
  if (!item || item.production_id !== params.id) return NextResponse.json({ error: "הפריט לא נמצא בהפקה" }, { status: 404 });

  // the item's latest version — the highest number, like the history and the markers export
  const { data: latest, error: vErr } = await admin
    .from("client_review_versions")
    .select("id")
    .eq("item_id", item.id)
    .not("number", "is", null)
    .order("number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (vErr) return NextResponse.json({ error: vErr.message }, { status: 400 });

  let q = admin
    .from("client_review_comments")
    .select("id,acked_at,resolved_at")
    .eq("item_id", item.id)
    .in("id", asked)
    .is("resolved_at", null);
  q = latest ? q.eq("version_id", latest.id) : q.is("version_id", null);
  const { data: targets, error: tErr } = await q;
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 400 });
  if (!targets?.length) return NextResponse.json({ ok: true, already: true, resolved: 0 });
  const targetIds = targets.map((t) => t.id as string);

  // what else keeps the dot lit — the same reads as one mark
  const { data: itemRows, error: irErr } = await admin.from("client_review_items").select("id").eq("production_id", params.id);
  if (irErr) return NextResponse.json({ error: irErr.message }, { status: 400 });
  const itemIds = (itemRows ?? []).map((r) => r.id as string);
  const [unreadRes, roundRes, prodRes, evRes] = await Promise.all([
    admin
      .from("client_review_comments")
      .select("id")
      .in("item_id", itemIds)
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

  const plan = planResolveMany({
    comments: targets,
    otherUnread: (unreadRes.data ?? []).filter((r) => !targetIds.includes(r.id as string)).length,
    latestRound: roundRes.data ?? null,
    prodAckLinkId: (prodRes.data.review_ack_link_id as string | null) ?? null,
    missingDownloads: outstandingMissing((evRes.data ?? []) as AttentionEvent[]).length,
  });
  if (plan.kind === "nothing") return NextResponse.json({ ok: true, already: true, resolved: 0 });

  const nowIso = new Date().toISOString();
  // the guard on resolved_at: a comment someone marked meanwhile keeps its own stamp
  const { data: hit, error: rErr } = await admin
    .from("client_review_comments")
    .update({ resolved_at: nowIso, resolved_by: user.id })
    .in("id", plan.resolveIds)
    .is("resolved_at", null)
    .select("id");
  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 400 });
  const hitIds = (hit ?? []).map((h) => h.id as string);
  if (!hitIds.length) return NextResponse.json({ ok: true, already: true, resolved: 0 });

  const ackIds = plan.ackIds.filter((id) => hitIds.includes(id));
  if (ackIds.length) {
    const { error: ackErr } = await admin
      .from("client_review_comments")
      .update({ acked_at: nowIso, acked_by: user.id })
      .in("id", ackIds)
      .is("acked_at", null);
    if (ackErr) return NextResponse.json({ error: ackErr.message }, { status: 400 });
  }
  // a race left some of the set to someone else → the dot is decided by what WE marked;
  // if fewer landed than planned, the plan's "nothing else unread" still holds
  // (the others were resolved, not left unread)
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

  // ONE event for the batch (owner 18.10); each comment carries its own stamp
  const { error: evErr } = await admin.from("events").insert({
    entity_type: "production",
    entity_id: params.id,
    event_type: "client_review_comments_resolved_bulk",
    actor_id: user.id,
    payload: {
      item_id: item.id,
      version_id: latest?.id ?? null,
      count: hitIds.length,
      comment_ids: hitIds,
      acked: ackIds.length,
      round_acked: plan.ackRound,
      attention_cleared: plan.clearAttention,
    },
  });
  if (evErr) console.error("review-items resolve-all: event insert failed", evErr.message);

  return NextResponse.json({ ok: true, resolved: hitIds.length, acked: ackIds.length, round_acked: plan.ackRound, attention_cleared: plan.clearAttention });
}
