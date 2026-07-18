"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import IconTile from "@/components/IconTile";

export type LastSync = { at: string; source: "cron" | "manual"; created: number };

const WARNING_TEXT = "הסריקה תרוץ כל בוקר 06:00 ותכניס הקלטות של אותו יום, לפי aliases של התוכניות.";

export default function SettingsClient({
  calendarSyncEnabled,
  lastSync,
}: {
  calendarSyncEnabled: boolean;
  lastSync: LastSync | null;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(calendarSyncEnabled);
  const [confirming, setConfirming] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  async function setSyncEnabled(next: boolean) {
    setToggling(true);
    setError(null);
    const res = await fetch("/api/settings/calendar-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    setToggling(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "העדכון נכשל");
      return;
    }
    setEnabled(next);
    router.refresh();
  }

  async function syncNow() {
    setSyncing(true);
    setSyncResult(null);
    setError(null);
    const res = await fetch("/api/calendar/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    setSyncing(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "שגיאת סנכרון");
      return;
    }
    const d = await res.json();
    setSyncResult(
      `נוצרו ${d.created} · עודכנו ${d.updated} · דגל שינוי ${d.flaggedChanged} · דגל הוסר ${d.flaggedRemoved} · דולגו בשקט ${d.skippedNoMatch}`
    );
    router.refresh();
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-lg font-bold mb-4 flex items-center gap-2.5">
        <IconTile icon="settings" accent="violet" size={30} iconSize={17} />
        הגדרות
      </h1>

      {error && (
        <div className="mb-3 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2">{error}</div>
      )}

      <section
        className="glass-card-secondary"
        style={{ padding: "18px 20px" }}
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="font-bold text-sm mb-1">סנכרון יומן אוטומטי</div>
            <div className="text-xs text-[var(--faint)]">
              {enabled ? "פעיל — הסריקה האוטומטית רצה כל בוקר." : "כבוי — הקרון לא נוגע ביומן האמיתי."}
            </div>
          </div>
          <button
            role="switch"
            aria-checked={enabled}
            disabled={toggling}
            onClick={() => (enabled ? void setSyncEnabled(false) : setConfirming(true))}
            className="relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50"
            style={{
              background: enabled ? "linear-gradient(135deg, var(--violet), var(--violet-dk))" : "var(--panel3)",
              boxShadow: enabled ? "0 2px 10px rgba(139,92,246,0.35)" : "none",
            }}
          >
            <span
              className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform"
              style={{ transform: enabled ? "translateX(-1.5rem)" : "translateX(-0.125rem)", right: 0 }}
            />
          </button>
        </div>

        <div className="mt-4 pt-4 border-t border-[var(--rule)] flex items-center justify-between gap-4">
          <div className="text-xs text-[var(--faint)]">
            {lastSync ? (
              <>
                סנכרון אחרון: <span className="font-mono">{new Date(lastSync.at).toLocaleString("he-IL")}</span>
                {" · "}
                {lastSync.source === "cron" ? "אוטומטי" : "ידני"}
                {" · "}
                נכנסו <span className="font-mono">{lastSync.created}</span> הפקות
              </>
            ) : (
              "עדיין לא רץ סנכרון."
            )}
          </div>
          <button
            onClick={syncNow}
            disabled={syncing}
            className="text-xs border border-[var(--rule)] rounded-xl px-3 py-1.5 text-[var(--dim)] hover:bg-[var(--panel3)] hover:border-[var(--rule2)] disabled:opacity-50 shrink-0 transition-colors"
          >
            {syncing ? "מסנכרן…" : "סנכרן עכשיו"}
          </button>
        </div>

        {syncResult && (
          <div className="mt-3 text-xs text-[var(--dim)] border border-[var(--rule)] rounded-xl px-3 py-2 font-mono">
            {syncResult}
          </div>
        )}
      </section>

      {confirming && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4 z-50"
          style={{ background: "rgba(3,2,10,0.66)", backdropFilter: "blur(6px)" }}
          onClick={() => setConfirming(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl"
            style={{ background: "rgba(15,13,28,0.92)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
          >
            <h3 className="font-bold mb-2">הפעלת סנכרון יומן אוטומטי</h3>
            <p className="text-xs text-[var(--dim)] mb-4">{WARNING_TEXT}</p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setConfirming(false);
                  void setSyncEnabled(true);
                }}
                disabled={toggling}
                className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
                style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 14px rgba(139,92,246,0.3)" }}
              >
                הפעל
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)] hover:bg-[var(--panel3)] transition-colors"
              >
                ביטול
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
