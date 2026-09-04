import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// "קיבלתי, מטפל" — the technician's answer to a client's correction round
// (0071). The gap it closes: a revisions response lights productions
// .needs_attention (links.ts:407) and the only thing that ever cleared it was
// the same client coming back through a live link and approving everything
// (links.ts:403). This route is the human "received" step.
//
// The three ack columns are the ONLY thing written here. needs_attention stays
// as it is: it is a generic board flag with its own manual route, and 0071
// (header, "WHY needs_attention SURVIVES AS A SEPARATE COLUMN") keeps the two
// apart on purpose.
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

  const body = (await request.json().catch(() => ({}))) as { link_id?: string };
  if (typeof body.link_id !== "string" || !body.link_id) {
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
    .select("id,responded_at")
    .eq("production_id", params.id)
    .not("responded_at", "is", null)
    .order("responded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (roundErr) return NextResponse.json({ error: roundErr.message }, { status: 400 });
  if (!latestRound) return NextResponse.json({ error: "אין סבב הערות לאישור" }, { status: 400 });

  // A newer round answered while this screen was open. Refused with the id it
  // should have been acking, so the caller can refresh onto the real one.
  if (latestRound.id !== body.link_id) {
    return NextResponse.json(
      {
        error: "יש סבב חדש יותר — רענן ונסה שוב",
        status: "stale_round",
        latest_link_id: latestRound.id,
      },
      { status: 409 }
    );
  }

  const { data: prod, error: prodErr } = await admin
    .from("productions")
    .select("id,review_ack_link_id")
    .eq("id", params.id)
    .maybeSingle();
  if (prodErr) return NextResponse.json({ error: prodErr.message }, { status: 400 });
  if (!prod) return NextResponse.json({ error: "ההפקה לא נמצאה" }, { status: 404 });

  // Already acknowledged, same round — a double click, not a second event.
  // Nothing is written: re-stamping review_ack_at would move the moment
  // someone actually received the note.
  if (prod.review_ack_link_id === latestRound.id) {
    return NextResponse.json({ ok: true, already: true });
  }

  // ═══ 1. THE ACK ═══════════════════════════════════════════════════════════
  const { data: updated, error: updErr } = await admin
    .from("productions")
    .update({
      review_ack_at: new Date().toISOString(),
      review_ack_by: user.id,
      review_ack_link_id: latestRound.id,
    })
    .eq("id", params.id)
    .select("id,review_ack_at,review_ack_by,review_ack_link_id")
    .single();
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
  });
}
