/**
 * E13-2 — the backfill v1 planner (src/lib/review/backfillV1.ts).
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_e13_backfill_v1.ts
 *
 * ═══ F19 ═══ Pure function, in-memory rows. No database, no network.
 */
import { planBackfillV1, formatBackfillReport, type BfEvent, type BfItem, type BfLink, type BfExisting } from "../src/lib/review/backfillV1";

global.fetch = (async () => {
  throw new Error("F19: this suite must not perform any fetch");
}) as unknown as typeof fetch;

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}\n       got:  ${g?.slice(0, 500)}\n       want: ${w?.slice(0, 500)}`);
  }
}
const section = (t: string) => console.log(`\n── ${t}`);

const RUN = "2026-10-15T09:00:00.000Z";
const none = (): BfExisting => ({ v1ItemIds: new Set(), v1IdByItem: new Map(), otherVersionItemIds: new Set(), approvalSources: new Set(), commentSources: new Set() });

// P1: episode + 2 reels, item mode, everything approved
// P2: episode only, approved then B10 reset (approved=false now)
// P3: track-mode link with reels note not split + track-mode reels decision
// P4: approved item with no approved_at but an event
// P5: approved item with no timestamp and no event
const items: BfItem[] = [
  { id: "e1", production_id: "P1", kind: "episode", reel_index: null, media_link: " https://drive/e1 ", approved: true, approved_at: "2026-09-01T10:00:00Z" },
  { id: "r1a", production_id: "P1", kind: "reel", reel_index: 1, media_link: "https://drive/r1", approved: true, approved_at: "2026-09-01T10:00:00Z" },
  { id: "r1b", production_id: "P1", kind: "reel", reel_index: 2, media_link: "", approved: false, approved_at: null },
  { id: "e2", production_id: "P2", kind: "episode", reel_index: null, media_link: "https://drive/e2", approved: false, approved_at: null },
  { id: "e3", production_id: "P3", kind: "episode", reel_index: null, media_link: null, approved: false, approved_at: null },
  { id: "r3a", production_id: "P3", kind: "reel", reel_index: 1, media_link: "https://drive/r3", approved: false, approved_at: null },
  { id: "e4", production_id: "P4", kind: "episode", reel_index: null, media_link: "https://drive/e4", approved: true, approved_at: null },
  { id: "e5", production_id: "P5", kind: "episode", reel_index: null, media_link: null, approved: true, approved_at: null },
];
const links: BfLink[] = [
  // P1 round 1: revisions on episode + reel 2 (item mode), reel 1 approved
  { id: "L1", production_id: "P1", responded_at: "2026-08-20T10:00:00Z", episode_response: "revisions", reels_response: "revisions",
    episode_note: "להוריד את הפתיח", reels_note: "ריל 2: לקצר\nוגם כתוביות\nריל 7: אין כזה ריל" },
  // P1 round 2: everything approved
  { id: "L2", production_id: "P1", responded_at: "2026-09-01T10:00:00Z", episode_response: "approved", reels_response: "approved", episode_note: null, reels_note: null },
  // P2: approved, later reset on the board
  { id: "L3", production_id: "P2", responded_at: "2026-07-01T10:00:00Z", episode_response: "approved", reels_response: null, episode_note: null, reels_note: null },
  // P3: track mode — one note for all reels, one decision for all reels
  { id: "L4", production_id: "P3", responded_at: "2026-06-01T10:00:00Z", episode_response: null, reels_response: "revisions", episode_note: null, reels_note: "כל הרילז צריכים כתוביות" },
  // P1: an item-mode reel with the synthetic placeholder
  { id: "L5", production_id: "P1", responded_at: "2026-08-25T10:00:00Z", episode_response: null, reels_response: "revisions", episode_note: "  ", reels_note: "ריל 2: תיקונים התבקשו" },
  // unanswered link — ignored
  { id: "L6", production_id: "P1", responded_at: null, episode_response: null, reels_response: null, episode_note: "x", reels_note: "ריל 1: y" },
];
const events: BfEvent[] = [
  { event_type: "client_review_revisions", created_at: "2026-08-20T10:00:01Z", payload: { link_id: "L1", items: [
    { id: "e1", kind: "episode", reel_index: null, response: "revisions", note: "להוריד את הפתיח" },
    { id: "r1a", kind: "reel", reel_index: 1, response: "approved", note: null },
    { id: "r1b", kind: "reel", reel_index: 2, response: "revisions", note: "לקצר\nוגם כתוביות" },
  ] } },
  { event_type: "client_review_approved", created_at: "2026-09-01T10:00:01Z", payload: { link_id: "L2", items: [
    { id: "e1", kind: "episode", reel_index: null, response: "approved", note: null },
    { id: "r1b", kind: "reel", reel_index: 2, response: "approved", note: null },
  ] } },
  { event_type: "client_review_revisions", created_at: "2026-08-25T10:00:01Z", payload: { link_id: "L5", items: [
    { id: "r1b", kind: "reel", reel_index: 2, response: "revisions", note: null },
    { id: "ghost", kind: "reel", reel_index: 9, response: "revisions", note: null },
  ] } },
  // P4's approval: event only, no approved_at on the item, no responded link
  { event_type: "client_review_approved", created_at: "2026-09-10T08:00:00Z", payload: { link_id: "LX", items: [
    { id: "e4", kind: "episode", reel_index: null, response: "approved", note: null },
  ] } },
  { event_type: "something_else", created_at: "2026-09-10T08:00:00Z", payload: { link_id: "L4" } },
];

const plan = planBackfillV1(items, links, events, none(), RUN);
const bySrc = (s: string) => plan.approvals.find((a) => a.backfill_source === s);

section("versions: v1 for every item with a non-empty media_link, Drive, backfill");
check("items → v1", plan.versions.map((v) => v.item_id), ["e1", "r1a", "e2", "r3a", "e4"]);
check("media_link trimmed, number 1, drive, is_backfill", plan.versions[0], { item_id: "e1", number: 1, source: "drive", media_link: "https://drive/e1", is_backfill: true });

section("approvals (a): episode decisions from responded links");
check("L1 episode revisions", [bySrc("link:L1:episode")?.decision, bySrc("link:L1:episode")?.note, bySrc("link:L1:episode")?.decided_at], ["revisions", "להוריד את הפתיח", "2026-08-20T10:00:00Z"]);
check("L2 episode approved, not revoked (e1 approved today)", [bySrc("link:L2:episode")?.decision, bySrc("link:L2:episode")?.revoked_at], ["approved", null]);
check("L3 approved but e2 reset by B10 → written REVOKED (no deletion clock)",
  [bySrc("link:L3:episode")?.decision, bySrc("link:L3:episode")?.revoked_at, bySrc("link:L3:episode")?.revoked_reason],
  ["approved", RUN, "backfill:item_not_approved"]);
check("history rows are version-less", [bySrc("link:L1:episode")?.v1_of_item, bySrc("link:L3:episode")?.v1_of_item], [null, null]);

section("approvals (b): per-reel decisions only from item-mode events");
check("L1 reel 1 approved, reel 2 revisions with note", [bySrc("link:L1:item:r1a")?.decision, bySrc("link:L1:item:r1b")?.decision, bySrc("link:L1:item:r1b")?.note],
  ["approved", "revisions", "לקצר\nוגם כתוביות"]);
check("the episode in the event is NOT a second episode decision", plan.approvals.filter((a) => a.link_id === "L1" && a.item_id === "e1").length, 1);
check("L2 reel 2 approved but r1b is not approved today → revoked", bySrc("link:L2:item:r1b")?.revoked_reason, "backfill:item_not_approved");
check("track-mode reels decision (L4) not split → reported", plan.report.skipped.reelsDecisionNotSplit, ["L4"]);
check("event naming an unknown item → reported", plan.report.skipped.eventItemUnknown, ["ghost"]);

section("approvals (c): the item flag, only when no history row approved it");
check("e1 and r1a already approved via L1/L2 → no item:… row", [bySrc("item:e1:approved"), bySrc("item:r1a:approved")], [undefined, undefined]);
check("e4: approved_at empty → event time + link, linked to its v1", [bySrc("item:e4:approved")?.decided_at, bySrc("item:e4:approved")?.link_id, bySrc("item:e4:approved")?.v1_of_item],
  ["2026-09-10T08:00:00Z", "LX", "e4"]);
check("e5: no timestamp, no event → reported, not written", [bySrc("item:e5:approved"), plan.report.skipped.approvedWithoutTimestamp], [undefined, ["e5"]]);

section("comments");
const com = (s: string) => plan.comments.find((c) => c.backfill_source === s);
check("episode_note → general on the episode item, at responded_at", [com("link:L1:episode_note")?.item_id, com("link:L1:episode_note")?.body, com("link:L1:episode_note")?.created_at],
  ["e1", "להוריד את הפתיח", "2026-08-20T10:00:00Z"]);
check("reels note 'ריל 2:' with a continuation line → reel 2's item, joined", [com("link:L1:reels_note:reel:2")?.item_id, com("link:L1:reels_note:reel:2")?.body],
  ["r1b", "לקצר\nוגם כתוביות"]);
check("'ריל 7:' with no such reel → reported", plan.report.skipped.reelItemMissing, ["L1:7"]);
check("Q9: track-mode reels note NOT migrated, reported", [plan.comments.some((c) => c.link_id === "L4"), plan.report.skipped.trackModeReelsNote], [false, ["L4"]]);
check("placeholder 'תיקונים התבקשו' skipped and counted", [plan.comments.some((c) => c.link_id === "L5"), plan.report.skipped.placeholderReelNotes], [false, 1]);
check("whitespace-only episode note → nothing", com("link:L5:episode_note"), undefined);
check("unanswered link ignored entirely", [plan.comments.some((c) => c.link_id === "L6"), plan.approvals.some((a) => a.link_id === "L6")], [false, false]);
check("every comment is general, client, backfill", plan.comments.every((c) => c.kind === "general" && c.author_kind === "client" && c.is_backfill), true);
check("total comments", plan.comments.length, 2);

section("idempotency: a second run with the first run's keys plans nothing");
const existing: BfExisting = {
  v1ItemIds: new Set(plan.versions.map((v) => v.item_id)),
  v1IdByItem: new Map(plan.versions.map((v) => [v.item_id, `ver-${v.item_id}`])),
  otherVersionItemIds: new Set(),
  approvalSources: new Set(plan.approvals.map((a) => a.backfill_source)),
  commentSources: new Set(plan.comments.map((c) => c.backfill_source)),
};
const again = planBackfillV1(items, links, events, existing, RUN);
check("second run: 0 / 0 / 0", [again.versions.length, again.approvals.length, again.comments.length], [0, 0, 0]);
check("second run reports them as already present", again.report.alreadyPresent, { versions: 5, approvals: plan.approvals.length, comments: 2 });
check("backfill_source unique within a run", new Set(plan.approvals.map((a) => a.backfill_source)).size, plan.approvals.length);

section("E13-3: an item that already has a non-backfill version gets no v1");
const guarded = planBackfillV1(items, links, events, { ...none(), otherVersionItemIds: new Set(["e4"]) }, RUN);
check("e4 gets no v1, the others still do", [guarded.versions.some((v) => v.item_id === "e4"), guarded.versions.length], [false, plan.versions.length - 1]);
check("e4 is reported", guarded.report.skipped.itemHasOtherVersion, ["e4"]);
const e4c = guarded.approvals.find((a) => a.item_id === "e4" && a.decision === "approved");
check("e4's flag approval is still written, but not linked to any version", [Boolean(e4c), e4c?.v1_of_item ?? null], [true, null]);
check("nothing else changes", [guarded.approvals.length, guarded.comments.length], [plan.approvals.length, plan.comments.length]);
check("no guard set → none reported", plan.report.skipped.itemHasOtherVersion, []);
check("the report names the guarded item", formatBackfillReport(guarded).includes("e4"), true);
const guardedV1 = planBackfillV1(items, links, events, { ...none(), v1ItemIds: new Set(["e4"]), otherVersionItemIds: new Set(["e4"]) }, RUN);
check("a backfill v1 already present wins over the guard (counted present, not reported)", [guardedV1.report.alreadyPresent.versions, guardedV1.report.skipped.itemHasOtherVersion], [1, []]);

section("determinism and the report");
check("same input → same plan", JSON.stringify(planBackfillV1(items, [...links].reverse(), events, none(), RUN)), JSON.stringify(plan));
const text = formatBackfillReport(plan);
check("report mentions the Q9 skip with its link", text.includes("Q9") && text.includes("L4"), true);
check("report states the expected 89", text.includes("צפוי 89"), true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
