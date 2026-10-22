/**
 * 0122 (owner 22.10) — withdrawing a review version, and version views.
 * The client page skips a withdrawn version (and never serves it); the drawer
 * shows "הוסרה" + the reason, "נצפה לאחרונה", and "הסרת גרסה" for owner/admin;
 * comments on a withdrawn version stay, marked "גרסה הוסרה". Built from
 * המניפה 14.10 ep 6: v1 Drive history + v2 = the reel file sent by mistake.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_review_withdraw_views.tsx
 *
 * No database, no network.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { clientVersionsForItem, isPlayableBunny, latestShownVersionId, type VersionForClient } from "../src/lib/review/clientVersions";
import { publicVersion, withdrawReasonError, withdrawVersion, type VersionRow, type VersionStore } from "../src/lib/review/versions";
import { shouldRecordView, VIEW_DEDUP_MS } from "../src/lib/review/views";
import ReviewVersionsPanel, { type PanelItem } from "../src/components/ReviewVersionsPanel";

let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("network is forbidden in this suite");
}) as unknown as typeof fetch;

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail !== undefined ? `\n       ${JSON.stringify(detail)?.slice(0, 600)}` : ""}`);
  }
}
const eq = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

// ── המניפה ep 6, episode item ──────────────────────────────────────────────
const ITEM = "a66dcbf8-0000-4000-8000-000000000001";
const V1: VersionForClient = {
  id: "e3187e58-0000-4000-8000-000000000001", item_id: ITEM, number: 1, source: "drive", media_link: "https://drive.google.com/file/d/EPV1/view",
  bunny_video_id: null, bunny_status: null, integrity: null, has_original: null, is_audio_only: false, original_filename: null, drive_file_id: null, media_deleted_at: null,
};
const V2: VersionForClient = {
  id: "8a48befa-a5cd-4012-bb55-108ea63d7910", item_id: ITEM, number: 2, source: "bunny", media_link: null, bunny_video_id: "a42126bb-6af7-42bf-b2a0-fd8d25a782ff",
  bunny_status: "ready", integrity: "hash_match", has_original: true, is_audio_only: false, original_filename: "HAMENIFA - EP 6 - REEL 1 - V1.mp4",
  drive_file_id: "1hxiL2ID-fRuMB3vfdgNRCJ50TRtax0oZ", media_deleted_at: null,
};
const sign = () => ({ url: "https://cdn/x", expires: 0 });

async function main() {
  console.log("\n=== 1. the client page skips a withdrawn version ===");
  eq("before: v1 + v2 (the reel), v2 is the current one", clientVersionsForItem([V1, V2], sign).map((v) => [v.number, v.kind]), [[1, "drive"], [2, "bunny"]]);
  eq("…and v2 is 'current' for comments / approvals", latestShownVersionId([V1, V2]), V2.id);
  const W2 = { ...V2, withdrawn_at: "2026-10-22T20:00:00Z" };
  eq("after withdrawing v2: nothing reached Bunny any more -> [] (the page shows the item's media_link)", clientVersionsForItem([V1, W2], sign), []);
  eq("…'current' falls back to v1", latestShownVersionId([V1, W2]), V1.id);
  ok("…a withdrawn version is never playable (the download / playback routes refuse it)", !isPlayableBunny(W2));
  const V3 = { ...V2, id: "v3", number: 3, bunny_video_id: "g3", original_filename: "HAMENIFA- EP 6 - V2.mp4" };
  eq("a later real v3: v1, v3 — the withdrawn v2 is not between them", clientVersionsForItem([V1, W2, V3], sign).map((v) => v.number), [1, 3]);
  eq("…v3 is current", latestShownVersionId([V1, W2, V3]), "v3");
  const pendingWithdrawn = { ...V2, bunny_status: "processing", integrity: null, withdrawn_at: "2026-10-22T20:00:00Z" };
  eq("a withdrawn version still processing is not 'pending' (no Drive-history fallback because of it)", clientVersionsForItem([V1, pendingWithdrawn], sign), []);

  console.log("\n=== 2. the withdraw ===");
  eq("reason: empty", withdrawReasonError(""), "יש לכתוב סיבה להסרה");
  eq("reason: 2 chars", withdrawReasonError(" ab "), "יש לכתוב סיבה להסרה");
  eq("reason: fine", withdrawReasonError("קובץ ריל שנשלח לשדה הפרק"), null);
  ok("reason: 501 chars refused", withdrawReasonError("x".repeat(501)) !== null);

  const row: VersionRow = {
    id: V2.id, item_id: ITEM, number: 2, source: "bunny", media_link: null, bunny_video_id: V2.bunny_video_id, bunny_status: "ready", bunny_status_raw: 4,
    is_audio_only: false, original_filename: V2.original_filename, original_size_bytes: 135659059, drive_file_id: V2.drive_file_id, drive_sha256: "8".repeat(64),
    drive_size_bytes: 135659059, integrity: "hash_match", ready_at: "2026-10-21T13:31:07Z", fetch_requested_at: "2026-10-21T13:29:40Z", is_backfill: false,
    created_at: "2026-10-21T13:29:40Z", media_deleted_at: null, withdrawn_at: null, withdrawn_reason: null,
  };
  const events: { type: string; payload: Record<string, unknown>; actor?: string | null }[] = [];
  const store = {
    async versionProduction(id: string) {
      return id === row.id ? "p-menifa" : null;
    },
    async getVersion(id: string) {
      return id === row.id ? row : null;
    },
    async withdraw(id: string, userId: string | null, reason: string) {
      if (row.withdrawn_at) return false;
      row.withdrawn_at = "2026-10-22T20:00:00Z";
      row.withdrawn_reason = reason;
      void userId;
      return true;
    },
    async update(id: string, patch: Record<string, unknown>) {
      Object.assign(row, patch);
    },
    async event(type: string, _p: string, payload: Record<string, unknown>, actor?: string | null) {
      events.push({ type, payload, actor });
    },
  } as unknown as VersionStore;
  const deleted: string[] = [];
  const del = async (g: string) => {
    deleted.push(g);
    return { dryRun: false as const, alreadyGone: false };
  };
  eq("no reason -> 400, nothing done", [(await withdrawVersion({ productionId: "p-menifa", versionId: row.id, userId: "u-owner", reason: "" }, { store, deleteVideo: del })).status, row.withdrawn_at, deleted.length], [400, null, 0]);
  eq("another production's version -> 404", (await withdrawVersion({ productionId: "p-x", versionId: row.id, userId: "u-owner", reason: "סיבה טובה" }, { store, deleteVideo: del })).status, 404);
  const r = await withdrawVersion({ productionId: "p-menifa", versionId: row.id, userId: "u-owner", reason: "  קובץ ריל שנשלח לשדה הפרק  " }, { store, deleteVideo: del });
  eq("withdraw -> 200, deleted from Bunny", [r.status, (r.body as { bunny_delete?: string }).bunny_delete, deleted], [200, "deleted", [V2.bunny_video_id]]);
  eq("…the row: withdrawn, reason trimmed, number kept, media_deleted_at set", [!!row.withdrawn_at, row.withdrawn_reason, row.number, !!row.media_deleted_at], [true, "קובץ ריל שנשלח לשדה הפרק", 2, true]);
  ok("…one event review_version_withdrawn by the owner, with the reason", events.length === 1 && events[0].type === "review_version_withdrawn" && events[0].actor === "u-owner" && events[0].payload.reason === "קובץ ריל שנשלח לשדה הפרק");
  eq("a second click -> 409, Bunny not called again", [(await withdrawVersion({ productionId: "p-menifa", versionId: row.id, userId: "u-owner", reason: "שוב פעם" }, { store, deleteVideo: del })).status, deleted.length], [409, 1]);
  {
    // a Bunny delete that fails: still withdrawn, the failure recorded, media_deleted_at stays null
    const r2: VersionRow = { ...row, id: "v-fail", withdrawn_at: null, withdrawn_reason: null, media_deleted_at: null };
    const s2 = { ...store, versionProduction: async () => "p-menifa", getVersion: async () => r2, withdraw: async () => ((r2.withdrawn_at = "now"), true), update: async (_: string, p: Record<string, unknown>) => void Object.assign(r2, p) } as unknown as VersionStore;
    const res = await withdrawVersion({ productionId: "p-menifa", versionId: "v-fail", userId: null, reason: "בדיקה" }, { store: s2, deleteVideo: async () => { throw new Error("503"); } });
    ok("Bunny delete fails -> still 200, withdrawn, 'failed' recorded, media_deleted_at null", res.status === 200 && String((res.body as { bunny_delete?: string }).bunny_delete).startsWith("failed") && r2.media_deleted_at === null, res);
  }
  const pv = publicVersion(row);
  eq("the drawer's view: withdrawn + reason, final (no polling)", [!!pv.withdrawn_at, pv.withdrawn_reason, pv.final], [true, "קובץ ריל שנשלח לשדה הפרק", true]);

  console.log("\n=== 3. views ===");
  const now = new Date("2026-10-22T20:00:00Z");
  ok("first view -> recorded", shouldRecordView(null, now));
  ok("same link + version 5 minutes later -> one view", !shouldRecordView(new Date(now.getTime() - 5 * 60_000).toISOString(), now));
  ok("…after the window -> a new view", shouldRecordView(new Date(now.getTime() - VIEW_DEDUP_MS).toISOString(), now));

  console.log("\n=== 4. the drawer panel ===");
  const items: PanelItem[] = [
    {
      kind: "episode",
      reel_index: null,
      versions: [
        { id: "d1", number: 1, source: "drive", status: null, integrity: null, has_guid: false, is_audio_only: false, file_name: null, final: true, created_at: "2026-10-14T10:00:00Z", last_viewed_at: "2026-10-19T08:00:00Z" },
        { id: "b2", number: 2, source: "bunny", status: "ready", integrity: "hash_match", has_guid: true, is_audio_only: false, file_name: "HAMENIFA - EP 6 - REEL 1 - V1.mp4", final: true, created_at: "2026-10-21T13:29:40Z", withdrawn_at: "2026-10-22T20:00:00Z", withdrawn_reason: "קובץ ריל שנשלח לשדה הפרק", last_viewed_at: "2026-10-22T10:39:00Z" },
      ],
    },
  ];
  const render = (canWithdraw: boolean) =>
    renderToString(<ReviewVersionsPanel productionId="p" hasEpisode reelCount={0} items={items} canEdit canWithdraw={canWithdraw} onChanged={() => {}} />).replace(/<!-- -->/g, "");
  const owner = render(true);
  ok("withdrawn v2: 'הוסרה' + the reason", owner.includes("הוסרה") && owner.includes("קובץ ריל שנשלח לשדה הפרק"), owner);
  ok("v1: 'נצפה לאחרונה'; the withdrawn one does not show it", (owner.match(/data-review-last-viewed/g) ?? []).length === 1 && owner.includes("נצפה לאחרונה"));
  ok("owner/admin: 'הסרת גרסה' on v1 only (v2 is already withdrawn)", (owner.match(/data-action="review-withdraw"/g) ?? []).length === 1);
  ok("a technician: no 'הסרת גרסה'", !render(false).includes("review-withdraw"));

  console.log("\n=== 5. the wiring (source) ===");
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf-8");
  const route = read("src/app/api/productions/[id]/review-versions/[versionId]/withdraw/route.ts");
  ok("withdraw route: owner / admin only", route.includes("hasOwnerAccess(profile)"));
  const view = read("src/app/api/r/[token]/view/route.ts");
  ok("view route: the token like the page, the link scope, no viewer data", view.includes("resolveLink(") && view.includes("itemInLinkScope(") && view.includes("insert({ version_id: v.id, item_id: v.item_id, link_id: state.link.id })") && !/x-forwarded-for|user-agent|ip/i.test(view.replace(/\/\/.*$/gm, "")));
  const player = read("src/app/r/[token]/ReviewPlayer.tsx");
  ok("the player logs the version it shows", player.includes("logVersionView(token, viewedId)"));
  const store2 = read("src/lib/review/versionStore.ts");
  ok("withdrawn versions: never polled, never a duplicate / warning source", (store2.match(/\.is\("withdrawn_at", null\)/g) ?? []).length >= 4);
  const history = read("src/components/ClientCommentHistory.tsx");
  ok("comment history: 'גרסה הוסרה' on a withdrawn version's comments", history.includes("c.version_withdrawn") && history.includes("גרסה הוסרה"));

  eq("no network call", fetchCalls, 0);
  console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
