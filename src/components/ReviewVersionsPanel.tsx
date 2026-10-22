"use client";

import { useEffect, useRef, useState } from "react";
import { REFRESH_MS, isStuck, versionLabel, type VersionTone } from "@/lib/review/versionLabel";
import { FOLDER_LINK_ERROR, isDriveFolderLink } from "@/lib/review/itemLinks";
import ReviewSendConfirm, { type SendPreview } from "@/components/ReviewSendConfirm";

// E13-4 — "שלח לביקורת" from the drawer (plan §9.2). One row per deliverable
// (episode, reel 1..n): a Drive link field, the send button, and the item's
// versions for the TEAM only. The client sees nothing new until E13-6.
// The old per-item Drive field (review-items, the iframe route) is untouched.
//
// Polling: while the drawer is open and any shown version is not final, each
// such version's refresh route is called every 30 seconds, then the drawer
// reloads quietly. Closing the drawer unmounts this and stops it.

export type PanelVersion = {
  id: string;
  number: number | null;
  source: "drive" | "bunny";
  status: "created" | "uploading" | "processing" | "playable" | "ready" | "failed" | null;
  integrity: "hash_match" | "size_match" | "mismatch" | "unchecked" | null;
  has_guid: boolean;
  is_audio_only: boolean;
  file_name: string | null;
  final: boolean;
  created_at: string;
};

export type PanelItem = { kind: string; reel_index: number | null; versions?: PanelVersion[] };

type Row = { key: string; label: string; kind: "episode" | "reel"; reelIndex: number | null; versions: PanelVersion[] };

const TONE: Record<VersionTone, string> = {
  dim: "text-[var(--faint)]",
  busy: "text-[var(--amber)]",
  ok: "text-emerald-400",
  bad: "text-rose-400",
};

export default function ReviewVersionsPanel({
  productionId,
  hasEpisode,
  reelCount,
  items,
  canEdit,
  onChanged,
}: {
  productionId: string;
  hasEpisode: boolean;
  reelCount: number;
  items: PanelItem[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [links, setLinks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Record<string, { text: string; bad: boolean }>>({});
  // owner 22.10: the confirmation screen of one row at a time
  const [confirm, setConfirm] = useState<{ key: string; url: string; preview: SendPreview } | null>(null);

  const rows: Row[] = [];
  const versionsOf = (kind: string, idx: number | null) =>
    items.find((i) => i.kind === kind && (i.reel_index ?? null) === idx)?.versions ?? [];
  if (hasEpisode) rows.push({ key: "episode", label: "🎬 פרק", kind: "episode", reelIndex: null, versions: versionsOf("episode", null) });
  for (let i = 1; i <= reelCount; i++) rows.push({ key: `reel-${i}`, label: `📱 ריל ${i}`, kind: "reel", reelIndex: i, versions: versionsOf("reel", i) });

  // ── polling ──
  const pending = rows.flatMap((r) => r.versions.filter((v) => !v.final).map((v) => v.id));
  const pendingKey = pending.join(",");
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  useEffect(() => {
    if (!pendingKey) return;
    const ids = pendingKey.split(",");
    const t = setInterval(async () => {
      await Promise.all(
        ids.map((id) =>
          fetch(`/api/productions/${productionId}/review-versions/${id}/refresh`, { method: "POST" }).catch(() => null)
        )
      );
      onChangedRef.current();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [pendingKey, productionId]);

  async function send(row: Row) {
    const url = (links[row.key] ?? "").trim();
    if (!url) return;
    // owner 18.10: a folder link is the common mistake — refused here at once
    // (the server refuses it too: checkReviewFile → 'folder')
    if (isDriveFolderLink(url)) {
      setNotice((n) => ({ ...n, [row.key]: { text: FOLDER_LINK_ERROR, bad: true } }));
      return;
    }
    setBusy(row.key);
    setNotice((n) => ({ ...n, [row.key]: { text: "בודק את הקובץ ב-Drive…", bad: false } }));
    // owner 22.10: first what would be sent where (and the warnings) — nothing is sent yet
    const res = await fetch(`/api/productions/${productionId}/review-versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: row.kind, reel_index: row.reelIndex, drive_url: url, preview: true }),
    }).catch(() => null);
    const b = res ? await res.json().catch(() => ({})) : {};
    setBusy(null);
    if (!res || !res.ok || !(b as { preview?: SendPreview }).preview) {
      setNotice((n) => ({ ...n, [row.key]: { text: (b as { error?: string }).error ?? "הבדיקה נכשלה", bad: true } }));
      return;
    }
    setNotice((n) => {
      const next = { ...n };
      delete next[row.key];
      return next;
    });
    setConfirm({ key: row.key, url, preview: (b as { preview: SendPreview }).preview });
  }

  async function sendConfirmed(row: Row) {
    if (!confirm || confirm.key !== row.key) return;
    const { url, preview } = confirm;
    setBusy(row.key);
    const res = await fetch(`/api/productions/${productionId}/review-versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: row.kind, reel_index: row.reelIndex, drive_url: url, ack_warnings: (preview.warnings ?? []).length > 0 }),
    }).catch(() => null);
    const b = res ? await res.json().catch(() => ({})) : {};
    setBusy(null);
    setConfirm(null);
    if (!res || !res.ok) {
      setNotice((n) => ({ ...n, [row.key]: { text: (b as { error?: string }).error ?? "השליחה נכשלה", bad: true } }));
      return;
    }
    setNotice((n) => ({ ...n, [row.key]: { text: (b as { message?: string }).message ?? "נשלח", bad: false } }));
    if (!(b as { dryRun?: boolean }).dryRun) setLinks((l) => ({ ...l, [row.key]: "" }));
    onChanged();
  }

  // owner 22.10: a stuck (an hour) or failed version is sent again, same file, same item
  async function resend(row: Row, v: PanelVersion) {
    if (!window.confirm(`לשלוח מחדש את ${v.number ? `v${v.number}` : "הגרסה"}? הגרסה התקועה תסומן כנכשלה, תימחק מ-Bunny, והקובץ יישלח שוב כגרסה חדשה.`)) return;
    setBusy(row.key);
    setNotice((n) => ({ ...n, [row.key]: { text: "שולח מחדש…", bad: false } }));
    const res = await fetch(`/api/productions/${productionId}/review-versions/${v.id}/resend`, { method: "POST" }).catch(() => null);
    const b = res ? await res.json().catch(() => ({})) : {};
    setBusy(null);
    setNotice((n) => ({
      ...n,
      [row.key]: res && res.ok
        ? { text: (b as { message?: string }).message ?? "נשלח מחדש", bad: false }
        : { text: (b as { error?: string }).error ?? "השליחה מחדש נכשלה", bad: true },
    }));
    onChanged();
  }

  const now = new Date();
  if (!rows.length) return null;
  return (
    <div className="rounded-lg px-2.5 py-2 space-y-2.5 border border-[var(--rule)]">
      <div className="text-[10px] font-bold text-[var(--violet-light)]">🎞 גרסאות לביקורת (Bunny) · לצוות בלבד</div>
      {rows.map((row) => {
        const note = notice[row.key];
        return (
          <div key={row.key} className="space-y-1">
            <div className="text-[11px] font-bold">{row.label}</div>
            {canEdit && (
              <div className="flex gap-1.5">
                <input
                  dir="ltr"
                  value={links[row.key] ?? ""}
                  onChange={(e) => setLinks((l) => ({ ...l, [row.key]: e.target.value }))}
                  placeholder="קישור לקובץ ב-Drive (BIZI PODCLUB)"
                  className="flex-1 min-w-0 text-[11px] bg-[var(--panel2)] border border-[var(--rule)] rounded-md px-2 py-1"
                />
                <button
                  onClick={() => void send(row)}
                  disabled={busy !== null || confirm !== null || !(links[row.key] ?? "").trim()}
                  className="shrink-0 text-[11px] rounded-md px-2.5 py-1 border border-[var(--violet-light)] text-[var(--violet-light)] hover:bg-[rgba(139,92,246,0.14)] disabled:opacity-50 transition-colors"
                >
                  {busy === row.key ? "שולח…" : "שלח לביקורת"}
                </button>
              </div>
            )}
            {confirm?.key === row.key && (
              <ReviewSendConfirm
                preview={confirm.preview}
                busy={busy === row.key}
                onConfirm={() => void sendConfirmed(row)}
                onCancel={() => setConfirm(null)}
              />
            )}
            {note && <div className={`text-[10px] ${note.bad ? "text-rose-400" : "text-[var(--dim)]"}`}>{note.text}</div>}
            {row.versions.length > 0 && (
              <div className="space-y-0.5">
                {row.versions.map((v) => {
                  const stuck = isStuck({ final: v.final, status: v.status, sent_at: v.created_at }, now);
                  const l = versionLabel({ ...v, stuck });
                  const canResend = canEdit && v.source === "bunny" && (stuck || v.status === "failed");
                  return (
                    <div key={v.id} className="flex items-center gap-2 text-[10px]">
                      <span className="font-bold w-7">{v.number ? `v${v.number}` : "—"}</span>
                      <span className={TONE[l.tone]}>{l.text}</span>
                      {canResend && (
                        <button
                          data-action="review-resend"
                          onClick={() => void resend(row, v)}
                          disabled={busy !== null}
                          className="shrink-0 rounded px-1.5 border border-rose-500 text-rose-400 disabled:opacity-50"
                        >
                          שליחה מחדש
                        </button>
                      )}
                      {v.file_name && (
                        <span className="text-[var(--faint)] truncate" dir="ltr" title={v.file_name}>
                          {v.is_audio_only ? "🎧 " : ""}
                          {v.file_name}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
