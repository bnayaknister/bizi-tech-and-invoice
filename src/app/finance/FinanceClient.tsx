"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useDrawer } from "@/components/EntityDrawer";
import IconTile from "@/components/IconTile";
import { deriveState, TAB_META, ALL_TABS, type FinanceState } from "@/lib/finance/state";

type DocSlot = { number: string | null; pdf: string | null; manual: boolean | null };
export type FinanceJob = {
  id: string;
  date: string | null;
  client_name: string | null;
  show_name: string | null;
  campaign: string | null;
  amount: number | null;
  paid: string | null;
  due_days: number | null;
  due_estimated: boolean;
  state: FinanceState;
  biz: DocSlot;
  tax: DocSlot;
};
export type FinanceSummary = {
  debt: number;
  overdue60Count: number;
  overdue60Sum: number;
  missingTaxCount: number;
  missingTaxSum: number;
  closedCount: number;
  closedSum: number;
};

const NIS = new Intl.NumberFormat("he-IL");
const money = (n: number | null | undefined) => (n == null ? "—" : `${NIS.format(Math.round(n))} ₪`);

function dueLabel(days: number | null): { text: string; color: string } {
  if (days == null) return { text: "—", color: "var(--faint)" };
  if (days < 0) return { text: `באיחור ${Math.abs(days)} יום`, color: "var(--red)" };
  if (days === 0) return { text: "היום", color: "var(--amber)" };
  return { text: `בעוד ${days} יום`, color: days <= 7 ? "var(--amber)" : "var(--green)" };
}

export default function FinanceClient({
  rows: initial,
  summary,
  canEditMoney,
}: {
  rows: FinanceJob[];
  summary: FinanceSummary;
  canEditMoney: boolean;
}) {
  const router = useRouter();
  const { openEntity } = useDrawer();
  const [rows, setRows] = useState(initial);
  const [tab, setTab] = useState<FinanceState>("purple");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [issueFor, setIssueFor] = useState<{ job: FinanceJob; type: "עסקה" | "מס" } | null>(null);
  const [paidLoopFor, setPaidLoopFor] = useState<FinanceJob | null>(null);

  const counts = useMemo(() => {
    const c: Record<FinanceState, { n: number; sum: number }> = {
      purple: { n: 0, sum: 0 },
      blue: { n: 0, sum: 0 },
      red: { n: 0, sum: 0 },
      closed: { n: 0, sum: 0 },
    };
    for (const r of rows) {
      c[r.state].n += 1;
      c[r.state].sum += r.amount ?? 0;
    }
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => r.state === tab)
      .filter((r) =>
        !q
          ? true
          : (r.client_name ?? "").toLowerCase().includes(q) ||
            (r.show_name ?? "").toLowerCase().includes(q) ||
            (r.campaign ?? "").toLowerCase().includes(q)
      )
      .sort((a, b) => (a.due_days ?? 1e9) - (b.due_days ?? 1e9));
  }, [rows, tab, query]);

  function patchRow(id: string, patch: Partial<FinanceJob>) {
    setRows((rs) =>
      rs.map((r) => {
        if (r.id !== id) return r;
        const merged = { ...r, ...patch } as FinanceJob;
        merged.state = deriveState({
          paid: merged.paid,
          invoice_biz: merged.biz.number,
          invoice_tax: merged.tax.number,
        });
        return merged;
      })
    );
  }

  async function markPaid(job: FinanceJob) {
    setError(null);
    const res = await fetch("/api/finance/mark-paid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: job.id }),
    });
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? "העדכון נכשל");
      return;
    }
    const d = await res.json();
    patchRow(job.id, { paid: "כן" });
    router.refresh();
    if (d.needs_tax) {
      // "paid opens, doesn't close" — money is in but the tax invoice isn't
      setPaidLoopFor({ ...job, paid: "כן", state: "red" });
      setTab("red");
    }
  }

  async function issue(
    job: FinanceJob,
    type: "עסקה" | "מס",
    mode: "morning" | "manual",
    fields?: { doc_number?: string; issued_at?: string; amount?: number; pdf_url?: string }
  ): Promise<boolean> {
    setError(null);
    const res = await fetch("/api/finance/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: job.id, type, mode, ...fields }),
    });
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? "ההנפקה נכשלה");
      return false;
    }
    const d = await res.json();
    const slot = { number: d.invoice.doc_number as string, pdf: (d.invoice.pdf_url as string) ?? null, manual: mode === "manual" };
    patchRow(job.id, type === "עסקה" ? { biz: slot } : { tax: slot });
    router.refresh();
    return true;
  }

  function exportCsv() {
    const header = ["תאריך", "לקוח", "תוכנית", "קמפיין", "סכום", "פירעון", "שולם", "חשבונית עסקה", "חשבונית מס"];
    const lines = visible.map((r) =>
      [
        r.date ?? "",
        r.client_name ?? "",
        r.show_name ?? "",
        r.campaign ?? "",
        r.amount ?? "",
        dueLabel(r.due_days).text,
        r.paid ?? "",
        r.biz.number ?? "",
        r.tax.number ?? "",
      ]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`)
        .join(",")
    );
    const blob = new Blob(["﻿" + [header.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `finance-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <h1 className="text-lg font-bold mb-4 flex items-center gap-2.5">
        <IconTile icon="finance" accent="rose" size={30} iconSize={17} />
        כספים
      </h1>

      {/* summary cards — glass + corner orbs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <SummaryCard label="חוב לגבייה" value={money(summary.debt)} accent="debt" />
        <SummaryCard
          label="באיחור 60+"
          value={money(summary.overdue60Sum)}
          sub={`${summary.overdue60Count} חיובים`}
          accent="rose"
        />
        <SummaryCard
          label="חסרות חשבוניות מס"
          value={money(summary.missingTaxSum)}
          sub={`${summary.missingTaxCount} חיובים`}
          accent="rose"
          alert={summary.missingTaxCount > 0}
        />
        <SummaryCard label="סגור" value={money(summary.closedSum)} sub={`${summary.closedCount} חיובים`} accent="green" />
      </div>

      {/* tabs by state (1-3 pipeline shown; closed available but quiet) */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {ALL_TABS.map((s) => {
          const meta = TAB_META[s];
          const isRedWithItems = s === "red" && counts.red.n > 0;
          const active = tab === s;
          const closedTab = s === "closed";
          return (
            <button
              key={s}
              onClick={() => setTab(s)}
              className={`text-xs rounded-xl px-3 py-2 border transition-colors flex items-center gap-2 ${
                closedTab && !active ? "opacity-60" : ""
              }`}
              style={{
                borderColor: active ? meta.dot : isRedWithItems ? "var(--red)" : "var(--rule)",
                background: active ? `color-mix(in srgb, ${meta.dot} 12%, transparent)` : "transparent",
                boxShadow: isRedWithItems && !active ? "0 0 0 1px rgba(251,113,133,0.3)" : "none",
              }}
            >
              <span className="w-2 h-2 rounded-full" style={{ background: meta.dot }} />
              <span className="font-bold" style={{ color: active ? meta.color : "var(--dim)" }}>
                {meta.label}
              </span>
              <span className="font-mono text-[var(--faint)]">{counts[s].n}</span>
              <span className="font-mono text-[10px] text-[var(--faint)]">· {money(counts[s].sum)}</span>
            </button>
          );
        })}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="חיפוש לקוח, תוכנית, קמפיין…"
          className="mr-auto w-56 max-w-full border border-[var(--rule)] rounded-xl px-3 py-1.5 text-sm focus:border-[var(--violet-light)] outline-none transition-colors"
          style={{ background: "rgba(255,255,255,0.04)", backdropFilter: "blur(8px)" }}
        />
        <button
          onClick={exportCsv}
          className="text-xs border border-[var(--rule)] rounded-xl px-3 py-1.5 text-[var(--dim)] hover:bg-[var(--panel3)] transition-colors"
        >
          ייצוא CSV
        </button>
      </div>

      <div className="text-[11px] text-[var(--faint)] mb-2">{TAB_META[tab].short} · {TAB_META[tab].hint}</div>
      {error && <div className="mb-3 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2">{error}</div>}

      {/* the table */}
      <div
        className="overflow-x-auto border border-[var(--rule)] rounded-2xl"
        style={{ background: "rgba(255,255,255,0.03)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-[10px] uppercase tracking-wider text-[var(--faint)] border-b border-[var(--rule)] bg-[var(--panel3)]">
              <th className="px-3 py-2.5 font-semibold">תאריך</th>
              <th className="px-3 py-2.5 font-semibold">לקוח</th>
              <th className="px-3 py-2.5 font-semibold">תוכנית</th>
              <th className="px-3 py-2.5 font-semibold">קמפיין</th>
              <th className="px-3 py-2.5 font-semibold">סכום</th>
              <th className="px-3 py-2.5 font-semibold">פירעון</th>
              <th className="px-3 py-2.5 font-semibold">מסמכים</th>
              <th className="px-3 py-2.5 font-semibold">פעולה</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const due = dueLabel(r.due_days);
              return (
                <tr
                  key={r.id}
                  onClick={() => openEntity({ type: "job", id: r.id })}
                  className="border-b border-[var(--rule)] last:border-b-0 hover:bg-[rgba(255,255,255,0.03)] cursor-pointer transition-colors"
                >
                  <td className="px-3 py-2.5 font-mono text-[var(--dim)]">{r.date ?? "—"}</td>
                  <td className="px-3 py-2.5">{r.client_name ?? "—"}</td>
                  <td className="px-3 py-2.5 text-[var(--dim)]">{r.show_name ?? "—"}</td>
                  <td className="px-3 py-2.5 text-[var(--dim)] max-w-[160px] truncate">{r.campaign ?? "—"}</td>
                  <td className="px-3 py-2.5 font-mono font-bold">{money(r.amount)}</td>
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-1" style={{ color: due.color }}>
                      {r.due_estimated && <span title="משוער">⚠</span>}
                      {due.text}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <DocChip label="עסקה" slot={r.biz} />
                      <DocChip label="מס" slot={r.tax} />
                    </div>
                  </td>
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    {canEditMoney && (
                      <div className="flex items-center gap-1.5">
                        {r.state === "purple" && (
                          <button onClick={() => setIssueFor({ job: r, type: "עסקה" })} className="fin-btn">
                            הנפק חשבונית
                          </button>
                        )}
                        {r.state === "red" && (
                          <button onClick={() => setIssueFor({ job: r, type: "מס" })} className="fin-btn fin-btn-red">
                            הנפק חשבונית מס
                          </button>
                        )}
                        {r.paid !== "כן" && r.paid !== "ללא חיוב" && (
                          <button onClick={() => markPaid(r)} className="fin-btn">
                            סמן שולם
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-[var(--faint)] text-sm">
                  {tab === "red" ? "אין חשבוניות מס חסרות — מצוין." : "אין פריטים בלשונית זו."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <style jsx>{`
        :global(.fin-btn) {
          font-size: 11px;
          border: 1px solid var(--rule);
          border-radius: 10px;
          padding: 4px 10px;
          color: var(--dim);
          transition: background 0.15s, border-color 0.15s;
        }
        :global(.fin-btn:hover) {
          background: var(--panel3);
          border-color: var(--rule2);
        }
        :global(.fin-btn-red) {
          border-color: var(--red);
          color: var(--red);
        }
      `}</style>

      {issueFor && (
        <IssueModal
          job={issueFor.job}
          type={issueFor.type}
          onClose={() => setIssueFor(null)}
          onIssue={async (mode, fields) => {
            const ok = await issue(issueFor.job, issueFor.type, mode, fields);
            if (ok) setIssueFor(null);
          }}
        />
      )}

      {paidLoopFor && (
        <PaidLoopModal
          job={paidLoopFor}
          onClose={() => setPaidLoopFor(null)}
          onIssueNow={(manual) => {
            const job = paidLoopFor;
            setPaidLoopFor(null);
            setIssueFor({ job, type: "מס" });
            if (manual) {
              /* IssueModal defaults to showing the manual form too */
            }
          }}
        />
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  accent,
  alert,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: "debt" | "rose" | "green";
  alert?: boolean;
}) {
  const A = {
    debt: {
      grad: "linear-gradient(135deg, rgba(251,113,133,0.20), rgba(139,92,246,0.15), rgba(30,20,55,0.42))",
      border: "rgba(251,113,133,0.32)",
      glow: "rgba(251,113,133,0.26)",
      color: "var(--red)",
    },
    rose: {
      grad: "linear-gradient(135deg, rgba(251,113,133,0.20), rgba(45,18,32,0.42))",
      border: "rgba(251,113,133,0.32)",
      glow: "rgba(251,113,133,0.26)",
      color: "var(--red)",
    },
    green: {
      grad: "linear-gradient(135deg, rgba(74,222,128,0.16), rgba(18,40,28,0.42))",
      border: "rgba(74,222,128,0.28)",
      glow: "rgba(74,222,128,0.22)",
      color: "var(--green)",
    },
  }[accent];
  return (
    <div
      className="glass-card"
      style={{ background: A.grad, borderColor: A.border, ...(alert ? { boxShadow: "0 0 0 1px rgba(251,113,133,0.4), 0 8px 28px rgba(251,113,133,0.18)" } : {}) }}
    >
      <span className="corner-glow" style={{ ["--glow-color" as string]: A.glow }} />
      <div className="glass-content">
        <div className="text-xs text-[var(--dim)] mb-2">{label}</div>
        <div className="num-glow font-mono text-2xl font-medium" style={{ color: A.color }}>
          {value}
        </div>
        {sub && <div className="text-[11px] text-[var(--faint)] mt-1 font-mono">{sub}</div>}
      </div>
    </div>
  );
}

function DocChip({ label, slot }: { label: string; slot: DocSlot }) {
  if (!slot.number) {
    return <span className="text-[10px] text-[var(--faint)] opacity-50">{label} —</span>;
  }
  const body = (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded-full inline-flex items-center gap-1"
      style={{ background: "rgba(255,255,255,0.05)", border: "1px solid var(--rule)" }}
    >
      {label} <span className="font-mono">{slot.number}</span>
      {slot.manual && <span className="text-[var(--amber)]" title="הוזן ידנית">ידני</span>}
    </span>
  );
  return slot.pdf ? (
    <a href={slot.pdf} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="hover:opacity-80">
      {body}
    </a>
  ) : (
    body
  );
}

function IssueModal({
  job,
  type,
  onClose,
  onIssue,
}: {
  job: FinanceJob;
  type: "עסקה" | "מס";
  onClose: () => void;
  onIssue: (mode: "morning" | "manual", fields?: { doc_number?: string; issued_at?: string; amount?: number; pdf_url?: string }) => void;
}) {
  const [docNumber, setDocNumber] = useState("");
  const [issuedAt, setIssuedAt] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState(String(job.amount ?? ""));
  const [pdf, setPdf] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 z-50"
      style={{ background: "rgba(3,2,10,0.66)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl"
        style={{ background: "rgba(15,13,28,0.94)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
      >
        <h3 className="font-bold mb-1">הנפקת חשבונית {type}</h3>
        <p className="text-xs text-[var(--dim)] mb-4">
          {job.client_name ?? "—"} · {job.campaign ?? "—"} · <span className="font-mono">{money(job.amount)}</span>
        </p>

        {/* path A — Morning (dry run) */}
        <button
          onClick={() => {
            setBusy(true);
            onIssue("morning");
          }}
          disabled={busy}
          className="w-full text-white font-bold rounded-xl px-4 py-2.5 text-sm disabled:opacity-40 mb-1"
          style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 14px rgba(139,92,246,0.3)" }}
        >
          הנפק דרך Morning
        </button>
        <p className="text-[10px] text-[var(--amber)] text-center mb-4">הדמיה — MORNING_DRY_RUN פעיל, לא נשלח ל-API אמיתי</p>

        <div className="flex items-center gap-2 mb-3">
          <div className="flex-1 h-px bg-[var(--rule)]" />
          <span className="text-[10px] text-[var(--faint)]">או — כבר הנפקתי במורנינג</span>
          <div className="flex-1 h-px bg-[var(--rule)]" />
        </div>

        {/* path B — manual */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <input value={docNumber} onChange={(e) => setDocNumber(e.target.value)} placeholder="מספר מסמך" className="fin-in" />
          <input type="date" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} className="fin-in" />
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="סכום" className="fin-in" />
          <input value={pdf} onChange={(e) => setPdf(e.target.value)} placeholder="קישור PDF (אופציונלי)" dir="ltr" className="fin-in" />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              setBusy(true);
              onIssue("manual", {
                doc_number: docNumber.trim(),
                issued_at: issuedAt,
                amount: amount ? Number(amount) : undefined,
                pdf_url: pdf.trim() || undefined,
              });
            }}
            disabled={busy || !docNumber.trim()}
            className="border border-[var(--rule2)] rounded-xl px-4 py-2 text-sm text-[var(--ink)] hover:bg-[var(--panel3)] disabled:opacity-40 transition-colors"
          >
            שמור הזנה ידנית
          </button>
          <button onClick={onClose} className="text-[var(--dim)] text-sm px-3">
            ביטול
          </button>
        </div>
      </div>
      <style jsx>{`
        :global(.fin-in) {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid var(--rule);
          border-radius: 10px;
          padding: 8px 10px;
          font-size: 13px;
          outline: none;
        }
        :global(.fin-in:focus) {
          border-color: var(--violet-light);
        }
      `}</style>
    </div>
  );
}

function PaidLoopModal({
  job,
  onClose,
  onIssueNow,
}: {
  job: FinanceJob;
  onClose: () => void;
  onIssueNow: (manual: boolean) => void;
}) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 z-50"
      style={{ background: "rgba(3,2,10,0.66)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm border border-[var(--red)] rounded-2xl p-5 shadow-2xl"
        style={{ background: "rgba(15,13,28,0.94)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
      >
        <h3 className="font-bold mb-1">הכסף נכנס</h3>
        <p className="text-xs text-[var(--dim)] mb-4">
          {job.client_name ?? "—"} · <span className="font-mono">{money(job.amount)}</span> — הונפקה חשבונית מס?
        </p>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => onIssueNow(false)}
            className="text-white font-bold rounded-xl px-4 py-2.5 text-sm"
            style={{ background: "linear-gradient(135deg, var(--red), var(--red-dk))" }}
          >
            הנפק עכשיו
          </button>
          <button
            onClick={() => onIssueNow(true)}
            className="border border-[var(--rule2)] rounded-xl px-4 py-2 text-sm text-[var(--ink)] hover:bg-[var(--panel3)] transition-colors"
          >
            הוזנה ידנית
          </button>
          <button onClick={onClose} className="text-[var(--dim)] text-xs py-1.5 hover:text-[var(--ink)] transition-colors">
            אזכיר לי מחר (נשאר בלשונית האדומה)
          </button>
        </div>
      </div>
    </div>
  );
}
