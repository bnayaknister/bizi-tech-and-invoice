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
    // { addonId: 'approved' | 'rejected' } — only honoured on full approval
    addons?: Record<string, unknown>;
  };

  const episode = validTrack(body.episode);
  const reels = validTrack(body.reels);

  // must respond to at least one pending, in-scope track
  const reelsInScope = state.production.review_reels_required && state.link.reels_included;
  const episodePending = !state.production.review_episode_approved;
  const reelsPending = reelsInScope && !state.production.review_reels_approved;
  const answersEpisode = episodePending && !!episode;
  const answersReels = reelsPending && !!reels;
  // when every track is already approved (a prior round) only the add-ons
  // remain — the client may finalise with just add-on decisions
  const onlyAddonsLeft = !episodePending && !reelsPending && state.addons.length > 0;
  if (!answersEpisode && !answersReels && !onlyAddonsLeft) {
    return NextResponse.json({ error: "יש לבחור אישור או תיקונים לפחות עבור בלוק אחד" }, { status: 400 });
  }

  // normalise the add-on decisions to the priced, proposed lines on this link
  const shownAddonIds = new Set(state.addons.map((a) => a.id));
  const addonDecisions: Record<string, "approved" | "rejected"> = {};
  for (const [id, v] of Object.entries(body.addons ?? {})) {
    if (shownAddonIds.has(id) && (v === "approved" || v === "rejected")) addonDecisions[id] = v;
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
    addons: addonDecisions,
  });

  return NextResponse.json({ ok: true, approved_all: approvedAll });
}
