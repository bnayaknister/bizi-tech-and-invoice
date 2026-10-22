/**
 * E13-4 — ReviewVersionsPanel renders, including with missing fields (the
 * lesson of "SSR 200 is not a render check": render the component itself,
 * with the shapes an older API answer or a failed versions read can give).
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_review_versions_panel.tsx
 */
import { renderToString } from "react-dom/server";
import React from "react";
import ReviewVersionsPanel, { type PanelItem } from "../src/components/ReviewVersionsPanel";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? `\n       ${detail.slice(0, 400)}` : ""}`);
  }
}
function render(props: Partial<React.ComponentProps<typeof ReviewVersionsPanel>>): string {
  try {
    return renderToString(
      <ReviewVersionsPanel productionId="p1" hasEpisode reelCount={2} items={[]} canEdit onChanged={() => {}} {...props} />
    );
  } catch (e) {
    return `THREW: ${e instanceof Error ? e.message : String(e)}`;
  }
}
const v = (over: Record<string, unknown>) => ({
  id: "v",
  number: 1,
  source: "bunny" as const,
  status: "ready" as const,
  integrity: "hash_match" as const,
  has_guid: true,
  is_audio_only: false,
  file_name: "reel1.mp4",
  final: true,
  created_at: "2026-10-16T10:00:00Z",
  ...over,
});

const empty = render({});
ok("no items at all → renders a row per deliverable", empty.includes("פרק") && empty.includes("ריל 1") && empty.includes("ריל 2"), empty);
ok("…with a send button per row", (empty.match(/שלח לביקורת/g) ?? []).length === 3, empty);

const legacy = render({ items: [{ kind: "episode", reel_index: null } as PanelItem] });
ok("an item WITHOUT a versions field (older answer) → renders, no crash", !legacy.startsWith("THREW"), legacy);

const full = render({
  items: [
    { kind: "episode", reel_index: null, versions: [v({ id: "d1", source: "drive", status: null, integrity: null, file_name: null, number: 1 }), v({ id: "b2", number: 2 })] },
    { kind: "reel", reel_index: 1, versions: [v({ id: "r1", number: null, status: "uploading", integrity: null, has_guid: false, final: false, file_name: "._x.wav", is_audio_only: true, created_at: new Date().toISOString() })] },
  ],
});
ok("labels: Drive history, מוכן ✓, נשלח", ["Drive (היסטוריה)", "מוכן ✓", "נשלח"].every((t) => full.includes(t)), full);
// owner 22.10: not ready an hour after it was sent -> "תקוע", with "שליחה מחדש" (canEdit)
const stuck = render({
  canEdit: true,
  items: [{ kind: "reel", reel_index: 1, versions: [v({ id: "s1", number: 2, status: "processing", integrity: null, final: false, created_at: new Date(Date.now() - 2 * 3600_000).toISOString() })] }],
});
ok("a version processing for 2 hours: 'תקוע — מעל שעה' + 'שליחה מחדש'", stuck.includes("תקוע — מעל שעה") && stuck.includes("שליחה מחדש"), stuck);
const fresh = render({
  canEdit: true,
  items: [{ kind: "reel", reel_index: 1, versions: [v({ id: "s2", number: 2, status: "processing", integrity: null, final: false, created_at: new Date(Date.now() - 10 * 60_000).toISOString() })] }],
});
ok("…10 minutes: 'בקידוד', no resend", fresh.includes("בקידוד") && !fresh.includes("שליחה מחדש"), fresh);
const failedV = render({ canEdit: true, items: [{ kind: "episode", reel_index: null, versions: [v({ id: "f1", status: "failed", final: true })] }] });
ok("a failed version: 'נכשל' + 'שליחה מחדש'", failedV.includes("נכשל") && failedV.includes("שליחה מחדש"), failedV);
const noEdit = render({ canEdit: false, items: [{ kind: "episode", reel_index: null, versions: [v({ id: "f2", status: "failed", final: true })] }] });
ok("…without edit permission: no resend button", !noEdit.includes("שליחה מחדש"), noEdit);
ok("an unnumbered version shows —, numbered ones vN", full.includes("v1") && full.includes("v2") && full.includes("—"), full);
ok("a null file name renders nothing for it, no crash", !full.startsWith("THREW"));

const viewer = render({ canEdit: false, items: [{ kind: "reel", reel_index: 1, versions: [v({})] }] });
ok("canEdit=false → no input and no send button, versions still listed", !viewer.includes("שלח לביקורת") && !viewer.includes("<input") && viewer.includes("מוכן ✓"), viewer);

const nothing = render({ hasEpisode: false, reelCount: 0 });
ok("no episode and no reels → renders nothing", nothing === "", nothing);

const weird = render({ items: [{ kind: "reel", reel_index: 1, versions: [v({ status: "something-new" as never, integrity: null })] }] });
ok("an unknown status from a newer server → '—', no crash", !weird.startsWith("THREW") && weird.includes("—"), weird);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
