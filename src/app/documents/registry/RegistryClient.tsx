"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useDrawer } from "@/components/EntityDrawer";
import { REGISTRY_TAB_LABEL, type RegistryTab } from "@/lib/morning/types";

export type DocRow = {
  id: string;
  number: string | null;
  type: number;
  tab: RegistryTab;
  status: number | null;
  client_id: string | null;
  client_name: string | null;
  morning_client_name: string | null;
  amount: number | null;
  currency: string;
  document_date: string | null;
  pdf_url: string | null;
  source: "app" | "pull" | "manual";
  production_id: string | null;
  job_id: string | null;
  show_name: string | null;
};

// tab order = the owner's five, then "other", then the unmatched bucket which
// is a client-match state, not a Morning type (owner: "לשונית לא משויך")
const TAB_ORDER: (RegistryTab | "unmatched")[] = [
  "work_order",
  "deal_invoice",
  "tax_invoice",
  "tax_receipt",
  "receipt",
  "other",
  "unmatched",
];

const SOURCE_LABEL: Record<DocRow["source"], string> = { app: "מהאפליקציה", pull: "ממורנינג", manual: "ידני" };

const money = (n: number | null, cur: string) =>
  n === null ? "—" : new Intl.NumberFormat("he-IL", { style: "currency", currency: cur || "ILS", maximumFractionDigits: 0 }).format(n);

export default function RegistryClient({
  rows,
  canPull,
  lastPull,
}: {
  rows: DocRow[];
  canPull: boolean;
  lastPull: string | null;
}) {
  const router = useRouter();
  const { openEntity } = useDrawer();
  const [tab, setTab] = useState<RegistryTab | "unmatched">("work_order");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"date" | "amount">("date");
  const [pulling, setPulling] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, { n: number; total: number }> = {};
    for (const t of TAB_ORDER) c[t] = { n: 0, total: 0 };
    for (const r of rows) {
      const key = r.client_id ? r.tab : "unmatched";
      c[key].n++;
      c[key].total += r.amount ?? 0;
    }
    return c;
  }, [rows]);

  const shown = useMemo(() => {
    const term = q.trim();
    const list = rows.filter((r) => {
      const inTab = tab === "unmatched" ? !r.client_id : r.tab === tab && r.client_id;
      if (!inTab) return false;
      if (!term) return true;
      return (
        (r.number ?? "").includes(term) ||
        (r.client_name ?? "").includes(term) ||
        (r.show_name ?? "").includes(term)
      );
    });
    list.sort((a, b) => {
      if (sort === "amount") return (b.amount ?? 0) - (a.amount ?? 0);
      return (b.document_date ?? "").localeCompare(a.document_date ?? "");
    });
    return list;
  }, [rows, tab, q, sort]);

  async function pullNow() {
    setPulling(true);
    setMsg(null);
    try {
      const res = await fetch("/api/documents/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setMsg(body.error ?? "המשיכה נכשלה");
        return;
      }
      setMsg(`נמשכו ${body.pulled} · חדשים ${body.inserted} · לא משויכים ${body.unmatched}`);
      router.refresh();
    } catch {
      setMsg("שגיאת רשת");
    } finally {
      setPulling(false);
    }
  }

  function openRow(r: DocRow) {
    if (r.production_id) openEntity({ type: "production", id: r.production_id });
    else if (r.job_id) openEntity({ type: "job", id: r.job_id });
    else if (r.client_id) openEntity({ type: "client", id: r.client_id });
  }

  return (
    <main className="max-w-5xl mx-auto p-6">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-bold">מסמכים</h1>
        {canPull && (
          <div className="flex items-center gap-3">
            {lastPull && (
              <span className="text-[11px] text-[var(--faint)]">
                נמשך לאחרונה: {new Date(lastPull).toLocaleString("he-IL")}
              </span>
            )}
            <button
              disabled={pulling}
              onClick={pullNow}
              className="text-xs font-bold rounded-xl px-4 py-1.5 border border-[var(--rule2)] disabled:opacity-40"
            >
              {pulling ? "מושך…" : "משוך ממורנינג"}
            </button>
          </div>
        )}
      </div>
      {msg && <div className="mb-3 text-xs text-[var(--dim)] border border-[var(--rule)] rounded-xl px-3 py-2">{msg}</div>}

      {/* tabs */}
      <div className="flex flex-wrap gap-1.5 mb-4 border-b border-[var(--rule)] pb-2">
        {TAB_ORDER.map((t) => {
          const label = t === "unmatched" ? "לא משויך" : REGISTRY_TAB_LABEL[t];
          const c = counts[t];
          if (c.n === 0 && t !== tab) return null; // hide empty tabs, keep the active one
          const active = tab === t;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-xs rounded-xl px-3 py-1.5 ${
                active ? "bg-[var(--signal)] text-white font-bold" : "border border-[var(--rule)] text-[var(--dim)]"
              } ${t === "unmatched" && c.n > 0 ? "border-[var(--warn)]" : ""}`}
            >
              {label} {c.n > 0 && <span className="opacity-80">({c.n})</span>}
            </button>
          );
        })}
      </div>

      {/* controls + total */}
      <div className="flex items-center gap-3 mb-3 text-xs">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="חיפוש לפי מספר / לקוח / תוכנית…"
          className="flex-1 bg-transparent border border-[var(--rule)] rounded-xl px-3 py-1.5"
        />
        <button
          onClick={() => setSort(sort === "date" ? "amount" : "date")}
          className="rounded-xl px-3 py-1.5 border border-[var(--rule)] shrink-0"
        >
          מיון: {sort === "date" ? "תאריך" : "סכום"}
        </button>
        <span className="text-[var(--faint)] shrink-0">
          {shown.length} מסמכים · {money(counts[tab].total, "ILS")}
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="text-center text-sm text-[var(--faint)] py-12 border border-dashed border-[var(--rule)] rounded-2xl">
          אין מסמכים בלשונית זו
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[var(--faint)] text-[10px] uppercase tracking-wider">
              <tr className="text-right">
                <th className="py-2 px-2">מספר</th>
                <th className="py-2 px-2">לקוח</th>
                <th className="py-2 px-2">תוכנית / הפקה</th>
                <th className="py-2 px-2">סכום</th>
                <th className="py-2 px-2">תאריך</th>
                <th className="py-2 px-2">מקור</th>
                <th className="py-2 px-2">PDF</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => openRow(r)}
                  className="border-t border-[var(--rule)] hover:bg-[var(--hover)] cursor-pointer"
                >
                  <td className="py-2 px-2 font-mono">{r.number ?? "—"}</td>
                  <td className="py-2 px-2">
                    {r.client_name ?? "—"}
                    {!r.client_id && r.morning_client_name && (
                      <span className="text-[10px] text-[var(--warn)]"> (לא משויך)</span>
                    )}
                  </td>
                  <td className="py-2 px-2 text-[var(--dim)]">{r.show_name ?? "—"}</td>
                  <td className="py-2 px-2 font-mono">{money(r.amount, r.currency)}</td>
                  <td className="py-2 px-2 font-mono text-[var(--faint)]">{r.document_date ?? "—"}</td>
                  <td className="py-2 px-2">
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-[var(--rule)] text-[var(--faint)]">
                      {SOURCE_LABEL[r.source]}
                    </span>
                  </td>
                  <td className="py-2 px-2" onClick={(e) => e.stopPropagation()}>
                    {r.pdf_url ? (
                      <a href={r.pdf_url} target="_blank" rel="noopener noreferrer" className="text-[var(--signal)] underline">
                        פתח
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
