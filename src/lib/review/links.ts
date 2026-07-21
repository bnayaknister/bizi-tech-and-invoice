import { randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueDocument, type ProductionForBilling } from "@/lib/documents/enqueue";

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
 * Mint a fresh review link, superseding any previous live one (a new round =
 * a new link; the old one dies). Per-track approval state on the production is
 * preserved, so an already-approved track stays locked across rounds.
 */
export async function createReviewLink(
  admin: SupabaseClient,
  productionId: string,
  opts: { createdBy: string; baseUrl: string; reelsIncluded: boolean; episodeLink?: string | null; reelsLink?: string | null }
): Promise<CreateLinkResult> {
  await admin
    .from("client_review_links")
    .update({ superseded: true })
    .eq("production_id", productionId)
    .eq("superseded", false)
    .is("responded_at", null);

  // scope of this review round is remembered on the production so the final
  // "all tracks approved?" test is stable
  await admin.from("productions").update({ review_reels_required: opts.reelsIncluded }).eq("id", productionId);

  const token = generateToken();
  const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 24 * 3600_000).toISOString();
  const { error } = await admin.from("client_review_links").insert({
    production_id: productionId,
    token,
    expires_at: expiresAt,
    created_by: opts.createdBy,
    reels_included: opts.reelsIncluded,
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

export type LinkState =
  | { status: "ok"; link: ReviewLinkRow; production: ReviewProductionRow; addons: ReviewAddon[]; baseAmount: number | null }
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
    .select("id,production_id,token,expires_at,responded_at,superseded,reels_included,episode_link,reels_link")
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

  return { status: "ok", link: link as ReviewLinkRow, production: production as ReviewProductionRow, addons, baseAmount };
}

export type TrackResponse = "approved" | "revisions" | undefined;

/**
 * Apply a client's response. Only PENDING, in-scope tracks are affected — an
 * already-approved track can't be reopened by a later link. When every
 * in-scope track is approved the production is marked client-approved (which
 * fires the job trigger) and a deal invoice is queued; otherwise it goes back
 * to editing, flagged for attention, with the correction notes attached.
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
    // per-add-on client decision, keyed by add-on id (owner spec 2026-07-21).
    // Only consulted when the whole production is being approved this round.
    addons?: Record<string, "approved" | "rejected">;
  }
): Promise<{ approvedAll: boolean }> {
  const patch: Record<string, unknown> = {};

  // episode
  let episodeApproved = production.review_episode_approved;
  if (!production.review_episode_approved && resp.episode) {
    if (resp.episode === "approved") {
      episodeApproved = true;
      patch.review_episode_approved = true;
      patch.review_episode_note = null;
    } else {
      episodeApproved = false;
      patch.review_episode_note = resp.episodeNote?.trim() || "תיקונים התבקשו";
    }
  }

  // reels (only if this review includes them)
  let reelsApproved = production.review_reels_approved;
  const reelsInScope = production.review_reels_required && link.reels_included;
  if (reelsInScope && !production.review_reels_approved && resp.reels) {
    if (resp.reels === "approved") {
      reelsApproved = true;
      patch.review_reels_approved = true;
      patch.review_reels_note = null;
    } else {
      reelsApproved = false;
      patch.review_reels_note = resp.reelsNote?.trim() || "תיקונים התבקשו";
    }
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
    for (const [addonId, decision] of Object.entries(resp.addons)) {
      if (decision !== "approved" && decision !== "rejected") continue;
      await admin
        .from("production_addons")
        .update({ status: decision, approved_via: "link" })
        .eq("id", addonId)
        .eq("production_id", production.id)
        .eq("status", "proposed")
        .not("unit_price", "is", null);
    }
  }

  const { error: prodErr } = await admin.from("productions").update(patch).eq("id", production.id);
  if (prodErr) throw new Error(prodErr.message);

  // record the response on the link (history) and lock it
  await admin
    .from("client_review_links")
    .update({
      responded_at: new Date().toISOString(),
      episode_response: resp.episode ?? null,
      reels_response: reelsInScope ? resp.reels ?? null : null,
      episode_note: resp.episodeNote?.trim() || null,
      reels_note: resp.reelsNote?.trim() || null,
    })
    .eq("id", link.id);

  await admin.from("events").insert({
    entity_type: "production",
    entity_id: production.id,
    event_type: approvedAll ? "client_review_approved" : "client_review_revisions",
    payload: {
      link_id: link.id,
      episode: resp.episode ?? null,
      reels: reelsInScope ? resp.reels ?? null : null,
      episode_note: resp.episodeNote?.trim() || null,
      reels_note: resp.reelsNote?.trim() || null,
    },
  });

  // full approval → deal invoice into the queue (same as the manual path).
  // The add-ons were already resolved above, before the status flip.
  if (approvedAll) {
    const { data: prod } = await admin
      .from("productions")
      .select("id,kind,legacy,client_id,show_id,podcast_name,record_date,price_override")
      .eq("id", production.id)
      .maybeSingle();
    const { data: link2 } = await admin
      .from("job_productions")
      .select("job_id")
      .eq("production_id", production.id)
      .limit(1)
      .maybeSingle();
    if (prod) {
      await enqueueDocument(admin, "deal_invoice", prod as ProductionForBilling, { jobId: link2?.job_id ?? null });
    }
  }

  return { approvedAll };
}
