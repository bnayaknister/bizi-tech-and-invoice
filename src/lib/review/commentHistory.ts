import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

// ═══════════════════════════════════════════════════════════════════════════
// E13-8c — the PERMANENT history of a client's comments, for the team
// (owner 17.10, after the אסתטיטוקס test): no comment or pin ever leaves the
// team's view — not after a re-approval, not after a new version, not after
// "קיבלתי". Open ones stand out, handled ones are dimmed, none is hidden.
//
// The source is client_review_comments (0114, append-only from the app: no
// code path deletes a row) — never client_review_items.last_note, which is a
// one-line cache that a re-approval clears. That cache is exactly the bug the
// test found: after "מאשר שוב" the note vanished from the drawer.
//
// THE STATE of each comment, derived from the approvals ledger:
//   revoked_approval — this comment revoked a valid approval (0118 writes the
//                      revoke in the same transaction, so revoked_at equals
//                      the comment's created_at)
//   after_approval   — written while a valid approval stood, without revoking
//                      it (does not happen through 0118 today; kept so a
//                      future path cannot be mislabelled)
//   minor            — written before an approval that the client then gave
//                      on the SAME link: "approved with notes" (owner 17.10,
//                      option א — the comments reach the team as minor notes)
//   before_approval  — everything else: a correction the item still waits on
// ═══════════════════════════════════════════════════════════════════════════

export type CommentState = "before_approval" | "minor" | "revoked_approval" | "after_approval";

export const COMMENT_STATE_LABEL: Record<CommentState, string> = {
  before_approval: "לפני אישור",
  minor: "הערה קטנה · אושר עם הערות",
  revoked_approval: "ביטלה אישור",
  after_approval: "אחרי אישור",
};

export type HcComment = {
  id: string;
  item_id: string;
  version_id: string | null;
  link_id: string | null;
  kind: string;
  pin_number: number | null;
  time_ms: number | null;
  body: string;
  author_kind: string;
  created_at: string;
  acked_at: string | null;
  acked_by: string | null;
  resolved_at: string | null;
  after_response: boolean;
  is_backfill: boolean;
};
export type HcApproval = { item_id: string; link_id: string | null; decision: string; decided_at: string; revoked_at: string | null; revoked_reason: string | null };

const SAME_TXN_MS = 2000;
const t = (s: string) => Date.parse(s);

/** Pure: one comment's state against its item's ledger rows. */
export function commentState(c: HcComment, approvals: HcApproval[]): CommentState {
  const mine = approvals.filter((a) => a.item_id === c.item_id);
  const at = t(c.created_at);
  if (mine.some((a) => a.revoked_reason === "client_comment" && a.revoked_at && Math.abs(t(a.revoked_at) - at) <= SAME_TXN_MS)) {
    return "revoked_approval";
  }
  const validThen = mine.some(
    (a) => a.decision === "approved" && t(a.decided_at) <= at && (!a.revoked_at || t(a.revoked_at) > at + SAME_TXN_MS)
  );
  if (validThen) return "after_approval";
  if (c.link_id) {
    // the next decision on this item from the SAME link, after the comment
    const next = mine
      .filter((a) => a.link_id === c.link_id && t(a.decided_at) >= at)
      .sort((a, b) => t(a.decided_at) - t(b.decided_at))[0];
    if (next && next.decision === "approved") return "minor";
  }
  return "before_approval";
}

export type HistoryComment = HcComment & {
  state: CommentState;
  state_label: string;
  open: boolean;
  version_number: number | null;
  version_file: string | null;
  acked_by_name: string | null;
};

export type HistoryItem = { id: string; kind: string; reel_index: number | null; approved: boolean; label: string; comments: HistoryComment[] };

/**
 * Pure: comments of one production → per item, newest version first, pins by
 * time inside a version, general comments after them, history (no version)
 * last. Every comment is kept — nothing here filters one out.
 */
export function buildCommentHistory(input: {
  items: { id: string; kind: string; reel_index: number | null; approved: boolean }[];
  comments: HcComment[];
  approvals: HcApproval[];
  versions: { id: string; number: number | null; original_filename: string | null }[];
  names: Record<string, string>;
}): HistoryItem[] {
  const vById = new Map(input.versions.map((v) => [v.id, v]));
  const order = (i: { kind: string; reel_index: number | null }) => (i.kind === "episode" ? 0 : 1000 + (i.reel_index ?? 999));
  return [...input.items]
    .sort((a, b) => order(a) - order(b))
    .map((it) => {
      const list: HistoryComment[] = input.comments
        .filter((c) => c.item_id === it.id)
        .map((c) => {
          const state = commentState(c, input.approvals);
          const v = c.version_id ? vById.get(c.version_id) : undefined;
          return {
            ...c,
            state,
            state_label: COMMENT_STATE_LABEL[state],
            open: !c.acked_at && !c.resolved_at,
            version_number: v?.number ?? null,
            version_file: v?.original_filename ?? null,
            acked_by_name: c.acked_by ? input.names[c.acked_by] ?? null : null,
          };
        })
        .sort((a, b) => {
          const va = a.version_number ?? -1;
          const vb = b.version_number ?? -1;
          if (va !== vb) return vb - va;
          const pa = a.kind === "pin" ? 0 : 1;
          const pb = b.kind === "pin" ? 0 : 1;
          if (pa !== pb) return pa - pb;
          if (a.kind === "pin" && b.kind === "pin") return (a.time_ms ?? 0) - (b.time_ms ?? 0);
          return t(a.created_at) - t(b.created_at);
        });
      return { id: it.id, kind: it.kind, reel_index: it.reel_index, approved: it.approved, label: it.kind === "episode" ? "פרק מלא" : `ריל ${it.reel_index}`, comments: list };
    });
}

/** Pure: comments the team has not acknowledged ("קיבלתי") — what keeps the red dot lit. */
export function unackedCommentCount(comments: { acked_at: string | null; resolved_at: string | null; author_kind: string; is_backfill: boolean }[]): number {
  return comments.filter((c) => c.author_kind === "client" && !c.is_backfill && !c.acked_at && !c.resolved_at).length;
}

/** The whole history of one production. Throws on a read error. */
export async function loadCommentHistory(admin: SupabaseClient<Database>, productionId: string): Promise<HistoryItem[]> {
  const { data: items, error: iErr } = await admin
    .from("client_review_items")
    .select("id,kind,reel_index,approved")
    .eq("production_id", productionId);
  if (iErr) throw new Error(`client_review_items: ${iErr.message}`);
  const ids = (items ?? []).map((i) => i.id);
  if (!ids.length) return [];
  const [{ data: comments, error: cErr }, { data: approvals, error: aErr }, { data: versions, error: vErr }] = await Promise.all([
    admin
      .from("client_review_comments")
      .select("id,item_id,version_id,link_id,kind,pin_number,time_ms,body,author_kind,created_at,acked_at,acked_by,resolved_at,after_response,is_backfill")
      .in("item_id", ids),
    admin.from("client_review_approvals").select("item_id,link_id,decision,decided_at,revoked_at,revoked_reason").in("item_id", ids),
    admin.from("client_review_versions").select("id,number,original_filename").in("item_id", ids),
  ]);
  if (cErr) throw new Error(`client_review_comments: ${cErr.message}`);
  if (aErr) throw new Error(`client_review_approvals: ${aErr.message}`);
  if (vErr) throw new Error(`client_review_versions: ${vErr.message}`);
  const ackers = Array.from(new Set((comments ?? []).map((c) => c.acked_by).filter((x): x is string => !!x)));
  const names: Record<string, string> = {};
  if (ackers.length) {
    const { data: profs } = await admin.from("profiles").select("id,name").in("id", ackers);
    for (const p of profs ?? []) names[p.id] = p.name;
  }
  return buildCommentHistory({ items: items ?? [], comments: comments ?? [], approvals: approvals ?? [], versions: versions ?? [], names });
}
