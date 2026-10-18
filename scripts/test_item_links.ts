/**
 * One link per deliverable in the drawer (owner 18.10).
 *   src/lib/review/itemLinks.ts                       the shared rules
 *   src/app/api/productions/[id]/review-versions      "שלח לביקורת" writes the item's old link
 *   src/app/api/productions/[id]/review-items         PATCH refuses to change a locked link
 *   src/components/EntityDrawer.tsx                   read-only + the note, follows reloads
 *   src/components/ReviewVersionsPanel.tsx            a folder link refused at once
 *   src/lib/google/drive.ts                           …and on the server ('folder')
 *
 * Run:  npx tsx --tsconfig tsconfig.scripts.json scripts/test_item_links.ts
 * ═══ F19 ═══ No database, no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_LINK_NOTE, FOLDER_LINK_ERROR, LINK_LOCKED_ERROR, driveFileViewUrl, hasLiveBunnyVersion, isDriveFolderLink } from "../src/lib/review/itemLinks";
import { classifyDriveLink } from "../src/lib/review/drive";

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
const ok = (name: string, cond: boolean) => check(name, cond, true);
const section = (t: string) => console.log(`\n── ${t}`);

section("the rules");
check("the owner's sentence for a folder", FOLDER_LINK_ERROR, "זה קישור לתיקייה. פתח את הקובץ ב-Drive והעתק את הקישור שלו");
check("the owner's note for the read-only field", AUTO_LINK_NOTE, "עודכן אוטומטית מהגרסה האחרונה");
check("folder links (all the shapes Drive hands out)", ["https://drive.google.com/drive/folders/1AbC", "https://drive.google.com/drive/u/1/folders/1AbC?usp=sharing", "  https://drive.google.com/drive/folders/1AbC  "].map(isDriveFolderLink), [true, true, true]);
check("file links are NOT folders", ["https://drive.google.com/file/d/1AbC/view", "https://drive.google.com/open?id=1AbC", "https://example.com/folders/x"].map(isDriveFolderLink), [false, false, false]);
const fv = driveFileViewUrl("1Glb67etfdAguxT5kWJtkX2P3S19B18C9");
check("the file link written to the old field — the shape a technician pastes", fv, "https://drive.google.com/file/d/1Glb67etfdAguxT5kWJtkX2P3S19B18C9/view");
check("…and the client page can embed it (classifyDriveLink → file + /preview)", classifyDriveLink(fv), { type: "file", embedUrl: "https://drive.google.com/file/d/1Glb67etfdAguxT5kWJtkX2P3S19B18C9/preview", url: fv });
check("Bunny version sending / ready → locked", [hasLiveBunnyVersion([{ source: "bunny", status: "uploading" }]), hasLiveBunnyVersion([{ source: "bunny", bunny_status: "ready" }])], [true, true]);
check("only a FAILED Bunny version → not locked (a technician is never locked out by an error)", hasLiveBunnyVersion([{ source: "bunny", status: "failed" }]), false);
check("Drive history only / nothing → not locked (editable as today)", [hasLiveBunnyVersion([{ source: "drive", status: null }]), hasLiveBunnyVersion([])], [false, false]);
ok("the 409 sentence tells the technician where to go instead", LINK_LOCKED_ERROR.startsWith(AUTO_LINK_NOTE) && LINK_LOCKED_ERROR.includes("גרסאות לביקורת"));

section("static: the routes");
const root = join(__dirname, "..");
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const rv = strip(readFileSync(join(root, "src/app/api/productions/[id]/review-versions/route.ts"), "utf8"));
ok("send: after a successful send, the item's media_link = the version's Drive file", /\.update\(\{ media_link: driveFileViewUrl\(sent\.drive_file_id\) \}\)\s*\.eq\("id", sent\.item_id\)\s*\.eq\("production_id", params\.id\)/.test(rv));
ok("send: that write sits in the post-send try (cannot turn a sent version into 'not sent')", rv.indexOf("driveFileViewUrl(sent.drive_file_id)") > rv.indexOf("try {\n        const admin = createTypedAdminClient();"));
const ri = strip(readFileSync(join(root, "src/app/api/productions/[id]/review-items/route.ts"), "utf8"));
ok("PATCH: an item with a live Bunny version → 409 link_locked for a DIFFERENT link", /return NextResponse\.json\(\{ error: LINK_LOCKED_ERROR, code: "link_locked" \}, \{ status: 409 \}\)/.test(ri));
ok("PATCH: the SAME link again (a blur) → a no-op, not an error", /if \(\(\(match\.media_link as string \| null\) \?\? null\) === mediaLink\) continue;/.test(ri));
ok("PATCH: the lock uses the shared rule", /hasLiveBunnyVersion\(/.test(ri));
const gd = strip(readFileSync(join(root, "src/lib/google/drive.ts"), "utf8"));
ok("server: checkReviewFile refuses a folder with the owner's sentence, before any Drive call", /if \(isDriveFolderLink\(input\)\) return reject\("folder", FOLDER_LINK_ERROR\);/.test(gd) && gd.indexOf('reject("folder"') < gd.indexOf("extractDriveFileId(input)"));

section("static: the drawer");
const dr = strip(readFileSync(join(root, "src/components/EntityDrawer.tsx"), "utf8"));
ok("episode field: read-only when the episode item has a live Bunny version", /mediaReadOnly=\{hasLiveBunnyVersion\(\(data\.reviewItems \?\? \[\]\)\.find\(\(it\) => it\.kind === "episode"\)\?\.versions \?\? \[\]\)\}/.test(dr));
ok("reel fields: read-only per reel", /readOnly: hasLiveBunnyVersion\(item\?\.versions \?\? \[\]\),/.test(dr));
ok("read-only fields show the note and never save on blur", /onBlur=\{f\.readOnly \? undefined : f\.onBlur\}/.test(dr) && /onBlur=\{mediaReadOnly \? undefined : onMediaBlur\}/.test(dr) && (dr.match(/\{AUTO_LINK_NOTE\}/g) ?? []).length === 2);
ok("read-only fields follow every reload (the send rewrites them)", /if \(!it\.media_link \|\| !hasLiveBunnyVersion\(it\.versions \?\? \[\]\)\) continue;/.test(dr));
const vp = strip(readFileSync(join(root, "src/components/ReviewVersionsPanel.tsx"), "utf8"));
ok("versions panel: a folder link refused at once, no request", /if \(isDriveFolderLink\(url\)\) \{\s*setNotice\(\(n\) => \(\{ \.\.\.n, \[row\.key\]: \{ text: FOLDER_LINK_ERROR, bad: true \} \}\)\);\s*return;/.test(vp) && vp.indexOf("isDriveFolderLink(url)") < vp.indexOf("/review-versions`"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
