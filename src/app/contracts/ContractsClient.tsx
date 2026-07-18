"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import IconTile from "@/components/IconTile";
import ClientCombobox from "@/components/ClientCombobox";
import { MILESTONE_META, type MilestoneState } from "@/lib/finance/milestone";

export type MilestoneCard = {
  id: string;
  name: string;
  amount: number;
  expected_date: string | null;
  is_estimated: boolean;
  state: MilestoneState;
  invoice_number: string | null;
  invoice_date: string | null;
};
export type ContractCard = {
  id: string;
  name: string;
  client_name: string | null;
  total_amount: number;
  paid_sum: number;
  milestones: MilestoneCard[];
};

const NIS = new Intl.NumberFormat("he-IL");
const money = (n: number | null | undefined) => (n == null ? "—" : `${NIS.format(Math.round(n))} ₪`);
function heDate(d: string | null): string {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${Number(day)}.${Number(m)}.${y.slice(2)}`;
}

export default function ContractsClient({
  contracts,
  clients,
  canEditMoney,
}: {
  contracts: ContractCard[];
  clients: { id: string; name: string }[];
  canEditMoney: boolean;
}) {
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [issueFor, setIssueFor] = useState<MilestoneCard | null>(null);
  const [editDateFor, setEditDateFor] = useState<MilestoneCard | null>(null);
  const [addMsFor, setAddMsFor] = useState<ContractCard | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-lg font-bold flex items-center gap-2.5">
          <IconTile icon="contracts" accent="violet-light" size={30} iconSize={17} />
          חוזים
        </h1>
        <div className="flex-1" />
        {canEditMoney && (
          <button
            onClick={() => setAddOpen(true)}
            className="text-xs text-white font-bold rounded-xl px-3 py-1.5"
            style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 14px rgba(139,92,246,0.3)" }}
          >
            + חוזה חדש
          </button>
        )}
      </div>

      {error && <div className="mb-3 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2">{error}</div>}

      {contracts.length === 0 && (
        <div className="text-center text-sm text-[var(--faint)] py-16 border border-dashed border-[var(--rule)] rounded-2xl">
          עדיין אין חוזים. הוסף את הראשון.
        </div>
      )}

      <div className="space-y-5">
        {contracts.map((c) => {
          const pct = c.total_amount > 0 ? Math.min(100, Math.round((c.paid_sum / c.total_amount) * 100)) : 0;
          const openSum = c.milestones
            .filter((m) => m.state === "open" || m.state === "overdue" || m.state === "invoiced")
            .reduce((t, m) => t + m.amount, 0);
          return (
            <div key={c.id} className="glass-card">
              <span className="corner-glow" style={{ ["--glow-color" as string]: "rgba(192,132,252,0.24)" }} />
              <div className="glass-content">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
                  <h2 className="font-bold text-base">{c.name}</h2>
                  <span className="text-xs text-[var(--dim)]">{c.client_name ?? "—"}</span>
                  <div className="flex-1" />
                  <span className="font-mono text-sm">{money(c.total_amount)}</span>
                </div>

                {/* the central visual: a gradient progress bar (paid / total) */}
                <div className="mb-1">
                  <div className="h-3 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                    <div
                      className="h-full rounded-full transition-[width] duration-500"
                      style={{ width: `${pct}%`, background: "linear-gradient(90deg, var(--violet), var(--cyan))" }}
                    />
                  </div>
                  <div className="flex items-center justify-between mt-1.5 text-[11px]">
                    <span className="font-mono text-[var(--green)]">{money(c.paid_sum)} שולם</span>
                    {openSum > 0 && <span className="font-mono text-[var(--cyan)]">{money(openSum)} התחייבות פתוחה</span>}
                    <span className="font-mono text-[var(--faint)]">{pct}%</span>
                  </div>
                </div>

                {/* milestones */}
                <div className="mt-4 space-y-2">
                  {c.milestones.map((m) => {
                    const meta = MILESTONE_META[m.state];
                    return (
                      <div
                        key={m.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[var(--rule)] px-3 py-2"
                        style={{ background: "rgba(255,255,255,0.02)" }}
                      >
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: meta.dot }} />
                        <span className="text-sm font-medium">{m.name}</span>
                        <span className="font-mono text-sm">{money(m.amount)}</span>
                        <span className="text-[11px]" style={{ color: meta.color }}>
                          {meta.label}
                        </span>
                        <div className="flex-1" />
                        {(m.state === "paid" || m.state === "invoiced") && m.invoice_number && (
                          <span className="text-[11px] text-[var(--dim)] font-mono">
                            חשבונית {m.invoice_number}
                            {m.invoice_date ? ` · ${heDate(m.invoice_date)}` : ""}
                          </span>
                        )}
                        {(m.state === "open" || m.state === "overdue") && (
                          <span className="text-[11px] flex items-center gap-1" style={{ color: meta.color }}>
                            {m.is_estimated && <span title="מועד משוער">⚠</span>}
                            צפי {heDate(m.expected_date)}
                          </span>
                        )}
                        {canEditMoney && (m.state === "open" || m.state === "overdue") && (
                          <div className="flex items-center gap-1.5" style={{ direction: "rtl" }}>
                            <button
                              onClick={() => setIssueFor(m)}
                              className={`text-[11px] border rounded-lg px-2.5 py-1 transition-colors ${
                                m.state === "overdue"
                                  ? "border-[var(--red)] text-[var(--red)] hover:bg-[rgba(251,113,133,0.08)]"
                                  : "border-[var(--rule)] text-[var(--dim)] hover:bg-[var(--panel3)]"
                              }`}
                            >
                              הנפק חשבונית
                            </button>
                            <button
                              onClick={() => setEditDateFor(m)}
                              className="text-[11px] border border-[var(--rule)] rounded-lg px-2.5 py-1 text-[var(--dim)] hover:bg-[var(--panel3)] transition-colors"
                            >
                              ערוך מועד
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {c.milestones.length === 0 && <div className="text-xs text-[var(--faint)]">אין אבני דרך.</div>}
                </div>

                {canEditMoney && (
                  <button
                    onClick={() => setAddMsFor(c)}
                    className="mt-3 text-[11px] text-[var(--dim)] border border-dashed border-[var(--rule)] rounded-lg px-3 py-1.5 hover:bg-[var(--panel3)] transition-colors"
                  >
                    + אבן דרך
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {addOpen && (
        <AddContractModal
          clients={clients}
          onClose={() => setAddOpen(false)}
          onDone={() => {
            setAddOpen(false);
            router.refresh();
          }}
          onError={setError}
        />
      )}
      {addMsFor && (
        <AddMilestoneModal
          contract={addMsFor}
          onClose={() => setAddMsFor(null)}
          onDone={() => {
            setAddMsFor(null);
            router.refresh();
          }}
          onError={setError}
        />
      )}
      {issueFor && (
        <IssueModal
          milestone={issueFor}
          onClose={() => setIssueFor(null)}
          onDone={() => {
            setIssueFor(null);
            router.refresh();
          }}
          onError={setError}
        />
      )}
      {editDateFor && (
        <EditDateModal
          milestone={editDateFor}
          onClose={() => setEditDateFor(null)}
          onDone={() => {
            setEditDateFor(null);
            router.refresh();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

// ---------- modals ----------
const OVERLAY = { background: "rgba(3,2,10,0.66)", backdropFilter: "blur(6px)" } as React.CSSProperties;
const PANEL = {
  background: "rgba(15,13,28,0.94)",
  backdropFilter: "blur(24px)",
  WebkitBackdropFilter: "blur(24px)",
} as React.CSSProperties;
const INPUT =
  "w-full border border-[var(--rule)] rounded-xl px-3 py-2 text-sm focus:border-[var(--violet-light)] outline-none transition-colors";
const inputBg = { background: "rgba(255,255,255,0.05)" } as React.CSSProperties;

function AddContractModal({
  clients,
  onClose,
  onDone,
  onError,
}: {
  clients: { id: string; name: string }[];
  onClose: () => void;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState<string | null>(null);
  const [total, setTotal] = useState("");
  const [ms, setMs] = useState<{ name: string; amount: string; expected_date: string; is_estimated: boolean }[]>([
    { name: "", amount: "", expected_date: "", is_estimated: false },
  ]);
  const [busy, setBusy] = useState(false);
  const [localClients, setLocalClients] = useState(clients);

  async function submit() {
    setBusy(true);
    const res = await fetch("/api/contracts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        client_id: clientId,
        total_amount: total ? Number(total) : null,
        milestones: ms
          .filter((m) => m.name.trim() && m.amount)
          .map((m) => ({
            name: m.name.trim(),
            amount: Number(m.amount),
            expected_date: m.expected_date || null,
            is_estimated: m.is_estimated,
          })),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      onError((await res.json().catch(() => ({}))).error ?? "היצירה נכשלה");
      onClose();
      return;
    }
    onDone();
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center p-4 z-50" style={OVERLAY} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl max-h-[88vh] overflow-y-auto" style={PANEL}>
        <h3 className="font-bold mb-3">חוזה חדש</h3>
        <div className="space-y-2 mb-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="שם החוזה" className={INPUT} style={inputBg} />
          <ClientCombobox
            clients={localClients}
            value={clientId}
            onChange={setClientId}
            onCreated={(c) => setLocalClients((cs) => [...cs, c])}
          />
          <input value={total} onChange={(e) => setTotal(e.target.value)} type="number" placeholder="סכום כולל" className={INPUT} style={inputBg} />
        </div>
        <div className="text-[11px] text-[var(--faint)] mb-1">אבני דרך</div>
        <div className="space-y-2 mb-3">
          {ms.map((m, i) => (
            <div key={i} className="grid grid-cols-[1fr_80px_110px] gap-1.5">
              <input value={m.name} onChange={(e) => setMs((a) => a.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="שם" className={INPUT} style={inputBg} />
              <input value={m.amount} onChange={(e) => setMs((a) => a.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} type="number" placeholder="סכום" className={INPUT} style={inputBg} />
              <input value={m.expected_date} onChange={(e) => setMs((a) => a.map((x, j) => (j === i ? { ...x, expected_date: e.target.value } : x)))} type="date" className={INPUT} style={inputBg} />
            </div>
          ))}
          <button onClick={() => setMs((a) => [...a, { name: "", amount: "", expected_date: "", is_estimated: false }])} className="text-[11px] text-[var(--dim)] underline">
            + עוד אבן דרך
          </button>
        </div>
        <div className="flex gap-2">
          <button onClick={submit} disabled={busy || !name.trim() || !clientId || !total} className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40" style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}>
            צור חוזה
          </button>
          <button onClick={onClose} className="text-[var(--dim)] text-sm px-3">ביטול</button>
        </div>
      </div>
    </div>
  );
}

function AddMilestoneModal({ contract, onClose, onDone, onError }: { contract: ContractCard; onClose: () => void; onDone: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [est, setEst] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    const res = await fetch(`/api/contracts/${contract.id}/milestones`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, amount: amount ? Number(amount) : null, expected_date: date || null, is_estimated: est }),
    });
    setBusy(false);
    if (!res.ok) {
      onError((await res.json().catch(() => ({}))).error ?? "ההוספה נכשלה");
      onClose();
      return;
    }
    onDone();
  }
  return (
    <div className="fixed inset-0 flex items-center justify-center p-4 z-50" style={OVERLAY} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl" style={PANEL}>
        <h3 className="font-bold mb-3">אבן דרך — {contract.name}</h3>
        <div className="space-y-2 mb-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="שם" className={INPUT} style={inputBg} />
          <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" placeholder="סכום" className={INPUT} style={inputBg} />
          <input value={date} onChange={(e) => setDate(e.target.value)} type="date" className={INPUT} style={inputBg} />
          <label className="flex items-center gap-2 text-xs text-[var(--dim)] cursor-pointer">
            <input type="checkbox" checked={est} onChange={(e) => setEst(e.target.checked)} /> מועד משוער
          </label>
        </div>
        <div className="flex gap-2">
          <button onClick={submit} disabled={busy || !name.trim() || !amount} className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40" style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}>
            הוסף
          </button>
          <button onClick={onClose} className="text-[var(--dim)] text-sm px-3">ביטול</button>
        </div>
      </div>
    </div>
  );
}

function EditDateModal({ milestone, onClose, onDone, onError }: { milestone: MilestoneCard; onClose: () => void; onDone: () => void; onError: (m: string) => void }) {
  const [date, setDate] = useState(milestone.expected_date ?? "");
  const [est, setEst] = useState(milestone.is_estimated);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    const res = await fetch(`/api/contracts/milestones/${milestone.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: { expected_date: date || null, is_estimated: est } }),
    });
    setBusy(false);
    if (!res.ok) {
      onError((await res.json().catch(() => ({}))).error ?? "העדכון נכשל");
      onClose();
      return;
    }
    onDone();
  }
  return (
    <div className="fixed inset-0 flex items-center justify-center p-4 z-50" style={OVERLAY} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl" style={PANEL}>
        <h3 className="font-bold mb-3">מועד — {milestone.name}</h3>
        <input value={date} onChange={(e) => setDate(e.target.value)} type="date" className={`${INPUT} mb-2`} style={inputBg} />
        <label className="flex items-center gap-2 text-xs text-[var(--dim)] cursor-pointer mb-4">
          <input type="checkbox" checked={est} onChange={(e) => setEst(e.target.checked)} /> מועד משוער
        </label>
        <div className="flex gap-2">
          <button onClick={submit} disabled={busy} className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40" style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}>
            שמור
          </button>
          <button onClick={onClose} className="text-[var(--dim)] text-sm px-3">ביטול</button>
        </div>
      </div>
    </div>
  );
}

function IssueModal({ milestone, onClose, onDone, onError }: { milestone: MilestoneCard; onClose: () => void; onDone: () => void; onError: (m: string) => void }) {
  const [docNumber, setDocNumber] = useState("");
  const [issuedAt, setIssuedAt] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState(String(milestone.amount));
  const [pdf, setPdf] = useState("");
  const [busy, setBusy] = useState(false);

  async function go(mode: "morning" | "manual") {
    setBusy(true);
    const res = await fetch(`/api/contracts/milestones/${milestone.id}/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        doc_number: docNumber.trim() || undefined,
        issued_at: issuedAt,
        amount: amount ? Number(amount) : undefined,
        pdf_url: pdf.trim() || undefined,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      onError((await res.json().catch(() => ({}))).error ?? "ההנפקה נכשלה");
      onClose();
      return;
    }
    onDone();
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center p-4 z-50" style={OVERLAY} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl" style={PANEL}>
        <h3 className="font-bold mb-1">הנפקת חשבונית — {milestone.name}</h3>
        <p className="text-xs text-[var(--dim)] mb-4 font-mono">{money(milestone.amount)}</p>
        <button onClick={() => go("morning")} disabled={busy} className="w-full text-white font-bold rounded-xl px-4 py-2.5 text-sm disabled:opacity-40 mb-1" style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 14px rgba(139,92,246,0.3)" }}>
          הנפק דרך Morning
        </button>
        <p className="text-[10px] text-[var(--amber)] text-center mb-4">הדמיה — MORNING_DRY_RUN פעיל</p>
        <div className="flex items-center gap-2 mb-3">
          <div className="flex-1 h-px bg-[var(--rule)]" />
          <span className="text-[10px] text-[var(--faint)]">או — כבר הנפקתי במורנינג</span>
          <div className="flex-1 h-px bg-[var(--rule)]" />
        </div>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <input value={docNumber} onChange={(e) => setDocNumber(e.target.value)} placeholder="מספר מסמך" className={INPUT} style={inputBg} />
          <input value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} type="date" className={INPUT} style={inputBg} />
          <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" placeholder="סכום" className={INPUT} style={inputBg} />
          <input value={pdf} onChange={(e) => setPdf(e.target.value)} placeholder="קישור PDF" dir="ltr" className={INPUT} style={inputBg} />
        </div>
        <div className="flex gap-2">
          <button onClick={() => go("manual")} disabled={busy || !docNumber.trim()} className="border border-[var(--rule2)] rounded-xl px-4 py-2 text-sm text-[var(--ink)] hover:bg-[var(--panel3)] disabled:opacity-40 transition-colors">
            שמור הזנה ידנית
          </button>
          <button onClick={onClose} className="text-[var(--dim)] text-sm px-3">ביטול</button>
        </div>
      </div>
    </div>
  );
}
