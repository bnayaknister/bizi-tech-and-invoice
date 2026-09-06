"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useDrawer } from "@/components/EntityDrawer";
import AssignDocModal from "@/components/AssignDocModal";
import NewDocModal from "./NewDocModal";
import BundleFromShowModal from "@/components/BundleFromShowModal";
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
  // The OTHER way a document points at jobs, and the only way a bundled one
  // does: a consolidated deal invoice covers N episodes, so it carries job_id
  // NULL and lists every job here (issue.ts writes it through at issuance).
  // Any code that asks "is this document linked?" by reading job_id alone will
  // say no about a document linked to four.
  bundle_job_ids: string[] | null;
  show_name: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  archived_at: string | null;
  archive_reason: string | null;
  // the pending_documents row this document was issued from, when there is one.
  // null = raised by hand in Morning, so there is no frozen payload to inherit
  // — since stage 4 such a document may still be buildable through the raw path.
  pending_id: string | null;
  // The queue row's own amount — the NET this document was issued on, and the
  // figure createTaxFromParents sums when it builds a child. `amount` above is
  // documents.amount, Morning's GROSS. They differ by VAT and both are correct
  // about different things, so the bundling UI reads THIS one: it previews what
  // the child will carry, not what the parent printed.
  // null when there is no queue row (a raw row), or when one exists without an
  // amount — a state the builder itself refuses ("אין סכום"), so the screen
  // shows "—" rather than substitute the gross.
  pending_amount: number | null;
  // Which child this row may raise, resolved server-side from the allow-list in
  // taxFromParent.ts. null = a leaf (320, 400) or a type we never build on.
  // Not a list of codes kept here: the rungs are declared in one place.
  /** Every child this document may father, in the order they are offered.
   *  A list, not one value: a work order can produce BOTH a deal invoice and a
   *  tax document, and collapsing that to one hid the deal invoice entirely. */
  child_actions: ChildAction[];
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

export type ChildAction = "deal_invoice" | "tax" | "receipt";

const CHILD_ACTION_LABEL: Record<ChildAction, string> = {
  deal_invoice: "צור חשבון עסקה",
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

/**
 * Σ of the queue rows' net amounts — the figure the bundled child will carry.
 *
 * ALL-OR-NOTHING: one missing `pending_amount` returns null, and `money` renders
 * that as "—". Skipping the row instead would print a total that is short by
 * exactly the line nobody can see, on a screen whose whole job is to say what
 * is about to be issued. Substituting `amount` (the gross) would be worse
 * still — a bigger number wearing the net's label.
 *
 * The case is close to unreachable: a selectable row has a queue row by
 * definition, and createTaxFromParents refuses a source with no amount
 * ("אין סכום — לא ניתן לסכם את מסמכי המקור") before it builds anything. So "—"
 * here previews a refusal rather than hiding one.
 */
const sumPendingAmounts = (rows: DocRow[]): number | null =>
  rows.some((r) => r.pending_amount === null)
    ? null
    : rows.reduce((s, r) => s + (r.pending_amount ?? 0), 0);

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
  // N episodes of one show, billed as a single order — no productions involved
  const [bundleOpen, setBundleOpen] = useState(false);
  // ONE child document, N source rows. The array is the whole shape change:
  // createTaxFromParents has taken N parents since it was written, and the
  // route caps only the `documentIds` door — `sourceIds` never had a limit.
  const [childDoc, setChildDoc] = useState<{ rows: DocRow[]; action: "tax" | "receipt" } | null>(null);
  // Bundled tax documents: which queue rows are ticked. Keyed by pending_id —
  // that IS what goes out as sourceIds, so the state holds the thing it sends
  // rather than a row id that would have to be re-resolved at submit time.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // in "לא משויך", quotes/orders/credits are noise for the bookkeeper — show
  // only real billing docs by default (owner spec 2026-07-27), the rest behind a toggle
  const [showNonBilling, setShowNonBilling] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * "צור חשבון עסקה" — the same route the accrued screen calls, reached from
   * the row the bookkeeper is actually looking at.
   *
   * A direct POST rather than the child-document modal: that modal exists to
   * collect a payment method and a date for a tax document, and this builder
   * takes neither — it inherits the order's lines verbatim. Nothing goes to
   * Morning here either way; the invoice lands in the approval queue.
   *
   * The server's refusal is shown as-is. It is written for this reader and
   * names the fix ("כבר קיים חשבון עסקה על סמך ההזמנה הזו", "N מהעבודות
   * המקושרות אינן ניתנות לחיוב: …"), and paraphrasing it here would only make
   * the screen and the server disagree about why something did not happen.
   */
  async function convertToDealInvoice(r: DocRow) {
    if (busy || !r.pending_id) return;
    setBusy(r.id);
    setMsg(null);
    try {
      const res = await fetch("/api/documents/convert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workOrderPendingId: r.pending_id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "היצירה נכשלה");
      setMsg(
        `חשבון עסקה על סמך הזמנה ${r.number ?? ""} (${j.deal_invoice?.lines ?? "?"} שורות) — נכנס לתור לאישור`
      );
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "שגיאה");
    } finally {
      setBusy(null);
    }
  }

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

  /**
   * May this row join a bundled tax document?
   *
   * The conditions are the "צור חשבונית מס" button's own, plus one: the row
   * must go through the `sourceIds` door. A `raw` row (raised by hand in
   * Morning, no queue row) travels as `documentIds`, which the route caps at
   * one and refuses to mix with sourceIds — so a checkbox on it could only ever
   * produce a 400. It keeps its single-row button and gets no checkbox at all:
   * a control that cannot work is worse than a control that is not there.
   *
   * `over_ceiling` needs no thought here and that is not an accident — the
   * ceiling lives in mapPullDocToSource and is only ever set on a raw row
   * (page.tsx's `over-ceiling` state), which this predicate has already
   * excluded. Selectable rows are therefore always ceiling-free, and the
   * handshake below stays exactly the single-row path it is today.
   */
  const taxSelectable = (r: DocRow): boolean =>
    canPull &&
    r.buildable === "pending" &&
    !!r.pending_id &&
    r.child_actions.includes("tax") &&
    parentOpenness(r.status).open;

  // the checkbox column exists only where bundling is on the table
  const selectMode = canPull && tab === "deal_invoice";

  /** How many jobs a BUNDLED document covers. 0 = not a bundle. */
  const bundleSize = (r: DocRow): number => r.bundle_job_ids?.length ?? 0;

  /**
   * Does this document still need a job?
   *
   * Extracted because two places asked it and asked it DIFFERENTLY the moment a
   * bundle appeared — the button below and the `assignShown` mirror beside the
   * openness chip, whose comment already warned they must agree. One predicate,
   * two readers, no drift.
   *
   * The bundle clause is the fix: a consolidated deal invoice (40312,
   * חתונמיות) carries job_id NULL and four ids in bundle_job_ids. Reading
   * job_id alone called it unassigned and offered to assign it — on a document
   * already linked to every episode it bills, where the assign path writes a
   * single job_id and would have narrowed four links to one.
   */
  const needsJobAssignment = (r: DocRow): boolean =>
    canPull && !r.job_id && bundleSize(r) === 0 && BILLING_TYPES.includes(r.type);

  // Re-filtered through taxSelectable, not trusted from the tick alone: the
  // ticks were made against the rows as they were, and this is the last read
  // before they are sent. Deliberately not memoised — a filter over the visible
  // page costs nothing, and a memo here would need taxSelectable in its deps,
  // which is rebuilt every render anyway.
  const selectedRows = shown.filter(
    (r) => r.pending_id && selected.has(r.pending_id) && taxSelectable(r)
  );

  function toggleSelected(pendingId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pendingId)) next.delete(pendingId);
      else next.add(pendingId);
      return next;
    });
  }

  // A tick means "this row, as it is now". Both things that can invalidate that
  // clear it: switching tabs (the rows are a different set) and any refresh of
  // the list (a pull, a create — `rows` is a new array from the server every
  // time). Carrying ticks across either would let the operator submit a set
  // they can no longer see.
  useEffect(() => {
    setSelected(new Set());
  }, [rows, tab]);

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
        {canPull && tab === "work_order" && (
          <button
            onClick={() => setBundleOpen(true)}
            className="rounded-xl px-3 py-1.5 border border-[var(--rule2)] shrink-0 font-bold text-[var(--signal)]"
          >
            + הזמנה מרוכזת מתוכנית
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

      {/* The bundling bar. Its own row rather than another button in the
          controls above: it is a MODE the operator entered by ticking boxes,
          and it has to carry the count and the sum — the two numbers that say
          what is about to be created. One selected row is not a bundle, so it
          appears at two and the single-row button keeps that case. */}
      {selectMode && selectedRows.length >= 2 && (
        <div className="flex items-center justify-between gap-3 mb-3 text-xs border border-[var(--rule2)] rounded-xl px-3 py-2">
          <span>
            <span className="font-bold">נבחרו {selectedRows.length} חשבונות עסקה</span>
            <span className="text-[var(--faint)]">
              {" · "}
              {money(sumPendingAmounts(selectedRows), selectedRows[0]?.currency ?? "ILS")}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="rounded-lg px-3 py-1 border border-[var(--rule)] text-[var(--faint)]"
            >
              נקה בחירה
            </button>
            <button
              onClick={() => setChildDoc({ rows: selectedRows, action: "tax" })}
              className="font-bold rounded-lg px-3 py-1 bg-[var(--signal)] text-white"
              title="חשבונית מס אחת שסוגרת את כל המסמכים שנבחרו"
            >
              צור חשבונית מס מאוגדת ({selectedRows.length})
            </button>
          </span>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="text-center text-sm text-[var(--faint)] py-12 border border-dashed border-[var(--rule)] rounded-2xl">
          אין מסמכים בלשונית זו
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[var(--faint)] text-[10px] uppercase tracking-wider">
              <tr className="text-right">
                {selectMode && <th className="py-2 px-2 w-6"></th>}
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
                  {selectMode && (
                    <td className="py-2 px-2" onClick={(e) => e.stopPropagation()}>
                      {taxSelectable(r) && (
                        <input
                          type="checkbox"
                          checked={selected.has(r.pending_id!)}
                          onChange={() => toggleSelected(r.pending_id!)}
                          title="כלול בחשבונית מס מאוגדת"
                        />
                      )}
                    </td>
                  )}
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
                        {needsJobAssignment(r) && (
                          <button
                            onClick={() => setAssignDoc(r)}
                            className="text-[10px] font-bold rounded-lg px-2 py-1 border border-[var(--rule2)]"
                          >
                            שייך ל-job
                          </button>
                        )}
                        {r.job_id ? (
                          <span className="text-[10px] text-[var(--green)]">משויך</span>
                        ) : bundleSize(r) > 0 ? (
                          // same chip, same colour — a bundle is not "less
                          // assigned" than a single link, it is assigned to more.
                          // The count is the point: it is what tells the reader
                          // the empty job_id column is correct and not a gap.
                          <span
                            className="text-[10px] text-[var(--green)]"
                            title="מסמך מאוגד — הקישור לעבודות נשמר עליו עצמו ולא דרך פרק בודד"
                          >
                            משויך ל-{bundleSize(r)} עבודות
                          </span>
                        ) : null}
                        {/* The chip and the button tell ONE story: the chip is
                            why the button is or isn't there. Shown only on
                            100/300, the rows where "can I still build on this?"
                            is a real question — on a 320 or a 400 it is noise. */}
                        {r.child_actions.length > 0 && (() => {
                          const o = parentOpenness(r.status);
                          const action = r.child_actions.find((a) => a !== "deal_invoice") as
                            | "tax"
                            | "receipt"
                            | undefined;
                          // mirrors the "שייך ל-job" button's condition above:
                          // when that button is in the cell, the visible block
                          // sentence would say the same thing twice — the
                          // tooltip keeps the full reason either way.
                          // Literally the same predicate now, not a copy of it.
                          const assignShown = needsJobAssignment(r);
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
                              {/* The deal invoice: its own gate, because its
                                  builder has its own rules. `buildable` is the
                                  tax path's verdict (net ceiling, mapper state)
                                  and says nothing about this one. What this one
                                  needs is a queue row — createDealInvoiceFromWorkOrder
                                  is keyed on pending_documents.id, so an order
                                  issued straight into Morning cannot be converted
                                  by us at all. Open-only, like its sibling: 237
                                  of the 249 work orders here are closed, and a
                                  button on those is an invitation to a 409. */}
                              {canPull && r.child_actions.includes("deal_invoice") && o.open && r.pending_id && (
                                <button
                                  onClick={() => convertToDealInvoice(r)}
                                  disabled={busy === r.id}
                                  className="text-[10px] font-bold rounded-lg px-2 py-1 border border-[var(--rule2)] text-[var(--signal)] disabled:opacity-40"
                                  title="נכנס לתור האישורים, לא מונפק מיד"
                                >
                                  {CHILD_ACTION_LABEL.deal_invoice}
                                </button>
                              )}
                              {/* open, but never went through our queue — say so
                                  rather than leave an empty cell (the 40258
                                  lesson: a reason only in a tooltip reads as no
                                  reason at all) */}
                              {canPull && r.child_actions.includes("deal_invoice") && o.open && !r.pending_id && (
                                <span title="ההזמנה הונפקה ישירות במורנינג ואין לה שורת תור — לא ניתן להמיר אותה מכאן">
                                  <button
                                    disabled
                                    className="text-[10px] font-bold rounded-lg px-2 py-1 border border-[var(--rule)] text-[var(--faint)] opacity-50 cursor-not-allowed"
                                  >
                                    {CHILD_ACTION_LABEL.deal_invoice}
                                  </button>
                                  <span className="text-[10px] text-[var(--faint)] inline-block max-w-[200px] truncate align-middle mr-1.5">
                                    הונפקה ישירות במורנינג
                                  </span>
                                </span>
                              )}
                              {action && canPull && r.buildable && o.open && (
                                <button
                                  onClick={() => setChildDoc({ rows: [r], action })}
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
                              {action && canPull && !r.buildable && r.build_block && o.open && (
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
                        {canPull && r.child_actions.length === 0 && r.build_block && (
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
          docs={childDoc.rows}
          action={childDoc.action}
          onClose={() => setChildDoc(null)}
          onQueued={(m) => {
            setChildDoc(null);
            setSelected(new Set());
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

      {bundleOpen && (
        <BundleFromShowModal
          onClose={() => setBundleOpen(false)}
          onQueued={(m) => {
            setBundleOpen(false);
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

/**
 * ONE tax document (or receipt) from N source rows.
 *
 * `docs` is the whole difference from the single-row version, and everything
 * below it follows one rule: docs[0] is the PRIMARY, and every text, amount and
 * gate that existed before reads from it exactly as it did. A one-element array
 * therefore renders and posts byte-for-byte what it did yesterday; the multi
 * blocks are additive and appear only above one.
 *
 * The ceiling handshake is untouched and reachable only in the single case:
 * `over_ceiling` is set exclusively on a `raw` row, and taxSelectable refuses
 * those, so a bundle can never carry one. That is checked, not assumed — the
 * predicate says so and this comment is the second place it is written down.
 */
function TaxFromParentModal({
  docs,
  action,
  onClose,
  onQueued,
}: {
  docs: DocRow[];
  action: "tax" | "receipt";
  onClose: () => void;
  onQueued: (msg: string) => void;
}) {
  const doc = docs[0];
  const multi = docs.length > 1;
  // the net the child will be built on, not the parents' printed gross
  const sourcesTotal = sumPendingAmounts(docs);
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
      // otherwise — mirrors the server's pending-wins rule exactly.
      //
      // The sourceIds branch maps over ALL of them. With one row that is the
      // same single-element array it always sent; with several it is the bundle.
      // The raw branch stays [doc.id] because it can never hold more than one:
      // taxSelectable excludes raw rows from selection, and the route caps
      // documentIds at 1 and refuses to mix the two doors in one request.
      const base =
        doc.buildable === "raw"
          ? { documentIds: [doc.id] }
          : { sourceIds: docs.map((d) => d.pending_id) };

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
              {isReceipt ? "צור קבלה" : "צור מסמך מס"}{" "}
              {multi ? `על סמך ${docs.length} מסמכי מקור` : `על סמך #${doc.number ?? ""}`}
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
                ההכנסה יורשות {multi ? "מכל מסמכי המקור" : "מהמסמך הזה"} במדויק, והקישור{" "}
                {multi ? "אליהם הוא שסוגר את כולם" : "אליו הוא שסוגר אותו"} במורנינג. במסך האישור
                תוכלי להחליף ל<b>חשבונית מס קבלה</b> — אבל רק אם הכסף כבר התקבל, כי היא מצהירה על כך.
                {doc.buildable === "raw" && (
                  <> המסמך הזה נמשך ממורנינג — הירושה היא מהנתונים שנמשכו, לפי הנטו המאומת.</>
                )}
              </p>
            )}
            <div className="text-xs space-y-1 border border-[var(--rule)] rounded-xl p-3 mb-3">
              {multi ? (
                <>
                  <div className="text-[var(--faint)] mb-1">מסמכי מקור ({docs.length})</div>
                  <div className="space-y-0.5 mb-2">
                    {docs.map((d) => (
                      <div key={d.id} className="flex justify-between gap-2 font-mono">
                        <span>#{d.number ?? "—"}</span>
                        <span className="text-[var(--faint)]">{d.document_date ?? "—"}</span>
                        <span>{money(d.pending_amount, d.currency)}</span>
                      </div>
                    ))}
                  </div>
                  {/* Plain "סה״כ": this IS the figure the document will carry.
                      Both the lines and the total read pending_amount — the
                      queue rows' net, exactly what createTaxFromParents sums —
                      so this preview and the סכום כולל on the confirmation
                      screen are the same number reached two different ways. */}
                  <div className="flex justify-between gap-2 border-t border-[var(--rule)] pt-1">
                    <span className="text-[var(--faint)]">סה״כ</span>
                    <span className="font-mono font-bold">{money(sourcesTotal, doc.currency)}</span>
                  </div>
                </>
              ) : (
                <div>
                  <span className="text-[var(--faint)]">מסמך מקור: </span>
                  <span className="font-mono">#{doc.number ?? "—"}</span>
                </div>
              )}
              <div>
                <span className="text-[var(--faint)]">לקוח: </span>
                {doc.client_name ?? "—"}
              </div>
              {/* a pull row's `amount` is the GROSS; a TAX child is built on
                  the proven NET, so that modal shows both, net first. A receipt
                  is the opposite: it states money that already moved, tax
                  included — the gross IS its number, and a net line here would
                  be the classic net-instead-of-gross mistake in reverse. */}
              {multi ? null : doc.buildable === "raw" && isReceipt ? (
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
                {multi
                  ? "לא ידוע אם כל מסמכי המקור עדיין פתוחים במורנינג — לפחות אחד מהם טרם נמשך משם. אם אחד מהם כבר נסגר, הקישור לא יסגור אותו שוב ותידרש בדיקה ידנית."
                  : "לא ידוע אם מסמך המקור עדיין פתוח במורנינג — הוא טרם נמשך משם. אם הוא כבר נסגר, הקישור לא יסגור אותו שוב ותידרש בדיקה ידנית."}
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
                onClick={() =>
                  onQueued(
                    `${isReceipt ? "נוצרה קבלה" : "נוצר מסמך מס"} על סמך ${
                      multi
                        ? `${docs.length} מסמכים (${docs.map((d) => `#${d.number ?? "?"}`).join(", ")})`
                        : `#${doc.number ?? ""}`
                    } — ממתין לאישור בתור המסמכים`
                  )
                }
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
