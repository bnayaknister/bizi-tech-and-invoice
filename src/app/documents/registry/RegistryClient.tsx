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
  // the pending_documents row this document was issued from, when there is one.
  // null = raised by hand in Morning, so there is no frozen payload to inherit
  // — since stage 4 such a document may still be buildable through the raw path.
  pending_id: string | null;
  // Which child this row may raise, resolved server-side from the allow-list in
  // taxFromParent.ts. null = a leaf (320, 400) or a type we never build on.
  // Not a list of codes kept here: the rungs are declared in one place.
  child_action: "tax" | "receipt" | null;
  // The action-cell verdict, resolved SERVER-SIDE by the same mapper the route
  // runs — the button never promises what the server would refuse.
  //   'pending' — build from the queue row (sourceIds, the original door)
  //   'raw'     — build from the pulled document (documentIds)
  //   null      — no button; if build_block is set, a DISABLED button shows it
  buildable: "pending" | "raw" | null;
  // why the button is dark, in the server's own words (ceiling, assign-a-job
  // guidance, invoice_tax already stamped, …). null = no button at all.
  build_block: string | null;
  // the proven net for a raw-buildable row. documents.amount is GROSS for pull
  // rows — showing it in the modal against a net child bred distrust, so the
  // modal shows both, labelled.
  net_amount: number | null;
  // Set only when this row is over PULL_NET_CEILING **and** the viewer may
  // override it (can_manage_users). Non-null means: buildable, but only after
  // the two-call ticket handshake with a stated reason. null on every other
  // row — including an over-ceiling row seen by someone who cannot override,
  // which stays a plain block.
  over_ceiling: { net: number; ceiling: number } | null;
};

const CHILD_ACTION_LABEL: Record<"tax" | "receipt", string> = {
  tax: "צור חשבונית מס",
  receipt: "צור קבלה",
};

const CHILD_ACTION_ENDPOINT: Record<"tax" | "receipt", string> = {
  tax: "/api/documents/tax",
  receipt: "/api/documents/receipt",
};

/**
 * Can this document still father a tax document?
 *
 * documents.status is Morning's own state, refreshed on every pull, and it is a
 * perfect predictor of the builder's openness gate — verified across 609
 * documents (owner 2026-08-09): status=0 always carries a ref containing BOTH
 * 305 and 320; status=1 and status=2 always carry an empty ref. So the screen
 * reads `status` and never `raw->'ref'`, which would mean hauling heavy jsonb
 * across a 5,000-row query to learn the same thing.
 *
 * The proportion is the point: only 23 of those 609 are open. Until now the
 * button lit on all of them, so it was mostly an invitation to a 409.
 *
 * null / anything unexpected = we have no state for it (an app-issued document
 * carries no status until the next pull — issue.ts never writes one). The
 * builder ALLOWS that case and flags it, so the button stays lit and the chip
 * says so rather than pretending to know.
 */
type Openness = { open: boolean; label: string; tone: "open" | "closed" | "unknown" };

function parentOpenness(status: number | null): Openness {
  // null = never pulled, so we genuinely do not know. Everything else Morning
  // gave us a state for.
  if (status === null || status === undefined) {
    return { open: true, label: "טרם נמשך ממורנינג", tone: "unknown" };
  }
  if (status === 0) return { open: true, label: "פתוח", tone: "open" };
  if (status === 1) return { open: false, label: "נסגר אוטומטית", tone: "closed" };
  if (status === 2) return { open: false, label: "נסגר ידנית", tone: "closed" };
  // Any OTHER code counts as closed, and that is deliberate. We met status=4 on
  // five 305s (2026-08-11) having only ever seen 0/1/2 — and its ref was empty,
  // exactly like 1 and 2. Treating an unrecognised code as "unknown" would light
  // the button on a document the builder is about to refuse; treating it as
  // closed matches every observation and fails safe. Only 0 has ever carried a
  // non-empty ref.
  return { open: false, label: "סגור", tone: "closed" };
}

const OPENNESS_TITLE: Record<Openness["tone"], string> = {
  open: "פתוח במורנינג — אפשר להנפיק על סמכו מסמך מס",
  closed: "סגור במורנינג — כבר לא ניתן להנפיק על סמכו",
  unknown: "המסמך טרם נמשך ממורנינג, ולכן מצבו אינו ידוע. אפשר לנסות — הבדיקה תיעשה בשרת.",
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
  const [childDoc, setChildDoc] = useState<{ row: DocRow; action: "tax" | "receipt" } | null>(null);
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
                        {/* The chip and the button tell ONE story: the chip is
                            why the button is or isn't there. Shown only on
                            100/300, the rows where "can I still build on this?"
                            is a real question — on a 320 or a 400 it is noise. */}
                        {r.child_action && (() => {
                          const o = parentOpenness(r.status);
                          const action = r.child_action!;
                          // mirrors the "שייך ל-job" button's condition above:
                          // when that button is in the cell, the visible block
                          // sentence would say the same thing twice — the
                          // tooltip keeps the full reason either way
                          const assignShown = canPull && !r.job_id && BILLING_TYPES.includes(r.type);
                          return (
                            <>
                              <span
                                title={OPENNESS_TITLE[o.tone]}
                                className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                                  o.tone === "open"
                                    ? "border-[var(--green)] text-[var(--green)]"
                                    : o.tone === "unknown"
                                      ? "border-[var(--warn)] text-[var(--warn)]"
                                      : "border-[var(--rule)] text-[var(--faint)]"
                                }`}
                              >
                                {o.label}
                              </span>
                              {canPull && r.buildable && o.open && (
                                <button
                                  onClick={() => setChildDoc({ row: r, action })}
                                  className="text-[10px] font-bold rounded-lg px-2 py-1 border border-[var(--rule2)] text-[var(--signal)]"
                                  title={
                                    r.buildable === "raw"
                                      ? "נבנה מהמסמך שנמשך ממורנינג — נכנס לתור האישורים, לא מונפק מיד"
                                      : "נכנס לתור האישורים, לא מונפק מיד"
                                  }
                                >
                                  {CHILD_ACTION_LABEL[action]}
                                </button>
                              )}
                              {/* the dark button carries its reason — the
                                  server's own message, VISIBLE beside it, not
                                  only in a hover tooltip (40258 taught that a
                                  title-only reason reads as no reason at all).
                                  title stays on the span for the full text
                                  when the visible copy truncates; it also
                                  works around disabled elements not reliably
                                  showing tooltips. */}
                              {canPull && !r.buildable && r.build_block && o.open && (
                                <span title={r.build_block}>
                                  <button
                                    disabled
                                    className="text-[10px] font-bold rounded-lg px-2 py-1 border border-[var(--rule)] text-[var(--faint)] opacity-50 cursor-not-allowed"
                                  >
                                    {CHILD_ACTION_LABEL[action]}
                                  </button>
                                  {!assignShown && (
                                    <span className="text-[10px] text-[var(--faint)] inline-block max-w-[240px] truncate align-middle mr-1.5">
                                      {r.build_block}
                                    </span>
                                  )}
                                </span>
                              )}
                            </>
                          );
                        })()}
                        {/* a row that can never father a child but carries a
                            reason — today only the 320 case — shows the reason
                            instead of an empty cell. No dark button: this is a
                            permanent "never", not a fixable block. */}
                        {canPull && !r.child_action && r.build_block && (
                          <span className="text-[10px] text-[var(--faint)]" title={r.build_block}>
                            {r.build_block}
                          </span>
                        )}
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

      {childDoc && (
        <TaxFromParentModal
          doc={childDoc.row}
          action={childDoc.action}
          onClose={() => setChildDoc(null)}
          onQueued={(m) => {
            setChildDoc(null);
            setMsg(m);
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

// What the builder actually produced. Rendered in full — every income line, the
// links, the printed remark — because a summary is exactly what hides the field
// that is wrong, and a tax document cannot be corrected once it is in Morning.
type BuiltPayload = {
  type: number;
  description?: string;
  remarks?: string;
  linkedDocumentIds?: string[];
  client?: { id?: string; name?: string };
  income?: { description: string; quantity: number; price: number }[];
};

function TaxFromParentModal({
  doc,
  action,
  onClose,
  onQueued,
}: {
  doc: DocRow;
  action: "tax" | "receipt";
  onClose: () => void;
  onQueued: (msg: string) => void;
}) {
  const isReceipt = action === "receipt";
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // mandatory when doc.over_ceiling is set; ignored otherwise
  const [overrideReason, setOverrideReason] = useState("");
  const [built, setBuilt] = useState<{
    id: string;
    amount: number | null;
    parentOpennessUnknown: boolean;
    payload: BuiltPayload | null;
  } | null>(null);

  async function submit() {
    if (doc.over_ceiling && !overrideReason.trim()) {
      setErr("חובה לציין סיבה לעקיפת התקרה");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // which door: the queue row when there is one, the pulled document
      // otherwise — mirrors the server's pending-wins rule exactly
      const base =
        doc.buildable === "raw" ? { documentIds: [doc.id] } : { sourceIds: [doc.pending_id] };

      // The ceiling handshake, and note what is NOT here: no `confirm: true`
      // this code could hard-code. The first request carries no ticket and is
      // REFUSED; the server mints one bound to the document, the net, this
      // user and a 10-minute window, and only the echo of that ticket is
      // accepted. There is nothing to set in advance.
      const send = (extra: Record<string, unknown> = {}) =>
        fetch(CHILD_ACTION_ENDPOINT[action], {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...base, ...extra }),
        });

      let res = await send(
        doc.over_ceiling ? { overCeiling: true, overCeilingReason: overrideReason.trim() } : {}
      );
      let body = await res.json();

      if (!res.ok && body?.needs_confirmation && body?.over_ceiling?.ticket) {
        res = await send({
          overCeiling: true,
          overCeilingReason: overrideReason.trim(),
          overCeilingTicket: body.over_ceiling.ticket,
        });
        body = await res.json();
      }

      if (!res.ok) {
        setErr(body.error ?? "היצירה נכשלה");
        return;
      }
      const t = body.tax_document ?? body.receipt ?? {};
      setBuilt({
        id: t.id,
        amount: t.amount ?? null,
        parentOpennessUnknown: !!t.parent_openness_unknown,
        payload: (t.payload ?? null) as BuiltPayload | null,
      });
    } catch {
      setErr("שגיאת רשת");
    } finally {
      setBusy(false);
    }
  }

  const p = built?.payload;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="glass-card w-full max-w-lg p-5 rounded-2xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {!built ? (
          <>
            <h2 className="text-sm font-bold mb-1">
              {isReceipt ? "צור קבלה" : "צור מסמך מס"} על סמך #{doc.number ?? ""}
            </h2>
            {isReceipt ? (
              <p className="text-[11px] text-[var(--faint)] mb-3 leading-relaxed">
                הקבלה תיכנס לתור האישורים — היא אינה מונפקת כאן. היא אינה נושאת שורות הכנסה, רק את
                הסכום שהתקבל, והקישור לחשבונית הוא שסוגר אותה במורנינג. את פרטי התקבול — אמצעי, סכום
                ותאריך — ממלאים במסך האישור.
              </p>
            ) : (
              <p className="text-[11px] text-[var(--faint)] mb-3 leading-relaxed">
                המסמך ייווצר כ<b>חשבונית מס</b> ויכנס לתור האישורים — הוא אינו מונפק כאן. שורות
                ההכנסה יורשות מהמסמך הזה במדויק, והקישור אליו הוא שסוגר אותו במורנינג. במסך האישור
                תוכלי להחליף ל<b>חשבונית מס קבלה</b> — אבל רק אם הכסף כבר התקבל, כי היא מצהירה על כך.
                {doc.buildable === "raw" && (
                  <> המסמך הזה נמשך ממורנינג — הירושה היא מהנתונים שנמשכו, לפי הנטו המאומת.</>
                )}
              </p>
            )}
            <div className="text-xs space-y-1 border border-[var(--rule)] rounded-xl p-3 mb-3">
              <div>
                <span className="text-[var(--faint)]">מסמך מקור: </span>
                <span className="font-mono">#{doc.number ?? "—"}</span>
              </div>
              <div>
                <span className="text-[var(--faint)]">לקוח: </span>
                {doc.client_name ?? "—"}
              </div>
              {/* a pull row's `amount` is the GROSS; a TAX child is built on
                  the proven NET, so that modal shows both, net first. A receipt
                  is the opposite: it states money that already moved, tax
                  included — the gross IS its number, and a net line here would
                  be the classic net-instead-of-gross mistake in reverse. */}
              {doc.buildable === "raw" && isReceipt ? (
                <div>
                  <span className="text-[var(--faint)]">סכום (ברוטו): </span>
                  <span className="font-mono">{money(doc.amount, doc.currency)}</span>
                </div>
              ) : doc.buildable === "raw" && doc.net_amount !== null ? (
                <div>
                  <span className="text-[var(--faint)]">סכום נטו: </span>
                  <span className="font-mono">{money(doc.net_amount, doc.currency)}</span>
                  <span className="text-[var(--faint)]"> (ברוטו {money(doc.amount, doc.currency)})</span>
                </div>
              ) : (
                <div>
                  <span className="text-[var(--faint)]">סכום: </span>
                  <span className="font-mono">{money(doc.amount, doc.currency)}</span>
                </div>
              )}
            </div>
            {/* The override. Shown only when the server already judged this row
                over the ceiling AND this viewer may step over it — the field
                cannot appear on a row that does not need it. */}
            {doc.over_ceiling && (
              <div className="text-[11px] border border-[var(--warn)] rounded-xl p-3 mb-3 leading-relaxed">
                <div className="font-bold text-[var(--warn)] mb-1">עקיפת תקרת סכום</div>
                <div className="mb-2">
                  הנטו של המסמך הזה ({money(doc.over_ceiling.net, doc.currency)}) גבוה מתקרת המסלול (
                  {money(doc.over_ceiling.ceiling, doc.currency)}). המסלול הזה צעיר, ולכן סכומים בסדר
                  גודל כזה מונפקים בדרך כלל ידנית במורנינג. הסכום עצמו כבר אומת מול המסמך המקורי
                  ואינו ניתן לשינוי כאן — העקיפה מתירה את הגודל בלבד.
                </div>
                <label className="block">
                  <span className="text-[var(--faint)]">סיבה (חובה, נשמרת ביומן)</span>
                  <input
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    className="w-full mt-0.5 bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1"
                    placeholder="למשל: אבן דרך ב׳ בחוזה ידיעות — סוכם מול הלקוח"
                  />
                </label>
              </div>
            )}
            {err && <div className="text-[11px] text-[var(--red)] mb-2">{err}</div>}
            <div className="flex items-center justify-end gap-2">
              <button onClick={onClose} className="text-xs rounded-xl px-4 py-1.5 border border-[var(--rule)]">
                ביטול
              </button>
              <button
                onClick={submit}
                disabled={busy || (!!doc.over_ceiling && !overrideReason.trim())}
                className="text-xs font-bold rounded-xl px-4 py-1.5 bg-[var(--signal)] text-white disabled:opacity-40"
              >
                {busy ? "יוצר…" : doc.over_ceiling ? "אשר עקיפה וצור" : "צור והוסף לתור"}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-sm font-bold mb-1">{isReceipt ? "נוצרה קבלה" : "נוצר מסמך מס"} — ממתין לאישור</h2>
            <p className="text-[11px] text-[var(--faint)] mb-3">
              זה בדיוק מה שיישלח למורנינג באישור. שום דבר עוד לא יצא.
            </p>
            {built.parentOpennessUnknown && (
              <div className="text-[11px] text-[var(--warn)] border border-[var(--warn)] rounded-xl px-3 py-2 mb-3 leading-relaxed">
                לא ידוע אם מסמך המקור עדיין פתוח במורנינג — הוא טרם נמשך משם. אם הוא כבר נסגר,
                הקישור לא יסגור אותו שוב ותידרש בדיקה ידנית.
              </div>
            )}
            <div className="text-[11px] space-y-2 border border-[var(--rule)] rounded-xl p-3 mb-3">
              <Field label="סוג (קוד מורנינג)" value={String(p?.type ?? "—")} mono />
              <Field label="תיאור" value={p?.description ?? "—"} />
              <Field label="הערה מודפסת (remarks)" value={p?.remarks ?? "—"} />
              <Field label="קישור למסמכי מקור" value={(p?.linkedDocumentIds ?? []).join(", ") || "—"} mono />
              <Field label="לקוח במורנינג" value={p?.client?.name ?? p?.client?.id ?? "—"} />
              <div>
                <div className="text-[var(--faint)] mb-1">שורות הכנסה ({p?.income?.length ?? 0})</div>
                <div className="space-y-0.5">
                  {(p?.income ?? []).map((l, i) => (
                    <div key={i} className="flex justify-between gap-2 font-mono">
                      <span className="truncate">{l.description}</span>
                      <span className="shrink-0">
                        {l.quantity} × {l.price}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <Field label="סכום כולל" value={money(built.amount, doc.currency)} mono />
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => onQueued(`${isReceipt ? "נוצרה קבלה" : "נוצר מסמך מס"} על סמך #${doc.number ?? ""} — ממתין לאישור בתור המסמכים`)}
                className="text-xs font-bold rounded-xl px-4 py-1.5 bg-[var(--signal)] text-white"
              >
                סגור
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="text-[var(--faint)] shrink-0">{label}:</span>
      <span className={`break-all ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
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
