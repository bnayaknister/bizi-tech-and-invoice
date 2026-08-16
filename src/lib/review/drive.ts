// Classify a pasted Google Drive URL for the public review page (item-based
// review spec §3, phase 0). Only a FILE link can host Drive's embedded player,
// and only via the /preview path — /view refuses iframes. Folder links (some
// live reels_link values are folders) and anything unrecognised keep today's
// plain "▶ צפייה" button behaviour.
//
// media_link stays a single canonical URL everywhere; the file-ID is derived
// here at read time, never stored — so when Google Picker replaces hand-pasting
// it fills the same field and this classifier keeps working unchanged.

export type DriveMedia =
  | { type: "file"; embedUrl: string; url: string }
  | { type: "folder"; url: string }
  | { type: "unknown"; url: string };

export function classifyDriveLink(url: string): DriveMedia {
  const file = url.match(/drive\.google\.com\/file\/d\/([\w-]+)/);
  if (file) {
    return { type: "file", embedUrl: `https://drive.google.com/file/d/${file[1]}/preview`, url };
  }
  // open?id= / uc?id= are legacy file-link shapes Drive still hands out
  const byId = url.match(/drive\.google\.com\/(?:open|uc)\?[^#]*\bid=([\w-]+)/);
  if (byId) {
    return { type: "file", embedUrl: `https://drive.google.com/file/d/${byId[1]}/preview`, url };
  }
  if (/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?)?folders\//.test(url)) {
    return { type: "folder", url };
  }
  return { type: "unknown", url };
}
