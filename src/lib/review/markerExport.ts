// ═══════════════════════════════════════════════════════════════════════════
// E13-11 — the client's pins → Premiere Pro markers (plan §9.2 E13-11; owner
// decisions 18.10). PURE: no I/O, safe in the browser (the drawer validates
// the offset field with the same parser the route uses).
//
//   · 25fps, always. The editor's timeline starts at 00:00:00:00 like the file
//     it renders, so a pin's time IS the marker's position — unless the editor
//     ticks "הסרט שלי מתחיל בטיימקוד:" and types an offset (MM:SS or
//     HH:MM:SS:FF), which is added to every pin.
//   · a pin lands on the NEAREST frame (time_ms is exact to the millisecond;
//     a marker can only sit on a frame).
//   · default: the OPEN comments of the LATEST version; "all" = every comment
//     of that version, acked ones too.
//   · general comments (no time) → ONE marker at the start (+ offset) holding
//     all of their text, so nothing is lost (owner 18.10).
//
// Two files from one list: the JSON the "Bizi · מרקרים" UXP panel reads
// (premiere-plugin/bizi-markers), and an FCP7 XML fallback for File › Import
// (markers land on a NEW sequence there — Adobe's own import behaviour).
// ═══════════════════════════════════════════════════════════════════════════

export const MARKER_FPS = 25;
export const MARKER_FILE_FORMAT = "bizi-markers";
export const MARKER_FILE_VERSION = 1;

/** "23:30" (MM:SS, minutes may exceed 59) or "01:00:00:00" (HH:MM:SS:FF @25) → frames. Empty → 0. */
export function parseTimecodeOffset(input: string): { ok: true; frames: number } | { ok: false; error: string } {
  const s = input.trim();
  if (!s) return { ok: true, frames: 0 };
  let m = /^(\d{1,3}):([0-5]\d)$/.exec(s);
  if (m) return { ok: true, frames: (Number(m[1]) * 60 + Number(m[2])) * MARKER_FPS };
  m = /^(\d{1,2}):([0-5]\d):([0-5]\d):(\d{2})$/.exec(s);
  if (m) {
    const ff = Number(m[4]);
    if (ff >= MARKER_FPS) return { ok: false, error: `פריים ${ff} לא קיים ב-25fps (00 עד 24)` };
    return { ok: true, frames: ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * MARKER_FPS + ff };
  }
  return { ok: false, error: "טיימקוד לא תקין. כתבו MM:SS (למשל 23:30) או HH:MM:SS:FF (למשל 01:00:00:00)" };
}

/** ms → the nearest frame at 25fps. */
export const msToFrame = (ms: number) => Math.max(0, Math.round((ms * MARKER_FPS) / 1000));

/** frames → "HH:MM:SS:FF" at 25fps. */
export function framesToTimecode(frames: number): string {
  const f = Math.max(0, Math.round(frames));
  const two = (n: number) => String(n).padStart(2, "0");
  const ff = f % MARKER_FPS;
  const totalS = Math.floor(f / MARKER_FPS);
  return `${two(Math.floor(totalS / 3600))}:${two(Math.floor((totalS % 3600) / 60))}:${two(totalS % 60)}:${two(ff)}`;
}

export type ExportComment = {
  id: string;
  kind: string;
  pin_number: number | null;
  time_ms: number | null;
  body: string;
  created_at: string;
  open: boolean;
  state_label: string;
  version_id: string | null;
};

export type BiziMarker = { frame: number; seconds: number; timecode: string; name: string; comment: string; kind: "pin" | "general" };

export type BiziMarkerFile = {
  format: typeof MARKER_FILE_FORMAT;
  version: typeof MARKER_FILE_VERSION;
  fps: typeof MARKER_FPS;
  production: string;
  item: string;
  version_number: number | null;
  file_name: string | null;
  scope: "open" | "all";
  offset_frames: number;
  offset_timecode: string;
  generated_at: string;
  markers: BiziMarker[];
};

const excerpt = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/**
 * Pure: the markers of one version. Pins by time; the general comments as one
 * marker at the start. Marker names carry no emoji — Premiere's timeline font
 * is not guaranteed to draw one.
 */
export function buildMarkers(input: {
  comments: ExportComment[];
  versionId: string;
  scope: "open" | "all";
  offsetFrames: number;
  versionNumber: number | null;
  fileName: string | null;
  formatDate: (iso: string) => string;
}): BiziMarker[] {
  const mine = input.comments.filter((c) => c.version_id === input.versionId && (input.scope === "all" || c.open));
  const vTag = [input.versionNumber !== null ? `v${input.versionNumber}` : null, input.fileName].filter(Boolean).join(" · ");
  const at = (frame: number) => ({ frame, seconds: frame / MARKER_FPS, timecode: framesToTimecode(frame) });
  const pins = mine
    .filter((c) => c.kind === "pin" && c.time_ms !== null)
    .sort((a, b) => (a.time_ms ?? 0) - (b.time_ms ?? 0))
    .map<BiziMarker>((c) => ({
      ...at(msToFrame(c.time_ms ?? 0) + input.offsetFrames),
      kind: "pin",
      name: `#${c.pin_number ?? "?"} ${excerpt(c.body, 48)}`,
      comment: [c.body.trim(), `— ${[vTag, input.formatDate(c.created_at), c.state_label].filter(Boolean).join(" · ")}`].join("\n"),
    }));
  const general = mine.filter((c) => c.kind !== "pin").sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (general.length) {
    pins.unshift({
      ...at(input.offsetFrames),
      kind: "general",
      name: `הערות כלליות (${general.length})`,
      comment: general.map((c) => `• ${c.body.trim()} — ${input.formatDate(c.created_at)}`).join("\n"),
    });
  }
  return pins;
}

/** Ascii-safe file name: "bizi-markers-740d206e-reel1-v2.json" */
export function markerFileName(productionId: string, itemKind: string, reelIndex: number | null, versionNumber: number | null, ext: "json" | "xml"): string {
  const item = itemKind === "episode" ? "episode" : `reel${reelIndex ?? ""}`;
  return `bizi-markers-${productionId.slice(0, 8)}-${item}${versionNumber !== null ? `-v${versionNumber}` : ""}.${ext}`;
}

const xmlEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * The FCP7 XML fallback (xmeml v4): one sequence at 25fps, timecode starting
 * at 00:00:00:00, its markers in frames, out = -1 (a point, not a range).
 * Premiere's File › Import makes a bin with this sequence (Adobe: "sequence
 * markers" are preserved); it does NOT add markers to an existing sequence.
 */
export function buildFcp7Xml(file: BiziMarkerFile, sequenceName: string): string {
  const last = file.markers.reduce((m, x) => Math.max(m, x.frame), 0);
  const duration = last + MARKER_FPS * 10;
  const rate = "<rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>";
  const markers = file.markers
    .map((m) => `      <marker>\n        <name>${xmlEsc(m.name)}</name>\n        <comment>${xmlEsc(m.comment)}</comment>\n        <in>${m.frame}</in>\n        <out>-1</out>\n      </marker>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="bizi-markers">
    <name>${xmlEsc(sequenceName)}</name>
    <duration>${duration}</duration>
    ${rate}
    <timecode>
      ${rate}
      <string>00:00:00:00</string>
      <frame>0</frame>
      <displayformat>NDF</displayformat>
    </timecode>
    <media>
      <video>
        <format><samplecharacteristics>${rate}<width>1920</width><height>1080</height></samplecharacteristics></format>
        <track></track>
      </video>
      <audio>
        <track></track>
      </audio>
    </media>
${markers}
  </sequence>
</xmeml>
`;
}
