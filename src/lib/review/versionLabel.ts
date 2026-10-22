// E13-4 — the drawer's word for a version's state (plan §9.2). Pure and
// client-safe: no server import, so the drawer and the tests share it.

export type VersionLabelInput = {
  source: "drive" | "bunny";
  status: "created" | "uploading" | "processing" | "playable" | "ready" | "failed" | null;
  integrity: "hash_match" | "size_match" | "mismatch" | "unchecked" | null;
  has_guid: boolean;
  /** owner 22.10: not ready an hour after it was sent (isStuck) */
  stuck?: boolean;
};

/** owner 22.10: a version not ready this long after it was sent is "stuck" (was 24 hours, for no-guid only) */
export const STUCK_ALERT_MS = 60 * 60 * 1000;

/** Not final, not failed, sent more than an hour ago. PURE. */
export function isStuck(v: { final: boolean; status: string | null; sent_at: string | null | undefined }, now: Date): boolean {
  if (v.final || v.status === "failed" || v.status === "ready" || !v.sent_at) return false;
  const t = Date.parse(v.sent_at);
  return Number.isFinite(t) && now.getTime() - t > STUCK_ALERT_MS;
}

export type VersionTone = "dim" | "busy" | "ok" | "bad";

export function versionLabel(v: VersionLabelInput): { text: string; tone: VersionTone } {
  if (v.source === "drive") return { text: "Drive (היסטוריה)", tone: "dim" };
  if (v.stuck && v.status !== "failed" && v.status !== "ready") return { text: "תקוע — מעל שעה", tone: "bad" };
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
