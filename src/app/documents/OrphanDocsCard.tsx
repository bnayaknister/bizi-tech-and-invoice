"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { orphanLine, type OrphanDoc } from "@/lib/documents/orphanDocs";

// B38-3: documents issued in Morning for a recording that was cancelled (or
// whose calendar event vanished), still open there. The action is the existing
// E11 route — close in Morning, then mark cancelled here — through the same
// reason it asks for on the registry screen.
export default function OrphanDocsCard({ orphans, canAct }: { orphans: OrphanDoc[]; canAct: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});

  async function close(o: OrphanDoc) {
    if (!o.registryId) return;
    const reason = window.prompt(`סיבת הביטול של ${orphanLine(o)}:`, o.reason === "cancelled" ? "ההקלטה בוטלה" : "האירוע נמחק מהיומן — ההקלטה לא קרתה");
    if (!reason || !reason.trim()) return;
    setBusy(o.pendingId);
    try {
      const res = await fetch(`/api/documents/${o.registryId}/cancel-in-morning`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      setNote((n) => ({ ...n, [o.pendingId]: res.ok ? body?.message ?? "נסגר" : body?.error ?? "הסגירה נכשלה" }));
      if (res.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (orphans.length === 0) return null;
  return (
    <section className="max-w-5xl mx-auto px-4 mt-4">
      <div className="rounded-2xl border p-4" style={{ borderColor: "var(--amber)", background: "rgba(245,158,11,0.08)" }}>
        <div className="text-sm font-bold text-[var(--amber)] mb-2">
          ⚠ {orphans.length === 1 ? "מסמך הופק במורנינג להקלטה שלא קרתה" : `${orphans.length} מסמכים הופקו במורנינג להקלטות שלא קרו`} — לסגור במורנינג
        </div>
        <ul className="space-y-2">
          {orphans.map((o) => (
            <li key={o.pendingId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="flex-1 min-w-[220px]">
                {orphanLine(o)}
                <span className="text-xs text-[var(--dim)]"> · {o.reason === "cancelled" ? "ההקלטה בוטלה" : "האירוע נמחק מהיומן"}</span>
              </span>
              {o.registryId && canAct ? (
                <button
                  onClick={() => void close(o)}
                  disabled={busy === o.pendingId}
                  className="text-xs rounded-lg px-3 py-1.5 border border-[var(--amber)] text-[var(--amber)] hover:bg-[rgba(245,158,11,0.14)] disabled:opacity-50"
                >
                  {busy === o.pendingId ? "סוגר…" : "בטל ב-Morning"}
                </button>
              ) : (
                <span className="text-xs text-[var(--dim)]">
                  {o.registryId ? "סגירה — בהרשאת עריכת כספים" : "המסמך עוד לא נמשך ממורנינג — לסגור ידנית במורנינג"}
                </span>
              )}
              {note[o.pendingId] && <span className="text-xs text-[var(--dim)] w-full">{note[o.pendingId]}</span>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
