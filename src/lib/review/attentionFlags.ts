import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { commentState, type HcApproval, type HcComment } from "@/lib/review/commentHistory";

// ═══════════════════════════════════════════════════════════════════════════
// E13-8c follow-up (owner 18.10) — two signals on a production card, both
// DERIVED from the client's open comments (acked_at / resolved_at empty):
//
//   minor  (🟠 "אושר עם הערות") — the client approved an item in the same
//          round as a comment of theirs ("יש לך הערות. לאשר בכל זאת?" → yes).
//          The production stays אושר_ע"י_לקוח; the orange dot stays until
//          "קיבלתי" acks those comments. Distinct from the red "תיקונים" dot.
//   unsent (🔴 "הלקוח השאיר הערות ולא שלח") — comments on a LIVE link (not
//          answered, not superseded) whose newest one is over 24 hours old.
//          Pins on a live link do not light anything at once (owner 18.10);
//          the hourly cron (api/cron/review-versions) lights needs_attention
//          once this turns true.
//
// Derived, not stored: nothing to keep in sync, and an ack ends both by
// itself (an acked comment is no longer open). PURE apart from the loader.
// ═══════════════════════════════════════════════════════════════════════════

export const UNSENT_AFTER_MS = 24 * 60 * 60 * 1000;

export type FlagComment = Pick<HcComment, "id" | "item_id" | "link_id" | "created_at" | "after_response"> & {
  acked_at: string | null;
  resolved_at: string | null;
};
export type FlagLink = { id: string; production_id: string; responded_at: string | null; superseded: boolean };
export type FlagItem = { id: string; production_id: string };
export type ReviewFlags = { minor: boolean; unsent: boolean; unsentLinkId: string | null; unsentLastAt: string | null; unsentCount: number };

const asHc = (c: FlagComment): HcComment => ({
  ...c,
  version_id: null,
  kind: "pin",
  pin_number: null,
  time_ms: null,
  body: "",
  author_kind: "client",
  acked_by: null,
  is_backfill: false,
});

export function deriveReviewFlags(input: {
  comments: FlagComment[]; // the client's, non-backfill
  items: FlagItem[];
  approvals: HcApproval[];
  links: FlagLink[];
  nowMs: number;
}): Map<string, ReviewFlags> {
  const prodOfItem = new Map(input.items.map((i) => [i.id, i.production_id]));
  const linkById = new Map(input.links.map((l) => [l.id, l]));
  const out = new Map<string, ReviewFlags>();
  const get = (pid: string) => {
    let f = out.get(pid);
    if (!f) out.set(pid, (f = { minor: false, unsent: false, unsentLinkId: null, unsentLastAt: null, unsentCount: 0 }));
    return f;
  };
  const open = input.comments.filter((c) => !c.acked_at && !c.resolved_at);

  for (const c of open) {
    const pid = prodOfItem.get(c.item_id);
    if (!pid) continue;
    if (commentState(asHc(c), input.approvals) === "minor") get(pid).minor = true;
  }

  // unsent: per live link, its newest open comment over 24h old
  const byLink = new Map<string, FlagComment[]>();
  for (const c of open) if (c.link_id) byLink.set(c.link_id, [...(byLink.get(c.link_id) ?? []), c]);
  byLink.forEach((list, linkId) => {
    const link = linkById.get(linkId);
    if (!link || link.responded_at || link.superseded) return;
    const last = list.reduce((m, c) => (c.created_at > m ? c.created_at : m), list[0].created_at);
    if (input.nowMs - Date.parse(last) < UNSENT_AFTER_MS) return;
    const f = get(link.production_id);
    f.unsent = true;
    if (!f.unsentLastAt || last > f.unsentLastAt) {
      f.unsentLinkId = linkId;
      f.unsentLastAt = last;
    }
    f.unsentCount += list.length;
  });
  return out;
}

/**
 * The flags for every production that has an open client comment (or only
 * for `productionIds`, when given). Open comments are few — the read starts
 * there, not from the board's productions. Throws on a read error.
 */
export async function loadReviewFlags(admin: SupabaseClient<Database>, nowMs: number, productionIds?: string[]): Promise<Map<string, ReviewFlags>> {
  const { data: comments, error: cErr } = await admin
    .from("client_review_comments")
    .select("id,item_id,link_id,created_at,after_response,acked_at,resolved_at")
    .eq("author_kind", "client")
    .eq("is_backfill", false)
    .is("acked_at", null)
    .is("resolved_at", null);
  if (cErr) throw new Error(`client_review_comments: ${cErr.message}`);
  if (!comments?.length) return new Map();
  const itemIds = Array.from(new Set(comments.map((c) => c.item_id)));
  const { data: items, error: iErr } = await admin.from("client_review_items").select("id,production_id").in("id", itemIds);
  if (iErr) throw new Error(`client_review_items: ${iErr.message}`);
  const wanted = productionIds ? new Set(productionIds) : null;
  const keptItems = (items ?? []).filter((i) => !wanted || wanted.has(i.production_id));
  if (!keptItems.length) return new Map();
  const keptIds = new Set(keptItems.map((i) => i.id));
  const linkIds = Array.from(new Set(comments.filter((c) => keptIds.has(c.item_id) && c.link_id).map((c) => c.link_id as string)));
  const [{ data: approvals, error: aErr }, { data: links, error: lErr }] = await Promise.all([
    admin.from("client_review_approvals").select("item_id,link_id,decision,decided_at,revoked_at,revoked_reason").in("item_id", Array.from(keptIds)),
    linkIds.length
      ? admin.from("client_review_links").select("id,production_id,responded_at,superseded").in("id", linkIds)
      : Promise.resolve({ data: [] as FlagLink[], error: null }),
  ]);
  if (aErr) throw new Error(`client_review_approvals: ${aErr.message}`);
  if (lErr) throw new Error(`client_review_links: ${lErr.message}`);
  return deriveReviewFlags({
    comments: comments.filter((c) => keptIds.has(c.item_id)),
    items: keptItems,
    approvals: approvals ?? [],
    links: (links ?? []) as FlagLink[],
    nowMs,
  });
}

export const UNSENT_EVENT = "client_review_comments_unsent";

/**
 * The hourly cron's step (owner 18.10): every production whose client left
 * comments on a live link and sent nothing for 24h gets needs_attention ON,
 * ONCE per (link, newest comment) — an event marks it, so an ack followed by
 * no new comment never re-lights, and a new comment re-arms it.
 */
export async function sweepUnsentComments(admin: SupabaseClient<Database>, nowMs: number): Promise<{ lit: number; skipped: number }> {
  const flags = await loadReviewFlags(admin, nowMs);
  let lit = 0;
  let skipped = 0;
  for (const [pid, f] of Array.from(flags.entries())) {
    if (!f.unsent || !f.unsentLinkId || !f.unsentLastAt) continue;
    const { data: prior } = await admin
      .from("events")
      .select("id,payload")
      .eq("entity_type", "production")
      .eq("entity_id", pid)
      .eq("event_type", UNSENT_EVENT);
    const already = (prior ?? []).some((e) => {
      const p = (e.payload ?? {}) as { link_id?: string; last_comment_at?: string };
      return p.link_id === f.unsentLinkId && p.last_comment_at === f.unsentLastAt;
    });
    if (already) {
      skipped++;
      continue;
    }
    const { error: uErr } = await admin.from("productions").update({ needs_attention: true }).eq("id", pid);
    if (uErr) throw new Error(`productions: ${uErr.message}`);
    await admin.from("events").insert({
      entity_type: "production",
      entity_id: pid,
      event_type: UNSENT_EVENT,
      payload: { link_id: f.unsentLinkId, last_comment_at: f.unsentLastAt, comments: f.unsentCount },
    });
    lit++;
  }
  return { lit, skipped };
}
