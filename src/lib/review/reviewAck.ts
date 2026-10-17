// ═══════════════════════════════════════════════════════════════════════════
// E13-8c — "קיבלתי, מטפל" over BOTH things a client can leave (plan §4a;
// owner 17.10): the round's own notes (client_review_links, 0071) and the
// comments / pins (client_review_comments, 0114 acked_at / acked_by).
// PURE — the route reads, asks this, and writes what it says.
//
//   · the round is acked as before: by its link_id, refused (409) when a newer
//     answered round arrived while the window was open
//   · comments are acked up to `up_to` — the newest comment the window SHOWED.
//     A comment that arrived after it stays open, and keeps the dot lit:
//     "קיבלתי" on a stale window must not swallow a note nobody has read
//   · the red dot goes out only when nothing unread is left: no unacked
//     revisions round, and no unacked comment
//   · acking is never hiding: an acked comment stays in every list, dimmed
// ═══════════════════════════════════════════════════════════════════════════

export type AckRound = { id: string; episode_response: string | null; reels_response: string | null } | null;
export type AckComment = { id: string; created_at: string };

export type AckPlan =
  | { kind: "stale_round"; latestLinkId: string }
  | { kind: "nothing" }
  | {
      kind: "ack";
      ackRound: boolean;
      commentIds: string[];
      newerUnacked: number;
      clearAttention: boolean;
    };

export function planReviewAck(input: {
  requestedLinkId: string | null;
  upTo: string | null;
  latestRound: AckRound;
  prodAckLinkId: string | null;
  unackedComments: AckComment[];
}): AckPlan {
  const { requestedLinkId, upTo, latestRound, prodAckLinkId, unackedComments } = input;
  if (requestedLinkId && latestRound && requestedLinkId !== latestRound.id) return { kind: "stale_round", latestLinkId: latestRound.id };
  if (requestedLinkId && !latestRound) return { kind: "nothing" };

  const ackRound = !!latestRound && requestedLinkId === latestRound.id && prodAckLinkId !== latestRound.id;
  const limit = upTo ? Date.parse(upTo) : NaN;
  const shown = Number.isNaN(limit) ? [] : unackedComments.filter((c) => Date.parse(c.created_at) <= limit);
  const newerUnacked = unackedComments.length - shown.length;
  if (!ackRound && !shown.length) return { kind: "nothing" };

  const roundRevisions = !!latestRound && (latestRound.episode_response === "revisions" || latestRound.reels_response === "revisions");
  const roundStillUnread = roundRevisions && !ackRound && prodAckLinkId !== latestRound!.id;
  return { kind: "ack", ackRound, commentIds: shown.map((c) => c.id), newerUnacked, clearAttention: newerUnacked === 0 && !roundStillUnread };
}
