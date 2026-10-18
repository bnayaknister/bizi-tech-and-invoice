// ═══════════════════════════════════════════════════════════════════════════
// E13-9 — "טופל" on ONE client comment (plan §2.3, §9.2 E13-9; owner 18.10).
// PURE — the route reads, asks this, and writes what it says.
//
//   · "טופל" and "קיבלתי" stay two facts (0114: resolved_* vs acked_*), but
//     marking "טופל" also acks the comment if nobody did (owner 18.10, (2)):
//     whoever fixed a note has read it
//   · the red dot goes out when nothing unread is left — the same rule as
//     "קיבלתי" (lib/review/reviewAck): no unacked comment, and no unacked
//     revisions round — and no Drive file the client could not download
//     (lib/review/downloadAttention: the dot is shared, a clear must not hide it)
//   · the round: resolving the last unread comment also acks the latest
//     revisions round, but ONLY when that round carries no note text of its own
//     (episode_note / reels_note empty — its corrections are all comments).
//     A round with typed notes still needs "קיבלתי": those words are not a
//     comment anyone marked
//   · un-marking ("בטל טופל") clears resolved_* only. The ack stays — the
//     comment WAS read — so the dot does not come back
//   · nothing is ever deleted: the comment stays in every list
// ═══════════════════════════════════════════════════════════════════════════

export type ResolveRound = {
  id: string;
  episode_response: string | null;
  reels_response: string | null;
  episode_note: string | null;
  reels_note: string | null;
} | null;

export type ResolvePlan =
  | { kind: "nothing" }
  | { kind: "unresolve" }
  | { kind: "resolve"; ack: boolean; ackRound: boolean; clearAttention: boolean };

export function planResolve(input: {
  resolved: boolean;
  comment: { acked_at: string | null; resolved_at: string | null };
  /** unread client comments of the production OTHER than this one (not acked, not resolved, not backfill) */
  otherUnread: number;
  latestRound: ResolveRound;
  prodAckLinkId: string | null;
  /** outstanding "client could not download" entries (downloadAttention.outstandingMissing) */
  missingDownloads: number;
}): ResolvePlan {
  const { resolved, comment, otherUnread, latestRound, prodAckLinkId, missingDownloads } = input;
  if (!resolved) return comment.resolved_at ? { kind: "unresolve" } : { kind: "nothing" };
  // a double click, or someone else got there first — no second stamp
  if (comment.resolved_at) return { kind: "nothing" };

  const plan = planResolveMany({ comments: [comment], otherUnread, latestRound, prodAckLinkId, missingDownloads });
  return plan.kind === "resolve" ? { kind: "resolve", ack: plan.ackIds.length > 0, ackRound: plan.ackRound, clearAttention: plan.clearAttention } : plan;
}

/**
 * E13-9 "✓ סמן הכול כטופל" (owner 18.10): the open comments of an item's
 * latest version, marked in one go — the SAME rule as one mark, applied to the
 * set. Each comment still gets its own stamp (resolved_by / resolved_at), and
 * acked_* where nobody acked it. `otherUnread` counts unread comments OUTSIDE
 * the set.
 */
export function planResolveMany(input: {
  comments: { id?: string; acked_at: string | null; resolved_at: string | null }[];
  otherUnread: number;
  latestRound: ResolveRound;
  prodAckLinkId: string | null;
  missingDownloads: number;
}): { kind: "nothing" } | { kind: "resolve"; resolveIds: string[]; ackIds: string[]; ackRound: boolean; clearAttention: boolean } {
  const { otherUnread, latestRound, prodAckLinkId, missingDownloads } = input;
  const targets = input.comments.filter((c) => !c.resolved_at);
  if (!targets.length) return { kind: "nothing" };

  const roundRevisions = !!latestRound && (latestRound.episode_response === "revisions" || latestRound.reels_response === "revisions");
  const roundUnread = roundRevisions && prodAckLinkId !== latestRound!.id;
  const roundHasText = !!latestRound && (!!latestRound.episode_note?.trim() || !!latestRound.reels_note?.trim());
  const nothingElseUnread = otherUnread === 0;
  const ackRound = roundUnread && !roundHasText && nothingElseUnread;
  const toAck = targets.filter((c) => !c.acked_at);
  return {
    kind: "resolve",
    resolveIds: targets.map((c) => c.id ?? ""),
    ackIds: toAck.map((c) => c.id ?? ""),
    ackRound,
    // only when THIS mark read something: resolving already-acked comments
    // must not put out a dot someone lit by hand after that ack
    clearAttention: (toAck.length > 0 || ackRound) && nothingElseUnread && (!roundUnread || ackRound) && missingDownloads === 0,
  };
}
