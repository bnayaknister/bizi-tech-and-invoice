"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useDrawer } from "@/components/EntityDrawer";
import AssignDocModal from "@/components/AssignDocModal";
import NewDocModal from "./NewDocModal";
import { REGISTRY_TAB_LABEL, type RegistryTab } from "@/lib/morning/types";

const BILLING_TYPES = [300, 305, 320, 400]; // deal / tax / tax-receipt / receipt — real חיוב, linkable to a job
const isBilling = (t: number) => BILLING_TYPES.includes(t);

export type DocRow = {
  id: string;
  morning_doc_id: string | null;
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
  cancelled_at: string | null;
  cancel_reason: string | null;
  archived_at: string | null;
  archive_reason: string | null;
};

// tab order = the owner's five, then "other", then the unmatched bucket which
// is a client-match state, not a Morning type (owner: "לשונית לא משויך")
const TAB_ORDER: (RegistryTab | "unmatched" | "cancelled" | "archived")[] = [
  "work_order",
  "deal_invoice",
  "tax_invoice",
  "tax_receipt",
  "receipt",
  "other",
  "unmatched",
  "cancelled",
  "archived",
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
  const [tab, setTab] = useState<RegistryTab | "unmatched" | "cancelled" | "archived">("work_order");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"date" | "amount">("date");
  const [pulling, setPulling] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [assignDoc, setAssignDoc] = useState<DocRow | null>(null);
  const [cancelDoc, setCancelDoc] = useState<DocRow | null>(null);
  const [newDoc, setNewDoc] = useState<"work_order" | "deal_invoice" | null>(null);
  // in "לא משויך", quotes/orders/credits are noise for the bookkeeper — show
  // only real billing docs by default (owner spec 2026-07-27), the rest behind a toggle
  const [showNonBilling, setShowNonBilling] = useState(false);

  const counts = useMemo(() => {
    const c: Record<string, { n: number; total: number }> = {};
    for (const t of TAB_ORDER) c[t] = { n: 0, total: 0 };
    for (const r of rows) {
      // cancelled / archived docs live only in their own quiet tab
      const key = r.archived_at ? "archived" : r.cancelled_at ? "cancelled" : r.client_id ? r.tab : "unmatched";
      c[key].n++;
      c[key].total += r.amount ?? 0;
    }
    return c;
  }, [rows]);

  const shown = useMemo(() => {
    const term = q.trim();
    const list = rows.filter((r) => {
      // archived / cancelled docs show ONLY in their own tab; excluded elsewhere
      if (tab === "archived") {
        if (!r.archived_at) return false;
      } else if (tab === "cancelled") {
        if (!r.cancelled_at || r.archived_at) return false;
      } else if (r.cancelled_at || r.archived_at) {
        return false;
      }
      const inTab =
        tab === "archived" || tab === "cancelled"
          ? true
          : tab === "unmatched"
            ? !r.client_id
            : r.tab === tab && r.client_id;
      if (!inTab) return false;
      // in the unassigned tab, hide non-billing docs (quotes/orders/credits) unless asked
      if (tab === "unmatched" && !showNonBilling && !isBilling(r.type)) return false;
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
  }, [rows, tab, q, sort, showNonBilling]);

  // how many non-billing (quotes/orders/credits) are hidden in the unassigned tab
  const hiddenNonBilling = useMemo(
    () => (tab === "unmatched" ? rows.filter((r) => !r.client_id && !isBilling(r.type)).length : 0),
    [rows, tab]
  );

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
      setMsg(
        `נמשכו ${body.pulled} · חדשים ${body.inserted} · שויכו ללקוח ${body.backfilled ?? 0} · שויכו ל-job ${body.linked ?? 0} · לא משויכים ${body.unmatched}`
      );
      router.refresh();
    } catch {
      setMsg("שגיאת רשת");
    } finally {
      setPulling(false);
    }
  }

  async function archiveRow(r: DocRow, restore: boolean) {
    setMsg(null);
    try {
      const res = await fetch(`/api/documents/${r.id}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: restore ? "restore" : "archive" }),
      });
      if (!res.ok) {
        const b = await res.json();
        setMsg(b.error ?? "הפעולה נכשלה");
        return;
      }
      router.refresh();
    } catch {
      setMsg("שגיאת רשת");
    }
  }

  async function bulkArchive() {
    try {
      const info = await (await fetch("/api/documents/archive")).json();
      const n = info.qualifying ?? 0;
      if (n === 0) {
        setMsg("אין מסמכים ישנים לא-משויכים לארכוב");
        return;
      }
      if (!confirm(`לארכב ${n} מסמכים לא-משויכים ישנים (לקוח לא קיים · מעל 90 יום · אין job)? ניתן לשחזר תמיד.`)) return;
      const res = await fetch("/api/documents/archive", { method: "POST" });
      const b = await res.json();
      if (!res.ok) {
        setMsg(b.error ?? "הארכוב נכשל");
        return;
      }
      setMsg(`אורכבו ${b.archived} מסמכים`);
      router.refresh();
    } catch {
      setMsg("שגיאת רשת");
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
        <div className="flex items-center gap-3">
          {lastPull && canPull && (
            <span className="text-[11px] text-[var(--faint)]">
              נמשך לאחרונה: {new Date(lastPull).toLocaleString("he-IL")}
            </span>
          )}
          <button
            onClick={() => router.push("/documents/gaps")}
            className="text-xs font-bold rounded-xl px-4 py-1.5 border border-[var(--rule2)]"
          >
            פערים לטיפול →
          </button>
          {canPull && (
            <button
              disabled={pulling}
              onClick={pullNow}
              className="text-xs font-bold rounded-xl px-4 py-1.5 border border-[var(--rule2)] disabled:opacity-40"
            >
              {pulling ? "מושך…" : "משוך ממורנינג"}
            </button>
          )}
        </div>
      </div>
      {msg && <div className="mb-3 text-xs text-[var(--dim)] border border-[var(--rule)] rounded-xl px-3 py-2">{msg}</div>}

      {/* tabs */}
      <div className="flex flex-wrap gap-1.5 mb-4 border-b border-[var(--rule)] pb-2">
        {TAB_ORDER.map((t) => {
          const label =
            t === "unmatched" ? "לא משויך" : t === "cancelled" ? "מבוטלים" : t === "archived" ? "ארכיון" : REGISTRY_TAB_LABEL[t];
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
        {canPull && (tab === "work_order" || tab === "deal_invoice") && (
          <button
            onClick={() => setNewDoc(tab === "work_order" ? "work_order" : "deal_invoice")}
            className="rounded-xl px-3 py-1.5 border border-[var(--rule2)] shrink-0 font-bold text-[var(--signal)]"
          >
            {tab === "work_order" ? "+ הזמנת עבודה חדשה" : "+ חשבון עסקה חדש"}
          </button>
        )}
        {tab === "unmatched" && hiddenNonBilling > 0 && (
          <button
            onClick={() => setShowNonBilling((v) => !v)}
            className="rounded-xl px-3 py-1.5 border border-[var(--rule)] shrink-0 text-[var(--faint)]"
          >
            {showNonBilling ? "הסתר הצעות/הזמנות" : `הצג גם הצעות/הזמנות (${hiddenNonBilling})`}
          </button>
        )}
        {tab === "unmatched" && canPull && (
          <button
            onClick={bulkArchive}
            className="rounded-xl px-3 py-1.5 border border-[var(--rule2)] shrink-0 font-bold"
            title="ארכוב אוטומטי: לקוח לא קיים באפליקציה · מעל 90 יום · אין job"
          >
            ארכב ישנים
          </button>
        )}
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
                <th className="py-2 px-2">שיוך</th>
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
                    <div className="flex items-center gap-2">
                      {r.pdf_url ? (
                        <a href={r.pdf_url} target="_blank" rel="noopener noreferrer" className="text-[var(--signal)] underline">
                          פתח
                        </a>
                      ) : (
                        "—"
                      )}
                      {/* Deep link to the document in Morning's own UI — the only
                          way to re-send an already-issued document (the API has
                          no resend endpoint). Pattern verified empirically by the
                          owner 2026-07-29. */}
                      {r.morning_doc_id && (
                        <a
                          href={`https://app.greeninvoice.co.il/incomes/documents/${r.morning_doc_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--faint)] underline"
                          title="פתח במורנינג — לשליחה חוזרת"
                        >
                          מורנינג ↗
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="py-2 px-2" onClick={(e) => e.stopPropagation()}>
                    {tab === "archived" ? (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-[var(--faint)]" title={r.archive_reason ?? ""}>מאורכב</span>
                        {canPull && (
                          <button onClick={() => archiveRow(r, true)} className="text-[10px] font-bold text-[var(--signal)]">
                            שחזר
                          </button>
                        )}
                      </div>
                    ) : tab === "cancelled" ? (
                      <span className="text-[10px] text-[var(--faint)]" title={r.cancel_reason ?? ""}>
                        בוטל{r.cancel_reason ? ` · ${r.cancel_reason}` : ""}
                      </span>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        {canPull && !r.job_id && BILLING_TYPES.includes(r.type) && (
                          <button
                            onClick={() => setAssignDoc(r)}
                            className="text-[10px] font-bold rounded-lg px-2 py-1 border border-[var(--rule2)]"
                          >
                            שייך ל-job
                          </button>
                        )}
                        {r.job_id && <span className="text-[10px] text-[var(--green)]">משויך</span>}
                        {canPull && r.type === 300 && (
                          <button
                            onClick={() => setCancelDoc(r)}
                            className="text-[10px] font-bold rounded-lg px-2 py-1 border border-[var(--rule2)] text-[var(--red)]"
                          >
                            סמן כמבוטל
                          </button>
                        )}
                        {canPull && (
                          <button
                            onClick={() => archiveRow(r, false)}
                            className="text-[10px] rounded-lg px-2 py-1 border border-[var(--rule)] text-[var(--faint)]"
                            title="ארכב מסמך זה (הפיך)"
                          >
                            ארכב
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {assignDoc && (
        <AssignDocModal
          mode="doc"
          id={assignDoc.id}
          docAmount={assignDoc.amount}
          heading={`שייך מסמך #${assignDoc.number ?? ""} ל-job`}
          onClose={() => setAssignDoc(null)}
          onAssigned={() => router.refresh()}
        />
      )}

      {cancelDoc && (
        <CancelModal
          doc={cancelDoc}
          onClose={() => setCancelDoc(null)}
          onCancelled={() => {
            setCancelDoc(null);
            router.refresh();
          }}
        />
      )}

      {newDoc && (
        <NewDocModal
          docType={newDoc}
          onClose={() => setNewDoc(null)}
          onQueued={(m) => {
            setNewDoc(null);
            setMsg(m);
            router.refresh();
          }}
        />
      )}
    </main>
  );
}

function CancelModal({ doc, onClose, onCancelled }: { doc: DocRow; onClose: () => void; onCancelled: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!reason.trim()) {
      setErr("חובה לציין סיבה");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/documents/${doc.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const body = await res.json();
      if (!res.ok) {
        setErr(body.error ?? "הביטול נכשל");
        return;
      }
      onCancelled();
    } catch {
      setErr("שגיאת רשת");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="glass-card w-full max-w-md p-5 rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-bold mb-1">לבטל את חשבון עסקה #{doc.number ?? ""}?</h2>
        <p className="text-[11px] text-[var(--faint)] mb-3 leading-relaxed">
          הביטול משקף פעולה שכבר נעשתה במורנינג — המערכת אינה מבטלת שם.
          {doc.job_id ? " ה-job המקושר יחזור למצב “לא חויב”." : ""}
        </p>
        <label className="block text-[11px] text-[var(--dim)] mb-1">סיבת הביטול (חובה)</label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
          rows={2}
          placeholder="לדוגמה: טעות במחיר"
          className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs mb-2"
        />
        {err && <div className="text-[11px] text-[var(--red)] mb-2">{err}</div>}
        <div className="flex items-center justify-end gap-2 mt-2">
          <button onClick={onClose} className="text-xs rounded-xl px-4 py-1.5 border border-[var(--rule)]">
            ביטול
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="text-xs font-bold rounded-xl px-4 py-1.5 bg-[var(--red)] text-white disabled:opacity-40"
          >
            {busy ? "מבטל…" : "סמן כמבוטל"}
          </button>
        </div>
      </div>
    </div>
  );
}
