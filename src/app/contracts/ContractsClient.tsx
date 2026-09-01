"use client";

import { useEffect, useState } from "react";
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
  status: string; // the raw column — what the status menu edits
  state: MilestoneState; // the derived display state (status OR the job's paid)
  job_id: string | null;
  job_number: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  // What the issue button keys off. Separate booleans rather than the collapsed
  // *_number strings above, which cannot distinguish a billed job from a bare
  // one — see the comment beside them in page.tsx.
  has_work_order: boolean; // one is queued/approved/issued for the linked job
  has_deal_invoice: boolean; // the job carries invoice_biz
  has_tax_document: boolean; // the job carries invoice_tax
};
export type ContractCard = {
  id: string;
  name: string;
  client_id: string | null;
  client_name: string | null;
  client_mapped: boolean; // the client has a morning_client_id
  total_amount: number;
  paid_sum: number;
  status: string; // 'active' | 'closed'
  all_paid: boolean;
  milestones: MilestoneCard[];
};

const MS_STATUS_LABEL: Record<string, string> = { pending: "ממתין", invoiced: "חויב", paid: "שולם" };

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
  const [linkJobFor, setLinkJobFor] = useState<{ milestone: MilestoneCard; contract: ContractCard } | null>(null);
  const [closeFor, setCloseFor] = useState<ContractCard | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const closedCount = contracts.filter((c) => c.status !== "active").length;
  const visible = showClosed ? contracts : contracts.filter((c) => c.status === "active");

  // status is not a money-guarded column (0010/0056 guard total_amount,
  // client_id, show_id) — the can_edit_money gate here and in the entity route
  // is the whole protection, same as the milestone edits on this screen.
  async function setContractStatus(c: ContractCard, status: "active" | "closed") {
    setBusyId(c.id);
    const res = await fetch(`/api/entity/contract/${c.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: { status } }),
    });
    setBusyId(null);
    setCloseFor(null);
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? "העדכון נכשל");
      return;
    }
    setError(null);
    router.refresh();
  }

  // One click, no modal. Nothing here needs a human choice: the amount, the
  // client and the description are all derivable from the milestone and its
  // contract, and the human gate this document has to pass is the approval
  // queue — which is where it is going. A modal that only says "are you sure"
  // in front of a gate that already asks is a second lock on the same door.
  async function enqueueWorkOrder(m: MilestoneCard) {
    setBusyId(m.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/contracts/milestones/${m.id}/enqueue`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "ההוספה לתור נכשלה");
        return;
      }
      setNotice(`הזמנת עבודה עבור "${m.name}" נכנסה לתור האישורים — אשרי במסך`);
      // the queue row is 'pending', which the page's fifth query counts, so the
      // refresh is what makes the button disappear
      router.refresh();
    } catch {
      setError("שגיאת רשת");
    } finally {
      setBusyId(null);
    }
  }

  async function setMilestoneStatus(m: MilestoneCard, status: string) {
    setBusyId(m.id);
    const res = await fetch(`/api/contracts/milestones/${m.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: { status } }),
    });
    setBusyId(null);
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? "העדכון נכשל");
      return;
    }
    setError(null);
    router.refresh();
  }

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-lg font-bold flex items-center gap-2.5">
          <IconTile icon="contracts" accent="violet-light" size={30} iconSize={17} />
          חוזים
        </h1>
        <div className="flex-1" />
        {closedCount > 0 && (
          <button
            onClick={() => setShowClosed((v) => !v)}
            className={`text-[11px] border rounded-lg px-2.5 py-1 transition-colors ${
              showClosed
                ? "border-[var(--violet-light)] text-[var(--violet-light)]"
                : "border-[var(--rule)] text-[var(--dim)] hover:bg-[var(--panel3)]"
            }`}
          >
            {showClosed ? "הסתר סגורים" : `הצג סגורים (${closedCount})`}
          </button>
        )}
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
      {notice && (
        <div className="mb-3 text-xs text-[var(--signal)] border border-[var(--signal)] rounded-xl px-3 py-2">
          {notice}{" "}
          <a href="/documents" className="font-bold hover:underline">
            מסמכים לאישור
          </a>
        </div>
      )}

      {visible.length === 0 && (
        <div className="text-center text-sm text-[var(--faint)] py-16 border border-dashed border-[var(--rule)] rounded-2xl">
          {contracts.length === 0
            ? "עדיין אין חוזים. הוסף את הראשון."
            : "אין חוזים פעילים. כל החוזים סגורים."}
        </div>
      )}

      <div className="space-y-5">
        {visible.map((c) => {
          const closed = c.status !== "active";
          const pct = c.total_amount > 0 ? Math.min(100, Math.round((c.paid_sum / c.total_amount) * 100)) : 0;
          const openSum = c.milestones
            .filter((m) => m.state === "open" || m.state === "overdue" || m.state === "invoiced")
            .reduce((t, m) => t + m.amount, 0);
          return (
            <div key={c.id} className="glass-card" style={closed ? { opacity: 0.62 } : undefined}>
              <span className="corner-glow" style={{ ["--glow-color" as string]: closed ? "rgba(148,163,184,0.16)" : "rgba(192,132,252,0.24)" }} />
              <div className="glass-content">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
                  <h2 className="font-bold text-base">{c.name}</h2>
                  <span className="text-xs text-[var(--dim)]">{c.client_name ?? "—"}</span>
                  {closed && (
                    <span className="text-[11px] border border-[var(--rule)] text-[var(--faint)] rounded-lg px-2 py-0.5">סגור</span>
                  )}
                  {!closed && c.all_paid && (
                    <span className="text-[11px] border rounded-lg px-2 py-0.5" style={{ borderColor: "var(--green)", color: "var(--green)" }}>
                      כל אבני הדרך שולמו ✓
                    </span>
                  )}
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
                        {/* a linked job on an open milestone had no trace on
                            this screen before — only paid/invoiced rows showed
                            their invoice number */}
                        {(m.state === "open" || m.state === "overdue") && m.job_id && (
                          <span className="text-[11px] text-[var(--dim)] font-mono">
                            {m.job_number ? `חשבונית ${m.job_number}` : "job מקושר"}
                          </span>
                        )}
                        {(m.state === "open" || m.state === "overdue") && (
                          <span className="text-[11px] flex items-center gap-1" style={{ color: meta.color }}>
                            {m.is_estimated && <span title="מועד משוער">⚠</span>}
                            צפי {heDate(m.expected_date)}
                          </span>
                        )}
                        {canEditMoney && !closed && (
                          <div className="flex items-center gap-1.5" style={{ direction: "rtl" }}>
                            {(m.state === "open" || m.state === "overdue") && (
                              <>
                                {/* Queue a real work order. Hidden once one is
                                    on its way, and once the job has been billed
                                    at all — an order for work already invoiced
                                    is backwards. An unmapped client leaves it
                                    VISIBLE but disabled: that refusal is the one
                                    she can fix herself, and a button that simply
                                    vanishes teaches her nothing. */}
                                {!m.has_work_order && !m.has_deal_invoice && !m.has_tax_document && (
                                  <button
                                    onClick={() => enqueueWorkOrder(m)}
                                    disabled={busyId === m.id || !c.client_mapped}
                                    title={
                                      c.client_mapped
                                        ? "מכניס הזמנת עבודה לתור האישורים — לא נשלח למורנינג עד לאישור"
                                        : `הלקוח ${c.client_name ?? ""} לא ממופה למורנינג — אי אפשר להנפיק`
                                    }
                                    className="text-[11px] font-bold rounded-lg px-2.5 py-1 bg-[var(--signal)] text-white disabled:opacity-40 transition-colors"
                                  >
                                    {busyId === m.id ? "מוסיף לתור…" : "הנפק הזמנת עבודה"}
                                  </button>
                                )}
                                {/* Records a document raised by hand in Morning
                                    — it issues nothing. Named for what it does
                                    since 2026-09-01; it read "הנפק חשבונית",
                                    which its own modal then contradicted. */}
                                <button
                                  onClick={() => setIssueFor(m)}
                                  className={`text-[11px] border rounded-lg px-2.5 py-1 transition-colors ${
                                    m.state === "overdue"
                                      ? "border-[var(--red)] text-[var(--red)] hover:bg-[rgba(251,113,133,0.08)]"
                                      : "border-[var(--rule)] text-[var(--dim)] hover:bg-[var(--panel3)]"
                                  }`}
                                >
                                  רשום מסמך שהונפק
                                </button>
                                <button
                                  onClick={() => setEditDateFor(m)}
                                  className="text-[11px] border border-[var(--rule)] rounded-lg px-2.5 py-1 text-[var(--dim)] hover:bg-[var(--panel3)] transition-colors"
                                >
                                  ערוך מועד
                                </button>
                              </>
                            )}
                            {/* available on EVERY state: an invoiced or paid
                                milestone had no action at all until now */}
                            <select
                              value={m.status}
                              disabled={busyId === m.id}
                              onChange={(e) => setMilestoneStatus(m, e.target.value)}
                              title={
                                m.job_id
                                  ? "לאבן דרך זו יש job מקושר — אם ה-job מסומן כשולם, השורה תישאר ירוקה גם אם תחזיר את הסטטוס לאחור"
                                  : undefined
                              }
                              className="text-[11px] border border-[var(--rule)] rounded-lg px-2 py-1 text-[var(--dim)] bg-transparent hover:bg-[var(--panel3)] transition-colors disabled:opacity-40"
                            >
                              {Object.entries(MS_STATUS_LABEL).map(([v, l]) => (
                                <option key={v} value={v} style={{ background: "var(--panel3)" }}>
                                  {l}
                                </option>
                              ))}
                            </select>
                            <button
                              onClick={() => setLinkJobFor({ milestone: m, contract: c })}
                              className="text-[11px] border border-[var(--rule)] rounded-lg px-2.5 py-1 text-[var(--dim)] hover:bg-[var(--panel3)] transition-colors"
                            >
                              {m.job_id ? "שנה job" : "קשר job"}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {c.milestones.length === 0 && <div className="text-xs text-[var(--faint)]">אין אבני דרך.</div>}
                </div>

                {canEditMoney && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {!closed && (
                      <button
                        onClick={() => setAddMsFor(c)}
                        className="text-[11px] text-[var(--dim)] border border-dashed border-[var(--rule)] rounded-lg px-3 py-1.5 hover:bg-[var(--panel3)] transition-colors"
                      >
                        + אבן דרך
                      </button>
                    )}
                    <div className="flex-1" />
                    {/* closing is reversible from this same card — there is no
                        other UI that can reopen a contract (the entity drawer
                        isn't reachable from anywhere yet) */}
                    <button
                      disabled={busyId === c.id}
                      onClick={() => (closed ? setContractStatus(c, "active") : setCloseFor(c))}
                      className="text-[11px] border border-[var(--rule)] rounded-lg px-2.5 py-1 text-[var(--dim)] hover:bg-[var(--panel3)] transition-colors disabled:opacity-40"
                    >
                      {closed ? "החזר לפעיל" : "סגור חוזה"}
                    </button>
                  </div>
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
      {linkJobFor && (
        <LinkJobModal
          milestone={linkJobFor.milestone}
          contract={linkJobFor.contract}
          onClose={() => setLinkJobFor(null)}
          onDone={() => {
            setLinkJobFor(null);
            router.refresh();
          }}
          onError={setError}
        />
      )}
      {closeFor && (
        <CloseContractModal
          contract={closeFor}
          busy={busyId === closeFor.id}
          onClose={() => setCloseFor(null)}
          onConfirm={() => setContractStatus(closeFor, "closed")}
        />
      )}
    </div>
  );
}

// Closing is what silences the radar (alerts.ts filters milestones by their
// contract's status), so the count of milestones that are about to go quiet is
// the whole content of this confirmation — not a generic "are you sure".
function CloseContractModal({
  contract,
  busy,
  onClose,
  onConfirm,
}: {
  contract: ContractCard;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const openCount = contract.milestones.filter((m) => m.state !== "paid").length;
  return (
    <div className="fixed inset-0 flex items-center justify-center p-4 z-50" style={OVERLAY} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl" style={PANEL}>
        <h3 className="font-bold mb-3">סגירת חוזה — {contract.name}</h3>
        {openCount > 0 ? (
          <p className="text-xs text-[var(--dim)] mb-4 leading-relaxed">
            בחוזה {openCount} אבני דרך שטרם שולמו. סגירה תשתיק אותן ברדאר — הן ייצאו מ&quot;התחייבות פתוחה&quot;
            ומהתראות אבני הדרך.
          </p>
        ) : (
          <p className="text-xs text-[var(--dim)] mb-4 leading-relaxed">כל אבני הדרך שולמו. החוזה ייצא מהתצוגה הפעילה.</p>
        )}
        <p className="text-[11px] text-[var(--faint)] mb-4">אפשר להחזיר לפעיל בכל רגע מאותו כרטיס.</p>
        <div className="flex gap-2">
          <button
            onClick={onConfirm}
            disabled={busy}
            className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
            style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
          >
            סגור חוזה
          </button>
          <button onClick={onClose} className="text-[var(--dim)] text-sm px-3">ביטול</button>
        </div>
      </div>
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
            morningCreate
            canEditMoney
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

// Attach a milestone to a job that already exists — the counterpart to the
// issue route, which only ever CREATES one. Reuses /api/finance/jobs-search
// (the same free-text picker the document registry uses). The server re-checks
// everything shown here; the client-side filtering below is a courtesy, not
// the enforcement.
type SearchJob = {
  id: string;
  client_id: string | null;
  client_name: string | null;
  show_name: string | null;
  campaign: string | null;
  amount: number | null;
  date: string | null;
  status: string;
};

function LinkJobModal({
  milestone,
  contract,
  onClose,
  onDone,
  onError,
}: {
  milestone: MilestoneCard;
  contract: ContractCard;
  onClose: () => void;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchJob[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // second gate before any write: re-pointing a milestone at a different job
  // moves which invoice this money is tracked against, and the display state
  // reads the job's `paid` — so a mis-click silently changes whether the
  // milestone reads as paid. `null` here = an unlink.
  const [confirm, setConfirm] = useState<{ job: SearchJob | null } | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      fetch(`/api/finance/jobs-search?q=${encodeURIComponent(q.trim())}`)
        .then((r) => r.json())
        .then((b) => setResults(b.jobs ?? []))
        .catch(() => setErr("שגיאת רשת"))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  async function link(jobId: string | null) {
    setBusy(true);
    setErr(null);
    setConfirm(null);
    const res = await fetch(`/api/contracts/milestones/${milestone.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: { job_id: jobId } }),
    });
    setBusy(false);
    if (!res.ok) {
      // stays open on rejection — the three validations are the point of this
      // screen, and the bookkeeper needs to read which one fired and retry
      setErr((await res.json().catch(() => ({}))).error ?? "הקישור נכשל");
      return;
    }
    onError("");
    onDone();
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center p-4 z-50" style={OVERLAY} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl max-h-[88vh] overflow-y-auto" style={PANEL}>
        <h3 className="font-bold mb-1">קישור job — {milestone.name}</h3>
        <p className="text-[11px] text-[var(--dim)] mb-4">
          רק job של {contract.client_name ?? "לקוח החוזה"}, שאינו מקושר כבר לאבן דרך אחרת.
        </p>

        {milestone.job_id && (
          <div className="flex items-center gap-2 mb-3 text-xs border border-[var(--rule)] rounded-xl px-3 py-2">
            <span className="text-[var(--dim)]">מקושר כעת:</span>
            <span className="font-mono">{milestone.job_number ?? milestone.job_id.slice(0, 8)}</span>
            <div className="flex-1" />
            <button onClick={() => setConfirm({ job: null })} disabled={busy} className="text-[11px] text-[var(--red)] hover:underline disabled:opacity-40">
              נתק
            </button>
          </div>
        )}

        {err && <div className="mb-3 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2">{err}</div>}

        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="חיפוש job — לקוח, תוכנית, אורח, סכום, תאריך"
          className={`${INPUT} mb-3`}
          style={inputBg}
          autoFocus
        />

        {searching && <div className="text-xs text-[var(--faint)] mb-2">מחפש…</div>}
        {!searching && q.trim().length >= 2 && results.length === 0 && (
          <div className="text-xs text-[var(--faint)] mb-2">לא נמצאו תוצאות.</div>
        )}

        <div className="space-y-1.5">
          {results.map((j) => {
            const otherClient = j.client_id !== contract.client_id;
            return (
              <button
                key={j.id}
                onClick={() => setConfirm({ job: j })}
                disabled={busy || otherClient}
                className="w-full text-right border border-[var(--rule)] rounded-xl px-3 py-2 hover:bg-[var(--panel3)] transition-colors disabled:opacity-35 disabled:hover:bg-transparent"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                  <span className="font-medium">{j.campaign ?? "—"}</span>
                  <span className="text-[var(--dim)]">{j.client_name ?? "—"}</span>
                  {j.show_name && <span className="text-[var(--faint)]">{j.show_name}</span>}
                  <div className="flex-1" />
                  <span className="font-mono">{money(j.amount)}</span>
                  <span className="text-[var(--faint)] font-mono">{j.date ? heDate(j.date) : "—"}</span>
                </div>
                {otherClient && <div className="text-[10px] text-[var(--red)] mt-1">לקוח אחר — לא ניתן לקישור</div>}
              </button>
            );
          })}
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="text-[var(--dim)] text-sm px-3">סגור</button>
        </div>

        {confirm && (
          <div className="fixed inset-0 flex items-center justify-center p-4 z-[60]" style={OVERLAY} onClick={() => setConfirm(null)}>
            <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl" style={PANEL}>
              <h3 className="font-bold mb-3">{confirm.job ? "שינוי קישור" : "ניתוק קישור"}</h3>
              <p className="text-xs text-[var(--dim)] mb-3 leading-relaxed">
                {confirm.job ? (
                  <>
                    משנה קישור של &quot;{milestone.name}&quot; מחשבונית{" "}
                    <span className="font-mono">{milestone.job_number ?? (milestone.job_id ? milestone.job_id.slice(0, 8) : "ללא")}</span> ל־
                    <span className="font-mono">{confirm.job.campaign ?? confirm.job.id.slice(0, 8)}</span>
                    {confirm.job.amount != null ? ` (${money(confirm.job.amount)})` : ""}.
                  </>
                ) : (
                  <>
                    מנתק את &quot;{milestone.name}&quot; מחשבונית{" "}
                    <span className="font-mono">{milestone.job_number ?? (milestone.job_id ? milestone.job_id.slice(0, 8) : "ללא")}</span>.
                  </>
                )}
              </p>
              <p className="text-[11px] text-[var(--peak)] mb-4">פעולה זו משנה את מעקב התשלום.</p>
              <div className="flex gap-2">
                <button
                  onClick={() => link(confirm.job ? confirm.job.id : null)}
                  disabled={busy}
                  className="text-white font-bold rounded-xl px-4 py-2 text-sm disabled:opacity-40"
                  style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
                >
                  {confirm.job ? "שנה קישור" : "נתק"}
                </button>
                <button onClick={() => setConfirm(null)} className="text-[var(--dim)] text-sm px-3">ביטול</button>
              </div>
            </div>
          </div>
        )}
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

  async function go(mode: "manual") {
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
        <p className="text-[11px] text-[var(--dim)] mb-4">
          כאן רושמים מסמך שהונפק כבר במורנינג. להנפקה עצמה — תור האישורים ב
          <a href="/documents" className="text-[var(--signal)] font-bold hover:underline"> מסמכים</a>.
        </p>
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
