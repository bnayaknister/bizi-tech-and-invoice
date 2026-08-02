"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type AccruedRow = {
  id: string;
  amount: number | null;
  show_name: string;
  record_date: string | null;
  guest: string | null;
  age_days: number;
};

export type AccruedGroup = {
  client_id: string;
  client_name: string;
  cadence: "per_episode" | "monthly" | "every_n";
  every_n: number | null;
  total: number;
  oldest_age_days: number;
  rows: AccruedRow[];
  ready?: boolean;
};

// A consolidated work order that already went out to Morning and still has no
// deal invoice linked back to it.
export type IssuedOrder = {
  id: string;
  client_name: string;
  doc_number: string | null;
  amount: number | null;
  lines: number;
  issued_at: string | null;
  dry_run: boolean;
};

const money = (n: number | null) =>
  n === null ? "—" : new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n);

const cadenceLabel = (g: AccruedGroup) =>
  g.cadence === "monthly" ? "מרוכז חודשי" : g.cadence === "every_n" ? `מרוכז כל ${g.every_n ?? "?"} פרקים` : "פר-פרק";

export default function AccruedClient({
  groups,
  issuedOrders,
  canRedeem,
}: {
  groups: AccruedGroup[];
  issuedOrders: IssuedOrder[];
  canRedeem: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function redeem(g: AccruedGroup) {
    if (busy) return;
    setBusy(g.client_id);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/documents/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: g.client_id }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "הפדיון נכשל");
      const parts = [`הזמנת עבודה מרוכזת (${j.work_order?.lines} פרקים)`];
      setNote(`${g.client_name}: ${parts.join(" · ")} — נכנסו לתור לאישור`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "שגיאה");
    } finally {
      setBusy(null);
    }
  }

  async function convert(o: IssuedOrder) {
    if (busy) return;
    setBusy(o.id);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/documents/convert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workOrderPendingId: o.id }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "היצירה נכשלה");
      setNote(
        `${o.client_name}: חשבון עסקה על סמך הזמנה ${o.doc_number ?? ""} (${j.deal_invoice?.lines} פרקים) — נכנס לתור לאישור`
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "שגיאה");
    } finally {
      setBusy(null);
    }
  }

  async function release(rowId: string) {
    if (busy) return;
    setBusy(rowId);
    setError(null);
    try {
      const res = await fetch("/api/documents/pending/accrue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: rowId, accrue: false }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "לא ניתן לשחרר");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "שגיאה");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8" dir="rtl">
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">פרקים מסוכמים — פדיון מרוכז</h1>
        <a href="/documents" className="text-sm text-[var(--violet)] hover:underline">← לתור המסמכים</a>
      </div>
      <p className="mb-6 text-sm opacity-70">
        לקוחות בקצב חודשי / כל-N. הפדיון יוצר הזמנת עבודה מרוכזת שנכנסת לתור הרגיל לאישור. אחרי שההזמנה מונפקת,
        חשבון העסקה נוצר על סמכה — וההזמנה נסגרת במורנינג מעצמה.
      </p>

      {error && <div className="mb-4 rounded-lg bg-rose-500/15 px-4 py-3 text-sm text-rose-300">{error}</div>}
      {note && <div className="mb-4 rounded-lg bg-emerald-500/15 px-4 py-3 text-sm text-emerald-300">{note}</div>}

      {issuedOrders.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-1 text-lg font-semibold">הזמנות שהונפקו וממתינות לחשבונית</h2>
          <p className="mb-3 text-xs opacity-60">
            חשבון העסקה נוצר על סמך ההזמנה, באותם סכומים בדיוק, וההזמנה נסגרת במורנינג עם ההנפקה.
          </p>
          <div className="space-y-2">
            {issuedOrders.map((o) => (
              <div key={o.id} className="glass-card flex items-center justify-between gap-3 rounded-2xl p-4">
                <div className="min-w-0">
                  <div className="font-semibold">{o.client_name}</div>
                  <div className="mt-0.5 text-xs opacity-60">
                    הזמנה {o.doc_number ?? "—"} · {o.lines} פרקים
                    {o.issued_at ? ` · הונפקה ${o.issued_at.slice(0, 10)}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-lg">{money(o.amount)}</span>
                  {canRedeem && (
                    <button
                      onClick={() => convert(o)}
                      disabled={busy !== null || o.dry_run}
                      title={
                        o.dry_run
                          ? "ההזמנה הונפקה בהרצה יבשה — אין מסמך אמיתי במורנינג לקשר אליו"
                          : "צור חשבון עסקה על סמך ההזמנה"
                      }
                      className="rounded-lg bg-[var(--violet)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {busy === o.id ? "יוצר…" : "צור חשבון עסקה"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {groups.length === 0 && issuedOrders.length === 0 && (
        <div className="glass-card rounded-2xl px-6 py-12 text-center opacity-70">אין פרקים מסוכמים כרגע.</div>
      )}

      <div className="space-y-5">
        {groups.map((g) => (
          <section key={g.client_id} className="glass-card rounded-2xl p-5">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold">{g.client_name}</h2>
                  {g.ready && (
                    <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300">מוכן לפדיון</span>
                  )}
                </div>
                <div className="mt-0.5 text-xs opacity-60">
                  {cadenceLabel(g)} · {g.rows.length} פרקים · הוותיק ביותר לפני {g.oldest_age_days} ימים
                </div>
              </div>
              <div className="text-left">
                <div className="font-mono text-xl">{money(g.total)}</div>
                {canRedeem && (
                  <button
                    onClick={() => redeem(g)}
                    disabled={busy !== null}
                    className="mt-2 rounded-lg bg-[var(--violet)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {busy === g.client_id ? "פודה…" : `פדה · ${g.rows.length} פרקים`}
                  </button>
                )}
              </div>
            </div>

            <ul className="divide-y divide-white/5">
              {g.rows.map((r) => (
                <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                  <div className="min-w-0">
                    <span className="truncate">{r.show_name}</span>
                    <span className="opacity-50">
                      {r.record_date ? ` · ${r.record_date}` : ""}
                      {r.guest ? ` · ${r.guest}` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono opacity-80">{money(r.amount)}</span>
                    {canRedeem && (
                      <button
                        onClick={() => release(r.id)}
                        disabled={busy !== null}
                        className="rounded-md border border-white/15 px-2 py-1 text-xs opacity-80 hover:opacity-100 disabled:opacity-40"
                        title="שחרר את הפרק הזה מהסיכום — הוצא כהזמנת עבודה נפרדת עכשיו"
                      >
                        הוצא עכשיו
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
