import { displayDateTime } from "@/lib/dates";
import { openOfLatest, type CommentState } from "@/lib/review/commentHistory";

// E13-8c — the client's comments, ALL of them (owner 17.10): every item,
// every version, every round. Open ones stand out; handled ones are dimmed —
// never hidden. E13-9 (owner 18.10): "handled" = "טופל". An acked ("קיבלתי")
// comment is still open work: full strength, only the "חדשה" accent goes.
// The drawer and the window pass onResolve → a "טופל" / "בטל טופל" button per
// comment; the PDF page passes nothing and shows the marks only. One component for the drawer, the
// "💬 הערות הלקוח" window and its PDF page, so the three never disagree.
// No hooks: it renders on the server (the print page) and in the browser.

export type HistoryCommentView = {
  id: string;
  version_id?: string | null;
  kind: string;
  pin_number: number | null;
  time_ms: number | null;
  body: string;
  created_at: string;
  version_number: number | null;
  version_file: string | null;
  state: CommentState;
  state_label: string;
  open: boolean;
  /** not acked, not resolved (optional: older payloads omit it → read as open) */
  unread?: boolean;
  acked_at: string | null;
  acked_by_name: string | null;
  resolved_at?: string | null;
  resolved_by_name?: string | null;
  is_backfill: boolean;
};
export type HistoryItemView = { id: string; label: string; approved: boolean; latest_version_id?: string | null; comments: HistoryCommentView[] };

/** 00:42.180 / 1:02:03.004 — exact, as E13-11 will export it. */
export function formatPinTimeExact(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  const h = Math.floor(v / 3_600_000);
  const m = Math.floor((v % 3_600_000) / 60_000);
  const s = Math.floor((v % 60_000) / 1000);
  const milli = v % 1000;
  const two = (n: number) => String(n).padStart(2, "0");
  const base = `${two(m)}:${two(s)}.${String(milli).padStart(3, "0")}`;
  return h ? `${h}:${base}` : base;
}

const STATE_TONE: Record<CommentState, { bg: string; fg: string }> = {
  pending_decision: { bg: "rgba(148,163,184,0.18)", fg: "#94a3b8" },
  minor: { bg: "rgba(251,146,60,0.18)", fg: "#ea580c" },
  revisions: { bg: "rgba(251,191,36,0.16)", fg: "#d97706" },
  revoked_approval: { bg: "rgba(251,113,133,0.16)", fg: "#e11d48" },
  after_response: { bg: "rgba(96,165,250,0.16)", fg: "#3b82f6" },
  history: { bg: "rgba(148,163,184,0.12)", fg: "#94a3b8" },
};

export default function ClientCommentHistory({
  items,
  emptyText = "אין הערות מהלקוח.",
  itemActions,
  onResolve,
  busyId = null,
  onResolveAll,
  busyItemId = null,
}: {
  items: HistoryItemView[];
  emptyText?: string;
  /** E13-11: per item, under its header — the drawer's "⬇ מרקרים ל-Premiere" (never in the client's window / PDF) */
  itemActions?: (item: HistoryItemView) => React.ReactNode;
  /** E13-9: mark / unmark "טופל" on one comment. Absent → no buttons (the PDF page) */
  onResolve?: (commentId: string, resolved: boolean) => void;
  /** the comment whose mark is being saved — its button is disabled */
  busyId?: string | null;
  /** E13-9 "✓ סמן הכול כטופל": the open comments of the item's latest version. Absent → no button */
  onResolveAll?: (itemId: string, commentIds: string[]) => void;
  busyItemId?: string | null;
}) {
  const withComments = items.filter((i) => i.comments.length);
  if (!withComments.length) return <div style={{ fontSize: 13, opacity: 0.7 }}>{emptyText}</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {withComments.map((it) => {
        const open = it.comments.filter((c) => c.open).length;
        const latestOpen = openOfLatest(it);
        return (
          <section key={it.id}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6, fontWeight: 700, fontSize: 14 }}>
              <span>{it.label}</span>
              <span style={{ fontSize: 12, fontWeight: 400, opacity: 0.75 }}>
                {it.comments.length} הערות{open ? ` · ${open} לא טופלו` : ""} · {it.approved ? "מאושר ✓" : "ממתין"}
              </span>
              {onResolveAll && latestOpen.length > 0 && (
                <button
                  type="button"
                  data-resolve-all={it.id}
                  onClick={() => onResolveAll(it.id, latestOpen)}
                  disabled={busyItemId === it.id}
                  style={{
                    marginInlineStart: "auto",
                    border: "1px solid rgba(22,163,74,0.5)",
                    borderRadius: 8,
                    padding: "1px 8px",
                    fontSize: 12,
                    fontWeight: 700,
                    background: "transparent",
                    color: "#16a34a",
                    cursor: busyItemId === it.id ? "wait" : "pointer",
                    opacity: busyItemId === it.id ? 0.5 : 1,
                  }}
                >
                  {busyItemId === it.id ? "שומר…" : "✓ סמן הכול כטופל"}
                </button>
              )}
            </div>
            {itemActions?.(it)}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {it.comments.map((c) => {
                const tone = STATE_TONE[c.state];
                const unread = c.unread ?? c.open;
                return (
                  <div
                    key={c.id}
                    data-open={c.open ? "1" : "0"}
                    data-unread={unread ? "1" : "0"}
                    style={{
                      border: unread ? "1px solid rgba(139,92,246,0.55)" : "1px solid rgba(127,127,127,0.25)",
                      borderRadius: 10,
                      padding: "8px 10px",
                      opacity: c.open ? 1 : 0.55,
                      breakInside: "avoid",
                    }}
                  >
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 4 }}>
                      <span style={{ fontWeight: 700 }}>
                        {c.kind === "pin" && c.time_ms !== null ? (
                          <>
                            📍{c.pin_number ?? ""} · <span dir="ltr">{formatPinTimeExact(c.time_ms)}</span>
                          </>
                        ) : (
                          "כללית"
                        )}
                      </span>
                      <span title={c.version_file ?? undefined} style={{ opacity: 0.8 }}>
                        {c.version_number !== null ? `v${c.version_number}` : "בלי גרסה"}
                      </span>
                      <span style={{ opacity: 0.7 }}>{displayDateTime(c.created_at) ?? ""}</span>
                      <span style={{ background: tone.bg, color: tone.fg, borderRadius: 999, padding: "1px 8px", fontWeight: 700 }}>{c.state_label}</span>
                      {c.is_backfill && <span style={{ opacity: 0.7 }}>היסטוריה</span>}
                      {unread && c.open && <span style={{ color: "#8b5cf6", fontWeight: 700 }}>חדשה</span>}
                      {c.acked_at && (
                        <span style={{ opacity: 0.85 }}>
                          ✓ קיבלתי{c.acked_by_name ? ` · ${c.acked_by_name}` : ""} · {displayDateTime(c.acked_at) ?? ""}
                        </span>
                      )}
                      {c.resolved_at && (
                        <span style={{ color: "#16a34a", fontWeight: 700 }}>
                          ✓ טופל{c.resolved_by_name ? ` · ${c.resolved_by_name}` : ""} · {displayDateTime(c.resolved_at) ?? ""}
                        </span>
                      )}
                      {onResolve && (
                        <button
                          type="button"
                          onClick={() => onResolve(c.id, !c.resolved_at)}
                          disabled={busyId === c.id}
                          style={{
                            marginInlineStart: "auto",
                            border: "1px solid rgba(127,127,127,0.4)",
                            borderRadius: 8,
                            padding: "1px 8px",
                            fontSize: 12,
                            fontWeight: 700,
                            background: "transparent",
                            color: c.resolved_at ? "inherit" : "#16a34a",
                            cursor: busyId === c.id ? "wait" : "pointer",
                            opacity: busyId === c.id ? 0.5 : 1,
                          }}
                        >
                          {busyId === c.id ? "שומר…" : c.resolved_at ? "בטל טופל" : "✓ טופל"}
                        </button>
                      )}
                    </div>
                    <div dir="auto" style={{ fontSize: 14, whiteSpace: "pre-wrap", fontWeight: unread ? 600 : 400 }}>
                      {c.body}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
