import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveLink, applyResponse, type TrackResponse } from "@/lib/review/links";

// The client's response — PUBLIC, no account. The 32-byte token is the only
// credential. Runs entirely on the service role.
//
// Rate limiting: a link accepts exactly ONE response (responded_at locks it),
// and an invalid token 404s, so the only abuse surface is guessing a token —
// infeasible at 32 random bytes. A short per-process throttle guards against
// a burst on a single token.

const lastHit = new Map<string, number>();
const THROTTLE_MS = 1000;

function validTrack(v: unknown): TrackResponse {
  return v === "approved" || v === "revisions" ? v : undefined;
}

export async function POST(request: Request, { params }: { params: { token: string } }) {
  const token = params.token;
  const now = Date.now();
  const prev = lastHit.get(token);
  if (prev && now - prev < THROTTLE_MS) {
    return NextResponse.json({ error: "נסה שוב בעוד רגע" }, { status: 429 });
  }
  lastHit.set(token, now);

  const admin = createAdminClient();
  const state = await resolveLink(admin, token);
  if (state.status !== "ok") {
    // missing / expired / superseded / responded → all "not available"
    return NextResponse.json({ error: "הלינק אינו זמין יותר", reason: state.status }, { status: 410 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    episode?: string;
    episode_note?: string;
    reels?: string;
    reels_note?: string;
  };

  const episode = validTrack(body.episode);
  const reels = validTrack(body.reels);

  // must respond to at least one pending, in-scope track
  const reelsInScope = state.production.review_reels_required && state.link.reels_included;
  const episodePending = !state.production.review_episode_approved;
  const reelsPending = reelsInScope && !state.production.review_reels_approved;
  const answersEpisode = episodePending && !!episode;
  const answersReels = reelsPending && !!reels;
  if (!answersEpisode && !answersReels) {
    return NextResponse.json({ error: "יש לבחור אישור או תיקונים לפחות עבור בלוק אחד" }, { status: 400 });
  }
  // a revision must carry a note (that's the whole point of the loop)
  if (episode === "revisions" && !(body.episode_note ?? "").trim()) {
    return NextResponse.json({ error: "נא לפרט מה לתקן בפרק" }, { status: 400 });
  }
  if (answersReels && reels === "revisions" && !(body.reels_note ?? "").trim()) {
    return NextResponse.json({ error: "נא לפרט מה לתקן ברילז" }, { status: 400 });
  }

  const { approvedAll } = await applyResponse(admin, state.link, state.production, {
    episode: answersEpisode ? episode : undefined,
    episodeNote: body.episode_note,
    reels: answersReels ? reels : undefined,
    reelsNote: body.reels_note,
  });

  return NextResponse.json({ ok: true, approved_all: approvedAll });
}
