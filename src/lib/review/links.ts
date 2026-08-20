import { randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueDocument, getClientCadence, type ProductionForBilling } from "@/lib/documents/enqueue";
import { bumpReelsCountForAddons } from "@/lib/production/reels";

// Client review links (screens-spec §9a). Server-only — every function here
// runs with the service-role client, since the public page and the response
// endpoint act on behalf of an account-less client identified solely by a
// long random token.

export function generateToken(): string {
  // 32 bytes -> 43 url-safe chars. Infeasible to guess; this IS the auth.
  return randomBytes(32).toString("base64url");
}

const LINK_TTL_DAYS = 14;

export type CreateLinkResult = { token: string; url: string; expiresAt: string };

/**
 * Mint a fresh review link, superseding any previous live one whose scope
 * OVERLAPS this one (a new round = a new link; the old one dies). Overlap,
 * not equality: 'all' shares a track with both 'episode' and 'reels', so an
 * episode link kills episode+all, a reels link kills reels+all, and 'all'
 * kills everything — but an episode link and a reels link live side by side
 * (B1: a global supersede killed the client's episode link the moment the
 * reels link was minted). Per-track approval state on the production is
 * preserved, so an already-approved track stays locked across rounds.
 */
export async function createReviewLink(
  admin: SupabaseClient,
  productionId: string,
  opts: { createdBy: string; baseUrl: string; scope: "episode" | "reels" | "all"; episodeLink?: string | null; reelsLink?: string | null }
): Promise<CreateLinkResult> {
  const overlappingScopes = opts.scope === "all" ? ["episode", "reels", "all"] : [opts.scope, "all"];
  await admin
    .from("client_review_links")
    .update({ superseded: true })
    .eq("production_id", productionId)
    .in("scope", overlappingScopes)
    .eq("superseded", false)
    .is("responded_at", null);

  // whether reels is part of this round is now carried by scope (0037);
  // reels_included is still written for back-compat until it's dropped. A
  // reels-bearing scope ('reels'/'all') marks the reels round open; an
  // 'episode' scope leaves the field ALONE — episode and reels links now live
  // side by side, and clearing it here blanked the reels block on a live
  // reels link (B1 completion). Nothing else ever writes this field; approval
  // through an episode link never consults it (reelsInScope is already false
  // by scope), so a stuck-true value cannot block anything.
  const reelsIncluded = opts.scope !== "episode";
  if (reelsIncluded) {
    await admin.from("productions").update({ review_reels_required: true }).eq("id", productionId);
  }

  // Lazy seeding (0057, item-based review §2): a production meets the items
  // model the first time a link is minted for it. Seeded from has_episode +
  // reels_count — the composition truth — with approved initialised from the
  // sticky per-track flags, and media inherited from what this mint carries.
  // Items are seeded HERE only; an approved reels add-on that later raises
  // reels_count must NOT retro-create items (spec §4 — the production may
  // already be approved). 23505 = a concurrent mint seeded first; fine.
  const { data: existingItems } = await admin
    .from("client_review_items")
    .select("id")
    .eq("production_id", productionId)
    .limit(1);
  if (!existingItems || existingItems.length === 0) {
    const { data: comp } = await admin
      .from("productions")
      .select("has_episode,reels_count,review_episode_approved,review_reels_approved")
      .eq("id", productionId)
      .maybeSingle();
    if (comp) {
      const rows: {
        production_id: string; kind: string; reel_index: number | null; media_link: string | null; approved: boolean;
      }[] = [];
      if (comp.has_episode) {
        rows.push({
          production_id: productionId, kind: "episode", reel_index: null,
          media_link: opts.episodeLink ?? null, approved: !!comp.review_episode_approved,
        });
      }
      const reelCount = Number(comp.reels_count) || 0;
      for (let i = 1; i <= reelCount; i++) {
        rows.push({
          production_id: productionId, kind: "reel", reel_index: i,
          media_link: opts.reelsLink ?? null, approved: !!comp.review_reels_approved,
        });
      }
      if (rows.length) {
        const { error: seedErr } = await admin.from("client_review_items").insert(rows);
        if (seedErr && seedErr.code !== "23505") throw new Error(seedErr.message);
      }
    }
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 24 * 3600_000).toISOString();
  const { error } = await admin.from("client_review_links").insert({
    production_id: productionId,
    token,
    expires_at: expiresAt,
    created_by: opts.createdBy,
    scope: opts.scope,
    reels_included: reelsIncluded,
    episode_link: opts.episodeLink ?? null,
    reels_link: opts.reelsLink ?? null,
  });
  if (error) throw new Error(error.message);

  return { token, url: `${opts.baseUrl}/r/${token}`, expiresAt };
}

// A priced, still-proposed upsell the client is being quoted on this link
// (owner spec 2026-07-21). Unpriced lines are never shown — there's nothing
// to approve without a price.
export type ReviewAddon = { id: string; title: string; quantity: number; unit_price: number; total: number };

// One deliverable under review (0057). Since stage 1b the items are the
// approval source for item-mode links: applyResponse writes them first and
// derives the production's per-track flags from them, so the flags stay a
// consistent cache for every legacy consumer.
export type ReviewItem = {
  id: string;
  kind: "episode" | "reel";
  reel_index: number | null;
  media_link: string | null;
  approved: boolean;
  last_note: string | null;
};

export type LinkState =
  | { status: "ok"; link: ReviewLinkRow; production: ReviewProductionRow; addons: ReviewAddon[]; baseAmount: number | null; items: ReviewItem[] }
  | { status: "missing" }
  | { status: "expired" }
  | { status: "superseded" }
  | { status: "responded" };

export type ReviewLinkRow = {
  id: string;
  production_id: string;
  token: string;
  expires_at: string;
  responded_at: string | null;
  superseded: boolean;
  reels_included: boolean;
  scope: "episode" | "reels" | "all";
  episode_link: string | null;
  reels_link: string | null;
};

export type ReviewProductionRow = {
  id: string;
  podcast_name: string | null;
  record_date: string | null;
  split_index: number | null;
  split_count: number | null;
  review_episode_approved: boolean;
  review_reels_approved: boolean;
  review_reels_required: boolean;
};

// Resolve a token to its link + production, classifying why it might be
// unusable. NEVER selects any money/system field — only what the public
// screen shows.
export async function resolveLink(admin: SupabaseClient, token: string): Promise<LinkState> {
  const { data: link } = await admin
    .from("client_review_links")
    .select("id,production_id,token,expires_at,responded_at,superseded,reels_included,scope,episode_link,reels_link")
    .eq("token", token)
    .maybeSingle();
  if (!link) return { status: "missing" };
  if (link.superseded) return { status: "superseded" };
  if (link.responded_at) return { status: "responded" };
  if (new Date(link.expires_at).getTime() < Date.now()) return { status: "expired" };

  const { data: production } = await admin
    .from("productions")
    .select("id,podcast_name,record_date,split_index,split_count,review_episode_approved,review_reels_approved,review_reels_required,price_override,show_id")
    .eq("id", link.production_id)
    .maybeSingle();
  if (!production) return { status: "missing" };

  // effective base price the client is quoted (owner decision 2026-07-21:
  // full transparency — the review link shows exactly what the invoice will).
  // price_override wins over the show's default_rate.
  let baseAmount: number | null = (production as { price_override: number | null }).price_override ?? null;
  if (baseAmount == null && (production as { show_id: string | null }).show_id) {
    const { data: show } = await admin
      .from("shows")
      .select("default_rate")
      .eq("id", (production as { show_id: string }).show_id)
      .maybeSingle();
    baseAmount = (show?.default_rate as number | null) ?? null;
  }

  // priced, still-proposed add-ons — the client's quote for this round
  const { data: addonRows } = await admin
    .from("production_addons")
    .select("id,title,quantity,unit_price,total")
    .eq("production_id", link.production_id)
    .eq("status", "proposed")
    .not("unit_price", "is", null)
    .order("created_at");
  const addons: ReviewAddon[] = (addonRows ?? []).map((a) => ({
    id: a.id as string,
    title: a.title as string,
    quantity: a.quantity as number,
    unit_price: a.unit_price as number,
    total: a.total as number,
  }));

  // review items (0057) — empty for a production minted before the items
  // model; the public page falls back to the track-level rendering then
  const { data: itemRows } = await admin
    .from("client_review_items")
    .select("id,kind,reel_index,media_link,approved,last_note")
    .eq("production_id", link.production_id)
    .order("kind") // 'episode' sorts before 'reel'
    .order("reel_index", { ascending: true });
  const items: ReviewItem[] = (itemRows ?? []).map((r) => ({
    id: r.id as string,
    kind: r.kind as "episode" | "reel",
    reel_index: (r.reel_index as number | null) ?? null,
    media_link: (r.media_link as string | null) ?? null,
    approved: !!r.approved,
    last_note: (r.last_note as string | null) ?? null,
  }));

  return { status: "ok", link: link as ReviewLinkRow, production: production as ReviewProductionRow, addons, baseAmount, items };
}

export type TrackResponse = "approved" | "revisions" | undefined;

// one client decision on one review item (stage 1b)
export type ItemResponse = { response: "approved" | "revisions"; note?: string };

/**
 * Apply a client's response. Only PENDING, in-scope items/tracks are affected
 * — an already-approved deliverable can't be reopened by a later link. When
 * every in-scope deliverable is approved the production is marked
 * client-approved (which fires the job trigger) and a deal invoice is queued;
 * otherwise it goes back to editing, flagged for attention, with the
 * correction notes attached.
 *
 * Two response shapes share this function:
 *   • item mode (stage 1b) — resp.items carries a per-item decision, the
 *     items are written FIRST (a failure there throws before anything is
 *     recorded), and the per-track flags/decisions are DERIVED from the item
 *     set so everything downstream (approvedAll, the status flip, the
 *     trigger, cadence, enqueue) runs exactly as before.
 *   • track mode (legacy fallback) — a production the items model hasn't
 *     reached, or an old client payload; byte-identical to the pre-1b path.
 */
export async function applyResponse(
  admin: SupabaseClient,
  link: ReviewLinkRow,
  production: ReviewProductionRow,
  resp: {
    episode?: TrackResponse;
    episodeNote?: string;
    reels?: TrackResponse;
    reelsNote?: string;
    // per-item decisions keyed by client_review_items.id (stage 1b)
    items?: Record<string, ItemResponse>;
    // per-add-on client decision, keyed by add-on id (owner spec 2026-07-21).
    // Only consulted when the whole production is being approved this round.
    addons?: Record<string, "approved" | "rejected">;
  },
  // the production's review items as resolved server-side (trusted, not from
  // the client); empty for a pre-items production
  currentItems: ReviewItem[] = []
): Promise<{ approvedAll: boolean }> {
  const patch: Record<string, unknown> = {};

  // which tracks this link may act on (0037). For every link that existed
  // before scope, scope backfilled to 'all'/'episode', so episodeInScope is
  // true and reelsInScope equals the old (review_reels_required &&
  // reels_included) — behaviour is byte-identical; only a new 'reels'-scoped
  // link changes anything (it leaves the episode untouched).
  const episodeInScope = link.scope === "episode" || link.scope === "all";
  const reelsInScope = (link.scope === "reels" || link.scope === "all") && production.review_reels_required;

  const itemMode = currentItems.length > 0 && !!resp.items;

  // ── item mode: write the items FIRST, then derive the track decisions ──
  // Item writes happen BEFORE the status update on purpose: a failure here
  // throws while nothing has been recorded yet, so the client can simply
  // retry — there is no half-recorded approval to reconcile.
  let respEpisode: TrackResponse = resp.episode;
  let respEpisodeNote: string | undefined = resp.episodeNote;
  let respReels: TrackResponse = resp.reels;
  let respReelsNote: string | undefined = resp.reelsNote;
  const itemDetail: { id: string; kind: string; reel_index: number | null; response: string; note: string | null }[] = [];

  if (itemMode) {
    const inScope = (i: ReviewItem) => (i.kind === "episode" ? episodeInScope : reelsInScope);
    const nowIso = new Date().toISOString();
    const reelRevisionNotes: string[] = [];
    let episodeAnswer: ItemResponse | null = null;
    let anyReelAnswered = false;

    for (const it of currentItems) {
      if (!inScope(it) || it.approved) continue; // sticky: an approved item is immutable from a link
      const d = resp.items![it.id];
      if (!d || (d.response !== "approved" && d.response !== "revisions")) continue;
      const note = d.note?.trim() || null;
      if (d.response === "approved") {
        // approval clears the correction note — the reset rule (B3)
        const { error } = await admin
          .from("client_review_items")
          .update({ approved: true, approved_at: nowIso, last_note: null })
          .eq("id", it.id)
          .eq("production_id", production.id)
          .eq("approved", false);
        if (error) throw new Error(error.message);
        it.approved = true;
        it.last_note = null;
      } else {
        const { error } = await admin
          .from("client_review_items")
          .update({ last_note: note ?? "תיקונים התבקשו" })
          .eq("id", it.id)
          .eq("production_id", production.id)
          .eq("approved", false);
        if (error) throw new Error(error.message);
        it.last_note = note ?? "תיקונים התבקשו";
      }
      itemDetail.push({ id: it.id, kind: it.kind, reel_index: it.reel_index, response: d.response, note });
      if (it.kind === "episode") episodeAnswer = d;
      else {
        anyReelAnswered = true;
        if (d.response === "revisions") reelRevisionNotes.push(`ריל ${it.reel_index}: ${note ?? "תיקונים התבקשו"}`);
      }
    }

    // derive the track-level decisions the existing machinery consumes; the
    // per-track flags stay a consistent cache of the item set
    if (episodeAnswer) {
      respEpisode = episodeAnswer.response;
      respEpisodeNote = episodeAnswer.note;
    } else {
      respEpisode = undefined;
      respEpisodeNote = undefined;
    }
    const reelItems = currentItems.filter((i) => i.kind === "reel");
    if (reelRevisionNotes.length) {
      respReels = "revisions";
      respReelsNote = reelRevisionNotes.join("\n");
    } else if (anyReelAnswered && reelItems.every((i) => i.approved)) {
      respReels = "approved";
      respReelsNote = undefined;
    } else {
      respReels = undefined;
      respReelsNote = undefined;
    }
  }

  // episode (only if this review includes it)
  let episodeApproved = production.review_episode_approved;
  if (episodeInScope && !production.review_episode_approved && respEpisode) {
    if (respEpisode === "approved") {
      episodeApproved = true;
      patch.review_episode_approved = true;
      patch.review_episode_note = null;
    } else {
      episodeApproved = false;
      patch.review_episode_note = respEpisodeNote?.trim() || "תיקונים התבקשו";
    }
  }

  // reels (only if this review includes them)
  let reelsApproved = production.review_reels_approved;
  if (reelsInScope && !production.review_reels_approved && respReels) {
    if (respReels === "approved") {
      reelsApproved = true;
      patch.review_reels_approved = true;
      patch.review_reels_note = null;
    } else {
      reelsApproved = false;
      patch.review_reels_note = respReelsNote?.trim() || "תיקונים התבקשו";
    }
  }

  // item mode refines the two "is this deliverable set approved" answers from
  // the items themselves — including the vacuous cases the flags get wrong
  // (a production with no episode item, or none of its reels in play). The
  // formula below is unchanged, so the flip moment does not move.
  if (itemMode) {
    const episodeItem = currentItems.find((i) => i.kind === "episode") ?? null;
    const reelItems = currentItems.filter((i) => i.kind === "reel");
    episodeApproved = episodeItem ? episodeItem.approved : true;
    reelsApproved = reelItems.length ? reelItems.every((i) => i.approved) : true;
  }

  const approvedAll = episodeApproved && (!reelsInScope || reelsApproved);

  if (approvedAll) {
    // fires guard_client_approval_transition (null-escape) + on_production_approved
    patch.status = 'אושר_ע"י_לקוח';
    patch.needs_attention = false;
  } else {
    // a correction was requested — back to the board, loudly
    patch.status = "בעריכה";
    patch.needs_attention = true;
  }

  // Resolve the upsells the client just decided on BEFORE flipping the
  // production to client-approved: the status change fires
  // on_production_approved, whose job total sums the 'approved' add-ons, so
  // they must already be approved when the trigger reads them (owner timing
  // note 2026-07-21). A rejected line is recorded, never billed; only priced,
  // still-proposed lines are touched — an already-decided line is immutable.
  if (approvedAll && resp.addons) {
    const justApproved: string[] = [];
    for (const [addonId, decision] of Object.entries(resp.addons)) {
      if (decision !== "approved" && decision !== "rejected") continue;
      const { data: touched } = await admin
        .from("production_addons")
        .update({ status: decision, approved_via: "link" })
        .eq("id", addonId)
        .eq("production_id", production.id)
        .eq("status", "proposed")
        .not("unit_price", "is", null)
        .select("id")
        .maybeSingle();
      if (touched && decision === "approved") justApproved.push(addonId);
    }
    // A reels add-on the client just bought raises the production's
    // reels_count — the tally's only source since 0055. Only lines this call
    // actually flipped are counted, so a replayed response can't inflate it.
    // Runs before the status patch below, so the count is already right by the
    // time on_production_approved fires.
    await bumpReelsCountForAddons(admin, production.id, justApproved);
  }

  // ══ the recording moment. This update (status + derived flags, one atomic
  // patch, exactly as before) is the last write allowed to throw. ══
  const { error: prodErr } = await admin.from("productions").update(patch).eq("id", production.id);
  if (prodErr) throw new Error(prodErr.message);

  // From here on the approval IS recorded — a failed follow-up write must not
  // fail the public page (rule 38, owner 2026-08-17). Each one is checked and,
  // on failure, leaves a trace event instead of throwing; the trace write
  // itself is best-effort.
  const recordFailure = async (what: string, message: string) => {
    try {
      await admin.from("events").insert({
        entity_type: "production",
        entity_id: production.id,
        event_type: "review_followup_write_failed",
        payload: { link_id: link.id, what, message },
      });
    } catch {
      // nothing left to do — the approval itself is safe
    }
  };

  // record the response on the link (history) and lock it
  const { error: histErr } = await admin
    .from("client_review_links")
    .update({
      responded_at: new Date().toISOString(),
      episode_response: respEpisode ?? null,
      reels_response: reelsInScope ? respReels ?? null : null,
      episode_note: respEpisodeNote?.trim() || null,
      reels_note: respReelsNote?.trim() || null,
    })
    .eq("id", link.id);
  if (histErr) await recordFailure("link_history", histErr.message);

  const { error: evErr } = await admin.from("events").insert({
    entity_type: "production",
    entity_id: production.id,
    event_type: approvedAll ? "client_review_approved" : "client_review_revisions",
    payload: {
      link_id: link.id,
      episode: respEpisode ?? null,
      reels: reelsInScope ? respReels ?? null : null,
      episode_note: respEpisodeNote?.trim() || null,
      reels_note: respReelsNote?.trim() || null,
      // per-item detail (stage 1b) — empty for a track-mode response
      items: itemDetail.length ? itemDetail : undefined,
    },
  });
  if (evErr) await recordFailure("response_event", evErr.message);

  // the client's correction notes join the production journal (§3, owner
  // 2026-07-24) — one full story. kind='client', author null (the client),
  // tagged to the track they were about. Only real notes on a revisions round.
  // In item mode each reel note is its own entry, prefixed with its reel.
  const clientLog: {
    production_id: string; kind: string; track: "episode" | "reels"; note: string;
  }[] = [];
  if (itemMode) {
    for (const d of itemDetail) {
      if (d.response !== "revisions" || !d.note) continue;
      clientLog.push({
        production_id: production.id,
        kind: "client",
        track: d.kind === "episode" ? "episode" : "reels",
        note: d.kind === "reel" ? `ריל ${d.reel_index}: ${d.note}` : d.note,
      });
    }
  } else {
    if (episodeInScope && respEpisode === "revisions" && respEpisodeNote?.trim())
      clientLog.push({ production_id: production.id, kind: "client", track: "episode", note: respEpisodeNote.trim() });
    if (reelsInScope && respReels === "revisions" && respReelsNote?.trim())
      clientLog.push({ production_id: production.id, kind: "client", track: "reels", note: respReelsNote.trim() });
  }
  if (clientLog.length) {
    const { error: logErr } = await admin.from("production_log").insert(clientLog);
    if (logErr) await recordFailure("client_log", logErr.message);
  }

  // full approval → deal invoice into the queue (same as the manual path).
  // The add-ons were already resolved above, before the status flip.
  if (approvedAll) {
    const { data: prod } = await admin
      .from("productions")
      // `guest` feeds the printed line (buildLineItemText) — omitting the
      // column would quietly bill a guest session as a guestless one
      .select("id,kind,legacy,client_id,show_id,podcast_name,record_date,guest,price_override")
      .eq("id", production.id)
      .maybeSingle();
    const { data: link2 } = await admin
      .from("job_productions")
      .select("job_id")
      .eq("production_id", production.id)
      .limit(1)
      .maybeSingle();
    if (prod) {
      // Cadence brake (owner spec 2026-07-28): monthly / every_n clients wait
      // for redemption — the deal invoice is not enqueued here. per_episode
      // enqueues immediately, same as the manual board path. The DB trigger
      // has already created the internal job either way.
      // The client's approval is already recorded — a failed enqueue (or a
      // failed cadence read, which throws) must not read as a failed approval
      // on the public page. Leave a trace instead of throwing.
      try {
        const cadence = await getClientCadence(admin, prod.client_id);
        if (cadence === "per_episode") {
          const res = await enqueueDocument(admin, "deal_invoice", prod as ProductionForBilling, { jobId: link2?.job_id ?? null });
          if (res.status === "error" || res.status === "blocked") {
            await admin.from("events").insert({
              entity_type: "production",
              entity_id: production.id,
              event_type: "deal_invoice_enqueue_failed",
              payload: { status: res.status, detail: res.status === "error" ? res.error : res.reason },
            });
          }
        }
      } catch (e) {
        await admin.from("events").insert({
          entity_type: "production",
          entity_id: production.id,
          event_type: "deal_invoice_enqueue_failed",
          payload: { status: "error", detail: e instanceof Error ? e.message : String(e) },
        });
      }
    }
  }

  return { approvedAll };
}
