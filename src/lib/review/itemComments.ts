import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { CLIENT_VERSION_SELECT, isPlayableBunny, latestShownVersionId, type VersionForClient } from "@/lib/review/clientVersions";

// ═══════════════════════════════════════════════════════════════════════════
// E13-8b — a client's comment / pin / re-approval on ONE item (plan §9.2
// E13-8 (b)–(e); owner decisions 16.10 + 17.10). Server-side only.
// The writes themselves are 0118's two functions (one transaction each);
// this file decides what may be asked of them, and what the page shows.
// ═══════════════════════════════════════════════════════════════════════════

export const COMMENT_MAX = 2000;

export type ItemAction =
  | { action: "pin"; versionId: string; timeMs: number; body: string }
  | { action: "comment"; versionId: string | null; body: string }
  | { action: "approve"; versionId: string };

/** Pure: the request body → an action, or the Hebrew reason it is refused. */
export function parseItemAction(raw: unknown): { ok: true; value: ItemAction } | { ok: false; error: string } {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const vid = typeof b.version_id === "string" && /^[0-9a-f-]{36}$/i.test(b.version_id) ? b.version_id : null;
  const body = typeof b.body === "string" ? b.body.trim() : "";
  if (b.action === "approve") {
    if (!vid) return { ok: false, error: "חסרה גרסה לאישור" };
    return { ok: true, value: { action: "approve", versionId: vid } };
  }
  if (b.action !== "pin" && b.action !== "comment") return { ok: false, error: "פעולה לא מוכרת" };
  if (!body) return { ok: false, error: "כתבו את ההערה" };
  if (body.length > COMMENT_MAX) return { ok: false, error: `ההערה ארוכה מ-${COMMENT_MAX} תווים` };
  if (b.action === "pin") {
    const t = b.time_ms;
    if (!vid) return { ok: false, error: "חסרה גרסה לנעץ" };
    if (typeof t !== "number" || !Number.isInteger(t) || t < 0) return { ok: false, error: "זמן הנעץ אינו תקין" };
    return { ok: true, value: { action: "pin", versionId: vid, timeMs: t, body } };
  }
  return { ok: true, value: { action: "comment", versionId: vid, body } };
}

export type VersionWithDuration = VersionForClient & { duration_ms: number | null };

/**
 * Pure: may this action be asked about this item, given its versions?
 * "Respond on the latest version only" (owner 16.10, §4b (2)) is enforced HERE
 * as well as in the page: the version must be the one the client is shown as
 * current. A pin needs that version to be a playable Bunny version, and its
 * time inside the file (1s of slack for the last frame).
 */
export function checkAgainstVersions(action: ItemAction, rows: VersionWithDuration[]): { ok: true } | { ok: false; status: number; error: string } {
  const latest = latestShownVersionId(rows);
  const stale = { ok: false as const, status: 409, error: "יש גרסה חדשה יותר. רעננו את הדף" };
  if (action.action === "comment") {
    if (action.versionId === null) return latest === null ? { ok: true } : stale; // only an item with no version at all
    return action.versionId === latest ? { ok: true } : stale;
  }
  if (action.versionId !== latest) return stale;
  if (action.action === "pin") {
    const v = rows.find((r) => r.id === action.versionId);
    if (!v || !isPlayableBunny(v)) return { ok: false, status: 400, error: "בגרסה הזו אין הערה בנקודת זמן" };
    if (v.duration_ms !== null && action.timeMs > v.duration_ms + 1000) return { ok: false, status: 400, error: "זמן הנעץ אחרי סוף הקובץ" };
  }
  return { ok: true };
}

/** Pure: 0118 raises with a Hebrew message; the client gets a status and a sentence it can read. */
export function mapRpcError(message: string): { status: number; error: string } {
  if (message.includes("כבר מאושר")) return { status: 409, error: "הפריט כבר מאושר" };
  if (message.includes("אין אישור שבוטל בהערה") || message.includes("הביטול לא נעשה מהקישור הזה"))
    return { status: 409, error: "אפשר לאשר שוב רק פריט שהאישור שלו בוטל בהערה מהקישור הזה" };
  if (message.includes("ההפקה בוטלה")) return { status: 410, error: "ההפקה אינה פעילה" };
  if (message.includes("נעץ רק על גרסת Bunny")) return { status: 400, error: "בגרסה הזו אין הערה בנקודת זמן" };
  if (message.includes("ריק או ארוך")) return { status: 400, error: "ההערה ריקה או ארוכה מדי" };
  return { status: 500, error: "השמירה נכשלה. נסו שוב בעוד רגע" };
}

// ── what the page shows ────────────────────────────────────────────────────

export type ClientComment = {
  id: string;
  version_id: string | null;
  kind: "pin" | "general";
  pin_number: number | null;
  time_ms: number | null;
  body: string;
  created_at: string;
};

export type ApprovalRow = { decision: string; decided_at: string; created_at: string; id: string; revoked_at: string | null; revoked_reason: string | null };
export type CommentRow = { link_id: string | null; author_kind: string; created_at: string };

/**
 * Pure: the "✓ מאשר שוב" button — the same rule review_item_reapprove
 * enforces (decision 2): the item is pending, its LAST ledger row is an
 * approval revoked by a client comment, and a client comment from THIS link
 * came at or after that revoke.
 */
export function canReapprove(itemApproved: boolean, approvals: ApprovalRow[], comments: CommentRow[], linkId: string): boolean {
  if (itemApproved || !approvals.length) return false;
  const last = [...approvals].sort((a, b) => b.decided_at.localeCompare(a.decided_at) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
  if (last.decision !== "approved" || last.revoked_reason !== "client_comment" || !last.revoked_at) return false;
  const since = Date.parse(last.revoked_at) - 1000;
  return comments.some((c) => c.link_id === linkId && c.author_kind === "client" && Date.parse(c.created_at) >= since);
}

/** "00:42", "1:02:03" — what the client reads; the stored value stays in ms. */
export function formatPinTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/**
 * The client's own comments per item (not the backfill history — that lives in
 * the drawer), and which items may be re-approved from this link. One read per
 * table. Throws on a read error; the page catches it (rule 38).
 */
export async function loadClientComments(
  admin: SupabaseClient<Database>,
  items: { id: string; approved: boolean }[],
  linkId: string
): Promise<{ comments: Record<string, ClientComment[]>; reapprovable: Record<string, boolean>; currentVersion: Record<string, string | null> }> {
  const ids = items.map((i) => i.id);
  if (!ids.length) return { comments: {}, reapprovable: {}, currentVersion: {} };
  const { data: cRows, error: cErr } = await admin
    .from("client_review_comments")
    .select("id,item_id,version_id,link_id,kind,pin_number,time_ms,body,author_kind,created_at,is_backfill")
    .in("item_id", ids)
    .eq("is_backfill", false)
    .eq("author_kind", "client")
    .order("created_at");
  if (cErr) throw new Error(`client_review_comments: ${cErr.message}`);
  const { data: aRows, error: aErr } = await admin
    .from("client_review_approvals")
    .select("id,item_id,decision,decided_at,created_at,revoked_at,revoked_reason")
    .in("item_id", ids);
  if (aErr) throw new Error(`client_review_approvals: ${aErr.message}`);
  const { data: vRows, error: vErr } = await admin.from("client_review_versions").select(CLIENT_VERSION_SELECT).in("item_id", ids);
  if (vErr) throw new Error(`client_review_versions: ${vErr.message}`);
  // the version a comment / re-approval is about — the same answer the route
  // checks against (a Drive history row when nothing reached Bunny)
  const currentVersion: Record<string, string | null> = {};
  for (const id of ids) currentVersion[id] = latestShownVersionId(((vRows ?? []) as VersionForClient[]).filter((v) => v.item_id === id));

  const comments: Record<string, ClientComment[]> = {};
  for (const r of cRows ?? []) {
    (comments[r.item_id] ??= []).push({
      id: r.id,
      version_id: r.version_id,
      kind: r.kind === "pin" ? "pin" : "general",
      pin_number: r.pin_number,
      time_ms: r.time_ms,
      body: r.body,
      created_at: r.created_at,
    });
  }
  const reapprovable: Record<string, boolean> = {};
  for (const it of items) {
    const ok = canReapprove(
      it.approved,
      (aRows ?? []).filter((a) => a.item_id === it.id),
      (cRows ?? []).filter((c) => c.item_id === it.id),
      linkId
    );
    if (ok) reapprovable[it.id] = true;
  }
  return { comments, reapprovable, currentVersion };
}
