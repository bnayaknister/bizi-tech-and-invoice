"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import IconTile from "@/components/IconTile";

export type ApprovalRow = {
  id: string;
  requested_by_name: string;
  action_type: string;
  entity_type: string;
  entity_id: string | null;
  payload: Record<string, unknown>;
  reason: string;
  status: string;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
};

const ACTION_LABEL: Record<string, string> = {
  show_delete: "מחיקת תוכנית",
  show_archive: "ארכוב תוכנית",
  show_merge: "מיזוג תוכניות",
  production_delete: "מחיקת הפקה",
  client_delete: "מחיקת לקוח",
  bulk_show_archive: "ארכוב מרובה של תוכניות",
};

const STATUS_LABEL: Record<string, string> = { pending: "ממתין", approved: "אושר", rejected: "נדחה" };
const STATUS_COLOR: Record<string, string> = {
  pending: "var(--amber)",
  approved: "var(--green)",
  rejected: "var(--red)",
};

export default function ApprovalsClient({ rows }: { rows: ApprovalRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<ApprovalRow | null>(null);

  const pending = rows.filter((r) => r.status === "pending");
  const history = rows.filter((r) => r.status !== "pending");

  async function review(id: string, decision: "approve" | "reject", note?: string) {
    setBusyId(id);
    setError(null);
    const res = await fetch(`/api/approvals/${id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, note }),
    });
    setBusyId(null);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "הפעולה נכשלה");
      return;
    }
    router.refresh();
  }

  const Card = ({ r }: { r: ApprovalRow }) => (
    <div
      className="rounded-2xl border border-[var(--rule)] p-4"
      style={{ background: "rgba(255,255,255,0.03)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-bold text-sm">{ACTION_LABEL[r.action_type] ?? r.action_type}</span>
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full"
              style={{ color: STATUS_COLOR[r.status], background: "rgba(255,255,255,0.04)" }}
            >
              {STATUS_LABEL[r.status] ?? r.status}
            </span>
          </div>
          <div className="text-xs text-[var(--dim)]">
            ביקש/ה: {r.requested_by_name} ·{" "}
            <span className="font-mono">{new Date(r.created_at).toLocaleString("he-IL")}</span>
          </div>
          <div className="mt-2 text-sm">
            <span className="text-[var(--faint)]">סיבה: </span>
            {r.reason}
          </div>
          {r.review_note && (
            <div className="mt-1 text-xs text-[var(--faint)]">הערת מנהל: {r.review_note}</div>
          )}
        </div>
        {r.status === "pending" && (
          <div className="flex flex-col gap-2 shrink-0">
            <button
              onClick={() => review(r.id, "approve")}
              disabled={busyId === r.id}
              className="text-white text-xs font-bold rounded-xl px-4 py-1.5 disabled:opacity-40"
              style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 14px rgba(139,92,246,0.3)" }}
            >
              אשר
            </button>
            <button
              onClick={() => setRejectFor(r)}
              disabled={busyId === r.id}
              className="text-xs rounded-xl px-4 py-1.5 border border-[var(--red)] text-[var(--red)] hover:bg-[rgba(251,113,133,0.08)] disabled:opacity-40 transition-colors"
            >
              דחה
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-lg font-bold mb-1 flex items-center gap-2.5">
        <IconTile icon="approvals" accent="rose" size={30} iconSize={17} />
        בקשות אישור
      </h1>
      <p className="text-xs text-[var(--faint)] mb-6">פעולות הרסניות שטכנאי ביקש · אישור מריץ אותן בפועל בהרשאות מנהל</p>

      {error && (
        <div className="mb-3 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2">{error}</div>
      )}

      <div className="mb-2 text-[10px] uppercase tracking-wider font-semibold text-[var(--faint)]">
        ממתינות ({pending.length})
      </div>
      {pending.length === 0 ? (
        <div className="text-center text-sm text-[var(--faint)] py-8 border border-dashed border-[var(--rule)] rounded-2xl mb-8">
          אין בקשות ממתינות.
        </div>
      ) : (
        <div className="space-y-3 mb-8">
          {pending.map((r) => (
            <Card key={r.id} r={r} />
          ))}
        </div>
      )}

      {history.length > 0 && (
        <>
          <div className="mb-2 text-[10px] uppercase tracking-wider font-semibold text-[var(--faint)]">היסטוריה</div>
          <div className="space-y-3">
            {history.map((r) => (
              <Card key={r.id} r={r} />
            ))}
          </div>
        </>
      )}

      {rejectFor && (
        <RejectModal
          row={rejectFor}
          onClose={() => setRejectFor(null)}
          onConfirm={(note) => {
            void review(rejectFor.id, "reject", note);
            setRejectFor(null);
          }}
        />
      )}
    </div>
  );
}

function RejectModal({
  row,
  onClose,
  onConfirm,
}: {
  row: ApprovalRow;
  onClose: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 z-50"
      style={{ background: "rgba(3,2,10,0.66)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl"
        style={{ background: "rgba(15,13,28,0.92)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
      >
        <h3 className="font-bold mb-1">דחיית בקשה</h3>
        <p className="text-xs text-[var(--dim)] mb-3">{ACTION_LABEL[row.action_type] ?? row.action_type}</p>
        <textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="הערה (אופציונלי) — למה נדחתה"
          className="w-full border border-[var(--rule)] rounded-xl px-3 py-2 text-sm mb-4 resize-y"
          style={{ background: "rgba(255,255,255,0.05)" }}
        />
        <div className="flex gap-2">
          <button
            onClick={() => onConfirm(note)}
            className="text-white font-bold rounded-xl px-4 py-2 text-sm"
            style={{ background: "linear-gradient(135deg, var(--red), var(--red-dk))" }}
          >
            דחה
          </button>
          <button onClick={onClose} className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)] hover:bg-[var(--panel3)] transition-colors">
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}
