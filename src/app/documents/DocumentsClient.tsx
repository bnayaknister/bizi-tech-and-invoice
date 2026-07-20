"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

export type PendingDocType = "work_order" | "deal_invoice" | "tax_invoice" | "tax_receipt";

export type PendingDocRow = {
  id: string;
  doc_type: PendingDocType;
  status: string;
  amount: number | null;
  created_at: string;
  age_hours: number;
  aging: "warning" | "critical" | null;
  client_name: string;
  show_name: string;
  record_date: string | null;
  guest: string | null;
  payload: Record<string, unknown>;
  last_error: string | null;
  attempts: number;
};

const TYPE_LABEL: Record<PendingDocType, string> = {
  work_order: "הזמנות עבודה",
  deal_invoice: "חשבוניות עסקה",
  tax_invoice: "חשבוניות מס",
  tax_receipt: "חשבוניות מס קבלה",
};

// Tax documents are issued one at a time behind their own confirmation.
// Mirrors the server rule in the review route — the UI must not offer what
// the server will refuse.
const TAX_TYPES: PendingDocType[] = ["tax_invoice", "tax_receipt"];
const isTax = (t: PendingDocType) => TAX_TYPES.includes(t);

const money = (n: number | null) =>
  n === null ? "—" : new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n);

export default function DocumentsClient({
  rows,
  canApprove,
  dryRun,
  env,
}: {
  rows: PendingDocRow[];
  canApprove: boolean;
  dryRun: boolean;
  env: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  // the second gate for a tax document
  const [confirming, setConfirming] = useState<PendingDocRow | null>(null);
  const [taxVariant, setTaxVariant] = useState<"tax_receipt" | "tax_invoice">("tax_receipt");
  // inline "edit before approve"
  const [editing, setEditing] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState<string>("");
  const [editDesc, setEditDesc] = useState<string>("");

  const groups = useMemo(() => {
    const g = new Map<PendingDocType, PendingDocRow[]>();
    for (const r of rows) {
      const arr = g.get(r.doc_type) ?? [];
      arr.push(r);
      g.set(r.doc_type, arr);
    }
    return g;
  }, [rows]);

  const critical = rows.filter((r) => r.aging === "critical").length;
  const warning = rows.filter((r) => r.aging === "warning").length;

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function send(ids: string[], action: "approve" | "reject", extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/documents/pending/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action, ...extra }),
      });
      const body = await res.json();
      if (res.status === 412 && body.needs_confirmation) {
        // server insisted on the second gate — open it rather than retrying
        const row = rows.find((r) => r.id === ids[0]);
        if (row) {
          setTaxVariant(row.doc_type === "tax_invoice" ? "tax_invoice" : "tax_receipt");
          setConfirming(row);
        }
        return;
      }
      if (!res.ok) {
        setError(body.error ?? "הפעולה נכשלה");
        return;
      }
      const failed = (body.results ?? []).filter((r: { ok: boolean }) => !r.ok);
      if (failed.length) {
        setError(failed.map((f: { detail: string }) => f.detail).join(" · "));
      }
      setSelected(new Set());
      setConfirming(null);
      router.refresh();
    } catch {
      setError("שגיאת רשת");
    } finally {
      setBusy(false);
    }
  }

  function approveOne(r: PendingDocRow) {
    if (isTax(r.doc_type)) {
      setTaxVariant(r.doc_type === "tax_invoice" ? "tax_invoice" : "tax_receipt");
      setConfirming(r);
      return;
    }
    send([r.id], "approve");
  }

  function reject(r: PendingDocRow) {
    const reason = window.prompt("סיבת דחייה (חובה):")?.trim();
    if (!reason) return;
    send([r.id], "reject", { reason });
  }

  function openEdit(r: PendingDocRow) {
    setEditing(r.id);
    setEditAmount(r.amount === null ? "" : String(r.amount));
    const desc = (r.payload as { description?: string })?.description ?? "";
    setEditDesc(desc);
  }

  async function saveEdit(r: PendingDocRow) {
    const amountNum = editAmount.trim() === "" ? undefined : Number(editAmount);
    if (amountNum !== undefined && !(amountNum > 0)) {
      setError("סכום חייב להיות מספר חיובי");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/documents/pending/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id, amount: amountNum, description: editDesc.trim() || undefined }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "העריכה נכשלה");
        return;
      }
      setEditing(null);
      router.refresh();
    } catch {
      setError("שגיאת רשת");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="max-w-4xl mx-auto p-6">
      <h1 className="text-lg font-bold mb-1">מסמכים לאישור</h1>
      <p className="text-xs text-[var(--faint)] mb-4">
        שום מסמך לא יוצא למורנינג בלי אישור אנושי · סביבה: <span className="font-mono">{env}</span>
        {dryRun && <span className="mr-2 text-[var(--peak)] font-bold">DRY RUN — לא נשלח בפועל</span>}
      </p>

      {(critical > 0 || warning > 0) && (
        <div
          className={`mb-4 text-xs rounded-xl px-3 py-2 border ${
            critical > 0 ? "border-[var(--peak)] text-[var(--peak)]" : "border-[var(--warn)] text-[var(--warn)]"
          }`}
        >
          {critical > 0 && <div>🔴 {critical} מסמכים ממתינים מעל 72 שעות</div>}
          {warning > 0 && <div>🟡 {warning} מסמכים ממתינים מעל 24 שעות</div>}
        </div>
      )}

      {error && (
        <div className="mb-4 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2">{error}</div>
      )}

      {rows.length === 0 && (
        <div className="text-center text-sm text-[var(--faint)] py-12 border border-dashed border-[var(--rule)] rounded-2xl">
          אין מסמכים ממתינים לאישור
        </div>
      )}

      {Array.from(groups.entries()).map(([type, list]) => {
        const groupIds = list.filter((r) => r.status === "pending").map((r) => r.id);
        const allSelected = groupIds.length > 0 && groupIds.every((id) => selected.has(id));
        return (
          <section key={type} className="mb-8">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[10px] uppercase tracking-wider font-semibold text-[var(--faint)]">
                {TYPE_LABEL[type]} ({list.length})
              </h2>
              {/* bulk approval — the busy-day case. Never offered for tax
                  documents: each of those needs its own confirmation. */}
              {canApprove && !isTax(type) && groupIds.length > 1 && (
                <button
                  disabled={busy}
                  onClick={() =>
                    allSelected
                      ? send(groupIds, "approve")
                      : setSelected(new Set([...Array.from(selected), ...groupIds]))
                  }
                  className="text-[11px] rounded-xl px-3 py-1 border border-[var(--rule)] hover:bg-[var(--hover)] disabled:opacity-40"
                >
                  {allSelected ? `אשר את כל ${groupIds.length} המסמכים` : `בחר את כל ${groupIds.length}`}
                </button>
              )}
            </div>

            <div className="flex flex-col gap-2">
              {list.map((r) => (
                <div
                  key={r.id}
                  className={`rounded-2xl border p-3 ${
                    r.aging === "critical"
                      ? "border-[var(--peak)]"
                      : r.aging === "warning"
                      ? "border-[var(--warn)]"
                      : "border-[var(--rule)]"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {canApprove && r.status === "pending" && !isTax(r.doc_type) && (
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggle(r.id)}
                        className="mt-1"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm">{r.client_name}</span>
                        <span className="text-xs text-[var(--dim)]">{r.show_name}</span>
                        {r.record_date && <span className="text-xs font-mono text-[var(--faint)]">{r.record_date}</span>}
                        <span className="text-sm font-bold">{money(r.amount)}</span>
                        {r.aging && <span className="text-[10px]">{r.aging === "critical" ? "🔴" : "🟡"} {r.age_hours}ש׳</span>}
                        {r.status === "failed" && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-[var(--peak)] text-[var(--peak)]">
                            נכשל ×{r.attempts}
                          </span>
                        )}
                      </div>
                      {r.last_error && <div className="mt-1 text-xs text-[var(--peak)]">{r.last_error}</div>}
                      <div className="mt-1 flex items-center gap-3">
                        <button
                          onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                          className="text-[11px] text-[var(--faint)] underline"
                        >
                          {expanded === r.id ? "הסתר" : "מה יישלח למורנינג"}
                        </button>
                        {canApprove && editing !== r.id && (
                          <button onClick={() => openEdit(r)} className="text-[11px] text-[var(--faint)] underline">
                            ערוך לפני אישור
                          </button>
                        )}
                      </div>
                      {editing === r.id && (
                        <div className="mt-2 border border-[var(--rule)] rounded-xl p-2 flex flex-col gap-2">
                          <label className="text-[11px]">
                            <span className="text-[var(--faint)]">סכום (₪)</span>
                            <input
                              type="number"
                              value={editAmount}
                              onChange={(e) => setEditAmount(e.target.value)}
                              className="w-full mt-0.5 bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1"
                            />
                          </label>
                          <label className="text-[11px]">
                            <span className="text-[var(--faint)]">תיאור</span>
                            <input
                              value={editDesc}
                              onChange={(e) => setEditDesc(e.target.value)}
                              className="w-full mt-0.5 bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1"
                            />
                          </label>
                          <div className="flex gap-2">
                            <button
                              disabled={busy}
                              onClick={() => saveEdit(r)}
                              className="text-[11px] bg-[var(--signal)] text-white font-bold rounded-lg px-3 py-1 disabled:opacity-40"
                            >
                              שמור
                            </button>
                            <button
                              onClick={() => setEditing(null)}
                              className="text-[11px] rounded-lg px-3 py-1 border border-[var(--rule)]"
                            >
                              ביטול
                            </button>
                          </div>
                        </div>
                      )}
                      {expanded === r.id && (
                        <pre className="mt-2 text-[10px] bg-[var(--hover)] rounded-xl p-2 overflow-x-auto" dir="ltr">
                          {JSON.stringify(r.payload, null, 2)}
                        </pre>
                      )}
                    </div>

                    {canApprove && (
                      <div className="flex flex-col gap-2 shrink-0">
                        <button
                          disabled={busy}
                          onClick={() => approveOne(r)}
                          className="bg-[var(--signal)] text-white text-xs font-bold rounded-xl px-4 py-1.5 disabled:opacity-40"
                        >
                          אשר
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => reject(r)}
                          className="text-xs rounded-xl px-4 py-1.5 border border-[var(--red)] text-[var(--red)] disabled:opacity-40"
                        >
                          דחה
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {canApprove && !isTax(type) && selected.size > 0 && groupIds.some((id) => selected.has(id)) && (
              <button
                disabled={busy}
                onClick={() => send(groupIds.filter((id) => selected.has(id)), "approve")}
                className="mt-3 bg-[var(--signal)] text-white text-xs font-bold rounded-xl px-4 py-2 disabled:opacity-40"
              >
                אשר {groupIds.filter((id) => selected.has(id)).length} מסמכים שנבחרו
              </button>
            )}
          </section>
        );
      })}

      {/* ---- the second gate for a tax document ---- */}
      {confirming && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-[var(--bg)] border border-[var(--rule)] rounded-2xl p-5 max-w-md w-full">
            <h3 className="font-bold text-sm mb-3">אישור הנפקת מסמך מס</h3>
            <div className="text-sm space-y-1 mb-4">
              <div>
                <span className="text-[var(--faint)]">לקוח: </span>
                {confirming.client_name}
              </div>
              <div>
                <span className="text-[var(--faint)]">תוכנית: </span>
                {confirming.show_name}
              </div>
              <div>
                <span className="text-[var(--faint)]">סכום: </span>
                <span className="font-bold">{money(confirming.amount)}</span>
              </div>
              <label className="block pt-2">
                <span className="text-[var(--faint)] text-xs">סוג המסמך</span>
                <select
                  value={taxVariant}
                  onChange={(e) => setTaxVariant(e.target.value as "tax_receipt" | "tax_invoice")}
                  className="w-full mt-1 bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-sm"
                >
                  {/* default: the money is already in */}
                  <option value="tax_receipt">חשבונית מס קבלה</option>
                  <option value="tax_invoice">חשבונית מס</option>
                </select>
              </label>
            </div>
            <p className="text-[11px] text-[var(--peak)] mb-4">
              מסמך מס אינו הפיך מהאפליקציה. ביטול מחייב חשבונית זיכוי במורנינג ישירות.
            </p>
            <div className="flex gap-2">
              <button
                disabled={busy}
                onClick={() => send([confirming.id], "approve", { confirmed: true, tax_variant: taxVariant })}
                className="flex-1 bg-[var(--signal)] text-white text-xs font-bold rounded-xl px-4 py-2 disabled:opacity-40"
              >
                כן, הנפק
              </button>
              <button
                disabled={busy}
                onClick={() => setConfirming(null)}
                className="flex-1 text-xs rounded-xl px-4 py-2 border border-[var(--rule)]"
              >
                ביטול
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
