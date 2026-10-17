import { displayDateTime } from "@/lib/dates";
import type { CommentState } from "@/lib/review/commentHistory";

// E13-8c — the client's comments, ALL of them (owner 17.10): every item,
// every version, every round. Open ones stand out; handled ones ("קיבלתי",
// later "טופל") are dimmed — never hidden. One component for the drawer, the
// "💬 הערות הלקוח" window and its PDF page, so the three never disagree.
// No hooks: it renders on the server (the print page) and in the browser.

export type HistoryCommentView = {
  id: string;
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
  acked_at: string | null;
  acked_by_name: string | null;
  is_backfill: boolean;
};
export type HistoryItemView = { id: string; label: string; approved: boolean; comments: HistoryCommentView[] };

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
}: {
  items: HistoryItemView[];
  emptyText?: string;
  /** E13-11: per item, under its header — the drawer's "⬇ מרקרים ל-Premiere" (never in the client's window / PDF) */
  itemActions?: (item: HistoryItemView) => React.ReactNode;
}) {
  const withComments = items.filter((i) => i.comments.length);
  if (!withComments.length) return <div style={{ fontSize: 13, opacity: 0.7 }}>{emptyText}</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {withComments.map((it) => {
        const open = it.comments.filter((c) => c.open).length;
        return (
          <section key={it.id}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6, fontWeight: 700, fontSize: 14 }}>
              <span>{it.label}</span>
              <span style={{ fontSize: 12, fontWeight: 400, opacity: 0.75 }}>
                {it.comments.length} הערות{open ? ` · ${open} פתוחות` : ""} · {it.approved ? "מאושר ✓" : "ממתין"}
              </span>
            </div>
            {itemActions?.(it)}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {it.comments.map((c) => {
                const tone = STATE_TONE[c.state];
                return (
                  <div
                    key={c.id}
                    data-open={c.open ? "1" : "0"}
                    style={{
                      border: c.open ? "1px solid rgba(139,92,246,0.55)" : "1px solid rgba(127,127,127,0.25)",
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
                      {c.acked_at && (
                        <span style={{ opacity: 0.85 }}>
                          ✓ קיבלתי{c.acked_by_name ? ` · ${c.acked_by_name}` : ""} · {displayDateTime(c.acked_at) ?? ""}
                        </span>
                      )}
                    </div>
                    <div dir="auto" style={{ fontSize: 14, whiteSpace: "pre-wrap", fontWeight: c.open ? 600 : 400 }}>
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
