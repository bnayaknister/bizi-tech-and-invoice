"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export type AccruedRow = {
  id: string;
  amount: number | null;
  show_name: string;
  record_date: string | null;
  guest: string | null;
  age_days: number;
};

// One month's worth of a monthly client's accrued episodes. `closed` = the
// month is over and nobody redeemed it — that is the failure, not the count.
export type AccruedMonth = {
  key: string; // YYYY-MM
  label: string;
  count: number;
  total: number;
  closed: boolean;
};

export type AccruedGroup = {
  client_id: string;
  client_name: string;
  cadence: "per_episode" | "monthly" | "every_n";
  every_n: number | null;
  total: number;
  oldest_age_days: number;
  rows: AccruedRow[];
  months?: AccruedMonth[];
  has_closed_month?: boolean;
  days_to_month_end?: number;
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

const remainingLabel = (n: number) => (n === 1 ? "עוד פרק אחד לאגד מלא" : `עוד ${n} פרקים לאגד מלא`);

const monthEndLabel = (days: number) =>
  days <= 0 ? "היום האחרון בחודש" : days === 1 ? "החודש נסגר מחר" : `החודש נסגר בעוד ${days} ימים`;

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
  // The confirmation gate. Both actions it guards move episodes OUT of a
  // bundle for good — there is no "un-redeem" and no "un-release" — so the
  // bookkeeper reads what she is giving up before it happens, in the app's own
  // language and typography (window.confirm is a browser chrome box that
  // breaks RTL and the design system alike).
  const [ask, setAsk] = useState<{ body: string; run: () => void } | null>(null);

  useEffect(() => {
    if (!ask) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAsk(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ask]);

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

  // Redeeming a PARTIAL every_n bundle is the one redemption worth stopping
  // for: the episodes leave the bundle permanently and the next one starts
  // from zero, so a bundle billed at 2/6 can never be made whole. A full
  // bundle is the intended moment and goes straight through, and a monthly
  // client has no bundle to break — partial redemption is normal there.
  function askRedeem(g: AccruedGroup) {
    const n = g.rows.length;
    const m = g.every_n;
    if (!(g.cadence === "every_n" && m != null && n < m)) {
      redeem(g);
      return;
    }
    setAsk({
      body:
        `האגד של ${g.client_name} עומד על ${n} מתוך ${m} פרקים. ` +
        `פדיון עכשיו ייצור הזמנת עבודה מאוגדת על ${n} פרקים (${money(g.total)}) ` +
        `והפרקים לא ייכללו באגד הבא. לפדות בכל זאת?`,
      run: () => redeem(g),
    });
  }

  // Releasing a single episode always asks: it is a one-way exit from the
  // accrual for that episode, whatever the client's rhythm.
  function askRelease(rowId: string) {
    setAsk({
      body: "הפרק יוצא מהצבירה ותונפק עליו הזמנת עבודה נפרדת. הוא לא ייכלל באגד. להוציא?",
      run: () => release(rowId),
    });
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
                    onClick={() => askRedeem(g)}
                    disabled={busy !== null}
                    className="mt-2 rounded-lg bg-[var(--violet)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {busy === g.client_id ? "פודה…" : `פדה · ${g.rows.length} פרקים`}
                  </button>
                )}
              </div>
            </div>

            {/* every_n has a real numeric target — show the progress toward it,
                not two separate numbers the eye has to combine. */}
            {g.cadence === "every_n" && g.every_n != null && (
              <div className="mb-3">
                <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                  <span className="opacity-70">
                    {g.rows.length >= g.every_n ? "האגד מלא — מוכן לפדיון" : remainingLabel(g.every_n - g.rows.length)}
                  </span>
                  <span className="font-mono text-sm">
                    {g.rows.length}/{g.every_n}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, Math.round((g.rows.length / g.every_n) * 100))}%`,
                      background: g.rows.length >= g.every_n ? "var(--green)" : "var(--violet)",
                    }}
                  />
                </div>
              </div>
            )}

            {/* monthly has no numeric target — the target is the end of the
                month. A month that already closed is not progress, it is a
                miss, and it gets the amber dot the rest of the app uses. */}
            {g.cadence === "monthly" && g.months && g.months.length > 0 && (
              <div className="mb-3 space-y-1">
                {g.months.map((m) => (
                  <div key={m.key} className="flex items-baseline justify-between gap-2 text-xs">
                    <span className={`flex items-center gap-1.5 ${m.closed ? "text-amber-300" : "opacity-70"}`}>
                      {m.closed && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />}
                      {m.label} · {m.count} פרקים
                    </span>
                    <span className="opacity-60">
                      {m.closed ? "חודש שנסגר ולא נפדה" : monthEndLabel(g.days_to_month_end ?? 0)}
                    </span>
                  </div>
                ))}
              </div>
            )}

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
                        onClick={() => askRelease(r.id)}
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

      {ask && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setAsk(null)}
          role="dialog"
          aria-modal="true"
        >
          <div className="glass-card w-full max-w-md rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm leading-relaxed">{ask.body}</p>
            <div className="mt-5 flex justify-end gap-2">
              {/* cancel is the default: it is focused on open, it is what
                  Escape and a backdrop click do, and it is the outline button —
                  the weight belongs on the reversible choice */}
              <button
                autoFocus
                onClick={() => setAsk(null)}
                className="rounded-xl border border-[var(--rule)] px-4 py-1.5 text-sm text-[var(--dim)]"
              >
                בטל
              </button>
              <button
                onClick={() => {
                  const run = ask.run;
                  setAsk(null);
                  run();
                }}
                className="rounded-xl bg-[var(--violet)] px-4 py-1.5 text-sm font-medium text-white"
              >
                המשך
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
