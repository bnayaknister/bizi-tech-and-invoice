"use client";

import { useRef, useState } from "react";
import Link from "next/link";

export type OrphanRow = {
  id: string;
  name: string;
  episodes: number;
  billing_mode: "per_episode" | "contract" | "none";
};

type Client = { id: string; name: string };
type RowState = { client_id: string; billing_mode: OrphanRow["billing_mode"]; status: "idle" | "saving" | "saved" | "error"; error?: string };

const BILLING_LABEL: Record<OrphanRow["billing_mode"], string> = {
  per_episode: "לפי פרק",
  contract: "חוזה",
  none: "ללא חיוב",
};

export default function AssignClient({ rows, clients }: { rows: OrphanRow[]; clients: Client[] }) {
  const [state, setState] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(rows.map((r) => [r.id, { client_id: "", billing_mode: r.billing_mode, status: "idle" as const }]))
  );
  // one ref per row's client <select>, so Enter can jump to the next row
  const clientRefs = useRef<(HTMLSelectElement | null)[]>([]);

  const assignedCount = Object.values(state).filter((s) => s.client_id).length;

  async function save(id: string, patch: Record<string, unknown>) {
    setState((s) => ({ ...s, [id]: { ...s[id], status: "saving", error: undefined } }));
    const res = await fetch("/api/shows/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, patch }),
    });
    if (res.ok) {
      setState((s) => ({ ...s, [id]: { ...s[id], status: "saved" } }));
    } else {
      const data = await res.json().catch(() => ({}));
      setState((s) => ({ ...s, [id]: { ...s[id], status: "error", error: data.error ?? "שגיאה" } }));
    }
  }

  function onClientChange(row: OrphanRow, value: string) {
    setState((s) => ({ ...s, [row.id]: { ...s[row.id], client_id: value } }));
    save(row.id, { client_id: value || null });
  }

  function onBillingChange(row: OrphanRow, value: OrphanRow["billing_mode"]) {
    setState((s) => ({ ...s, [row.id]: { ...s[row.id], billing_mode: value } }));
    save(row.id, { billing_mode: value });
  }

  function focusNextRow(index: number) {
    const next = clientRefs.current[index + 1];
    if (next) next.focus();
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex flex-wrap items-baseline gap-3 mb-1">
        <Link href="/shows" className="text-xs text-[var(--dim)] hover:text-[var(--ink)]">
          ← תוכניות
        </Link>
        <h1 className="text-lg font-bold">שיוך תוכניות יתומות</h1>
      </div>
      <p className="text-xs text-[var(--dim)] mb-4">
        {rows.length} תוכניות פעילות ללא לקוח · שויכו {assignedCount} · שמירה מיידית בכל שינוי ·
        Tab בין שדות · Enter לשורה הבאה
      </p>

      <div className="overflow-x-auto border border-[var(--rule)] rounded">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-xs text-[var(--faint)] border-b border-[var(--rule)] bg-[var(--panel2)]">
              <th className="px-3 py-2 font-normal">תוכנית</th>
              <th className="px-3 py-2 font-normal w-16">פרקים</th>
              <th className="px-3 py-2 font-normal">לקוח</th>
              <th className="px-3 py-2 font-normal w-32">אופן חיוב</th>
              <th className="px-3 py-2 font-normal w-24">סטטוס</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const rs = state[row.id];
              const done = !!rs.client_id;
              return (
                <tr
                  key={row.id}
                  className={`border-b border-[var(--rule)] last:border-b-0 ${done ? "bg-[var(--panel)]/40" : ""}`}
                >
                  <td className="px-3 py-2 font-medium">{row.name}</td>
                  <td className="px-3 py-2 text-[var(--dim)]">{row.episodes}</td>
                  <td className="px-3 py-2">
                    <select
                      ref={(el) => {
                        clientRefs.current[i] = el;
                      }}
                      value={rs.client_id}
                      onChange={(e) => onClientChange(row, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          focusNextRow(i);
                        }
                      }}
                      className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1.5 text-sm focus:border-[var(--signal)] outline-none"
                    >
                      <option value="">— בחר לקוח —</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={rs.billing_mode}
                      onChange={(e) => onBillingChange(row, e.target.value as OrphanRow["billing_mode"])}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          focusNextRow(i);
                        }
                      }}
                      className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1.5 text-sm focus:border-[var(--signal)] outline-none"
                    >
                      {(["per_episode", "contract", "none"] as const).map((m) => (
                        <option key={m} value={m}>
                          {BILLING_LABEL[m]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {rs.status === "saving" && <span className="text-[var(--dim)]">שומר…</span>}
                    {rs.status === "saved" && <span className="text-[var(--signal)]">✓ נשמר</span>}
                    {rs.status === "error" && (
                      <span className="text-[var(--peak)]" title={rs.error}>
                        ✕ {rs.error}
                      </span>
                    )}
                    {rs.status === "idle" && <span className="text-[var(--faint)]">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
