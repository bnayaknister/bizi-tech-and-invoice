"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import IconTile from "@/components/IconTile";
import { shortDate } from "@/lib/dates";
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
            l.due_date ? `לתשלום ${shortDate(l.due_date)}` : null,
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

  // Named states, never a range — the same rule STATUS_TONE follows. 'בוטל' is
  // excluded from "open" by being absent from this list, not by sorting after
  // something.
  const openCount = rows.filter((r) => r.status === "נפתח" || r.status === "בעבודה").length;

  return (
    <main className="max-w-6xl mx-auto p-6">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h1 className="text-lg font-bold flex items-center gap-2.5">
          <IconTile icon="productions" accent="violet-light" size={30} iconSize={17} />
          רדיו ושונות
        </h1>
        {rows.length > 0 && (
          <span className="text-xs text-[var(--faint)]">
            {rows.length} {rows.length === 1 ? "עבודה" : "עבודות"} · {openCount} פתוחות
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

      {rows.length === 0 ? (
        <div className="text-center text-sm text-[var(--faint)] py-16 border border-dashed border-[var(--rule)] rounded-2xl">
          {/* DESIGN.md §10: an empty screen is an invitation, not "No data" —
              so it names the action when there is one to name. */}
          {canEditMoney ? "עדיין לא נרשמו עבודות רדיו ושונות. הוסיפו את הראשונה." : "עדיין לא נרשמו עבודות רדיו ושונות."}
          <div className="mt-1 text-[11px] text-[var(--ink-faint)]">
            כאן תופענה עבודות שאינן פודקאסט — הפקת רדיו, עריכת סאונד להקלטה של מישהו אחר, סשן חד־פעמי.
          </div>
        </div>
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
              {rows.map((r) => (
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
                  <td className="py-2 px-3 font-mono whitespace-nowrap text-[var(--dim)]">{shortDate(r.work_date)}</td>
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
                      <span className="text-[var(--amber)] text-[11px]">טרם חויבה</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
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
