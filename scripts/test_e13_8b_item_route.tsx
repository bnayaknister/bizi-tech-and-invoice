/**
 * E13-8b — the client's comment / pin / re-approval on one item.
 *   src/lib/review/itemComments.ts                 parse, version rule, errors, re-approve rule
 *   src/app/api/r/[token]/items/[itemId]/route.ts  the route (static)
 *   src/app/r/[token]/ReviewClient.tsx + ReviewPlayer.tsx   the page (server render)
 *   src/lib/review/links.ts                        one deal-invoice path for both approvals
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_e13_8b_item_route.tsx
 *
 * ═══ F19 ═══ No database, no network. 0118 itself was proven on a local
 * Postgres (E13-8a) and on production by the owner's dryrun (17.10, 10/10).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  parseItemAction,
  checkAgainstVersions,
  mapRpcError,
  canReapprove,
  formatPinTime,
  type VersionWithDuration,
} from "../src/lib/review/itemComments";
import ReviewClient from "../src/app/r/[token]/ReviewClient";
import { formatPinTime as formatPinTimeClient, type ClientVersionView, type ClientCommentView } from "../src/app/r/[token]/ReviewPlayer";

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

const V1 = "00000000-0000-4000-8000-000000000001";
const V2 = "00000000-0000-4000-8000-000000000002";
const V3 = "00000000-0000-4000-8000-000000000003";
const IT = "11111111-1111-4111-8111-111111111111";
const ver = (over: Partial<VersionWithDuration>): VersionWithDuration => ({
  id: V2,
  item_id: IT,
  number: 2,
  source: "bunny",
  media_link: null,
  bunny_video_id: "aaaaaaaa-0000-4000-8000-000000000002",
  bunny_status: "ready",
  integrity: "hash_match",
  has_original: true,
  is_audio_only: false,
  original_filename: "reel01 v2.mp4",
  drive_file_id: "D",
  media_deleted_at: null,
  duration_ms: 60_000,
  ...over,
});
const drive1 = ver({ id: V1, number: 1, source: "drive", media_link: "https://drive.google.com/file/d/X/view", bunny_video_id: null, bunny_status: null, integrity: null, has_original: null, drive_file_id: null, duration_ms: null });

// ══════════════════════════════════════════════════════════════════════
section("parseItemAction — what the route accepts");
check("pin", parseItemAction({ action: "pin", version_id: V2, time_ms: 42180, body: "  שם  " }), { ok: true, value: { action: "pin", versionId: V2, timeMs: 42180, body: "שם" } });
check("pin: time must be a whole number of ms ≥ 0", [parseItemAction({ action: "pin", version_id: V2, time_ms: -1, body: "x" }).ok, parseItemAction({ action: "pin", version_id: V2, time_ms: 1.5, body: "x" }).ok, parseItemAction({ action: "pin", version_id: V2, body: "x" }).ok], [false, false, false]);
check("pin: needs a version", parseItemAction({ action: "pin", time_ms: 1, body: "x" }).ok, false);
check("comment with no version (an item without versions)", parseItemAction({ action: "comment", body: "x" }), { ok: true, value: { action: "comment", versionId: null, body: "x" } });
check("empty body → refused", parseItemAction({ action: "comment", version_id: V2, body: "   " }).ok, false);
check("2001 chars → refused", parseItemAction({ action: "comment", version_id: V2, body: "a".repeat(2001) }).ok, false);
check("approve needs a version", [parseItemAction({ action: "approve" }).ok, parseItemAction({ action: "approve", version_id: V2 }).ok], [false, true]);
check("unknown action / garbage body → refused", [parseItemAction({ action: "delete" }).ok, parseItemAction(null).ok, parseItemAction("x").ok], [false, false, false]);
check("a malformed version id is treated as missing", parseItemAction({ action: "approve", version_id: "../../x" }).ok, false);

// ══════════════════════════════════════════════════════════════════════
section("checkAgainstVersions — the latest version only, enforced on the server");
const rows = [drive1, ver({})];
check("pin on the current Bunny version → ok", checkAgainstVersions({ action: "pin", versionId: V2, timeMs: 1000, body: "x" }, rows), { ok: true });
check("pin on an older version → 409 'רעננו'", checkAgainstVersions({ action: "pin", versionId: V1, timeMs: 1000, body: "x" }, rows), { ok: false, status: 409, error: "יש גרסה חדשה יותר. רעננו את הדף" });
check("a newer v3 became current while the page was open → 409", checkAgainstVersions({ action: "comment", versionId: V2, body: "x" }, [...rows, ver({ id: V3, number: 3 })]).ok, false);
check("a v3 in mismatch is not current → v2 still accepted", checkAgainstVersions({ action: "comment", versionId: V2, body: "x" }, [...rows, ver({ id: V3, number: 3, integrity: "mismatch" })]).ok, true);
check("pin after the end of the file (+1s slack) → 400", checkAgainstVersions({ action: "pin", versionId: V2, timeMs: 61_001, body: "x" }, rows).ok, false);
check("pin exactly at the end → ok", checkAgainstVersions({ action: "pin", versionId: V2, timeMs: 61_000, body: "x" }, rows).ok, true);
check("only Drive history: a comment names the Drive row", checkAgainstVersions({ action: "comment", versionId: V1, body: "x" }, [drive1]).ok, true);
check("only Drive history: a pin → 400 (no playback time)", checkAgainstVersions({ action: "pin", versionId: V1, timeMs: 0, body: "x" }, [drive1]), { ok: false, status: 400, error: "בגרסה הזו אין הערה בנקודת זמן" });
// E13-10 (owner 18.10): an archive takes no new comment either (was: comment ok)
check("archived (deleted at Bunny) current → comment refused, pin refused", [checkAgainstVersions({ action: "comment", versionId: V2, body: "x" }, [drive1, ver({ media_deleted_at: "2027-01-01T00:00:00Z" })]).ok, checkAgainstVersions({ action: "pin", versionId: V2, timeMs: 0, body: "x" }, [drive1, ver({ media_deleted_at: "2027-01-01T00:00:00Z" })]).ok], [false, false]);
check("no versions at all: comment with null → ok; with an id → 409", [checkAgainstVersions({ action: "comment", versionId: null, body: "x" }, []).ok, checkAgainstVersions({ action: "comment", versionId: V2, body: "x" }, []).ok], [true, false]);
check("a version exists but the comment names none → 409", checkAgainstVersions({ action: "comment", versionId: null, body: "x" }, rows).ok, false);
check("approve on the current version → ok", checkAgainstVersions({ action: "approve", versionId: V2 }, rows).ok, true);

// ══════════════════════════════════════════════════════════════════════
section("mapRpcError — 0118's sentences → status + a client sentence");
check("already approved → 409", mapRpcError("review_item_reapprove: הפריט כבר מאושר").status, 409);
check("not revoked by a comment → 409", mapRpcError("review_item_reapprove: אין אישור שבוטל בהערה על הפריט").status, 409);
check("revoked from another link → 409", mapRpcError("review_item_reapprove: הביטול לא נעשה מהקישור הזה").status, 409);
check("cancelled production → 410", mapRpcError("review_item_comment: ההפקה בוטלה").status, 410);
check("anything else → 500, no internals leaked", mapRpcError("permission denied for table x"), { status: 500, error: "השמירה נכשלה. נסו שוב בעוד רגע" });

// ══════════════════════════════════════════════════════════════════════
section("canReapprove — the same rule as review_item_reapprove (decision 2)");
const L = "L1";
const revoked = { id: "a1", decision: "approved", decided_at: "2026-10-17T10:00:00Z", created_at: "2026-10-17T10:00:00Z", revoked_at: "2026-10-17T12:00:00Z", revoked_reason: "client_comment" };
const myComment = { link_id: L, author_kind: "client", created_at: "2026-10-17T12:00:00Z" };
check("revoked by my comment → yes", canReapprove(false, [revoked], [myComment], L), true);
check("item approved → no", canReapprove(true, [revoked], [myComment], L), false);
check("revoked on the board (board_rollback) → no", canReapprove(false, [{ ...revoked, revoked_reason: "board_rollback" }], [myComment], L), false);
check("the comment came from ANOTHER link → no", canReapprove(false, [revoked], [{ ...myComment, link_id: "L2" }], L), false);
check("a newer revisions decision after the revoke → no (next round)", canReapprove(false, [revoked, { ...revoked, id: "a2", decision: "revisions", decided_at: "2026-10-17T13:00:00Z", revoked_at: null, revoked_reason: null }], [myComment], L), false);
check("no ledger rows → no", canReapprove(false, [], [myComment], L), false);

section("formatPinTime");
check("00:00 / 00:42 / 59:59 / 1:02:03", [0, 42_180, 3_599_999, 3_723_000].map(formatPinTime), ["00:00", "00:42", "59:59", "1:02:03"]);
check("the client copy formats the same", [0, 42_180, 3_599_999, 3_723_000].map(formatPinTimeClient), [0, 42_180, 3_599_999, 3_723_000].map(formatPinTime));

// ══════════════════════════════════════════════════════════════════════
section("static: the route");
const root = join(__dirname, "..");
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const rt = strip(readFileSync(join(root, "src/app/api/r/[token]/items/[itemId]/route.ts"), "utf8"));
const iResolve = rt.indexOf("resolveLink(");
const iScope = rt.indexOf("itemInLinkScope(");
const iCheck = rt.indexOf("checkAgainstVersions(");
const iRpc = rt.indexOf("admin.rpc(");
ok("order: token → item in scope → latest-version rule → the 0118 function", iResolve > 0 && iScope > iResolve && iCheck > iScope && iRpc > iCheck);
ok("a replaced / expired link → 410 (resolveLink not ok)", /if \(state\.status !== "ok"\) return json\(\{ error: "הלינק אינו זמין יותר"/.test(rt));
ok("throttled per token + item", /THROTTLE_MS = 1000/.test(rt) && /`\$\{params\.token\}\|\$\{params\.itemId\}`/.test(rt));
ok("re-approve → the deal invoice ONLY on the flip into אושר_ע\"י_לקוח", /if \(res\.status === 'אושר_ע"י_לקוח' && res\.from_status !== 'אושר_ע"י_לקוח'\) \{\s*await enqueueDealInvoiceAfterApproval\(/.test(rt));
ok("the route exports only POST and dynamic", (rt.match(/^export /gm) ?? []).length === 2);
const lk = strip(readFileSync(join(root, "src/lib/review/links.ts"), "utf8"));
ok("applyResponse takes the same deal-invoice path", /if \(approvedAll\) await enqueueDealInvoiceAfterApproval\(admin, production\.id\);/.test(lk));
ok("…and that path still asks enqueueDocument (findBilledEvidence inside) for per_episode only", /export async function enqueueDealInvoiceAfterApproval[\s\S]*cadence === "per_episode"[\s\S]*enqueueDocument\(admin, "deal_invoice"/.test(lk));
const pg = strip(readFileSync(join(root, "src/app/r/[token]/page.tsx"), "utf8"));
ok("page: comments loaded inside try/catch (rule 38)", /try \{\s*const c = await loadClientComments\(/.test(pg) && /review_page_comments_failed/.test(pg));
ok("page: currentVersion passed only when the read succeeded", /currentVersion=\{commentsReady \? currentVersion : undefined\}/.test(pg));

// ══════════════════════════════════════════════════════════════════════
section("the page — server render");
const render = (el: React.ReactElement) => {
  try {
    return renderToString(el);
  } catch (e) {
    return `THREW: ${e instanceof Error ? e.message : String(e)}`;
  }
};
const views: ClientVersionView[] = [
  { id: V1, number: 1, kind: "drive", mediaLink: "https://drive.google.com/file/d/X/view" },
  { id: V2, number: 2, kind: "bunny", isAudio: false, fileName: "reel01 v2.mp4", playbackUrl: "https://cdn.test/p.m3u8", expires: 1, downloadable: true },
];
const comments: Record<string, ClientCommentView[]> = {
  [IT]: [
    { id: "c2", version_id: V2, kind: "pin", pin_number: 2, time_ms: 90_000, body: "שנייה", created_at: "t" },
    { id: "c1", version_id: V2, kind: "pin", pin_number: 1, time_ms: 42_180, body: "ראשונה", created_at: "t" },
    { id: "c3", version_id: V2, kind: "general", pin_number: null, time_ms: null, body: "כללית על הכל", created_at: "t" },
    { id: "c4", version_id: V1, kind: "pin", pin_number: 1, time_ms: 1000, body: "של גרסה קודמת", created_at: "t" },
  ],
};
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
  items: [{ id: IT, kind: "reel" as const, reel_index: 1, media_link: "https://drive.google.com/file/d/R/view", approved: true }],
  versionsByItem: { [IT]: views },
};
const post = render(<ReviewClient {...base} respondedAt="2026-10-17T10:00:00Z" comments={comments} currentVersion={{ [IT]: V2 }} />);
ok("answered link: 'יש לי עוד הערה' under the item", post.includes("יש לי עוד הערה"), post);
ok("…the pins of the version on screen, in time order, with mm:ss", post.indexOf("ראשונה") > 0 && post.indexOf("שנייה") > post.indexOf("ראשונה") && post.includes("00:42") && post.includes("01:30"), post);
ok("…the general comment after the pins", post.indexOf("כללית על הכל") > post.indexOf("שנייה"), post);
ok("…a comment of another version is not listed with this one", !post.includes("של גרסה קודמת"), post);
ok("…approved item: no 'מאשר שוב' (nothing was revoked)", !post.includes("מאשר שוב"), post);
const noCv = render(<ReviewClient {...base} respondedAt="2026-10-17T10:00:00Z" comments={comments} />);
ok("comments read failed (no currentVersion) → no box at all, page still renders", !noCv.startsWith("THREW") && !noCv.includes("יש לי עוד הערה") && noCv.includes("<video"), noCv);
const re = render(
  <ReviewClient {...base} items={[{ ...base.items[0], approved: false }]} respondedAt="2026-10-17T10:00:00Z" comments={comments} currentVersion={{ [IT]: V2 }} reapprovable={{ [IT]: true }} />
);
ok("revoked by a comment from this link → '✓ מאשר שוב'", re.includes("✓ מאשר שוב"), re);
const reNo = render(<ReviewClient {...base} items={[{ ...base.items[0], approved: false }]} respondedAt="2026-10-17T10:00:00Z" currentVersion={{ [IT]: V2 }} />);
ok("pending but not re-approvable (a revisions item) → no 'מאשר שוב'", !reNo.includes("מאשר שוב"), reNo);
const live = render(<ReviewClient {...base} items={[{ ...base.items[0], approved: false }]} comments={comments} currentVersion={{ [IT]: V2 }} />);
ok("live link, pending item on a Bunny version → '📍 הערה בנקודת זמן' (decision 1)", live.includes("📍 הערה בנקודת זמן") && live.includes("✓ מאשר"), live);
ok("live link: no 'יש לי עוד הערה' (that is the answered link's)", !live.includes("יש לי עוד הערה"), live);
const liveApproved = render(<ReviewClient {...base} comments={comments} currentVersion={{ [IT]: V2 }} />);
ok("live link, approved item → no pin button", !liveApproved.includes("📍 הערה בנקודת זמן"), liveApproved);
const driveOnly = render(
  <ReviewClient {...base} versionsByItem={{}} respondedAt="2026-10-17T10:00:00Z" currentVersion={{ [IT]: V1 }} />
);
ok("answered link, item with Drive only → 'יש לי עוד הערה' (a general comment)", driveOnly.includes("יש לי עוד הערה") && driveOnly.includes("R/preview"), driveOnly);
const liveDrive = render(<ReviewClient {...base} versionsByItem={{}} items={[{ ...base.items[0], approved: false }]} currentVersion={{ [IT]: V1 }} />);
ok("live link, Drive only → no pin button (no playback time)", !liveDrive.includes("📍 הערה בנקודת זמן"), liveDrive);
const track = render(<ReviewClient {...base} items={[]} episodeLink="https://drive.google.com/file/d/T/view" respondedAt="2026-10-17T10:00:00Z" currentVersion={{}} />);
ok("track-level layout (no items) → unchanged, no box", !track.startsWith("THREW") && !track.includes("יש לי עוד הערה"), track);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
