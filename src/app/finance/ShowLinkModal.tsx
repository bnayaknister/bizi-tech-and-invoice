"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FinanceJob } from "./FinanceClient";

type ProdHit = { id: string; show: string | null; guest: string | null; date: string | null };
type CurrentLink = { production_id: string; show: string | null; guest: string | null; date: string | null };
type Info = { current: CurrentLink[]; invoiceTax: string | null; taxDocs: { number: string | null; pdf: string | null }[] };

const label = (p: { show: string | null; guest: string | null; date: string | null }) =>
  `${p.show ?? "—"}${p.date ? ` · ${p.date}` : ""}${p.guest ? ` · ${p.guest}` : ""}`;

// Fix which show a finance row belongs to (owner spec — Feature 4): link/relink
// the job's production. The linked tax receipt is shown and left untouched —
// relinking a production never affects invoices/documents.
export default function ShowLinkModal({
  job,
  onClose,
  onChanged,
}: {
  job: FinanceJob;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ProdHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadInfo = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${job.id}/show-link`);
      if (res.ok) setInfo(await res.json());
    } catch {
      /* ignore */
    }
  }, [job.id]);

  useEffect(() => {
    loadInfo();
  }, [loadInfo]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/productions/search?q=${encodeURIComponent(term)}`);
        const body = await res.json();
        setHits(res.ok ? body.productions ?? [] : []);
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q]);

  async function act(payload: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/jobs/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error ?? "הפעולה נכשלה");
        return;
      }
      await loadInfo();
      onChanged();
    } catch {
      setErr("שגיאת רשת");
    } finally {
      setBusy(false);
    }
  }

  const linkedIds = new Set((info?.current ?? []).map((c) => c.production_id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="glass-card w-full max-w-lg p-5 rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-bold mb-1">שיוך תוכנית · {job.client_name ?? ""} {job.campaign ?? ""}</h2>
        <p className="text-[11px] text-[var(--faint)] mb-3">בחר את התוכנית/הפקה שאליה שייך החיוב.</p>

        {info && (info.invoiceTax || info.taxDocs.length > 0) && (
          <div className="mb-3 text-[11px] text-[var(--green)] border border-[var(--green)] rounded-xl px-3 py-2">
            מקושרת חשבונית מס {info.taxDocs[0]?.number ? `#${info.taxDocs[0].number}` : info.invoiceTax ? `#${info.invoiceTax}` : ""} — שינוי התוכנית לא יפגע בה.
          </div>
        )}

        {/* current links */}
        <div className="mb-3">
          <div className="text-[11px] text-[var(--dim)] mb-1">מקושר כעת</div>
          {info?.current.length ? (
            <div className="space-y-1">
              {info.current.map((c) => (
                <div key={c.production_id} className="flex items-center justify-between border border-[var(--rule)] rounded-xl px-3 py-1.5 text-xs">
                  <span className="min-w-0 truncate">{label(c)}</span>
                  <button
                    onClick={() => act({ action: "unlink", jobId: job.id, productionId: c.production_id })}
                    disabled={busy}
                    className="text-[10px] text-[var(--red)] shrink-0"
                  >
                    בטל קישור
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-[var(--faint)] border border-dashed border-[var(--rule)] rounded-xl px-3 py-2">
              אין תוכנית מקושרת
            </div>
          )}
        </div>

        {/* search + link */}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
          placeholder="חפש תוכנית / אורח / תאריך…"
          className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs mb-2"
        />
        <div className="max-h-56 overflow-y-auto space-y-1">
          {searching && <div className="text-[11px] text-[var(--faint)] px-1">מחפש…</div>}
          {!searching && q.trim().length >= 2 && hits.length === 0 && (
            <div className="text-[11px] text-[var(--faint)] px-1">לא נמצאו תוכניות</div>
          )}
          {hits.map((p) => (
            <button
              key={p.id}
              disabled={busy || linkedIds.has(p.id)}
              onClick={() => act({ action: "link", jobId: job.id, productionIds: [p.id], confidence: "manual" })}
              className="w-full text-right border border-[var(--rule)] rounded-xl px-3 py-2 text-xs hover:bg-[var(--hover)] disabled:opacity-40 flex items-center justify-between gap-2"
            >
              <span className="min-w-0 truncate">{label(p)}</span>
              <span className="text-[10px] text-[var(--signal)] shrink-0">{linkedIds.has(p.id) ? "מקושר" : "שייך"}</span>
            </button>
          ))}
        </div>

        {err && <div className="text-[11px] text-[var(--red)] mt-2">{err}</div>}
        <div className="flex items-center justify-end mt-4">
          <button onClick={onClose} className="text-xs font-bold rounded-xl px-4 py-1.5 border border-[var(--rule)]">
            סגור
          </button>
        </div>
      </div>
    </div>
  );
}
