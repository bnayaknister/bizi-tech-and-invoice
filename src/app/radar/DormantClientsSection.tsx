"use client";

import { useDrawer } from "@/components/EntityDrawer";
import type { DormantClient } from "@/modules/radar/alerts";

// Each row opens the client's own card, not a shared href — the generic
// alerts list (severity rows with one href each) can't express that, so this
// gets its own small client component (owner spec 2026-07-21, widened
// 2026-07-22 to "no business communication" across four signals — see
// alerts.ts). Server data in, drawer-open on click.

const NIS = new Intl.NumberFormat("he-IL");
const money = (n: number) => `${NIS.format(Math.round(n))} ₪`;
// D.M, no leading zeros (owner example: "12.3", "20.4") — so the reader
// knows what this alert is about before picking up the phone
const shortDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getDate()}.${d.getMonth() + 1}`;
};

export default function DormantClientsSection({ clients }: { clients: DormantClient[] }) {
  const { openEntity } = useDrawer();
  if (clients.length === 0) return null;

  return (
    <section>
      <h2 className="text-xs font-bold mb-2 flex items-center gap-1.5" style={{ color: "var(--cyan)" }}>
        <span className="w-2 h-2 rounded-full" style={{ background: "var(--cyan)" }} />
        אין תקשורת עסקית מעל 3 חודשים
      </h2>
      <div
        className="rounded-2xl border border-[var(--rule)] overflow-hidden"
        style={{ background: "rgba(255,255,255,0.03)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
      >
        {clients.map((c) => (
          <button
            key={c.id}
            onClick={() => openEntity({ type: "client", id: c.id })}
            className="w-full text-right flex items-center gap-3 px-4 py-3 border-b border-[var(--rule)] last:border-b-0 hover:bg-[rgba(255,255,255,0.03)] transition-colors"
          >
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: "var(--cyan)" }} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{c.name}</div>
              <div className="text-[11px] text-[var(--faint)] truncate">{c.shows.join(" · ")}</div>
              <div className="text-[11px] text-[var(--dim)] truncate mt-0.5">
                {c.activities.length > 0
                  ? c.activities.map((a) => `${a.label} ${shortDate(a.date)}`).join(" · ")
                  : "אין פעילות רשומה מעולם"}
              </div>
            </div>
            <div className="text-[11px] font-mono text-[var(--dim)] text-center shrink-0">
              {c.daysSinceLastActivity != null ? `לפני ${c.daysSinceLastActivity} ימים` : "—"}
            </div>
            <span className="font-mono text-xs text-[var(--dim)] min-w-20 text-left shrink-0">
              {money(c.historicalRevenue)}
            </span>
            <span className="text-[var(--faint)] shrink-0">←</span>
          </button>
        ))}
      </div>
    </section>
  );
}
