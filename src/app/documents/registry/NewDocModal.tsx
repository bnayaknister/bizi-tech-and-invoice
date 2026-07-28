"use client";

import { useEffect, useRef, useState } from "react";
import CreateMorningClientModal from "@/components/CreateMorningClientModal";

type JobHit = {
  id: string;
  client_id: string | null;
  client_name: string | null;
  client_mapped: boolean;
  show_name: string | null;
  guest: string | null;
  campaign: string | null;
  amount: number | null;
  date: string | null;
  status: string;
};

const TITLES: Record<"work_order" | "deal_invoice", string> = {
  work_order: "הזמנת עבודה חדשה",
  deal_invoice: "חשבון עסקה חדש",
};

const money = (n: number | null) =>
  n === null ? "—" : new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n);

// Issue a work order / deal invoice from the registry: search a job, confirm,
// and it enters the existing approval queue. can_edit_money is enforced on the
// route; this is just the picker.
export default function NewDocModal({
  docType,
  onClose,
  onQueued,
}: {
  docType: "work_order" | "deal_invoice";
  onClose: () => void;
  onQueued: (msg: string) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<JobHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<JobHit | null>(null);
  const [amount, setAmount] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [morningOpen, setMorningOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (picked) return; // stop searching once a job is chosen
    if (timer.current) clearTimeout(timer.current);
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/finance/jobs-search?q=${encodeURIComponent(term)}`);
        const body = await res.json();
        setHits(res.ok ? body.jobs ?? [] : []);
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q, picked]);

  function choose(j: JobHit) {
    setPicked(j);
    setAmount(j.amount != null ? String(j.amount) : "");
    setErr(null);
  }

  async function submit() {
    if (!picked) return;
    if (!picked.client_mapped) {
      setErr("הלקוח לא ממופה למורנינג — מפו אותו קודם");
      return;
    }
    const amtNum = amount.trim() === "" ? null : Number(amount);
    if (amtNum === null || Number.isNaN(amtNum)) {
      setErr("יש להזין סכום תקין");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/documents/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docType, jobId: picked.id, amount: amtNum, description: description.trim() || undefined }),
      });
      const body = await res.json();
      if (!res.ok) {
        setErr(body.error ?? "ההוספה לתור נכשלה");
        return;
      }
      onQueued(`${TITLES[docType]} נכנס לתור האישורים — אשר במסך “מסמכים לאישור”.`);
    } catch {
      setErr("שגיאת רשת");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="glass-card w-full max-w-lg p-5 rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-bold mb-3">{TITLES[docType]}</h2>

        {!picked ? (
          <>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
              placeholder="חפש job לפי לקוח / תוכנית / קמפיין / סכום…"
              className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs mb-2"
            />
            <div className="max-h-72 overflow-y-auto -mx-1">
              {searching && <div className="text-[11px] text-[var(--faint)] px-2 py-2">מחפש…</div>}
              {!searching && q.trim().length >= 2 && hits.length === 0 && (
                <div className="text-[11px] text-[var(--faint)] px-2 py-2">לא נמצאו jobs</div>
              )}
              {hits.map((j) => (
                <button
                  key={j.id}
                  onClick={() => choose(j)}
                  className="w-full text-right border border-[var(--rule)] rounded-xl px-3 py-2 mb-1.5 hover:bg-[var(--hover)] flex items-center justify-between gap-2"
                >
                  <span className="min-w-0">
                    <span className="text-xs font-bold">{j.client_name ?? "—"}</span>
                    <span className="text-[11px] text-[var(--dim)]">
                      {" "}
                      · {j.show_name ?? j.campaign ?? "—"}
                      {j.guest ? ` · ${j.guest}` : ""}
                    </span>
                    <span className="block text-[10px] text-[var(--faint)]">
                      {j.status} · {j.date ?? "—"}
                      {!j.client_mapped && <span className="text-[var(--warn)]"> · לא ממופה למורנינג</span>}
                    </span>
                  </span>
                  <span className="font-mono text-xs shrink-0">{money(j.amount)}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="border border-[var(--rule)] rounded-xl px-3 py-2 mb-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold">{picked.client_name ?? "—"}</span>
                <button onClick={() => setPicked(null)} className="text-[10px] text-[var(--signal)] underline">
                  החלף job
                </button>
              </div>
              <div className="text-[11px] text-[var(--dim)]">
                {picked.show_name ?? picked.campaign ?? "—"}
                {picked.guest ? ` · ${picked.guest}` : ""} · {picked.status}
              </div>
              {!picked.client_mapped && (
                <div className="text-[11px] text-[var(--warn)] mt-1 flex items-center gap-2">
                  <span>⚠️ הלקוח לא ממופה למורנינג — לא ניתן להנפיק</span>
                  {picked.client_id && (
                    <button onClick={() => setMorningOpen(true)} className="text-[var(--signal)] font-bold hover:underline">
                      מפה / צור במורנינג
                    </button>
                  )}
                </div>
              )}
            </div>
            <label className="block text-[11px] text-[var(--dim)] mb-1">סכום (₪, לפני מע״מ)</label>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs mb-2 font-mono"
            />
            <label className="block text-[11px] text-[var(--dim)] mb-1">תיאור (אופציונלי)</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="ברירת מחדל: סוג המסמך · לקוח · קמפיין"
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
            disabled={!picked || busy || !picked.client_mapped}
            className="text-xs font-bold rounded-xl px-4 py-1.5 bg-[var(--signal)] text-white disabled:opacity-40"
          >
            {busy ? "מוסיף לתור…" : "הוסף לתור האישורים"}
          </button>
        </div>
      </div>

      {morningOpen && picked?.client_id && (
        <CreateMorningClientModal
          clientId={picked.client_id}
          defaultName={picked.client_name ?? ""}
          onClose={() => setMorningOpen(false)}
          onResolved={() => {
            setMorningOpen(false);
            setPicked((p) => (p ? { ...p, client_mapped: true } : p));
          }}
        />
      )}
    </div>
  );
}
