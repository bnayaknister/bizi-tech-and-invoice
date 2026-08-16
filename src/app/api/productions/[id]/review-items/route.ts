import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Per-item media links for the client review page (0057, item-based review).
// The drawer saves a Drive link per deliverable (episode / reel 1..n) here on
// blur. Display metadata only — nothing in the approval flow reads these
// writes, so this route never touches approvals, statuses, or documents.
//
// Same permission model as the review-link mint: an operational action gated
// by can_edit_stages, then the service role does the writing (the table has
// no user policies — see 0057).

type ItemPatch = { kind: "episode" | "reel"; reel_index?: number | null; media_link?: string | null };

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_stages").eq("id", user.id).single();
  if (!profile?.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { items?: unknown };
  const patches: ItemPatch[] = Array.isArray(body.items)
    ? (body.items as ItemPatch[]).filter(
        (i) => i && (i.kind === "episode" || i.kind === "reel")
      )
    : [];
  if (!patches.length) return NextResponse.json({ error: "אין פריטים לעדכון" }, { status: 400 });

  const admin = createAdminClient();
  const { data: prod, error: prodErr } = await admin
    .from("productions")
    .select("id,has_episode,reels_count,review_episode_approved,review_reels_approved")
    .eq("id", params.id)
    .maybeSingle();
  if (prodErr) return NextResponse.json({ error: prodErr.message }, { status: 500 });
  if (!prod) return NextResponse.json({ error: "ההפקה לא נמצאה" }, { status: 404 });

  const reelCount = Number(prod.reels_count) || 0;
  for (const p of patches) {
    if (p.kind === "episode" && !prod.has_episode) {
      return NextResponse.json({ error: "להפקה אין פרק" }, { status: 400 });
    }
    if (p.kind === "reel") {
      const idx = Number(p.reel_index);
      if (!Number.isInteger(idx) || idx < 1 || idx > reelCount) {
        return NextResponse.json({ error: `אינדקס ריל לא תקין (1–${reelCount})` }, { status: 400 });
      }
    }
  }

  const { data: existing, error: exErr } = await admin
    .from("client_review_items")
    .select("id,kind,reel_index")
    .eq("production_id", params.id);
  if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 });

  for (const p of patches) {
    const reelIndex = p.kind === "reel" ? Number(p.reel_index) : null;
    const mediaLink = (p.media_link ?? "").trim() || null;
    const match = (existing ?? []).find(
      (e) => e.kind === p.kind && ((e.reel_index as number | null) ?? null) === reelIndex
    );
    if (match) {
      const { error } = await admin
        .from("client_review_items")
        .update({ media_link: mediaLink })
        .eq("id", match.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    } else {
      // a field edited before any link was minted — seed just this item, with
      // approved mirroring the sticky track flag (same rule as the lazy seed)
      const approved = p.kind === "episode" ? !!prod.review_episode_approved : !!prod.review_reels_approved;
      const { error } = await admin.from("client_review_items").insert({
        production_id: params.id,
        kind: p.kind,
        reel_index: reelIndex,
        media_link: mediaLink,
        approved,
      });
      // 23505 = seeded concurrently (link mint) — retry as an update
      if (error && error.code === "23505") {
        let retry = admin
          .from("client_review_items")
          .update({ media_link: mediaLink })
          .eq("production_id", params.id)
          .eq("kind", p.kind);
        retry = reelIndex === null ? retry.is("reel_index", null) : retry.eq("reel_index", reelIndex);
        const { error: retryErr } = await retry;
        if (retryErr) return NextResponse.json({ error: retryErr.message }, { status: 500 });
      } else if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }
  }

  return NextResponse.json({ ok: true });
}
