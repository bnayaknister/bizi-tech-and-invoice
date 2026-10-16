// E13-4 — the drawer's word for a version's state (plan §9.2). Pure and
// client-safe: no server import, so the drawer and the tests share it.

export type VersionLabelInput = {
  source: "drive" | "bunny";
  status: "created" | "uploading" | "processing" | "playable" | "ready" | "failed" | null;
  integrity: "hash_match" | "size_match" | "mismatch" | "unchecked" | null;
  has_guid: boolean;
};

export type VersionTone = "dim" | "busy" | "ok" | "bad";

export function versionLabel(v: VersionLabelInput): { text: string; tone: VersionTone } {
  if (v.source === "drive") return { text: "Drive (היסטוריה)", tone: "dim" };
  switch (v.status) {
    case "failed":
      return { text: "נכשל", tone: "bad" };
    case "ready":
      if (v.integrity === "hash_match" || v.integrity === "size_match") return { text: "מוכן ✓", tone: "ok" };
      if (v.integrity === "mismatch") return { text: "אי-התאמה", tone: "bad" };
      return { text: "בבדיקת שלמות", tone: "busy" };
    case "processing":
    case "playable":
      return { text: "בקידוד", tone: "busy" };
    case "created":
      return { text: "Bunny מושך", tone: "busy" };
    case "uploading":
      return { text: v.has_guid ? "Bunny מושך" : "נשלח", tone: "busy" };
    default:
      return { text: "—", tone: "dim" };
  }
}

/** The drawer polls every REFRESH_MS while any version it shows is not final. */
export const REFRESH_MS = 30_000;
