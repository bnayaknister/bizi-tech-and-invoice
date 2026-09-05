import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseReelNotes } from "@/lib/review/reelNotes";

// The client's correction notes from the round they last answered, shaped for
// the popup that shows them to the technician.
//
// ═══ WHY THIS READS ONE TABLE ═══
// client_review_links is the only place a round's response survives as a
// round: responded_at + the two response/note pairs are written together on
// the link (links.ts:469-478) and never overwritten, one row per round.
//
// The two other places the same text appears are deliberately NOT read:
//   • client_review_items.last_note — per-deliverable, but it belongs to the
//     PRODUCTION, not to a round (0057), and every new answer overwrites it.
//     It cannot say which round it came from.
//   • events — carries the richest per-item detail (links.ts:481-494), and is
//     owner-only by RLS (entity route:332). A popup for technicians cannot be
//     built on a table most of them may not read.
//
// ═══ WHY THE REELS NOTE IS PARSED ═══
// In item mode the client answers per reel, and those answers are joined into
// ONE string before they are stored — `ריל N: …` per line, "\n" between them
// (links.ts:335 and :351). The per-reel structure is real, it is simply
// flattened on the way into the column. Splitting it back out is reversing
// that join, not inventing structure. The parser itself lives in
// lib/review/reelNotes.ts — a route.ts may export nothing but its HTTP methods
// (the generated check in .next/types), and a pure function nobody can import
// is a pure function nobody can test. scripts/test_reel_notes.ts covers it.

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_stages").eq("id", user.id).single();
  if (!profile?.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  const admin = createAdminClient();
  const { data: round, error: roundErr } = await admin
    .from("client_review_links")
    .select("id,responded_at,scope,episode_response,episode_note,reels_response,reels_note")
    .eq("production_id", params.id)
    .not("responded_at", "is", null)
    .order("responded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (roundErr) return NextResponse.json({ error: "שגיאה בטעינת הסבב" }, { status: 400 });

  // No round ever answered on this production. Not an error — the popup shows
  // its empty state, and a 404 here would read as "the production is missing".
  if (!round) return NextResponse.json({ round: null });

  const episodeNote = (round.episode_note as string | null)?.trim() || null;
  const reelsNote = (round.reels_note as string | null)?.trim() || null;

  // 'approved' carries no correction to show, and a 'revisions' round with an
  // empty note is a real shape — the client asked for changes without typing
  // anything (links.ts writes null on the link in that case, and only the
  // production's own column gets the "תיקונים התבקשו" placeholder).
  const episode = round.episode_response === "revisions" && episodeNote ? { note: episodeNote } : null;
  const reels = round.reels_response === "revisions" && reelsNote ? parseReelNotes(reelsNote) : [];

  return NextResponse.json({
    round: {
      link_id: round.id,
      responded_at: round.responded_at,
      scope: round.scope,
      episode,
      reels,
    },
  });
}
