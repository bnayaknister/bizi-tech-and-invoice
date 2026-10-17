// Bizi · מרקרים — the panel's pure logic (no Premiere, no UXP, no network).
// Kept apart from index.js so scripts/test_e13_11_markers.ts can run it
// offline. The file it reads is made by the drawer's "⬇ מרקרים ל-Premiere"
// (src/lib/review/markerExport.ts): format "bizi-markers", version 1, 25fps,
// every marker already on its frame with the editor's offset applied.

const FORMAT = "bizi-markers";
const VERSION = 1;

/** text → { ok, file } | { ok: false, error } — every field checked, nothing trusted. */
function parseMarkerFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: "הקובץ אינו JSON תקין. הורידו אותו שוב מ-Bizi." };
  }
  if (!data || data.format !== FORMAT) return { ok: false, error: "זה לא קובץ מרקרים של Bizi." };
  if (data.version !== VERSION) return { ok: false, error: `גרסת קובץ ${data.version} לא נתמכת בפאנל הזה. עדכנו את הפאנל.` };
  if (data.fps !== 25) return { ok: false, error: "הקובץ אינו ב-25fps." };
  if (!Array.isArray(data.markers)) return { ok: false, error: "בקובץ אין רשימת מרקרים." };
  const markers = [];
  for (const m of data.markers) {
    if (!m || !Number.isInteger(m.frame) || m.frame < 0 || typeof m.name !== "string" || typeof m.comment !== "string") {
      return { ok: false, error: "מרקר לא תקין בקובץ. הורידו אותו שוב מ-Bizi." };
    }
    markers.push({ frame: m.frame, seconds: m.frame / 25, name: m.name.slice(0, 200), comment: m.comment.slice(0, 4000) });
  }
  return {
    ok: true,
    file: {
      production: String(data.production || ""),
      item: String(data.item || ""),
      versionNumber: data.version_number == null ? null : data.version_number,
      offsetTimecode: String(data.offset_timecode || "00:00:00:00"),
      markers,
    },
  };
}

/**
 * Which markers to add: a marker already on the sequence with the SAME name
 * at the SAME frame (±half a frame) is skipped, so importing the same file
 * twice never doubles anything. existing: [{ name, seconds }].
 */
function planMarkers(markers, existing) {
  const half = 0.5 / 25;
  const add = [];
  let skipped = 0;
  for (const m of markers) {
    const dup = existing.some((e) => e.name === m.name && Math.abs(e.seconds - m.seconds) < half);
    if (dup) skipped++;
    else add.push(m);
  }
  return { add, skipped };
}

module.exports = { parseMarkerFile, planMarkers, FORMAT, VERSION };
