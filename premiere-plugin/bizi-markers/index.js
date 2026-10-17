// Bizi · מרקרים — UXP panel for Premiere Pro 25.6+ (E13-11, owner 18.10).
// Reads a LOCAL file only: no network, no login, no token. The editor picks
// the file the Bizi drawer downloaded, and the panel adds its markers to the
// OPEN sequence, in one undoable step (Cmd+Z / Ctrl+Z).
//
// The Premiere calls follow Adobe's own sample
// (AdobeDocs/uxp-premiere-pro-samples, sample-panels/premiere-api/src/markers.ts):
// Project.getActiveProject → getActiveSequence → Markers.getMarkers(sequence)
// → project.lockedAccess(() => project.executeTransaction(compound =>
//   compound.addAction(markers.createAddMarkerAction(...)), undoName)).

const ppro = require("premierepro");
const uxp = require("uxp");
const { parseMarkerFile, planMarkers } = require("./lib.js");

const $ = (id) => document.getElementById(id);

function show(text, tone) {
  const el = $("status");
  el.textContent = text;
  el.className = tone || "";
}

async function importFile() {
  const btn = $("pick");
  btn.disabled = true;
  try {
    const file = await uxp.storage.localFileSystem.getFileForOpening({ types: ["json"] });
    if (!file) return show("לא נבחר קובץ.", "");
    const text = await file.read();
    const parsed = parseMarkerFile(text);
    if (!parsed.ok) return show(parsed.error, "err");
    const f = parsed.file;
    if (!f.markers.length) return show("בקובץ אין מרקרים (אין הערות פתוחות בגרסה הזו).", "warn");

    const project = await ppro.Project.getActiveProject();
    if (!project) return show("אין פרויקט פתוח ב-Premiere.", "err");
    const sequence = await project.getActiveSequence();
    if (!sequence) return show("פתחו את הרצף בטיימליין, ואז בחרו את הקובץ שוב.", "err");

    const owner = await ppro.Markers.getMarkers(sequence);
    const existing = owner.getMarkers().map((m) => ({ name: m.getName(), seconds: m.getStart().seconds }));
    const { add, skipped } = planMarkers(f.markers, existing);
    if (!add.length) return show(`כל ${skipped} המרקרים כבר ברצף. לא נוסף דבר.`, "warn");

    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction((compound) => {
        for (const m of add) {
          compound.addAction(
            owner.createAddMarkerAction(m.name, ppro.Marker.MARKER_TYPE_COMMENT, ppro.TickTime.createWithSeconds(m.seconds), ppro.TickTime.TIME_ZERO, m.comment)
          );
        }
      }, `Bizi · ${add.length} מרקרים`);
    });
    if (!ok) return show("Premiere לא הוסיף את המרקרים. נסו שוב, או השתמשו ב-XML (גיבוי).", "err");

    const seqName = sequence.name || "הרצף";
    const where = [f.production, f.item, f.versionNumber != null ? `v${f.versionNumber}` : null].filter(Boolean).join(" · ");
    show(
      `נוספו ${add.length} מרקרים לרצף "${seqName}"${skipped ? ` (${skipped} כבר היו)` : ""}.\n${where}${f.offsetTimecode !== "00:00:00:00" ? ` · היסט ${f.offsetTimecode}` : ""}\nלביטול: Cmd+Z / Ctrl+Z`,
      "ok"
    );
  } catch (e) {
    show(`שגיאה: ${e && e.message ? e.message : String(e)}`, "err");
  } finally {
    btn.disabled = false;
  }
}

uxp.entrypoints.setup({
  panels: {
    biziMarkers: {
      show() {
        const btn = $("pick");
        if (btn && !btn.dataset.wired) {
          btn.dataset.wired = "1";
          btn.addEventListener("click", importFile);
        }
      },
    },
  },
});

// also wire at load: some hosts call show() before the DOM is ready, some after
document.addEventListener("DOMContentLoaded", () => {
  const btn = $("pick");
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = "1";
    btn.addEventListener("click", importFile);
  }
});
