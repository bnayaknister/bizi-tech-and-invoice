"use client";

import { useEffect, useState } from "react";

// "הזמנה מרוכזת מתוכנית": N episodes that were edited but never entered as
// productions, billed as one work order. Same shape as NewDocModal — pick,
// then fill — except the thing being picked is a SHOW, and the amount comes
// from a count rather than from a job.
//
// The queue row it creates goes through the ordinary approval path; nothing
// here reaches Morning.

type ShowHit = {
  id: string;
  name: string;
  client_id: string | null;
  client_name: string | null;
  client_mapped: boolean;
  default_rate: number | null;
  pricing_model: string;
};

const money = (n: number) =>
  new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 2 }).format(n);

export default function BundleFromShowModal({
  onClose,
  onQueued,
}: {
  onClose: () => void;
  onQueued: (msg: string) => void;
}) {
  const [shows, setShows] = useState<ShowHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<ShowHit | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/shows/list");
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setErr(body.error ?? "טעינת התוכניות נכשלה");
          return;
        }
        setShows(body.shows ?? []);
      } catch {
        if (!cancelled) setErr("שגיאת רשת");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function choose(s: ShowHit) {
    setPicked(s);
    // the show's own rate, editable — a show billed by the hour has no
    // per-episode rate to prefill, and the field stays empty rather than
    // borrowing a number from somewhere it does not belong
    setUnitPrice(s.default_rate != null ? String(s.default_rate) : "");
    setErr(null);
  }

  const qtyNum = Number(quantity);
  const priceNum = Number(unitPrice);
  const qtyOk = Number.isInteger(qtyNum) && qtyNum >= 1;
  const priceOk = Number.isFinite(priceNum) && priceNum > 0;
  const total = qtyOk && priceOk ? Math.round(qtyNum * priceNum * 100) / 100 : null;

  const filtered = q.trim()
    ? shows.filter((s) =>
        `${s.name} ${s.client_name ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())
      )
    : shows;

  async function submit() {
    if (!picked) return;
    if (!picked.client_mapped) {
      setErr("הלקוח לא ממופה למורנינג — מפו אותו קודם");
      return;
    }
    if (!qtyOk) {
      setErr("כמות הפרקים חייבת להיות מספר שלם מ-1 ומעלה");
      return;
    }
    if (!priceOk) {
      setErr("יש להזין מחיר לפרק גדול מאפס");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/documents/bundle-from-show", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          showId: picked.id,
          quantity: qtyNum,
          unitPrice: priceNum,
          description: description.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setErr(body.error ?? "יצירת ההזמנה נכשלה");
        return;
      }
      onQueued(`נוצרה הזמנת עבודה מרוכזת על ${money(body.amount ?? total ?? 0)} — ממתינה לאישור בתור המסמכים`);
    } catch {
      setErr("שגיאת רשת");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="glass-card w-full max-w-lg max-h-[85vh] overflow-y-auto p-5 rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-bold mb-1">הזמנת עבודה מרוכזת מתוכנית</h2>
        <p className="text-[11px] text-[var(--dim)] mb-3">
          לפרקים שנערכו ולא הוזנו כהפקות — הזמנה אחת על כמות × מחיר.
        </p>

        {!picked ? (
          <>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
              placeholder="חפש תוכנית לפי שם / לקוח…"
              className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs mb-2"
            />
            <div className="max-h-72 overflow-y-auto -mx-1">
              {loading && <div className="text-[11px] text-[var(--faint)] px-2 py-2">טוען תוכניות…</div>}
              {!loading && filtered.length === 0 && (
                <div className="text-[11px] text-[var(--faint)] px-2 py-2">לא נמצאו תוכניות</div>
              )}
              {filtered.map((s) => (
                <button
                  key={s.id}
                  onClick={() => choose(s)}
                  className="w-full text-right border border-[var(--rule)] rounded-xl px-3 py-2 mb-1.5 hover:bg-[var(--panel3)] flex items-center justify-between gap-2"
                >
                  <span className="min-w-0">
                    <span className="text-xs font-bold">{s.name}</span>
                    <span className="block text-[10px] text-[var(--faint)]">
                      {s.client_name ?? "ללא לקוח"}
                      {!s.client_mapped && <span className="text-[var(--warn)]"> · לא ממופה למורנינג</span>}
                    </span>
                  </span>
                  <span className="font-mono text-xs shrink-0">
                    {s.default_rate != null ? money(s.default_rate) : "—"}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="border border-[var(--rule)] rounded-xl px-3 py-2 mb-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold">{picked.name}</span>
                <button onClick={() => setPicked(null)} className="text-[10px] text-[var(--signal)] underline">
                  החלף תוכנית
                </button>
              </div>
              <div className="text-[11px] text-[var(--dim)]">{picked.client_name ?? "ללא לקוח"}</div>
              {!picked.client_mapped && (
                <div className="text-[11px] text-[var(--warn)] mt-1">
                  ⚠️ הלקוח לא ממופה למורנינג — לא ניתן להנפיק
                </div>
              )}
              {picked.pricing_model !== "per_episode" && (
                <div className="text-[11px] text-[var(--warn)] mt-1">
                  ⚠️ התוכנית מתומחרת לפי {picked.pricing_model} — ודאו את המחיר לפרק
                </div>
              )}
            </div>

            <div className="flex gap-2 mb-2">
              <div className="flex-1">
                <label className="block text-[11px] text-[var(--dim)] mb-1">כמות פרקים</label>
                <input
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  inputMode="numeric"
                  className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs font-mono"
                />
              </div>
              <div className="flex-1">
                <label className="block text-[11px] text-[var(--dim)] mb-1">מחיר לפרק (₪, לפני מע״מ)</label>
                <input
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(e.target.value)}
                  inputMode="decimal"
                  className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs font-mono"
                />
              </div>
            </div>

            {/* the arithmetic, spelled out — this is the number that will be
                printed, and it is the one thing nobody should have to trust */}
            <div className="border border-[var(--rule2)] rounded-xl px-3 py-2 mb-2 text-center">
              {total != null ? (
                <span className="text-sm font-bold font-mono">
                  {qtyNum} × {money(priceNum)} = {money(total)}
                </span>
              ) : (
                <span className="text-[11px] text-[var(--faint)]">הזינו כמות ומחיר תקינים</span>
              )}
            </div>

            <label className="block text-[11px] text-[var(--dim)] mb-1">תיאור (אופציונלי)</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={`ברירת מחדל: הזמנת עבודה — ${picked.client_name ?? ""} ${picked.name}`}
              className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs mb-1"
            />
          </>
        )}

        {err && <div className="text-[11px] text-[var(--red)] mt-2">{err}</div>}

        <div className="flex items-center justify-end gap-2 mt-4">
          <button onClick={onClose} className="text-xs rounded-xl px-4 py-1.5 border border-[var(--rule)]">
            ביטול
          </button>
          <button
            onClick={submit}
            disabled={!picked || busy || !picked.client_mapped || total == null}
            className="text-xs font-bold rounded-xl px-4 py-1.5 bg-[var(--signal)] text-white disabled:opacity-40"
          >
            {busy ? "מוסיף לתור…" : "הוסף לתור האישורים"}
          </button>
        </div>
      </div>
    </div>
  );
}
