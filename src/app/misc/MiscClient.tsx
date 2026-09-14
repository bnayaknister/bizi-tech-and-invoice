"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import IconTile from "@/components/IconTile";
import { displayDate } from "@/lib/dates";
import NewMiscModal from "./NewMiscModal";

/** A client the create form may pick. `morningMapped` is the boolean form of
 *  clients.morning_client_id — the id itself never leaves the server. */
export type MiscClientOption = { id: string; name: string; morningMapped: boolean };

/**
 * The screen's notice, and WHETHER IT WENT WRONG — the shape RegistryClient
 * settled on today (RegistryClient.tsx:229-243) after a success and a 409
 * rendered in the same faint grey box and the owner clicked three times.
 *
 * Extended here with a third tone, because this screen has a third outcome:
 * the route's 207 is neither. The work WAS saved and the billing was not, and
 * calling that "ok" would hide a row that still needs a work order while
 * calling it "err" would send the operator looking for a job that exists.
 *
 * `detail` carries the server's own sentence under the headline. The 207 has
 * three distinct causes and which one it was decides whether the retry will
 * work, so it is surfaced rather than paraphrased away.
 */
export type Notice = { text: string; tone: "ok" | "warn" | "err"; detail?: string };

const NOTICE_STYLE: Record<Notice["tone"], string> = {
  ok: "text-[var(--green)] border-[var(--green)]",
  warn: "text-[var(--amber)] border-[var(--amber)]",
  err: "text-[var(--peak)] border-[var(--peak)]",
};

const NOTICE_MARK: Record<Notice["tone"], string> = { ok: "✓ ", warn: "⚠️ ", err: "✕ " };

export type SupplierLine = {
  supplier_name: string;
  service: string | null;
  /** nullable by design (0074): a supplier can be recorded before the fee is
   *  agreed. Null here means "not agreed yet", never zero. */
  price: number | null;
  due_date: string | null;
  /** paid_at IS the payment status (0074) — NULL means unpaid, so this is it. */
  paid: boolean;
};

export type MiscRow = {
  id: string;
  name: string;
  client_name: string | null;
  work_date: string;
  amount: number | null;
  status: string;
  client_order_ref: string | null;
  description: string | null;
  cancel_reason: string | null;
  /** job_id is set ⟺ a work order reached the approval queue. See page.tsx. */
  billed: boolean;
  suppliers: SupplierLine[];
};

// Every viewer of this screen has can_view_money (page.tsx gates on it), so
// there is no hidden-money branch anywhere in this file — a number that is not
// shown is a number that does not exist in the row.
const money = (n: number | null) => (n == null ? "—" : `₪${Math.round(n).toLocaleString("he-IL")}`);

/**
 * Status colour, keyed BY NAME — never by order.
 *
 * 0074's header states the rule that this map is the UI half of: the enum is
 * ordered נפתח, בעבודה, הושלם, בוטל with 'בוטל' LAST, so any test shaped like
 * `status >= 'הושלם'` sweeps cancelled rows in. The enum order exists for
 * display, not for logic. A record keyed on the literal cannot make that
 * mistake, and an unknown value falls through to the neutral tone rather than
 * being silently grouped with whatever sorts next to it.
 *
 * Hues follow DESIGN.md §2: cyan is open commitment (never debt), violet is the
 * active signal, green is done, and cancelled is greyed out rather than red —
 * a cancelled job is not a problem to fix, it is a job that will not happen.
 */
const STATUS_TONE: Record<string, string> = {
  "נפתח": "var(--cyan)",
  "בעבודה": "var(--violet-light)",
  "הושלם": "var(--green)",
  "בוטל": "var(--faint)",
};

function StatusPill({ status }: { status: string }) {
  const color = STATUS_TONE[status] ?? "var(--dim)";
  return (
    <span
      className="inline-block rounded-lg px-2 py-0.5 text-[11px] whitespace-nowrap"
      // transparent-tinted background + full-colour text, DESIGN.md §9
      style={{ color, background: "rgba(255,255,255,0.05)", border: `1px solid ${color}33` }}
    >
      {status}
    </span>
  );
}

/**
 * The supplier cell: how many, how much, and how much of it is still owed.
 *
 * The unpaid SUM is the number that carries the cell, not the count — it is the
 * question 0074's partial index on (due_date) where paid_at is null exists to
 * answer, and it is what a supplier line is for. Priced and unpriced lines are
 * reported separately on purpose: a line with no price yet is not worth ₪0, and
 * folding it into the total would understate what is owed with no sign that
 * anything was left out.
 */
function Suppliers({ lines }: { lines: SupplierLine[] }) {
  if (lines.length === 0) return <span className="text-[var(--ink-faint)]">—</span>;
  const unpaid = lines.filter((l) => !l.paid);
  const unpaidSum = unpaid.reduce((t, l) => t + (l.price ?? 0), 0);
  const unpriced = lines.filter((l) => l.price == null).length;
  return (
    <span
      title={lines
        .map((l) =>
          [
            l.supplier_name,
            l.service,
            l.price == null ? "מחיר טרם נקבע" : money(l.price),
            l.due_date ? `לתשלום ${displayDate(l.due_date)}` : null,
            l.paid ? "שולם" : "טרם שולם",
          ]
            .filter(Boolean)
            .join(" · ")
        )
        .join("\n")}
    >
      <span className="font-mono">{lines.length}</span>
      {unpaid.length > 0 && (
        <span className="text-[var(--amber)]">
          {" · "}
          {unpaidSum > 0 ? `${money(unpaidSum)} טרם שולמו` : `${unpaid.length} טרם שולמו`}
        </span>
      )}
      {unpriced > 0 && (
        <span className="text-[var(--ink-faint)]"> · {unpriced} ללא מחיר</span>
      )}
    </span>
  );
}

/**
 * ═══ THE BOARD (step 5) ═══
 *
 * A measured copy of the /productions kanban, not a generic extraction. A
 * second site is not a justification for an abstraction — the extraction is its
 * own task, for when there is a third. What is copied is the mechanism; what is
 * NOT copied is everything that turned out to be about `productions`.
 *
 * DRAG IS NATIVE HTML5, no library — the same three points ProductionsClient
 * uses (:863-874 for the column, :899-901 for the card), and there is no drag
 * dependency in package.json to copy even if one were wanted. The dragged id
 * travels in React state and NOT in dataTransfer, exactly as there: one tree,
 * one state, and nothing to serialise.
 *
 * ═══ ⚠️ THREE COLUMNS, NOT FOUR — 'בוטל' IS NOT ON THE BOARD ═══
 * misc_production_status has four values and this board shows three. That is
 * the /productions decision applied rather than a value dropped by accident:
 * STATUS_ORDER there lists nine states and omits 'בוטל' (status.ts:6-16,
 * "cancelled isn't even on the board"), cancelled rows are filtered off the
 * board unless a search is active (ProductionsClient.tsx:283-285), and
 * cancelling is a route of its own that REQUIRES A REASON and returns 409
 * needs_confirmation when documents were already issued.
 *
 * 0074 made the same call for this table from the other direction: it gave
 * misc_productions cancel_reason and no cancelled_at, on the grounds that "a
 * single status with a reason is the whole truth". A card dragged silently into
 * a 'בוטל' column would empty both decisions at once — no reason asked, no
 * warning that a work order is already in the approval queue, and cancel_reason
 * left NULL forever on the one row whose entire record of why it ended is that
 * column.
 *
 * So cancelling is not a drag. It will be an explicit action with its own
 * route; the backlog carries it, with the finding that misc has no equivalent
 * of the /productions 409 — nothing in the app cancels a queued work order, and
 * a cancelled job with an open 100 in Morning is precisely what 0063 was built
 * for on the productions side.
 *
 * Cancelled rows stay VISIBLE IN THE TABLE, with their reason beside the name
 * (:244-249). Off the board is not out of the screen.
 */
const BOARD_STATES = ["נפתח", "בעבודה", "הושלם"] as const;

const COLUMN_CAP = 60;

function MiscCard({
  r,
  draggable,
  onDragStart,
  onDragEnd,
}: {
  r: MiscRow;
  draggable: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}) {
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`rounded-xl border border-[var(--rule)] bg-[var(--panel)] p-2.5 ${
        draggable ? "cursor-grab active:cursor-grabbing" : ""
      }`}
    >
      <div className="text-xs font-medium leading-tight">{r.name}</div>
      <div className="text-[11px] text-[var(--dim)] mt-0.5">{r.client_name ?? "—"}</div>
      <div className="flex items-center gap-1.5 mt-1.5 text-[11px]">
        <span className="font-mono text-[var(--dim)]">{displayDate(r.work_date)}</span>
        <span className="text-[var(--ink-faint)]">·</span>
        {/* every viewer here has can_view_money (page.tsx gates on it), so the
            amount is shown unconditionally — the same reasoning the table uses */}
        <span className="font-mono">{money(r.amount)}</span>
        <div className="flex-1" />
        {r.suppliers.length > 0 && (
          <span className="text-[var(--ink-faint)] font-mono" title={`${r.suppliers.length} ספקים`}>
            ⚑{r.suppliers.length}
          </span>
        )}
      </div>
      {!r.billed && (
        // the one flag worth a card's space: a job that was recorded and never
        // billed is the retry point, and it is the column-agnostic fact — a row
        // can reach 'הושלם' unbilled
        <div className="text-[10px] text-[var(--amber)] mt-1">טרם חויבה</div>
      )}
    </div>
  );
}

function MiscKanban({
  rows,
  canEdit,
  dragId,
  dragOver,
  setDragId,
  setDragOver,
  onDropTo,
}: {
  rows: MiscRow[];
  canEdit: boolean;
  dragId: string | null;
  dragOver: string | null;
  setDragId: (id: string | null) => void;
  setDragOver: (s: string | null) => void;
  onDropTo: (id: string, status: string) => void;
}) {
  const byStatus = new Map<string, MiscRow[]>();
  for (const s of BOARD_STATES) byStatus.set(s, []);
  // Named lookup, so a row in any state that is not a column — 'בוטל' today,
  // anything a future migration adds — is simply absent from the board rather
  // than landing in whichever column sorts next to it.
  for (const r of rows) byStatus.get(r.status)?.push(r);

  return (
    <>
      {/* desktop / tablet: the horizontal board with drag between columns */}
      <div className="hidden sm:block overflow-x-auto pb-4">
        <div className="flex gap-3 min-w-max">
          {BOARD_STATES.map((status) => {
            const items = byStatus.get(status) ?? [];
            const isOver = dragOver === status;
            return (
              <div
                key={status}
                onDragOver={(e) => {
                  if (!canEdit) return;
                  e.preventDefault();
                  setDragOver(status);
                }}
                onDragLeave={() => dragOver === status && setDragOver(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(null);
                  if (dragId) onDropTo(dragId, status);
                  setDragId(null);
                }}
                className={`w-64 shrink-0 rounded-2xl border p-2 transition-colors ${
                  isOver ? "border-[var(--violet)]" : "border-[var(--rule)]"
                }`}
                style={{
                  background: isOver ? "rgba(139,92,246,0.08)" : "rgba(255,255,255,0.02)",
                  backdropFilter: "blur(8px)",
                  WebkitBackdropFilter: "blur(8px)",
                }}
              >
                <div className="flex items-center justify-between px-1.5 py-1.5 mb-1">
                  <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: STATUS_TONE[status] }}>
                    {status}
                  </span>
                  <span className="text-[11px] text-[var(--faint)] font-mono">{items.length}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {items.slice(0, COLUMN_CAP).map((r) => (
                    <MiscCard
                      key={r.id}
                      r={r}
                      draggable={canEdit}
                      onDragStart={() => setDragId(r.id)}
                      onDragEnd={() => setDragId(null)}
                    />
                  ))}
                  {items.length > COLUMN_CAP && (
                    <div className="text-[11px] text-[var(--faint)] text-center py-2">
                      ועוד {items.length - COLUMN_CAP} — צמצם עם התצוגה הטבלאית
                    </div>
                  )}
                  {items.length === 0 && <div className="text-[11px] text-[var(--faint)] text-center py-3">—</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* mobile: a grouped list, no drag. Native HTML5 drag does not fire on
          touch — the same reason ProductionsClient.tsx:920-925 gives. There the
          fallback is the drawer's one-tap advance; misc has no drawer yet, so
          this view is read-only on a phone and says nothing it cannot do. */}
      <div className="sm:hidden space-y-4 pb-4">
        {BOARD_STATES.map((status) => {
          const items = byStatus.get(status) ?? [];
          if (items.length === 0) return null;
          return (
            <section key={status}>
              <div className="flex items-center gap-2 mb-1.5 px-0.5">
                <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: STATUS_TONE[status] }}>
                  {status}
                </span>
                <span className="text-[11px] text-[var(--faint)] font-mono">{items.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {items.slice(0, COLUMN_CAP).map((r) => (
                  <MiscCard key={r.id} r={r} draggable={false} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

export default function MiscClient({
  rows,
  clients,
  canEditMoney,
}: {
  rows: MiscRow[];
  clients: MiscClientOption[];
  canEditMoney: boolean;
}) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tab, setTab] = useState<"table" | "kanban">("table");

  // The board writes, so the rows have to be local state and not the prop:
  // a card must move the instant it is dropped. Re-seeded when the server sends
  // a new set (a create, or router.refresh()), the same one-liner
  // ProductionsClient.tsx:210 uses for the same reason.
  const [board, setBoard] = useState<MiscRow[]>(rows);
  useEffect(() => setBoard(rows), [rows]);

  // Which row is mid-billing. One id and not a boolean: it disables every
  // button on the screen while one is in flight (two work orders queued by an
  // impatient double-click on two different rows is the same accident as on
  // one), and still lets the pressed row alone say "יוצר…".
  const [billingId, setBillingId] = useState<string | null>(null);

  /**
   * Step 6 — "צור הזמנת עבודה" for a row whose billing never happened.
   *
   * ⚠️ NO OPTIMISTIC UPDATE HERE, and that is the difference from moveStatus
   * above. A drag writes one enum column and reverting is exact. This mints a
   * JOB and a QUEUED DOCUMENT — the row's `billed` flag is a summary of state
   * on two other tables, and showing "הזמנת עבודה נוצרה" a moment before it is
   * true would be the screen asserting something about money it does not yet
   * know. So it waits, then refreshes from the server, which is also what makes
   * the new state survive the next render.
   */
  async function createWorkOrder(id: string) {
    if (billingId) return;
    setBillingId(id);
    setNotice(null);
    try {
      const res = await fetch(`/api/misc-productions/${id}/work-order`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 409 is not a breakage — it is "someone already did this", and it
        // reads as a warning rather than a failure so the operator does not go
        // looking for something to fix. Everything else is an error.
        setNotice({
          tone: res.status === 409 ? "warn" : "err",
          text: res.status === 409 ? "לא נוצרה הזמנה נוספת." : "יצירת הזמנת העבודה נכשלה.",
          detail: typeof body.error === "string" ? body.error : undefined,
        });
        return;
      }
      setNotice({ tone: "ok", text: "נוצרה הזמנת עבודה ונשלחה לאישור." });
      // The row is server-rendered, and `billed` is derived from job_id there —
      // without this the confirmation would sit above a row still saying
      // "טרם חויבה". Same call NewMiscModal makes after a create.
      router.refresh();
    } catch {
      setNotice({ tone: "err", text: "יצירת הזמנת העבודה נכשלה.", detail: "השרת לא נענה" });
    } finally {
      setBillingId(null);
    }
  }

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Named states, never a range — the same rule STATUS_TONE follows. 'בוטל' is
  // excluded from "open" by being absent from this list, not by sorting after
  // something.
  const openCount = board.filter((r) => r.status === "נפתח" || r.status === "בעבודה").length;

  /**
   * Optimistic move with a full revert, copied from ProductionsClient.tsx:229-243
   * because the shape is the point: the card moves first, and if the server
   * refuses, the ENTIRE previous list is restored rather than the one row
   * patched back. Restoring one row would be a second implementation of "what
   * did it look like before", and the two would disagree the first time a
   * response arrives out of order.
   *
   * The failure is surfaced in the notice box the screen already owns, so a
   * refused drag reads the same way a refused create does, in the same place.
   */
  async function moveStatus(id: string, status: string) {
    const prev = board;
    const row = board.find((r) => r.id === id);
    if (!row || row.status === status) return;

    setBoard((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));
    setNotice(null);

    const res = await fetch(`/api/misc-productions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setBoard(prev);
      setNotice({ text: data.error ?? "שינוי הסטטוס נכשל", tone: "err" });
    }
  }

  return (
    <main className="max-w-6xl mx-auto p-6">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h1 className="text-lg font-bold flex items-center gap-2.5">
          <IconTile icon="productions" accent="violet-light" size={30} iconSize={17} />
          רדיו ושונות
        </h1>
        {/* The view switch, not a second screen: page.tsx already loads every
            row for the table, and the board needs exactly those rows. A
            separate route would duplicate the paged read and the
            can_view_money gate for no new data. */}
        {board.length > 0 && (
          <div className="flex rounded-xl border border-[var(--rule)] overflow-hidden">
            {(
              [
                ["table", "טבלה"],
                ["kanban", "קנבן"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`text-xs px-4 py-1.5 transition-colors ${
                  tab === key ? "text-white font-bold" : "text-[var(--dim)] hover:bg-[var(--panel3)]"
                }`}
                style={
                  tab === key
                    ? { background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }
                    : undefined
                }
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {board.length > 0 && (
          <span className="text-xs text-[var(--faint)]">
            {board.length} {board.length === 1 ? "עבודה" : "עבודות"} · {openCount} פתוחות
          </span>
        )}
        <div className="flex-1" />
        {canEditMoney && (
          <button
            onClick={() => setModalOpen(true)}
            className="text-xs text-white font-bold rounded-xl px-3 py-1.5"
            style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 14px rgba(139,92,246,0.3)" }}
          >
            + עבודה חדשה
          </button>
        )}
      </div>

      {/* The notice lives here, directly under the button that produces it —
          the placement RegistryClient arrived at today, for the reason it
          records: on success the modal unmounts, so the element the operator
          was looking at disappears and something has to take its place where
          she is already looking. Dismissible, because it is her receipt and
          nothing else on this screen clears it. */}
      {notice && (
        <div
          className={`flex items-start justify-between gap-3 mb-3 text-xs border rounded-xl px-3 py-2 ${NOTICE_STYLE[notice.tone]}`}
        >
          <span>
            <span className="font-bold">{NOTICE_MARK[notice.tone]}</span>
            {notice.text}
            {notice.detail && <span className="block mt-0.5 text-[11px] opacity-70">{notice.detail}</span>}
          </span>
          <button
            onClick={() => setNotice(null)}
            aria-label="סגור"
            className="shrink-0 text-[var(--faint)] leading-none px-1"
          >
            ✕
          </button>
        </div>
      )}

      {board.length === 0 ? (
        <div className="text-center text-sm text-[var(--faint)] py-16 border border-dashed border-[var(--rule)] rounded-2xl">
          {/* DESIGN.md §10: an empty screen is an invitation, not "No data" —
              so it names the action when there is one to name. */}
          {canEditMoney ? "עדיין לא נרשמו עבודות רדיו ושונות. הוסיפו את הראשונה." : "עדיין לא נרשמו עבודות רדיו ושונות."}
          <div className="mt-1 text-[11px] text-[var(--ink-faint)]">
            כאן תופענה עבודות שאינן פודקאסט — הפקת רדיו, עריכת סאונד להקלטה של מישהו אחר, סשן חד־פעמי.
          </div>
        </div>
      ) : tab === "kanban" ? (
        <MiscKanban
          rows={board}
          // can_edit_money and NOT the screen's can_view_money: dragging is
          // writing, and the PATCH route checks the same flag (route.ts:87-89).
          // This is the identical distinction page.tsx:196-201 makes for the
          // "עבודה חדשה" button — a viewer who may read but not write is a real
          // combination, and a card that appears draggable and 403s is a lie
          // told by the UI.
          canEdit={canEditMoney}
          dragId={dragId}
          dragOver={dragOver}
          setDragId={setDragId}
          setDragOver={setDragOver}
          onDropTo={(id, status) => void moveStatus(id, status)}
        />
      ) : (
        <div className="glass-card overflow-x-auto rounded-2xl">
          <table className="w-full text-right text-sm">
            <thead>
              <tr className="border-b border-white/10 text-[11px] text-[var(--faint)]">
                <th className="py-2 px-3 font-normal">שם</th>
                <th className="py-2 px-3 font-normal">לקוח</th>
                <th className="py-2 px-3 font-normal whitespace-nowrap">תאריך עבודה</th>
                <th className="py-2 px-3 font-normal">סכום</th>
                <th className="py-2 px-3 font-normal">סטטוס</th>
                <th className="py-2 px-3 font-normal whitespace-nowrap">מספר הזמנה</th>
                <th className="py-2 px-3 font-normal">ספקים</th>
                <th className="py-2 px-3 font-normal">חיוב</th>
              </tr>
            </thead>
            <tbody>
              {board.map((r) => (
                <tr key={r.id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.03]">
                  <td className="py-2 px-3">
                    <div className="font-medium">{r.name}</div>
                    {/* the cancel reason belongs beside the name, not in the
                        status cell: 0074 carries no cancelled_at, so the reason
                        IS the rest of that status and reads as one sentence */}
                    {r.status === "בוטל" && r.cancel_reason && (
                      <div className="text-[11px] text-[var(--ink-faint)]">בוטל: {r.cancel_reason}</div>
                    )}
                    {r.status !== "בוטל" && r.description && (
                      <div className="text-[11px] text-[var(--ink-faint)] line-clamp-1">{r.description}</div>
                    )}
                  </td>
                  <td className="py-2 px-3 text-[var(--dim)]">{r.client_name ?? "—"}</td>
                  <td className="py-2 px-3 font-mono whitespace-nowrap text-[var(--dim)]">{displayDate(r.work_date)}</td>
                  <td className="py-2 px-3 font-mono whitespace-nowrap">{money(r.amount)}</td>
                  <td className="py-2 px-3">
                    <StatusPill status={r.status} />
                  </td>
                  <td className="py-2 px-3 font-mono text-[var(--dim)] whitespace-nowrap">
                    {r.client_order_ref || <span className="text-[var(--ink-faint)]">—</span>}
                  </td>
                  <td className="py-2 px-3 text-[var(--dim)] whitespace-nowrap">
                    <Suppliers lines={r.suppliers} />
                  </td>
                  <td className="py-2 px-3 whitespace-nowrap">
                    {r.billed ? (
                      <span className="text-[var(--cyan)] text-[11px]">הזמנת עבודה נוצרה</span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <span className="text-[var(--amber)] text-[11px]">טרם חויבה</span>
                        {/* Step 6. Three conditions, and each answers a
                            different question: can_edit_money — billing is a
                            write and the route checks the same flag; status —
                            cancelled work is not billed, and the board cannot
                            drag it back out to fix that; job_id — the button
                            IS the "no order yet" case, and `billed` is exactly
                            `job_id != null` (page.tsx:176).

                            NOT on the kanban card, deliberately: the card is a
                            drag surface and a button on it fights onDragStart.
                            The card still shows "טרם חויבה", which points here. */}
                        {canEditMoney && r.status !== "בוטל" && (
                          <button
                            onClick={() => void createWorkOrder(r.id)}
                            disabled={billingId !== null}
                            className="text-[11px] text-[var(--cyan)] border border-[var(--rule)] rounded-lg px-2 py-0.5 hover:bg-[var(--panel3)] disabled:opacity-40 whitespace-nowrap"
                          >
                            {billingId === r.id ? "יוצר…" : "צור הזמנת עבודה"}
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {board.length > 0 && (
        <p className="mt-3 text-[11px] text-[var(--ink-faint)]">
          &quot;טרם חויבה&quot; פירושו שהעבודה נרשמה ולא נוצרה לה הזמנת עבודה — מצב תקין, ונקודת הניסיון החוזר אם
          הוספת ההזמנה לתור נכשלה. סכום העבודה הוא מה שהלקוח מחויב; סכומי הספקים הם הוצאה נגדית ואינם מנוכים ממנו כאן.
        </p>
      )}

      {modalOpen && (
        <NewMiscModal
          clients={clients}
          onClose={() => setModalOpen(false)}
          onDone={(n) => {
            setModalOpen(false);
            setNotice(n);
            // The row is server-rendered — without this the confirmation would
            // appear above a table that does not contain what it confirms.
            // Runs on the 207 too: the entity exists there, only its billing
            // does not, and the row must show up at "טרם חויבה".
            router.refresh();
          }}
        />
      )}
    </main>
  );
}
