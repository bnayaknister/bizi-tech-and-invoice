"use client";

import type { SendWarning } from "@/lib/review/sendWarnings";

// owner 22.10 — the screen before "שלח לביקורת": what is sent where, and the
// warnings in plain sight. With warnings the button says "לשלוח בכל זאת" and
// the server holds the send until it is pressed. A PURE component (the render
// test counts what it shows); the panel owns the fetches.

export type SendPreview = {
  file: { name: string; size_bytes: number | null };
  folder: string | null;
  show: string | null;
  record_date: string | null;
  target: string;
  next_version: number;
  warnings: SendWarning[];
};

const gb = (n: number | null | undefined) =>
  n == null ? "" : n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
const dmy = (iso: string | null | undefined) =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}.${iso.slice(0, 4)}` : "";

export default function ReviewSendConfirm({
  preview,
  busy,
  onConfirm,
  onCancel,
}: {
  preview: SendPreview | null | undefined;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!preview) return null;
  const warnings = preview.warnings ?? [];
  const line = (label: string, value: string | null | undefined, ltr = false) =>
    value ? (
      <div className="flex gap-1.5">
        <span className="text-[var(--faint)] shrink-0">{label}:</span>
        <span className="font-bold break-all" dir={ltr ? "ltr" : undefined}>
          {value}
        </span>
      </div>
    ) : null;
  return (
    <div data-review-send-confirm="" className="rounded-lg border border-[var(--violet-light)] px-2.5 py-2 space-y-1.5 text-[11px]">
      <div className="font-bold text-[var(--violet-light)]">לאשר שליחה לביקורת?</div>
      {line("קובץ", `${preview.file?.name ?? "—"}${preview.file?.size_bytes ? ` (${gb(preview.file.size_bytes)})` : ""}`, true)}
      {line("תיקייה ב-Drive", preview.folder)}
      {line("תוכנית", [preview.show, dmy(preview.record_date)].filter(Boolean).join(" · ") || null)}
      {line("נשלח ל", `${preview.target} · v${preview.next_version}`)}
      {warnings.length > 0 && (
        <div data-review-send-warnings="" className="rounded-md border-2 border-rose-500 bg-[rgba(244,63,94,0.12)] px-2 py-1.5 space-y-1">
          <div className="font-bold text-rose-400">⚠️ לבדוק לפני ששולחים:</div>
          <ul className="space-y-0.5 list-disc ps-4">
            {warnings.map((w, i) => (
              <li key={i}>{w.text}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex gap-1.5 pt-0.5">
        <button
          data-action="review-send-confirm"
          onClick={onConfirm}
          disabled={busy}
          className={`text-[11px] rounded-md px-2.5 py-1 border disabled:opacity-50 ${
            warnings.length ? "border-rose-500 text-rose-400" : "border-[var(--violet-light)] text-[var(--violet-light)]"
          }`}
        >
          {busy ? "שולח…" : warnings.length ? "לשלוח בכל זאת" : "שליחה"}
        </button>
        <button onClick={onCancel} disabled={busy} className="text-[11px] rounded-md px-2.5 py-1 border border-[var(--rule)] text-[var(--dim)] disabled:opacity-50">
          ביטול
        </button>
      </div>
    </div>
  );
}
