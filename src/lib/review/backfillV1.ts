import { parseReelNotes } from "./reelNotes";

// ═══════════════════════════════════════════════════════════════════════════
// E13 backfill v1 — PURE planning (plan §7). No I/O here: the script
// scripts/e13_backfill_v1.ts reads the rows, calls planBackfillV1, prints the
// report, and writes only with --apply. Tested in scripts/test_e13_backfill_v1.ts.
// ═══════════════════════════════════════════════════════════════════════════
//
// INSERT-ONLY into the three 0114 tables. Nothing in client_review_items,
// client_review_links or productions is updated or deleted (§7.2).
//
// THE MAPPING (§7.1, with the owner's answers of 15.10):
//   versions   item with a non-empty media_link → v1, source 'drive'.
//   approvals  (a) a responded link's episode_response → one decision on the
//                  production's episode item, decided_at = responded_at.
//              (b) per-reel decisions ONLY from the response event's
//                  payload.items (item mode). A track-mode reels_response is
//                  one decision for all reels and is NOT split — reported.
//              (c) client_review_items.approved=true with no approved decision
//                  from (a)/(b) → one approved row, decided_at = approved_at;
//                  approved_at empty → the matching client_review_approved
//                  event's time; neither → REPORTED, not written.
//              An 'approved' decision on an item whose approved flag is false
//              TODAY is written revoked (revoked_reason
//              'backfill:item_not_approved'): the flag was reset by B10, and an
//              unrevoked row would start the 90-day deletion clock for an item
//              that is not approved.
//   comments   episode_note → one general comment on the episode item.
//              reels_note   → split with parseReelNotes; each `ריל N:` block on
//                             reel N's item.
//              🔴 Q9 (owner 15.10): a reels note NOT split per reel (track mode,
//              or text before the first `ריל N:`) is NOT migrated — reported,
//              and it stays readable on the old link.
//              The synthetic `ריל N: תיקונים התבקשו` (written by applyResponse
//              when the client gave no text, links.ts:539) is not a client
//              comment — skipped and counted.
//   NOT copied: production_log kind='client' (same text as the link — would
//   double every note), client_review_items.last_note (derived, overwritten).
//
// version_id: v1 only on (c) — the plan's rule for the item flag. The history
// rows (a)/(b) and the comments stay version-less: media_link was overwritten
// in place before 0114, so v1 is the CURRENT cut and an old round's note may
// be about an earlier one. 0114 allows version-less rows only when is_backfill.
//
// IDEMPOTENT: every row carries a backfill_source (unique in 0114 for comments
// and approvals; versions are keyed by (item_id, number=1)). Rows whose key
// already exists are left out of the plan, so a second run writes nothing.
//
// E13-3: an item that already has a NON-backfill version (sent from the
// drawer) gets no v1 — its numbers are taken — and is reported. The script is
// meant to run before the first send, so this list should be empty.

export const PLACEHOLDER_REEL_NOTE = "תיקונים התבקשו";

export type BfItem = {
  id: string;
  production_id: string;
  kind: "episode" | "reel";
  reel_index: number | null;
  media_link: string | null;
  approved: boolean;
  approved_at: string | null;
};

export type BfLink = {
  id: string;
  production_id: string;
  responded_at: string | null;
  episode_response: string | null;
  reels_response: string | null;
  episode_note: string | null;
  reels_note: string | null;
};

export type BfEvent = {
  event_type: string;
  created_at: string;
  payload: {
    link_id?: string;
    items?: { id: string; kind: string; reel_index: number | null; response: string; note: string | null }[];
  } | null;
};

export type BfExisting = {
  /** item ids that already have a version numbered 1 */
  v1ItemIds: Set<string>;
  /** item id → id of its existing v1 (for linking approvals on a re-run) */
  v1IdByItem: Map<string, string>;
  /**
   * E13-3: item ids that already have a version that is NOT the backfill v1
   * (a Bunny version sent from the drawer, numbered or not). Such an item gets
   * no backfill v1 — its numbers are taken (unique (item_id, number)) — and
   * is reported instead.
   */
  otherVersionItemIds: Set<string>;
  approvalSources: Set<string>;
  commentSources: Set<string>;
};

export type PlannedVersion = { item_id: string; number: 1; source: "drive"; media_link: string; is_backfill: true };
export type PlannedApproval = {
  item_id: string;
  /** resolved to an id by the script after the versions are written */
  v1_of_item: string | null;
  link_id: string | null;
  decision: "approved" | "revisions";
  note: string | null;
  decided_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  is_backfill: true;
  backfill_source: string;
};
export type PlannedComment = {
  item_id: string;
  link_id: string;
  kind: "general";
  body: string;
  author_kind: "client";
  created_at: string;
  is_backfill: true;
  backfill_source: string;
};

export type BackfillReport = {
  items: number;
  respondedLinks: number;
  skipped: {
    trackModeReelsNote: string[]; // link ids (Q9)
    reelsDecisionNotSplit: string[]; // link ids with a track-mode reels_response
    placeholderReelNotes: number;
    episodeItemMissing: string[]; // link ids
    reelItemMissing: string[]; // "link:reel"
    approvedWithoutTimestamp: string[]; // item ids
    eventItemUnknown: string[]; // item ids named in an event that do not exist
    itemHasOtherVersion: string[]; // item ids (E13-3): already has a non-backfill version
  };
  alreadyPresent: { versions: number; approvals: number; comments: number };
};

export type BackfillPlan = {
  versions: PlannedVersion[];
  approvals: PlannedApproval[];
  comments: PlannedComment[];
  report: BackfillReport;
};

const clean = (s: string | null | undefined) => (s ?? "").trim();

export function planBackfillV1(
  items: BfItem[],
  links: BfLink[],
  events: BfEvent[],
  existing: BfExisting,
  runAtIso: string
): BackfillPlan {
  const report: BackfillReport = {
    items: items.length,
    respondedLinks: 0,
    skipped: {
      trackModeReelsNote: [],
      reelsDecisionNotSplit: [],
      placeholderReelNotes: 0,
      episodeItemMissing: [],
      reelItemMissing: [],
      approvedWithoutTimestamp: [],
      eventItemUnknown: [],
      itemHasOtherVersion: [],
    },
    alreadyPresent: { versions: 0, approvals: 0, comments: 0 },
  };

  const itemById = new Map(items.map((i) => [i.id, i]));
  const episodeOf = new Map<string, BfItem>();
  const reelOf = new Map<string, BfItem>(); // `${production}:${reel}`
  for (const i of items) {
    if (i.kind === "episode") episodeOf.set(i.production_id, i);
    else if (i.reel_index != null) reelOf.set(`${i.production_id}:${i.reel_index}`, i);
  }

  // ── versions ────────────────────────────────────────────────────────────
  const versions: PlannedVersion[] = [];
  const hasV1 = new Set(existing.v1ItemIds);
  for (const i of items) {
    const link = clean(i.media_link);
    if (!link) continue;
    if (existing.v1ItemIds.has(i.id)) {
      report.alreadyPresent.versions++;
      continue;
    }
    if (existing.otherVersionItemIds.has(i.id)) {
      report.skipped.itemHasOtherVersion.push(i.id);
      continue;
    }
    versions.push({ item_id: i.id, number: 1, source: "drive", media_link: link, is_backfill: true });
    hasV1.add(i.id);
  }

  // ── approvals ───────────────────────────────────────────────────────────
  const approvals: PlannedApproval[] = [];
  const approvedItems = new Set<string>(); // items that got an 'approved' decision from (a)/(b)
  const push = (a: Omit<PlannedApproval, "revoked_at" | "revoked_reason" | "is_backfill">) => {
    const item = itemById.get(a.item_id)!;
    const revoke = a.decision === "approved" && !item.approved;
    const row: PlannedApproval = {
      ...a,
      revoked_at: revoke ? runAtIso : null,
      revoked_reason: revoke ? "backfill:item_not_approved" : null,
      is_backfill: true,
    };
    if (a.decision === "approved") approvedItems.add(a.item_id);
    if (existing.approvalSources.has(a.backfill_source)) {
      report.alreadyPresent.approvals++;
      return;
    }
    approvals.push(row);
  };

  const responseEvents = new Map<string, BfEvent>();
  for (const e of events) {
    if (e.event_type !== "client_review_approved" && e.event_type !== "client_review_revisions") continue;
    const lid = e.payload?.link_id;
    if (lid && !responseEvents.has(lid)) responseEvents.set(lid, e);
  }

  const responded = links
    .filter((l) => l.responded_at)
    .sort((a, b) => (a.responded_at! < b.responded_at! ? -1 : a.responded_at! > b.responded_at! ? 1 : a.id < b.id ? -1 : 1));
  report.respondedLinks = responded.length;

  for (const l of responded) {
    const at = l.responded_at!;
    // (a) episode decision
    if (l.episode_response === "approved" || l.episode_response === "revisions") {
      const ep = episodeOf.get(l.production_id);
      if (!ep) report.skipped.episodeItemMissing.push(l.id);
      else
        push({
          item_id: ep.id,
          v1_of_item: null,
          link_id: l.id,
          decision: l.episode_response,
          note: clean(l.episode_note) || null,
          decided_at: at,
          backfill_source: `link:${l.id}:episode`,
        });
    }
    // (b) per-reel decisions, item mode only
    const ev = responseEvents.get(l.id);
    const reelDetail = (ev?.payload?.items ?? []).filter((d) => d.kind === "reel");
    if (reelDetail.length) {
      for (const d of reelDetail) {
        if (d.response !== "approved" && d.response !== "revisions") continue;
        if (!itemById.has(d.id)) {
          report.skipped.eventItemUnknown.push(d.id);
          continue;
        }
        push({
          item_id: d.id,
          v1_of_item: null,
          link_id: l.id,
          decision: d.response,
          note: clean(d.note) || null,
          decided_at: at,
          backfill_source: `link:${l.id}:item:${d.id}`,
        });
      }
    } else if (l.reels_response === "approved" || l.reels_response === "revisions") {
      report.skipped.reelsDecisionNotSplit.push(l.id);
    }
  }

  // (c) the item flag, when no history row already says approved
  for (const i of items) {
    if (!i.approved || approvedItems.has(i.id)) continue;
    let decidedAt = i.approved_at;
    let linkId: string | null = null;
    if (!decidedAt) {
      const ev = events
        .filter((e) => e.event_type === "client_review_approved")
        .filter((e) => (e.payload?.items ?? []).some((d) => d.id === i.id && d.response === "approved"))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
      if (ev) {
        decidedAt = ev.created_at;
        linkId = ev.payload?.link_id ?? null;
      }
    }
    if (!decidedAt) {
      report.skipped.approvedWithoutTimestamp.push(i.id);
      continue;
    }
    push({
      item_id: i.id,
      v1_of_item: hasV1.has(i.id) ? i.id : null,
      link_id: linkId,
      decision: "approved",
      note: null,
      decided_at: decidedAt,
      backfill_source: `item:${i.id}:approved`,
    });
  }

  // ── comments ────────────────────────────────────────────────────────────
  const comments: PlannedComment[] = [];
  const addComment = (c: Omit<PlannedComment, "kind" | "author_kind" | "is_backfill">) => {
    if (existing.commentSources.has(c.backfill_source)) {
      report.alreadyPresent.comments++;
      return;
    }
    const dup = comments.find((x) => x.backfill_source === c.backfill_source);
    if (dup) {
      dup.body = `${dup.body}\n${c.body}`;
      return;
    }
    comments.push({ ...c, kind: "general", author_kind: "client", is_backfill: true });
  };

  for (const l of responded) {
    const at = l.responded_at!;
    const epNote = clean(l.episode_note);
    if (epNote) {
      const ep = episodeOf.get(l.production_id);
      if (!ep) {
        if (!report.skipped.episodeItemMissing.includes(l.id)) report.skipped.episodeItemMissing.push(l.id);
      } else addComment({ item_id: ep.id, link_id: l.id, body: epNote, created_at: at, backfill_source: `link:${l.id}:episode_note` });
    }

    const reelsNote = l.reels_note ?? "";
    if (!reelsNote.trim()) continue;
    let trackMode = false;
    for (const block of parseReelNotes(reelsNote)) {
      const body = block.note.trim();
      if (block.reel == null) {
        if (body) trackMode = true;
        continue;
      }
      if (!body) continue;
      if (body === PLACEHOLDER_REEL_NOTE) {
        report.skipped.placeholderReelNotes++;
        continue;
      }
      const reel = reelOf.get(`${l.production_id}:${block.reel}`);
      if (!reel) {
        report.skipped.reelItemMissing.push(`${l.id}:${block.reel}`);
        continue;
      }
      addComment({ item_id: reel.id, link_id: l.id, body, created_at: at, backfill_source: `link:${l.id}:reels_note:reel:${block.reel}` });
    }
    if (trackMode) report.skipped.trackModeReelsNote.push(l.id);
  }

  return { versions, approvals, comments, report };
}

export function formatBackfillReport(plan: BackfillPlan, expectedVersions = 89): string {
  const r = plan.report;
  const s = r.skipped;
  const lines = [
    `פריטים: ${r.items} · קישורים שנענו: ${r.respondedLinks}`,
    `ייכתבו: ${plan.versions.length} גרסאות v1 (צפוי ${expectedVersions} בריצה ראשונה, לפי ספירת 11.10)` +
      ` · ${plan.approvals.length} החלטות (${plan.approvals.filter((a) => a.decision === "approved").length} אישורים,` +
      ` מתוכם ${plan.approvals.filter((a) => a.revoked_at).length} מבוטלים כי הפריט אינו מאושר היום)` +
      ` · ${plan.comments.length} הערות כלליות`,
    `כבר קיימים (לא ייכתבו שוב): ${r.alreadyPresent.versions} גרסאות · ${r.alreadyPresent.approvals} החלטות · ${r.alreadyPresent.comments} הערות`,
    `לא הועבר:`,
    `  · הערת רילז שאינה מחולקת לפי ריל (Q9, נשארת על הקישור הישן): ${s.trackModeReelsNote.length}${s.trackModeReelsNote.length ? ` — ${s.trackModeReelsNote.join(", ")}` : ""}`,
    `  · החלטת רילז מצרפית בלי פירוט פר ריל: ${s.reelsDecisionNotSplit.length}${s.reelsDecisionNotSplit.length ? ` — ${s.reelsDecisionNotSplit.join(", ")}` : ""}`,
    `  · "ריל N: ${PLACEHOLDER_REEL_NOTE}" (טקסט מערכת, לא הערת לקוח): ${s.placeholderReelNotes}`,
    `  · אין פריט פרק להפקה: ${s.episodeItemMissing.length}${s.episodeItemMissing.length ? ` — ${s.episodeItemMissing.join(", ")}` : ""}`,
    `  · אין פריט לריל שבהערה: ${s.reelItemMissing.length}${s.reelItemMissing.length ? ` — ${s.reelItemMissing.join(", ")}` : ""}`,
    `  · פריט מאושר בלי חותמת ובלי אירוע: ${s.approvedWithoutTimestamp.length}${s.approvedWithoutTimestamp.length ? ` — ${s.approvedWithoutTimestamp.join(", ")}` : ""}`,
    `  · פריט מאירוע שאינו קיים: ${s.eventItemUnknown.length}${s.eventItemUnknown.length ? ` — ${s.eventItemUnknown.join(", ")}` : ""}`,
    `  · לפריט כבר יש גרסה שאינה v1 של ה-backfill (נשלחה מהדרואר), ולכן לא נוצר לו v1: ${s.itemHasOtherVersion.length}${s.itemHasOtherVersion.length ? ` — ${s.itemHasOtherVersion.join(", ")}` : ""}`,
  ];
  return lines.join("\n");
}
