/**
 * E13-9 — "טופל" on one client comment (owner 18.10).
 *   src/lib/review/resolveComment.ts        what a mark writes, when the dot goes out
 *   src/lib/review/commentHistory.ts        open = not "טופל"; unread = not acked, not resolved
 *   src/components/ClientCommentHistory.tsx the mark, who and when, the button, dimmed when handled
 *   src/lib/review/markerExport.ts          "open" export = not "טופל", acked or not
 *   src/app/r/[token]/ReviewPlayer.tsx      the client sees "טופל ✓"
 *   + static checks on the route, the client's read, the window and the drawer
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_e13_9_resolved.tsx
 *
 * ═══ F19 ═══ No database, no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import { planResolve, planResolveMany, type ResolveRound } from "../src/lib/review/resolveComment";
import { buildCommentHistory, openOfLatest, type HcComment } from "../src/lib/review/commentHistory";
import ClientCommentHistory from "../src/components/ClientCommentHistory";
import { buildMarkers } from "../src/lib/review/markerExport";
import ReviewPlayer, { type ClientCommentView, type ClientVersionView } from "../src/app/r/[token]/ReviewPlayer";
import { EVENT_LABEL, eventLabel } from "../src/lib/events/labels";

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
const root = join(__dirname, "..");
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

// ══════════════════════════════════════════════════════════════════════
section("planResolve — what a mark writes");
const fresh = { acked_at: null, resolved_at: null };
const ackedC = { acked_at: "2026-10-18T09:00:00Z", resolved_at: null };
const doneC = { acked_at: "2026-10-18T09:00:00Z", resolved_at: "2026-10-18T10:00:00Z" };
const revRound = (over: Partial<NonNullable<ResolveRound>> = {}): ResolveRound => ({ id: "R1", episode_response: null, reels_response: "revisions", episode_note: null, reels_note: null, ...over });
const base = { otherUnread: 0, latestRound: null as ResolveRound, prodAckLinkId: null as string | null, missingDownloads: 0 };

check("resolve an unread comment, nothing else waiting → stamp + ack + dot out", planResolve({ ...base, resolved: true, comment: fresh }), { kind: "resolve", ack: true, ackRound: false, clearAttention: true });
check("resolve twice → nothing (a double click writes no second stamp)", planResolve({ ...base, resolved: true, comment: doneC }), { kind: "nothing" });
check("unresolve a resolved comment → unresolve", planResolve({ ...base, resolved: false, comment: doneC }), { kind: "unresolve" });
check("unresolve one that is not resolved → nothing", planResolve({ ...base, resolved: false, comment: ackedC }), { kind: "nothing" });
check("an already-acked comment → no second ack, and the dot is NOT touched (someone may have lit it since)", planResolve({ ...base, resolved: true, comment: ackedC }), { kind: "resolve", ack: false, ackRound: false, clearAttention: false });
check("another comment still unread → the dot stays", planResolve({ ...base, otherUnread: 1, resolved: true, comment: fresh }), { kind: "resolve", ack: true, ackRound: false, clearAttention: false });
check("revisions round of pins only, last unread comment → the round is acked too, dot out", planResolve({ ...base, latestRound: revRound(), resolved: true, comment: fresh }), { kind: "resolve", ack: true, ackRound: true, clearAttention: true });
check("revisions round with TYPED notes → the round still needs 'קיבלתי', dot stays", planResolve({ ...base, latestRound: revRound({ reels_note: "ריל 1: לקצר" }), resolved: true, comment: fresh }), { kind: "resolve", ack: true, ackRound: false, clearAttention: false });
check("a note of only spaces counts as no text", planResolve({ ...base, latestRound: revRound({ episode_note: "   " }), resolved: true, comment: fresh }).kind === "resolve" && (planResolve({ ...base, latestRound: revRound({ episode_note: "   " }), resolved: true, comment: fresh }) as { ackRound: boolean }).ackRound, true);
check("revisions round already acked → no round ack, dot out", planResolve({ ...base, latestRound: revRound(), prodAckLinkId: "R1", resolved: true, comment: fresh }), { kind: "resolve", ack: true, ackRound: false, clearAttention: true });
check("revisions round, but other comments unread → no round ack, dot stays", planResolve({ ...base, otherUnread: 2, latestRound: revRound(), resolved: true, comment: fresh }), { kind: "resolve", ack: true, ackRound: false, clearAttention: false });
check("an approved round → nothing to ack, dot out", planResolve({ ...base, latestRound: revRound({ reels_response: "approved" }), resolved: true, comment: fresh }), { kind: "resolve", ack: true, ackRound: false, clearAttention: true });
check("a Drive file the client could not download → the dot stays (shared dot)", planResolve({ ...base, missingDownloads: 1, resolved: true, comment: fresh }), { kind: "resolve", ack: true, ackRound: false, clearAttention: false });

// ══════════════════════════════════════════════════════════════════════
section("buildCommentHistory — open = not 'טופל', unread = not acked and not resolved");
const IT = "item-1";
const V = "ver-2";
const c = (id: string, over: Partial<HcComment> = {}): HcComment => ({
  id, item_id: IT, version_id: V, link_id: "L1", kind: "pin", pin_number: Number(id.slice(1)), time_ms: 1000 * Number(id.slice(1)), body: `נעץ ${id}`,
  author_kind: "client", created_at: "2026-10-18T08:00:00Z", acked_at: null, acked_by: null, resolved_at: null, resolved_by: null, after_response: false, is_backfill: false, ...over,
});
const comments = [
  c("p1"),
  c("p2", { acked_at: "2026-10-18T09:00:00Z", acked_by: "u1" }),
  c("p3", { acked_at: "2026-10-18T09:00:00Z", acked_by: "u1", resolved_at: "2026-10-18T10:00:00Z", resolved_by: "u2" }),
];
const hist = buildCommentHistory({
  items: [{ id: IT, kind: "reel", reel_index: 1, approved: false }],
  comments,
  approvals: [],
  versions: [{ id: V, number: 2, original_filename: "reel01 v2.mp4" }],
  names: { u1: "אלי", u2: "דנה" },
});
const rows = hist[0].comments.map((x) => [x.id, x.open, x.unread, x.acked_by_name, x.resolved_by_name]);
check("new / acked / resolved", rows, [["p1", true, true, null, null], ["p2", true, false, "אלי", null], ["p3", false, false, "אלי", "דנה"]]);
check("nothing filtered out — the resolved one is still in the list", hist[0].comments.length, 3);

// ══════════════════════════════════════════════════════════════════════
section("ClientCommentHistory — the mark, who and when, the button");
const plain = renderToString(<ClientCommentHistory items={hist} />);
ok("'✓ טופל · דנה' shown on the resolved one", plain.replace(/<!-- -->/g, "").includes("✓ טופל · דנה"), plain);
ok("only the resolved one is dimmed", (plain.match(/opacity:0.55/g) ?? []).length === 1, plain);
ok("'חדשה' only on the unread one", (plain.match(/>חדשה</g) ?? []).length === 1, plain);
ok("header counts what is not resolved: 2 לא טופלו", plain.includes("2 לא טופלו"), plain);
ok("no onResolve (the PDF page) → no buttons", !plain.includes("<button"), plain);
const withBtn = renderToString(<ClientCommentHistory items={hist} onResolve={() => {}} busyId="p2" />);
ok("a button per comment: '✓ טופל' on the open ones, 'בטל טופל' on the resolved", (withBtn.match(/<button/g) ?? []).length === 3 && withBtn.includes("בטל טופל") && withBtn.includes("✓ טופל</button>"), withBtn);
ok("the busy one reads 'שומר…' and is disabled", /disabled=""[^>]*>שומר…<\/button>/.test(withBtn), withBtn);

// ══════════════════════════════════════════════════════════════════════
section("markers — 'open' = not 'טופל', acked or not (the 18.10 bug: acked pins exported 0)");
const exp = hist[0].comments.map((x) => ({ ...x, version_id: x.version_id }));
const mOpen = buildMarkers({ comments: exp, versionId: V, versionNumber: 2, fileName: "reel01 v2.mp4", formatDate: (s: string) => s.slice(0, 10), scope: "open", offsetFrames: 0 });
const mAll = buildMarkers({ comments: exp, versionId: V, versionNumber: 2, fileName: "reel01 v2.mp4", formatDate: (s: string) => s.slice(0, 10), scope: "all", offsetFrames: 0 });
check("open → the new pin AND the acked one; the resolved one is out", mOpen.map((m) => m.name.split(" ")[0]), ["#1", "#2"]);
check("all → all three, the resolved one too", mAll.map((m) => m.name.split(" ")[0]), ["#1", "#2", "#3"]);
const allAcked = buildCommentHistory({ items: [{ id: IT, kind: "reel", reel_index: 1, approved: true }], comments: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => c(`p${n}`, { acked_at: "2026-10-18T09:00:00Z" })), approvals: [], versions: [], names: {} });
check("אסתטיטוקס shape: 8 pins all acked, none resolved → 'open' exports 8 (was 0)", buildMarkers({ comments: allAcked[0].comments, versionId: V, versionNumber: 2, fileName: null, formatDate: (s: string) => s, scope: "open", offsetFrames: 0 }).length, 8);

// ══════════════════════════════════════════════════════════════════════
section("the client's page — 'טופל ✓' beside the comment");
const drive: ClientVersionView = { id: V, number: 2, kind: "drive", mediaLink: "https://drive.google.com/file/d/x/view" };
const cc = (id: string, kind: "pin" | "general", resolved?: boolean): ClientCommentView => ({ id, version_id: V, kind, pin_number: kind === "pin" ? 1 : null, time_ms: kind === "pin" ? 4442 : null, body: `הערה ${id}`, created_at: "2026-10-18T08:00:00Z", resolved });
const page = renderToString(
  <ReviewPlayer token="t" versions={[drive]} selectedId={V} onSelect={() => {}} renderDrive={() => <div>drive</div>} comments={[cc("a", "pin", true), cc("b", "general", true), cc("c", "general", false), cc("d", "pin")]} />
);
ok("two resolved → two 'טופל ✓'", (page.match(/טופל ✓/g) ?? []).length === 2, page);
ok("all four comments still shown", ["הערה a", "הערה b", "הערה c", "הערה d"].every((t) => page.includes(t)), page);
ok("no team names on the client's page", !page.includes("דנה") && !page.includes("אלי"), page);

// ══════════════════════════════════════════════════════════════════════
section("static: the route, the client's read, the window, the drawer, the labels");
const route = strip(readFileSync(join(root, "src/app/api/productions/[id]/review-comments/[commentId]/resolve/route.ts"), "utf8"));
ok("route: logged in + can_edit_stages", /status: 401/.test(route) && /can_edit_stages/.test(route) && /status: 403/.test(route));
ok("route: the comment must belong to THIS production (through its item)", /item\.production_id !== params\.id/.test(route));
ok("route: planResolve decides", /planResolve\(/.test(route));
ok("route: the stamp is guarded (a race is a no-op), the ack too", /\.update\(\{ resolved_at: nowIso, resolved_by: user\.id \}\)[\s\S]{0,80}\.is\("resolved_at", null\)/.test(route) && /\.update\(\{ acked_at: nowIso, acked_by: user\.id \}\)[\s\S]{0,80}\.is\("acked_at", null\)/.test(route));
ok("route: un-marking clears resolved_* only — never the ack", /\.update\(\{ resolved_at: null, resolved_by: null \}\)/.test(route) && !/acked_at: null/.test(route));
ok("route: the dot only when the plan says so", /if \(plan\.clearAttention\) patch\.needs_attention = false;/.test(route));
ok("route: nothing deleted", !/\.delete\(/.test(route));
ok("route: reads the missing-download entries (shared dot)", /outstandingMissing\(/.test(route));
ok("both events have Hebrew labels", !!EVENT_LABEL.client_review_comment_resolved && !!EVENT_LABEL.client_review_comment_unresolved);
const ic = strip(readFileSync(join(root, "src/lib/review/itemComments.ts"), "utf8"));
ok("the client's read takes resolved_at, never who resolved", /resolved_at/.test(ic) && !/resolved_by/.test(ic) && /resolved: !!r\.resolved_at/.test(ic));
const modal = strip(readFileSync(join(root, "src/components/ClientNotesModal.tsx"), "utf8"));
ok("window: passes onResolve, reloads after", /onResolve=\{/.test(modal) && /postResolve\(/.test(modal) && /setReloadKey/.test(modal));
const drawer = strip(readFileSync(join(root, "src/components/EntityDrawer.tsx"), "utf8"));
ok("drawer: onResolve only with stage edit", /onResolve=\{data\.canEditStages \? /.test(drawer));
const rc = strip(readFileSync(join(root, "src/app/api/productions/[id]/review-current/route.ts"), "utf8"));
ok("review-current: the 'קיבלתי' count reads UNREAD, not open", /filter\(\(c\) => c\.unread\)/.test(rc));
const mec = readFileSync(join(root, "src/components/MarkerExportControls.tsx"), "utf8");
ok("export picker reads 'שלא טופלו' / 'כולל שטופלו'", mec.includes("שלא טופלו") && mec.includes("כולל שטופלו"));

// ══════════════════════════════════════════════════════════════════════
section("✓ סמן הכול כטופל — the same rule over a set (owner 18.10)");
const many = (cs: { id: string; acked_at: string | null; resolved_at: string | null }[], over: Partial<Parameters<typeof planResolveMany>[0]> = {}) =>
  planResolveMany({ comments: cs, otherUnread: 0, latestRound: null, prodAckLinkId: null, missingDownloads: 0, ...over });
check("three open (one unread) → all three stamped, only the unread acked, dot out",
  many([{ id: "a", ...fresh }, { id: "b", ...ackedC }, { id: "c", ...ackedC }]),
  { kind: "resolve", resolveIds: ["a", "b", "c"], ackIds: ["a"], ackRound: false, clearAttention: true });
check("already-resolved ones in the set are left as they are", many([{ id: "a", ...fresh }, { id: "d", ...doneC }]).kind === "resolve" && (many([{ id: "a", ...fresh }, { id: "d", ...doneC }]) as { resolveIds: string[] }).resolveIds, ["a"]);
check("all already resolved → nothing", many([{ id: "d", ...doneC }]), { kind: "nothing" });
check("all acked already → stamped, the dot NOT touched (same as one mark)", many([{ id: "b", ...ackedC }]), { kind: "resolve", resolveIds: ["b"], ackIds: [], ackRound: false, clearAttention: false });
check("unread comments outside the set → the dot stays", many([{ id: "a", ...fresh }], { otherUnread: 1 }), { kind: "resolve", resolveIds: ["a"], ackIds: ["a"], ackRound: false, clearAttention: false });
check("pins-only revisions round, the set is the last unread → the round acked, dot out", many([{ id: "a", ...fresh }, { id: "b", ...fresh }], { latestRound: revRound() }), { kind: "resolve", resolveIds: ["a", "b"], ackIds: ["a", "b"], ackRound: true, clearAttention: true });
check("one mark and a set of one agree", planResolve({ ...base, latestRound: revRound(), resolved: true, comment: fresh }), { kind: "resolve", ack: true, ackRound: true, clearAttention: true });

section("openOfLatest — what the button counts");
const V1 = "ver-1";
const mixed = buildCommentHistory({
  items: [{ id: IT, kind: "reel", reel_index: 1, approved: false }],
  comments: [c("p1", { version_id: V1 }), c("p2"), c("p3", { acked_at: "2026-10-18T09:00:00Z" }), c("p4", { resolved_at: "2026-10-18T10:00:00Z" })],
  approvals: [],
  versions: [{ id: V1, item_id: IT, number: 1, original_filename: null }, { id: V, item_id: IT, number: 2, original_filename: null }],
  names: {},
});
check("latest version = the highest number", mixed[0].latest_version_id, V);
check("open of v2 only: the unread and the acked; not v1's, not the resolved one", openOfLatest(mixed[0]), ["p2", "p3"]);
const noVer = buildCommentHistory({ items: [{ id: IT, kind: "episode", reel_index: null, approved: false }], comments: [c("p1", { version_id: null, kind: "general" })], approvals: [], versions: [], names: {} });
check("an item with no version → its version-less open comments", [noVer[0].latest_version_id, openOfLatest(noVer[0])], [null, ["p1"]]);
check("an older payload (no latest_version_id) → no button", openOfLatest({ comments: [{ id: "x", open: true, version_id: V }] }), []);

const btnHtml = renderToString(<ClientCommentHistory items={mixed} onResolve={() => {}} onResolveAll={() => {}} />);
ok("the button sits in the item header", (btnHtml.match(/data-resolve-all="item-1"/g) ?? []).length === 1 && btnHtml.includes("✓ סמן הכול כטופל"), btnHtml);
const allDone = buildCommentHistory({ items: [{ id: IT, kind: "reel", reel_index: 1, approved: false }], comments: [c("p2", { resolved_at: "2026-10-18T10:00:00Z" })], approvals: [], versions: [{ id: V, item_id: IT, number: 2, original_filename: null }], names: {} });
ok("hidden when nothing is open on the latest version", !renderToString(<ClientCommentHistory items={allDone} onResolve={() => {}} onResolveAll={() => {}} />).includes("סמן הכול"));
ok("hidden without onResolveAll (the PDF page)", !renderToString(<ClientCommentHistory items={mixed} />).includes("סמן הכול"));
ok("busy → 'שומר…' and disabled", /data-resolve-all="item-1" disabled=""[^>]*>שומר…</.test(renderToString(<ClientCommentHistory items={mixed} onResolveAll={() => {}} busyItemId="item-1" />)));

section("one event: 'N הערות סומנו כטופלו'");
check("the label carries the count", [eventLabel("client_review_comments_resolved_bulk", { count: 8 }), eventLabel("client_review_comments_resolved_bulk", { count: 1 }), eventLabel("client_review_comments_resolved_bulk", null)], ["8 הערות סומנו כטופלו", "הערה אחת סומנה כטופלה", "הערות סומנו כטופלו"]);
const bulk = strip(readFileSync(join(root, "src/app/api/productions/[id]/review-items/[itemId]/resolve-all/route.ts"), "utf8"));
ok("bulk route: logged in + can_edit_stages + the item belongs to the production", /status: 401/.test(bulk) && /can_edit_stages/.test(bulk) && /item\.production_id !== params\.id/.test(bulk));
ok("bulk route: only the asked ids that are STILL open on the latest version", /\.in\("id", asked\)/.test(bulk) && /\.is\("resolved_at", null\)/.test(bulk) && /q\.eq\("version_id", latest\.id\)/.test(bulk));
ok("bulk route: each stamped with who and when, guarded; ack guarded", /\.update\(\{ resolved_at: nowIso, resolved_by: user\.id \}\)[\s\S]{0,80}\.is\("resolved_at", null\)/.test(bulk) && /\.update\(\{ acked_at: nowIso, acked_by: user\.id \}\)[\s\S]{0,80}\.is\("acked_at", null\)/.test(bulk));
ok("bulk route: planResolveMany decides the dot", /planResolveMany\(/.test(bulk) && /if \(plan\.clearAttention\) patch\.needs_attention = false;/.test(bulk));
ok("bulk route: exactly ONE event insert, with the count", (bulk.match(/from\("events"\)\.insert/g) ?? []).length === 1 && /event_type: "client_review_comments_resolved_bulk"/.test(bulk) && /count: hitIds\.length/.test(bulk));
ok("bulk route: nothing deleted", !/\.delete\(/.test(bulk));
const rf = readFileSync(join(root, "src/lib/review/resolveFetch.ts"), "utf8");
ok("confirm first: 'לסמן N הערות כטופלו?'", /window\.confirm\(/.test(rf) && rf.includes("הערות כטופלו?") && rf.indexOf("window.confirm") < rf.indexOf("resolve-all"));
const modal2 = strip(readFileSync(join(root, "src/components/ClientNotesModal.tsx"), "utf8"));
const drawer2 = strip(readFileSync(join(root, "src/components/EntityDrawer.tsx"), "utf8"));
ok("window + drawer pass onResolveAll (drawer: stage edit only)", /onResolveAll=\{/.test(modal2) && /onResolveAll=\{data\.canEditStages \? /.test(drawer2));
ok("drawer history label gets the payload", /eventLabel\(h\.event_type, h\.payload\)/.test(drawer2));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
