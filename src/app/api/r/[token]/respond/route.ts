import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveLink, applyResponse, type TrackResponse, type ItemResponse } from "@/lib/review/links";

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
    // { itemId: { response: 'approved' | 'revisions', note? } } — stage 1b
    items?: Record<string, unknown>;
    // { addonId: 'approved' | 'rejected' } — only honoured on full approval
    addons?: Record<string, unknown>;
  };

  const episodeInScope = state.link.scope === "episode" || state.link.scope === "all";
  const reelsInScope = (state.link.scope === "reels" || state.link.scope === "all") && state.production.review_reels_required;

  // normalise the add-on decisions to the priced, proposed lines on this link
  const shownAddonIds = new Set(state.addons.map((a) => a.id));
  const addonDecisions: Record<string, "approved" | "rejected"> = {};
  for (const [id, v] of Object.entries(body.addons ?? {})) {
    if (shownAddonIds.has(id) && (v === "approved" || v === "rejected")) addonDecisions[id] = v;
  }

  // ── item mode (stage 1b): the production has review items and the payload
  // answers per item. Unknown ids are dropped, not errors — same rule as the
  // add-on normalisation above. ──
  if (state.items.length > 0 && body.items && typeof body.items === "object") {
    const pendingInScope = state.items.filter(
      (i) => !i.approved && (i.kind === "episode" ? episodeInScope : reelsInScope)
    );
    const pendingIds = new Set(pendingInScope.map((i) => i.id));
    const itemDecisions: Record<string, ItemResponse> = {};
    for (const [id, v] of Object.entries(body.items)) {
      if (!pendingIds.has(id) || !v || typeof v !== "object") continue;
      const r = (v as { response?: unknown }).response;
      if (r !== "approved" && r !== "revisions") continue;
      const note = typeof (v as { note?: unknown }).note === "string" ? ((v as { note: string }).note) : undefined;
      itemDecisions[id] = { response: r, note };
    }
    const onlyAddonsLeft = pendingInScope.length === 0 && state.addons.length > 0;
    if (Object.keys(itemDecisions).length === 0 && !onlyAddonsLeft) {
      return NextResponse.json({ error: "יש לבחור אישור או תיקונים לפחות עבור תוצר אחד" }, { status: 400 });
    }
    // a revision must carry a note (that's the whole point of the loop)
    for (const it of pendingInScope) {
      const d = itemDecisions[it.id];
      if (d?.response === "revisions" && !(d.note ?? "").trim()) {
        const label = it.kind === "episode" ? "בפרק" : `בריל ${it.reel_index}`;
        return NextResponse.json({ error: `נא לפרט מה לתקן ${label}` }, { status: 400 });
      }
    }

    const { approvedAll } = await applyResponse(
      admin,
      state.link,
      state.production,
      { items: itemDecisions, addons: addonDecisions },
      state.items
    );
    return NextResponse.json({ ok: true, approved_all: approvedAll });
  }

  // ── track mode (legacy fallback) — unchanged pre-1b behaviour ──
  const episode = validTrack(body.episode);
  const reels = validTrack(body.reels);

  // must respond to at least one pending, in-scope track (scope, 0037)
  const episodePending = episodeInScope && !state.production.review_episode_approved;
  const reelsPending = reelsInScope && !state.production.review_reels_approved;
  const answersEpisode = episodePending && !!episode;
  const answersReels = reelsPending && !!reels;
  // when every track is already approved (a prior round) only the add-ons
  // remain — the client may finalise with just add-on decisions
  const onlyAddonsLeft = !episodePending && !reelsPending && state.addons.length > 0;
  if (!answersEpisode && !answersReels && !onlyAddonsLeft) {
    return NextResponse.json({ error: "יש לבחור אישור או תיקונים לפחות עבור בלוק אחד" }, { status: 400 });
  }

  // a revision must carry a note (that's the whole point of the loop)
  if (answersEpisode && episode === "revisions" && !(body.episode_note ?? "").trim()) {
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
