// 0122 (owner 22.10) - version views on the client page. PURE and client-safe.

/** the same link + version within this window is one view (a reload, a tab switch) */
export const VIEW_DEDUP_MS = 10 * 60 * 1000;

/** record a new view? (no earlier one, or the earlier one is older than the window) */
export function shouldRecordView(lastViewedAt: string | null | undefined, now: Date): boolean {
  if (!lastViewedAt) return true;
  const t = Date.parse(lastViewedAt);
  return !Number.isFinite(t) || now.getTime() - t >= VIEW_DEDUP_MS;
}

/** fire-and-forget from the page: never awaited by the UI, never shown on failure */
export function logVersionView(token: string, versionId: string): void {
  try {
    void fetch(`/api/r/${encodeURIComponent(token)}/view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version_id: versionId }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* a view that is not logged never touches the page */
  }
}
