// E13-6 — is the version's Drive file still downloadable, checked the way the
// CLIENT will get it (owner 17.10, after the device test). Server-side only.
//
// NOT files.get: the service account reads BIZI PODCLUB through its own Viewer
// grant, so files.get succeeds on a file that is no longer shared "anyone with
// the link" — and the client, who has no Google account here, would still land
// on Google's sign-in page. The probe is the client's own request instead: an
// anonymous GET of the direct-download address with Range: bytes=0-0 and no
// redirect following. One byte, no credentials, nothing to leak.
//
// What Drive answers (measured 17.10): a shared file → 206 with the media type;
// an id that does not exist (deleted / trashed) → 404 text/html. A file that
// is not shared → 403, or a redirect to accounts.google.com.
//
// THE RULE (owner 17.10): only a CLEAR "gone" refuses the download. Anything
// else — timeout, network, 5xx, 429, an HTML page we do not recognise — is
// "unknown", and the route goes on to Drive exactly as before the check.

import { driveDownloadUrl } from "@/lib/review/clientVersions";

export const DRIVE_PROBE_TIMEOUT_MS = 4000;

export type DriveAvailability =
  | { state: "ok" }
  | { state: "unavailable"; reason: "missing" | "not_shared"; httpStatus: number }
  | { state: "unknown"; detail: string };

/** Pure: one response's status / content-type / location → the verdict. */
export function classifyDriveProbe(status: number, contentType: string | null, location: string | null): DriveAvailability {
  const html = (contentType ?? "").toLowerCase().startsWith("text/html");
  if ((status === 200 || status === 206) && !html) return { state: "ok" };
  if (status === 404 || status === 410) return { state: "unavailable", reason: "missing", httpStatus: status };
  if (status === 401 || status === 403) return { state: "unavailable", reason: "not_shared", httpStatus: status };
  if (status >= 300 && status < 400 && location) {
    let host = "";
    try {
      host = new URL(location, "https://drive.usercontent.google.com").hostname;
    } catch {
      /* unparseable → unknown below */
    }
    if (host === "accounts.google.com") return { state: "unavailable", reason: "not_shared", httpStatus: status };
  }
  return { state: "unknown", detail: `HTTP ${status}${html ? " html" : ""}` };
}

/** The anonymous one-byte probe. Never throws: a failure to check is "unknown". */
export async function probeDriveDownload(
  fileId: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<DriveAvailability> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(driveDownloadUrl(fileId), {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs ?? DRIVE_PROBE_TIMEOUT_MS),
    });
    const verdict = classifyDriveProbe(res.status, res.headers.get("content-type"), res.headers.get("location"));
    await res.body?.cancel().catch(() => {});
    return verdict;
  } catch (e) {
    return { state: "unknown", detail: e instanceof Error ? e.name : "error" };
  }
}

/** The page the client sees when the Drive file is gone. No technical detail. */
export function unavailablePage(backHref: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>הקובץ לא זמין</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0f0c1d; color: #ece9fb; font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif; padding: 16px; box-sizing: border-box; }
  .card { max-width: 420px; width: 100%; text-align: center; border: 1px solid rgba(255,255,255,0.14); border-radius: 16px; padding: 28px 20px; background: rgba(255,255,255,0.03); }
  h1 { font-size: 18px; margin: 0 0 10px; }
  p { font-size: 14px; color: #c9c3e8; margin: 0 0 20px; line-height: 1.6; }
  a { display: inline-block; border: 1px solid rgba(167,139,250,0.55); background: rgba(167,139,250,0.10); color: #ddd6fe; border-radius: 12px; padding: 10px 18px; font-size: 14px; font-weight: 700; text-decoration: none; }
</style>
</head>
<body>
<div class="card">
  <h1>הקובץ לא זמין כרגע להורדה</h1>
  <p>הצוות קיבל הודעה ויחזור אליכם.</p>
  <a href="${backHref}">חזרה לדף</a>
</div>
</body>
</html>`;
}
