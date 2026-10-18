import { classifyDriveLink } from "@/lib/review/drive";

// ═══════════════════════════════════════════════════════════════════════════
// One link per deliverable in the drawer (owner 18.10). Until now a technician
// saw two fields — the item's old link (client_review_items.media_link, 0057)
// and "גרסאות לביקורת" (E13-4) — and could set them to different files.
//   · "שלח לביקורת" now ALSO writes the item's old link: the Drive file of
//     the version just sent (driveFileViewUrl).
//   · an item with a Bunny version shows the old link read-only, with
//     AUTO_LINK_NOTE; the PATCH route refuses to change it (409).
//   · an item with no Bunny version keeps the old link editable, as today.
//   · a FOLDER link pasted into "שלח לביקורת" is refused with FOLDER_LINK_ERROR.
// Client-safe (no server imports): the drawer and the routes share it.
// ═══════════════════════════════════════════════════════════════════════════

export const FOLDER_LINK_ERROR = "זה קישור לתיקייה. פתח את הקובץ ב-Drive והעתק את הקישור שלו";
export const AUTO_LINK_NOTE = "עודכן אוטומטית מהגרסה האחרונה";
export const LINK_LOCKED_ERROR = `${AUTO_LINK_NOTE}. כדי להחליף את הקובץ, שלחו גרסה חדשה בתיבה "גרסאות לביקורת"`;

/** A Drive FOLDER link (drive/folders/…, drive/u/N/folders/…). */
export const isDriveFolderLink = (url: string) => classifyDriveLink(url.trim()).type === "folder";

/** The canonical file link the old field holds — the same shape a technician pastes. */
export const driveFileViewUrl = (fileId: string) => `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;

/**
 * Does this item have a Bunny version that counts? Any Bunny version not
 * 'failed' — sending, processing, ready or archived. A failed send leaves the
 * old field editable, so a technician is never locked out by an error.
 * Accepts both the DB row (bunny_status) and the drawer's PanelVersion (status).
 */
export function hasLiveBunnyVersion(rows: { source: string; status?: string | null; bunny_status?: string | null }[]): boolean {
  return rows.some((r) => r.source === "bunny" && (r.status ?? r.bunny_status ?? null) !== "failed");
}
