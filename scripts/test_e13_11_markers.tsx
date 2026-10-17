/**
 * E13-11 — Premiere markers export (owner decisions 18.10).
 *   src/lib/review/markerExport.ts            offset, frames @25, markers, JSON, FCP7 XML
 *   src/app/api/productions/[id]/review-items/[itemId]/markers   the download (static)
 *   src/components/MarkerExportControls.tsx   the drawer controls (render + static)
 *   premiere-plugin/bizi-markers/             the UXP panel: lib.js run here, index.js static
 *   public/downloads/bizi-markers.ccx         the package
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_e13_11_markers.tsx
 *
 * ═══ F19 ═══ No database, no network, no Premiere. The panel's Premiere
 * calls are checked against Adobe's sample statically; the real test is the
 * owner's, in Premiere 26 (instructions in the report).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  parseTimecodeOffset,
  msToFrame,
  framesToTimecode,
  buildMarkers,
  buildFcp7Xml,
  markerFileName,
  MARKER_FPS,
  type ExportComment,
  type BiziMarkerFile,
} from "../src/lib/review/markerExport";
import MarkerExportControls from "../src/components/MarkerExportControls";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const panel = require("../premiere-plugin/bizi-markers/lib.js") as {
  parseMarkerFile: (t: string) => { ok: true; file: { markers: { frame: number; seconds: number; name: string; comment: string }[]; offsetTimecode: string } } | { ok: false; error: string };
  planMarkers: (m: { name: string; seconds: number }[], e: { name: string; seconds: number }[]) => { add: unknown[]; skipped: number };
};

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
  if (!cond && detail) console.log(`       ${detail.slice(0, 600)}`);
  check(name, cond, true);
};
const section = (t: string) => console.log(`\n── ${t}`);
const root = join(__dirname, "..");

// ══════════════════════════════════════════════════════════════════════
section("the timecode offset — MM:SS or HH:MM:SS:FF at 25fps (owner 18.10)");
check("empty → 0 (the default: 00:00:00:00)", parseTimecodeOffset(""), { ok: true, frames: 0 });
check("23:30 (MM:SS) → 23m30s = 35250 frames", parseTimecodeOffset("23:30"), { ok: true, frames: 35250 });
check("90:00 — minutes over 59 are fine in MM:SS", parseTimecodeOffset("90:00"), { ok: true, frames: 135000 });
check("01:00:00:00 → 90000 frames", parseTimecodeOffset("01:00:00:00"), { ok: true, frames: 90000 });
check("00:00:10:24 → 274 (the last frame of a second)", parseTimecodeOffset("00:00:10:24"), { ok: true, frames: 274 });
check("frame 25 does not exist at 25fps → refused", parseTimecodeOffset("00:00:10:25").ok, false);
check("garbage / seconds over 59 / HH:MM:SS without frames → refused", ["abc", "10:75", "01:00:00", "1:2:3:4:5"].map((s) => parseTimecodeOffset(s).ok), [false, false, false, false]);
check("spaces around are ignored", parseTimecodeOffset("  23:30 "), { ok: true, frames: 35250 });

section("ms → the nearest frame, frames → timecode");
// the 8 pins on אסתטיטוקס reel 1 v2 (DB, 17–18.10): their ms and the frame each must land on
const real = [0, 1166, 4442, 10076, 19048, 20960, 22192];
check("pins of 17–18.10 → frames (round to nearest)", real.map(msToFrame), [0, 29, 111, 252, 476, 524, 555]);
check("frames → timecode", [0, 29, 111, 555, 90000, 274].map(framesToTimecode), ["00:00:00:00", "00:00:01:04", "00:00:04:11", "00:00:22:05", "01:00:00:00", "00:00:10:24"]);
check("exactly half a frame (20ms) rounds up", msToFrame(20), 1);

// ══════════════════════════════════════════════════════════════════════
section("buildMarkers — open comments of the version by default, 'all' on request");
const V2 = "v2-id";
const pin = (n: number, ms: number, open = true, version = V2): ExportComment => ({
  id: `p${n}`, kind: "pin", pin_number: n, time_ms: ms, body: `הערה ${n} & <טקסט>`, created_at: `2026-10-17T20:0${n % 10}:00Z`, open, state_label: "ממתין להחלטת הלקוח", version_id: version,
});
const comments: ExportComment[] = [
  pin(1, 4442), pin(2, 1166), pin(3, 22192, false), pin(4, 10076),
  { id: "g1", kind: "general", pin_number: null, time_ms: null, body: "כללית ראשונה", created_at: "2026-10-17T20:30:00Z", open: true, state_label: "", version_id: V2 },
  { id: "g2", kind: "general", pin_number: null, time_ms: null, body: "כללית שנייה", created_at: "2026-10-17T20:40:00Z", open: true, state_label: "", version_id: V2 },
  pin(9, 1000, true, "older-version"),
];
const base = { comments, versionId: V2, versionNumber: 2, fileName: "reel01 v1.mp4", formatDate: (s: string) => s.slice(0, 10) };
const open = buildMarkers({ ...base, scope: "open", offsetFrames: 0 });
check("open: general first (one marker at 0), then pins by time; the acked pin 3 and another version's pin 9 are out", open.map((m) => [m.kind, m.frame]), [["general", 0], ["pin", 29], ["pin", 111], ["pin", 252]]);
check("the general marker holds BOTH general comments", open[0].comment.split("\n").length === 2 && open[0].name === "הערות כלליות (2)", true);
const all = buildMarkers({ ...base, scope: "all", offsetFrames: 0 });
check("all: the acked pin 3 is in too", all.filter((m) => m.kind === "pin").map((m) => m.frame), [29, 111, 252, 555]);
const shifted = buildMarkers({ ...base, scope: "open", offsetFrames: 35250 });
check("offset 23:30 is added to EVERY marker (general included)", shifted.map((m) => m.frame), [35250, 35279, 35361, 35502]);
check("…and the timecode follows", shifted[1].timecode, "00:23:31:04");
ok("names: '#N text', no emoji (Premiere's font may not draw one)", open[1].name.startsWith("#2 ") && !/[\uD83C-\uDBFF][\uDC00-\uDFFF]/.test(open.map((m) => m.name).join("")));
ok("comment: the client's text + version · file · date · state", open[1].comment.startsWith("הערה 2") && open[1].comment.includes("v2 · reel01 v1.mp4") && open[1].comment.includes("ממתין להחלטת הלקוח"));
check("no comments → no markers", buildMarkers({ ...base, comments: [], scope: "open", offsetFrames: 0 }), []);
check("file name, ascii-safe", [markerFileName("740d206e-6b9c", "reel", 1, 2, "json"), markerFileName("740d206e-6b9c", "episode", null, 1, "xml")], ["bizi-markers-740d206e-reel1-v2.json", "bizi-markers-740d206e-episode-v1.xml"]);

// ══════════════════════════════════════════════════════════════════════
section("the JSON → the panel's own parser (premiere-plugin/bizi-markers/lib.js), round trip");
const file: BiziMarkerFile = {
  format: "bizi-markers", version: 1, fps: MARKER_FPS, production: "אסתטיטוקס", item: "ריל 1", version_number: 2, file_name: "reel01 v1.mp4",
  scope: "open", offset_frames: 0, offset_timecode: "00:00:00:00", generated_at: "2026-10-18T00:00:00Z", markers: open,
};
const parsed = panel.parseMarkerFile(JSON.stringify(file, null, 2));
ok("the panel accepts the drawer's file", parsed.ok, JSON.stringify(parsed));
if (parsed.ok) {
  check("same markers, seconds = frame / 25 (frame-exact)", parsed.file.markers.map((m) => [m.frame, m.seconds]), open.map((m) => [m.frame, m.frame / 25]));
  check("names and comments intact", parsed.file.markers.map((m) => m.name), open.map((m) => m.name));
}
check("not JSON → refused", panel.parseMarkerFile("<xml/>").ok, false);
check("another format → refused", panel.parseMarkerFile(JSON.stringify({ ...file, format: "x" })).ok, false);
check("a future version → refused (asks to update the panel)", panel.parseMarkerFile(JSON.stringify({ ...file, version: 2 })).ok, false);
check("not 25fps → refused", panel.parseMarkerFile(JSON.stringify({ ...file, fps: 30 })).ok, false);
check("a negative / fractional frame → refused", [panel.parseMarkerFile(JSON.stringify({ ...file, markers: [{ ...open[1], frame: -1 }] })).ok, panel.parseMarkerFile(JSON.stringify({ ...file, markers: [{ ...open[1], frame: 1.5 }] })).ok], [false, false]);
const pm = parsed.ok ? parsed.file.markers : [];
check("importing twice adds nothing the second time (same name, same frame)", panel.planMarkers(pm, pm.map((m) => ({ name: m.name, seconds: m.seconds }))), { add: [], skipped: pm.length });
check("a marker of the editor's own at the same time with another name is NOT a duplicate", panel.planMarkers(pm.slice(1, 2), [{ name: "my own", seconds: pm[1].seconds }]).add.length, 1);

// ══════════════════════════════════════════════════════════════════════
section("the FCP7 XML fallback");
const xml = buildFcp7Xml(file, "Bizi · אסתטיטוקס · ריל 1 · v2 · מרקרים");
ok("xmeml v4, one sequence, 25fps non-drop, timecode from 00:00:00:00", xml.includes('<xmeml version="4">') && (xml.match(/<sequence /g) ?? []).length === 1 && xml.includes("<timebase>25</timebase><ntsc>FALSE</ntsc>") && xml.includes("<string>00:00:00:00</string>"));
check("one <marker> per marker, in frames, out = -1", [(xml.match(/<marker>/g) ?? []).length, (xml.match(/<out>-1<\/out>/g) ?? []).length, /<in>111<\/in>/.test(xml)], [open.length, open.length, true]);
ok("text is XML-escaped (& < > in the client's text)", xml.includes("&amp; &lt;טקסט&gt;") && !/הערה 2 & </.test(xml));
const tagBalance = (t: string) => (xml.match(new RegExp(`<${t}[ >]`, "g")) ?? []).length === (xml.match(new RegExp(`</${t}>`, "g")) ?? []).length;
ok("tags balanced (sequence, media, video, audio, marker, name, comment, rate, timecode)", ["sequence", "media", "video", "audio", "marker", "name", "comment", "rate", "timecode"].every(tagBalance));
let xmllintOk = true;
try {
  execSync("xmllint --noout -", { input: xml.replace("<!DOCTYPE xmeml>\n", ""), stdio: ["pipe", "ignore", "pipe"] });
} catch {
  xmllintOk = false;
}
ok("well-formed per xmllint", xmllintOk);

// ══════════════════════════════════════════════════════════════════════
section("static: the route, the drawer, the panel, the package");
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const rt = strip(readFileSync(join(root, "src/app/api/productions/[id]/review-items/[itemId]/markers/route.ts"), "utf8"));
ok("route: can_edit_stages, like the rest of the review panel", /if \(!profile\?\.can_edit_stages\) return NextResponse\.json/.test(rt));
ok("route: a bad offset → 400 with the parser's sentence", /if \(!off\.ok\) return NextResponse\.json\(\{ error: off\.error \}, \{ status: 400 \}\)/.test(rt));
ok("route: read-only (no insert / update / delete / rpc)", !/\.(insert|update|delete|upsert|rpc)\(/.test(rt));
ok("route: a download (Content-Disposition attachment)", /"Content-Disposition": `attachment; filename=/.test(rt));
ok("route: the latest numbered version unless ?version=", /\.order\("number", \{ ascending: false \}\)/.test(rt));
const ctl = strip(readFileSync(join(root, "src/components/MarkerExportControls.tsx"), "utf8"));
ok("controls: every localStorage access inside try/catch", (ctl.match(/window\.localStorage\./g) ?? []).length === 2 && (ctl.match(/try \{\s*(const raw = )?window\.localStorage/g) ?? []).length === 2);
ok("controls: the same parser as the route validates the offset", /parseTimecodeOffset\(value\)/.test(ctl));
const dr = strip(readFileSync(join(root, "src/components/EntityDrawer.tsx"), "utf8"));
ok("drawer: the controls next to each item's comments, for stage editors only", /itemActions=\{\s*data\.canEditStages\s*\?\s*\(it\) => <MarkerExportControls/.test(dr));
const idx = readFileSync(join(root, "premiere-plugin/bizi-markers/index.js"), "utf8");
ok("panel: Adobe's pattern — lockedAccess → executeTransaction → createAddMarkerAction (COMMENT) at TickTime seconds", /project\.lockedAccess\(/.test(idx) && /project\.executeTransaction\(/.test(idx) && /createAddMarkerAction\(m\.name, ppro\.Marker\.MARKER_TYPE_COMMENT, ppro\.TickTime\.createWithSeconds\(m\.seconds\), ppro\.TickTime\.TIME_ZERO, m\.comment\)/.test(idx));
ok("panel: the OPEN sequence (getActiveSequence), one undo step", /getActiveSequence\(\)/.test(idx) && /`Bizi · \$\{add\.length\} מרקרים`/.test(idx));
const all3 = idx + readFileSync(join(root, "premiere-plugin/bizi-markers/lib.js"), "utf8") + readFileSync(join(root, "premiere-plugin/bizi-markers/index.html"), "utf8");
ok("panel: NO network — no fetch / XMLHttpRequest / WebSocket / http URL", !/\bfetch\(|XMLHttpRequest|WebSocket|https?:\/\//.test(all3.replace(/AdobeDocs\/uxp-premiere-pro-samples/g, "")));
const man = JSON.parse(readFileSync(join(root, "premiere-plugin/bizi-markers/manifest.json"), "utf8")) as { host: { app: string; minVersion: string }; requiredPermissions: Record<string, unknown>; manifestVersion: number; main: string; entrypoints: { id: string; type: string }[] };
check("manifest: v5, premierepro ≥ 25.6.0, panel 'biziMarkers', main index.html", [man.manifestVersion, man.host.app, man.host.minVersion, man.entrypoints[0].type, man.entrypoints[0].id, man.main], [5, "premierepro", "25.6.0", "panel", "biziMarkers", "index.html"]);
check("manifest: the ONLY permission is opening a local file (no network)", Object.keys(man.requiredPermissions), ["localFileSystem"]);
ok("panel: the entrypoint id in index.js matches the manifest", /panels: \{\s*biziMarkers:/.test(idx));
const ccx = join(root, "public/downloads/bizi-markers.ccx");
ok("the .ccx exists", existsSync(ccx));
if (existsSync(ccx)) {
  const list = execSync(`unzip -Z1 "${ccx}"`).toString().trim().split("\n").sort();
  check("the .ccx holds the panel, manifest at its root, nothing else", list, ["icons/", "icons/panel.svg", "icons/plugin.svg", "index.html", "index.js", "lib.js", "manifest.json"]);
  for (const f of ["manifest.json", "index.html", "index.js", "lib.js"]) {
    const inZip = execSync(`unzip -p "${ccx}" ${f}`).toString();
    check(`the .ccx is up to date: ${f} equals the source (rebuild: sh scripts/build_bizi_markers_ccx.sh)`, inZip === readFileSync(join(root, "premiere-plugin/bizi-markers", f), "utf8"), true);
  }
}

// ══════════════════════════════════════════════════════════════════════
section("the drawer controls — server render");
const html = renderToString(<MarkerExportControls productionId="740d206e" itemId="I1" hasComments />);
ok("the checkbox, unchecked by default, and the offset field disabled", html.includes("הסרט שלי מתחיל בטיימקוד:") && !/type="checkbox"[^>]*checked/.test(html) && /placeholder="00:00:00:00"[^>]*disabled/.test(html), html);
ok("'⬇ מרקרים ל-Premiere' → the JSON, default scope = open", html.includes("⬇ מרקרים ל-Premiere") && html.includes("/api/productions/740d206e/review-items/I1/markers?format=json&amp;scope=open"), html);
ok("XML fallback link, and the panel install link", html.includes("format=xml") && html.includes("/downloads/bizi-markers.ccx"), html);
const none = renderToString(<MarkerExportControls productionId="740d206e" itemId="I1" hasComments={false} />);
ok("no comments → the buttons are disabled (no href)", !none.includes("format=json"), none);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
