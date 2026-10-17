/**
 * E13-8c — the permanent comment history, "קיבלתי" over comments, Hebrew
 * event labels, and the "תיקונים" redesign (owner 17.10).
 *   src/lib/review/commentHistory.ts   state + order, nothing filtered out
 *   src/lib/review/reviewAck.ts        what "קיבלתי" acks, when the dot goes out
 *   src/components/ClientCommentHistory.tsx   open vs dimmed, never hidden
 *   src/lib/events/labels.ts           every event type written in src has a label
 *   + static checks on the routes, the window, the print page, the drawer, the page
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_e13_8c_history.tsx
 *
 * ═══ F19 ═══ No database, no network.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import { buildCommentHistory, commentState, unackedCommentCount, type HcApproval, type HcComment } from "../src/lib/review/commentHistory";
import { planReviewAck } from "../src/lib/review/reviewAck";
import ClientCommentHistory, { formatPinTimeExact } from "../src/components/ClientCommentHistory";
import { EVENT_LABEL, eventLabel } from "../src/lib/events/labels";
import ReviewClient from "../src/app/r/[token]/ReviewClient";
import type { ClientVersionView, ClientCommentView } from "../src/app/r/[token]/ReviewPlayer";

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
    console.log(`  ❌ ${name}\n       got:  ${g?.slice(0, 600)}\n       want: ${w?.slice(0, 600)}`);
  }
}
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond && detail) console.log(`       ${detail.slice(0, 500)}`);
  check(name, cond, true);
};
const section = (t: string) => console.log(`\n── ${t}`);

// ══════════════════════════════════════════════════════════════════════
// The אסתטיטוקס test of 17.10, as it sits in the DB (read 17.10): 4 pins on a
// live link, all items approved on that link at 20:14, a 5th pin at 20:20
// that revoked reel 1, "מאשר שוב" at 20:26.
const REEL = "f7884b44";
const L = "ef899fed";
const V2 = "93314b02";
const pin = (n: number, ms: number, at: string, over: Partial<HcComment> = {}): HcComment => ({
  id: `c${n}`,
  item_id: REEL,
  version_id: V2,
  link_id: L,
  kind: "pin",
  pin_number: n,
  time_ms: ms,
  body: `נעץ ${n}`,
  author_kind: "client",
  created_at: at,
  acked_at: null,
  acked_by: null,
  resolved_at: null,
  after_response: false,
  is_backfill: false,
  ...over,
});
const today: HcComment[] = [
  pin(1, 4442, "2026-10-17T20:05:27.460Z"),
  pin(2, 1166, "2026-10-17T20:05:55.545Z"),
  pin(3, 22192, "2026-10-17T20:06:34.628Z"),
  pin(4, 10076, "2026-10-17T20:09:38.447Z"),
  pin(5, 0, "2026-10-17T20:20:19.861Z", { after_response: true }),
];
const ledger: HcApproval[] = [
  { item_id: REEL, link_id: L, decision: "approved", decided_at: "2026-10-17T20:14:00.310Z", revoked_at: "2026-10-17T20:20:19.861Z", revoked_reason: "client_comment" },
  { item_id: REEL, link_id: L, decision: "approved", decided_at: "2026-10-17T20:26:22.402Z", revoked_at: null, revoked_reason: null },
];

section("commentState — derived from the approvals ledger");
check("pins 1–4: before the approval the client gave on the SAME link → minor ('אושר עם הערות')", today.slice(0, 4).map((c) => commentState(c, ledger)), ["minor", "minor", "minor", "minor"]);
check("pin 5: revoked the approval in the same transaction → revoked_approval", commentState(today[4], ledger), "revoked_approval");
const revisionsLedger: HcApproval[] = [{ item_id: REEL, link_id: L, decision: "revisions", decided_at: "2026-10-17T20:14:00.310Z", revoked_at: null, revoked_reason: null }];
check("the client then sent 'תיקונים' in that round → revisions ('בקשת תיקון') — pin 8 of 18.10", commentState(today[0], revisionsLedger), "revisions");
check("no decision in its round yet → pending_decision ('ממתין להחלטת הלקוח')", commentState(today[0], []), "pending_decision");
const otherLink: HcApproval[] = [{ item_id: REEL, link_id: "OTHER", decision: "approved", decided_at: "2026-10-17T20:14:00.310Z", revoked_at: null, revoked_reason: null }];
check("approved through ANOTHER round → its own round is still open: pending_decision", commentState(today[0], otherLink), "pending_decision");
// the bug of 18.10, pin 6: an EARLIER round's approval must never label a comment of a later round
const earlier: HcApproval[] = [{ item_id: REEL, link_id: "OLD", decision: "approved", decided_at: "2026-10-17T19:00:00Z", revoked_at: null, revoked_reason: null }];
check("an approval from an earlier round, still standing → pending_decision, not 'אושר עם הערות'", commentState(today[0], earlier), "pending_decision");
check("written after its round's response, on an item not approved → after_response", commentState({ ...today[0], after_response: true }, []), "after_response");
check("a row with no round (backfill) → history", commentState({ ...today[0], link_id: null }, []), "history");
check("another item's ledger is never consulted (pin 5 was written after its round's response)", commentState({ ...today[4], item_id: "OTHER" }, ledger), "after_response");
// the 18.10 test, as in the DB: pin 6 on round 5ca6e8c3 approved after it (21:06:53), pin 8 on round 4b62a14f with 'תיקונים'
const r1810: HcApproval[] = [
  { item_id: REEL, link_id: "5ca6e8c3", decision: "approved", decided_at: "2026-10-17T21:06:53Z", revoked_at: "2026-10-17T21:08:42Z", revoked_reason: "board_rollback" },
  { item_id: REEL, link_id: "8449350d", decision: "approved", decided_at: "2026-10-17T21:10:22Z", revoked_at: "2026-10-17T21:12:57Z", revoked_reason: "board_rollback" },
  { item_id: REEL, link_id: "4b62a14f", decision: "revisions", decided_at: "2026-10-17T21:13:45Z", revoked_at: null, revoked_reason: null },
];
check("18.10 pin 6 (its round approved after it) → minor", commentState(pin(6, 20960, "2026-10-17T21:05:01Z", { link_id: "5ca6e8c3" }), r1810), "minor");
check("18.10 pin 6, viewed BEFORE its round's decision → pending_decision", commentState(pin(6, 20960, "2026-10-17T21:05:01Z", { link_id: "5ca6e8c3" }), r1810.filter((a) => a.link_id !== "5ca6e8c3")), "pending_decision");
check("18.10 pin 8 ('תיקונים' in its round) → revisions", commentState(pin(8, 1000, "2026-10-17T21:13:31Z", { link_id: "4b62a14f" }), r1810), "revisions");

section("buildCommentHistory — the bug of 17.10: nothing disappears after 'מאשר שוב'");
const items = [
  { id: "EP", kind: "episode", reel_index: null, approved: true },
  { id: REEL, kind: "reel", reel_index: 1, approved: true }, // re-approved
  { id: "R2", kind: "reel", reel_index: 2, approved: true },
];
const hist = buildCommentHistory({ items, comments: today, approvals: ledger, versions: [{ id: V2, number: 2, original_filename: "reel01 v1.mp4" }], names: {} });
const reel = hist.find((i) => i.id === REEL)!;
check("after re-approval, all 5 pins are still there", reel.comments.length, 5);
check("pins in file-time order (0, 1166, 4442, 10076, 22192)", reel.comments.map((c) => c.time_ms), [0, 1166, 4442, 10076, 22192]);
check("each carries its version number and file", [reel.comments[0].version_number, reel.comments[0].version_file], [2, "reel01 v1.mp4"]);
check("all open (no 'קיבלתי' yet)", reel.comments.every((c) => c.open), true);
check("items come episode first, then reels by index, even without comments", hist.map((i) => i.label), ["פרק מלא", "ריל 1", "ריל 2"]);
const acked = buildCommentHistory({
  items,
  comments: [{ ...today[0], acked_at: "2026-10-17T21:00:00Z", acked_by: "u1" }, today[1]],
  approvals: ledger,
  versions: [],
  names: { u1: "אלי" },
});
const ar = acked.find((i) => i.id === REEL)!;
check("an acked comment STAYS in the list, marked handled, with who acked", ar.comments.map((c) => [c.id, c.open, c.acked_by_name]).sort(), [["c1", false, "\u05d0\u05dc\u05d9"], ["c2", true, null]]);
check("…both comments present (acked one included)", ar.comments.length, 2);
const mixed = buildCommentHistory({
  items: [{ id: REEL, kind: "reel", reel_index: 1, approved: false }],
  comments: [
    { ...today[0], id: "g1", kind: "general", pin_number: null, time_ms: null, version_id: V2, created_at: "2026-10-17T20:00:00Z" },
    { ...today[1], id: "old", version_id: "V1", created_at: "2026-10-10T10:00:00Z" },
    today[2],
    { ...today[3], id: "bf", version_id: null, link_id: null, kind: "general", pin_number: null, time_ms: null, is_backfill: true, created_at: "2026-08-01T00:00:00Z" },
  ],
  approvals: [],
  versions: [{ id: V2, number: 2, original_filename: null }, { id: "V1", number: 1, original_filename: null }],
  names: {},
});
check("order: newest version first; pins before general inside a version; history (no version) last", mixed[0].comments.map((c) => c.id), ["c3", "g1", "old", "bf"]);
check("a row with no round (backfill without a link) reads 'היסטוריה'", mixed[0].comments.find((c) => c.id === "bf")?.state_label, "היסטוריה");
check("unacked count ignores backfill and team rows", unackedCommentCount([...today, { ...today[0], is_backfill: true }, { ...today[0], author_kind: "team" }, { ...today[0], acked_at: "x" }]), 5);

// ══════════════════════════════════════════════════════════════════════
section("planReviewAck — what 'קיבלתי' acks, and when the dot goes out");
const round = { id: "R1", episode_response: "revisions", reels_response: null };
const c = (id: string, at: string) => ({ id, created_at: at });
check("a newer round answered while the window was open → stale_round", planReviewAck({ requestedLinkId: "R0", upTo: null, latestRound: round, prodAckLinkId: null, unackedComments: [] }), { kind: "stale_round", latestLinkId: "R1" });
check("round + comments shown → both acked, dot out", planReviewAck({ requestedLinkId: "R1", upTo: "2026-10-17T20:30:00Z", latestRound: round, prodAckLinkId: null, unackedComments: [c("a", "2026-10-17T20:05:00Z"), c("b", "2026-10-17T20:20:00Z")] }), { kind: "ack", ackRound: true, commentIds: ["a", "b"], newerUnacked: 0, clearAttention: true });
check("a comment newer than the window → not acked, keeps the dot lit", planReviewAck({ requestedLinkId: "R1", upTo: "2026-10-17T20:10:00Z", latestRound: round, prodAckLinkId: null, unackedComments: [c("a", "2026-10-17T20:05:00Z"), c("b", "2026-10-17T20:20:00Z")] }), { kind: "ack", ackRound: true, commentIds: ["a"], newerUnacked: 1, clearAttention: false });
check("round already acked, new comments since → comments acked (the old 'already' left them lit)", planReviewAck({ requestedLinkId: "R1", upTo: "2026-10-17T20:30:00Z", latestRound: round, prodAckLinkId: "R1", unackedComments: [c("b", "2026-10-17T20:20:00Z")] }), { kind: "ack", ackRound: false, commentIds: ["b"], newerUnacked: 0, clearAttention: true });
check("pins on a live link, no answered round yet → comments acked, dot out", planReviewAck({ requestedLinkId: null, upTo: "2026-10-17T20:30:00Z", latestRound: null, prodAckLinkId: null, unackedComments: [c("a", "2026-10-17T20:05:00Z")] }), { kind: "ack", ackRound: false, commentIds: ["a"], newerUnacked: 0, clearAttention: true });
check("comments only, but a revisions round still unacked → the dot stays", planReviewAck({ requestedLinkId: null, upTo: "2026-10-17T20:30:00Z", latestRound: round, prodAckLinkId: null, unackedComments: [c("a", "2026-10-17T20:05:00Z")] }).kind === "ack" && (planReviewAck({ requestedLinkId: null, upTo: "2026-10-17T20:30:00Z", latestRound: round, prodAckLinkId: null, unackedComments: [c("a", "2026-10-17T20:05:00Z")] }) as { clearAttention: boolean }).clearAttention, false);
check("nothing new → 'nothing' (a double click writes nothing)", planReviewAck({ requestedLinkId: "R1", upTo: "2026-10-17T20:30:00Z", latestRound: round, prodAckLinkId: "R1", unackedComments: [] }), { kind: "nothing" });

// ══════════════════════════════════════════════════════════════════════
section("ClientCommentHistory — open stand out, handled dimmed, none hidden");
check("exact pin time", [formatPinTimeExact(0), formatPinTimeExact(42180), formatPinTimeExact(3723004)], ["00:00.000", "00:42.180", "1:02:03.004"]);
const html = renderToString(<ClientCommentHistory items={acked} />);
ok("both comments rendered (the acked one too)", html.includes("נעץ 1") && html.includes("נעץ 2"), html);
ok("open = full opacity, handled = dimmed", (html.match(/data-open="1"/g) ?? []).length === 1 && (html.match(/data-open="0"/g) ?? []).length === 1 && html.includes("opacity:0.55"), html);
ok("who acked is shown", html.includes("קיבלתי") && html.includes("אלי"), html);
ok("state label shown ('הערה קטנה · אושר עם הערות')", html.includes("הערה קטנה"), html);
const htmlToday = renderToString(<ClientCommentHistory items={hist} />);
ok("today's reel: 'ביטלה אישור' on pin 5, 'הערה קטנה' on the others, v2, mm:ss.mmm", htmlToday.includes("ביטלה אישור") && htmlToday.includes("הערה קטנה") && htmlToday.includes("v2") && htmlToday.includes("00:04.442"), htmlToday);
ok("no comments anywhere → the empty line, no crash", renderToString(<ClientCommentHistory items={[]} />).includes("אין הערות מהלקוח"));

// ══════════════════════════════════════════════════════════════════════
section("event labels — Hebrew for every event type written in src");
const root = join(__dirname, "..");
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.(ts|tsx)$/.test(f) ? [join(d, f)] : []));
const types = new Set<string>();
for (const f of walk(join(root, "src"))) {
  const t = readFileSync(f, "utf8");
  for (const m of Array.from(t.matchAll(/event_type: "([a-z0-9_]+)"/g))) types.add(m[1]);
  for (const m of Array.from(t.matchAll(/eventType = "([a-z0-9_]+)"/g))) types.add(m[1]);
  // ternaries: snake_case with an underscore only (skips values like "cron" / "new")
  for (const m of Array.from(t.matchAll(/\? "([a-z0-9]+_[a-z0-9_]+)" : "([a-z0-9]+_[a-z0-9_]+)"/g))) if (/event/i.test(t.slice(Math.max(0, (m.index ?? 0) - 80), m.index))) { types.add(m[1]); types.add(m[2]); }
}
const missing = Array.from(types).filter((x) => !EVENT_LABEL[x]);
check(`every event type written in src (${types.size}) has a Hebrew label`, missing, []);
check("the two from the owner's screenshot", [eventLabel("deal_invoice_skipped_already_billed"), eventLabel("client_approved_already_billed")], ["חשבון עסקה דולג: כבר חויב", "אישור לקוח: כבר חויב, לא נוצרה עבודה נוספת"]);
check("an unknown type → null (the drawer shows 'אירוע מערכת' + the code)", eventLabel("brand_new_event"), null);

// ══════════════════════════════════════════════════════════════════════
section("static: where the history is read and shown");
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const rc = strip(readFileSync(join(root, "src/app/api/productions/[id]/review-current/route.ts"), "utf8"));
ok("review-current returns items + up_to, also when there is no round", /loadCommentHistory\(/.test(rc) && /if \(!round\) return NextResponse\.json\(\{ round: null, items, up_to: upTo, unacked \}\)/.test(rc));
ok("review-current never reads last_note", !/last_note/.test(rc));
const ra = strip(readFileSync(join(root, "src/app/api/productions/[id]/review-ack/route.ts"), "utf8"));
ok("review-ack: planReviewAck decides; comments acked with acked_at/acked_by, never deleted", /planReviewAck\(/.test(ra) && /\.update\(\{ acked_at: nowIso, acked_by: user\.id \}\)/.test(ra) && !/\.delete\(/.test(ra));
ok("review-ack: the dot goes out only when the plan says so", /if \(plan\.clearAttention\) patch\.needs_attention = false;/.test(ra));
const modal = strip(readFileSync(join(root, "src/components/ClientNotesModal.tsx"), "utf8"));
ok("window: renders the full history and sends up_to with 'קיבלתי'", /<ClientCommentHistory items=\{items\} \/>/.test(modal) && /up_to: upTo/.test(modal));
ok("window: 'אין פירוט הערות בסבב זה' only when there are no comments either", /\{!hasDetail && !hasComments && \(/.test(modal));
const pr = strip(readFileSync(join(root, "src/app/productions/[id]/review-notes/print/page.tsx"), "utf8"));
const iGate = pr.indexOf("if (!profile.can_edit_stages)");
const iLoad = pr.indexOf("loadCommentHistory(createTypedAdminClient()");
ok("PDF page: the history is read with the service role only AFTER the can_edit_stages check", iGate > 0 && iLoad > iGate);
ok("PDF page: the same component as the window", /<ClientCommentHistory items=\{history\} \/>/.test(pr));
const dr = strip(readFileSync(join(root, "src/components/EntityDrawer.tsx"), "utf8"));
ok("drawer: the history section, from data.commentHistory", /<ClientCommentHistory\s+items=\{data\.commentHistory\}/.test(dr));
ok("drawer: Hebrew event names in the change history, 'אירוע מערכת' for an unknown one", /eventLabel\(h\.event_type\)/.test(dr) && dr.includes("אירוע מערכת"));
const eg = strip(readFileSync(join(root, "src/lib/drawer/entityGet.ts"), "utf8"));
ok("entityGet: history only with stages, only for a production, failure → null (rule 38)", /if \(!seesStages \|\| type !== "production"\) return null;/.test(eg) && /catch \{\s*return null;/.test(eg));
const da = strip(readFileSync(join(root, "src/lib/review/downloadAttention.ts"), "utf8"));
ok("missing-file auto-clear: an unacked client comment keeps the dot lit", /openComments > 0/.test(da) && /\.is\("acked_at", null\)/.test(da));
const rs = strip(readFileSync(join(root, "src/app/api/r/[token]/respond/route.ts"), "utf8"));
ok("respond: 'תיקונים' without text is accepted when this link left comments on the item", /const n = commentCount\.get\(it\.id\) \?\? 0;\s*if \(n > 0\) \{/.test(rs) && /\.eq\("link_id", linkId\)/.test(rs));
const rcl = strip(readFileSync(join(root, "src/app/r/[token]/ReviewClient.tsx"), "utf8"));
ok("page: 'יש לך הערות. לאשר בכל זאת?' before approving an item with comments", rcl.includes('window.confirm("יש לך הערות. לאשר בכל זאת?")') && /myCommentCount\(it\) > 0 && !window\.confirm/.test(rcl));
ok("page: a pin on a live link marks the item 'תיקונים'", /setItemChoice\(\(prev\) => \(\{ \.\.\.prev, \[itemId\]: "revisions" \}\)\);/.test(rcl));
ok("page: on Bunny 'תיקונים' opens the pins and hides the free-text note", /hideNote=\{liveBunny\(it\)\}/.test(rcl) && /openBox\(it\.id, true\);/.test(rcl));
ok("page (bug 3): every choice / note change clears the red line at once", (rcl.match(/setError\(null\);\s*set(EpChoice|ReChoice|EpNote|ReNote|ItemChoice|ItemNote)/g) ?? []).length >= 6);

// ══════════════════════════════════════════════════════════════════════
section("page render — the live link, Bunny vs Drive");
const ITEM = "11111111-1111-4111-8111-111111111111";
const V = "00000000-0000-4000-8000-000000000002";
const views: ClientVersionView[] = [{ id: V, number: 2, kind: "bunny", isAudio: false, fileName: "r.mp4", playbackUrl: "https://cdn.test/p.m3u8", expires: 1, downloadable: true }];
const base = {
  token: "tok",
  showName: "אסתטיטוקס",
  episodeLabel: "הפרק המלא",
  recordDate: "2026-07-20",
  episodeIncluded: true,
  reelsIncluded: true,
  episodeApproved: false,
  reelsApproved: false,
  episodeLink: null,
  reelsLink: null,
  addons: [],
  items: [{ id: ITEM, kind: "reel" as const, reel_index: 1, media_link: "https://drive.google.com/file/d/R/view", approved: false }],
};
const mine: ClientCommentView[] = [{ id: "m1", version_id: V, kind: "pin", pin_number: 1, time_ms: 4442, body: "שלי", created_at: "t", mine: true }];
const render = (el: React.ReactElement) => {
  try {
    return renderToString(el);
  } catch (e) {
    return `THREW: ${e instanceof Error ? e.message : String(e)}`;
  }
};
const liveB = render(<ReviewClient {...base} versionsByItem={{ [ITEM]: views }} currentVersion={{ [ITEM]: V }} comments={{ [ITEM]: mine }} />);
ok("Bunny, with my pin: '📍 הוסף עוד הערה', both decision buttons", liveB.includes("📍 הוסף עוד הערה") && liveB.includes("✓ מאשר") && liveB.includes("✎ תיקונים"), liveB);
const liveB0 = render(<ReviewClient {...base} versionsByItem={{ [ITEM]: views }} currentVersion={{ [ITEM]: V }} />);
ok("Bunny, no pins yet: '📍 הערה בנקודת זמן'", liveB0.includes("📍 הערה בנקודת זמן"), liveB0);
const liveD = render(<ReviewClient {...base} currentVersion={{ [ITEM]: "D1" }} />);
ok("Drive only: no pin link (the free-text note, as today)", !liveD.includes("📍") && liveD.includes("✎ תיקונים"), liveD);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
