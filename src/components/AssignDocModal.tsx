"use client";

import { useEffect, useState } from "react";
import { confidenceLabel } from "@/lib/documents/confidence";
import type { Confidence, AmountBasis } from "@/lib/documents/reconcile";

// The in-context "שייך מסמך קיים" / "שייך ל-job" picker (owner spec step 3 +
// manual search 2026-07-27). Top: the engine's ranked suggestions. For a
// document (mode "doc") that the engine can't match — e.g. a מס-קבלה billed to
// the guest while the job sits under the client — a full free-text search over
// ALL jobs below it, so the bookkeeper finds and picks the job herself. Both
// paths post to the same reconcile endpoint (payment docs also flip paid).

type Conf = { confidence: Confidence; amountBasis: AmountBasis; dateGapDays: number | null };
type DocCand = { docId: string; number: string | null; typeLabel: string; amount: number | null; date: string | null; clientName: string } & Conf;
type JobCand = { jobId: string; jobLabel: string; jobAmount: number | null; jobDate: string | null } & Conf;
type SearchJob = { id: string; client_name: string | null; show_name: string | null; guest: string | null; campaign: string | null; amount: number | null; date: string | null; status: string };

const money = (n: number | null) =>
  n === null ? "—" : new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n);

export default function AssignDocModal({
  mode,
  id,
  heading,
  docAmount = null,
  onClose,
  onAssigned,
}: {
  mode: "job" | "doc"; // "job": fix a job, pick a doc · "doc": fix a doc, pick a job
  id: string;
  heading: string;
  docAmount?: number | null; // the document's amount (mode "doc"), for the mismatch warning
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [docs, setDocs] = useState<DocCand[]>([]);
  const [jobs, setJobs] = useState<JobCand[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // manual search (mode "doc")
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchJob[]>([]);
  const [searching, setSearching] = useState(false);
  const [mismatch, setMismatch] = useState<{ jobId: string; jobAmount: number | null; label: string } | null>(null);

  useEffect(() => {
    const query = mode === "job" ? `jobId=${id}` : `docId=${id}`;
    fetch(`/api/documents/reconcile?${query}`)
      .then((r) => r.json())
      .then((b) => {
        if (mode === "job") setDocs(b.candidates ?? []);
        else setJobs(b.candidates ?? []);
      })
      .catch(() => setErr("שגיאת רשת"))
      .finally(() => setLoading(false));
  }, [mode, id]);

  // debounced free-text job search
  useEffect(() => {
    if (mode !== "doc" || q.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      fetch(`/api/finance/jobs-search?q=${encodeURIComponent(q.trim())}`)
        .then((r) => r.json())
        .then((b) => setResults(b.jobs ?? []))
        .catch(() => setErr("שגיאת רשת"))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [q, mode]);

  async function assign(docId: string, jobId: string) {
    setBusy(docId + jobId);
    setErr(null);
    try {
      const res = await fetch("/api/documents/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId, jobId }),
      });
      const b = await res.json();
      if (!res.ok) {
        setErr(b.error ?? "השיוך נכשל");
        return;
      }
      onAssigned();
      onClose();
    } catch {
      setErr("שגיאת רשת");
    } finally {
      setBusy(null);
    }
  }

  // a manual pick: warn (don't block) if the raw amounts differ (VAT / add-on)
  function pickManual(j: SearchJob) {
    if (docAmount != null && j.amount != null && Math.abs(docAmount - j.amount) > 1) {
      setMismatch({ jobId: j.id, jobAmount: j.amount, label: [j.client_name, j.campaign].filter(Boolean).join(" · ") });
      return;
    }
    assign(id, j.id);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="glass-card w-full max-w-lg max-h-[85vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold">{heading}</h2>
          <button onClick={onClose} className="text-[var(--faint)] text-lg leading-none">×</button>
        </div>
        {err && <div className="mb-3 text-xs text-[var(--red)] border border-[var(--red)] rounded-xl px-3 py-2">{err}</div>}
        {loading && <div className="text-xs text-[var(--faint)] py-6 text-center">טוען מועמדים…</div>}

        {/* ---- top: engine suggestions ---- */}
        <div className="flex flex-col gap-2">
          {mode === "job" &&
            docs.map((d) => {
              const { title, detail, color } = confidenceLabel(d.confidence, d.dateGapDays, d.amountBasis);
              return (
                <div key={d.docId} className="flex items-center justify-between gap-3 border border-[var(--rule)] rounded-xl px-3 py-2 text-xs">
                  <span className="flex flex-col gap-0.5">
                    <span><span className="font-mono font-bold">#{d.number ?? "—"}</span> · {d.typeLabel} · {money(d.amount)} · {d.date ?? "—"}</span>
                    <span className="text-[10px]" style={{ color }} title={detail}>● {title} <span className="text-[var(--faint)]">· {detail}</span></span>
                  </span>
                  <button disabled={busy !== null} onClick={() => assign(d.docId, id)} className="shrink-0 font-bold rounded-lg px-3 py-1 bg-[var(--signal)] text-white disabled:opacity-40">
                    {busy === d.docId + id ? "…" : "שייך"}
                  </button>
                </div>
              );
            })}
          {mode === "doc" &&
            jobs.map((j) => {
              const { title, detail, color } = confidenceLabel(j.confidence, j.dateGapDays, j.amountBasis);
              return (
                <div key={j.jobId} className="flex items-center justify-between gap-3 border border-[var(--rule)] rounded-xl px-3 py-2 text-xs">
                  <span className="flex flex-col gap-0.5">
                    <span className="font-bold">{j.jobLabel} <span className="text-[var(--faint)] font-normal">· {money(j.jobAmount)} · {j.jobDate ?? "—"}</span></span>
                    <span className="text-[10px]" style={{ color }} title={detail}>● {title} <span className="text-[var(--faint)]">· {detail}</span></span>
                  </span>
                  <button disabled={busy !== null} onClick={() => assign(id, j.jobId)} className="shrink-0 font-bold rounded-lg px-3 py-1 bg-[var(--signal)] text-white disabled:opacity-40">
                    {busy === id + j.jobId ? "…" : "שייך"}
                  </button>
                </div>
              );
            })}
        </div>

        {mode === "job" && !loading && docs.length === 0 && (
          <div className="text-xs text-[var(--faint)] py-6 text-center border border-dashed border-[var(--rule)] rounded-xl">
            לא נמצאו מסמכים מתאימים ברג׳יסטרי.
          </div>
        )}

        {/* ---- bottom: manual free-text job search (mode "doc") ---- */}
        {mode === "doc" && (
          <div className="mt-4 pt-4 border-t border-[var(--rule)]">
            <div className="text-xs font-bold text-[var(--dim)] mb-2">
              {jobs.length ? "לא זה? חפש ידנית:" : "לא נמצאה התאמה אוטומטית — חפש ידנית:"}
            </div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="לקוח · תוכנית · אורח · קמפיין · סכום · תאריך…"
              className="w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs mb-2 outline-none focus:border-[var(--violet-light)]"
            />
            {searching && <div className="text-[11px] text-[var(--faint)] py-2 text-center">מחפש…</div>}
            <div className="flex flex-col gap-1.5">
              {results.map((j) => {
                const diff = docAmount != null && j.amount != null && Math.abs(docAmount - j.amount) > 1;
                return (
                  <div key={j.id} className="flex items-center justify-between gap-3 bg-[var(--hover)] rounded-xl px-3 py-2 text-xs">
                    <span className="flex flex-col gap-0.5 min-w-0">
                      <span className="font-bold truncate">{j.client_name ?? "—"}{j.show_name ? ` · ${j.show_name}` : ""}</span>
                      <span className="text-[10px] text-[var(--faint)] truncate">
                        {[j.campaign, j.guest && `אורח: ${j.guest}`].filter(Boolean).join(" · ")}
                      </span>
                      <span className="text-[10px] text-[var(--faint)]">
                        <span className={diff ? "text-[var(--warn)]" : ""}>{money(j.amount)}</span> · {j.date ?? "—"} · {j.status}
                      </span>
                    </span>
                    <button disabled={busy !== null} onClick={() => pickManual(j)} className="shrink-0 font-bold rounded-lg px-3 py-1 border border-[var(--rule2)] disabled:opacity-40">
                      {busy === id + j.id ? "…" : "שייך"}
                    </button>
                  </div>
                );
              })}
              {q.trim().length >= 2 && !searching && results.length === 0 && (
                <div className="text-[11px] text-[var(--faint)] py-3 text-center">לא נמצאו jobs תואמים</div>
              )}
            </div>
          </div>
        )}

        {/* amount-mismatch confirm (non-blocking) */}
        {mismatch && (
          <div className="mt-3 border border-[var(--warn)] rounded-xl px-3 py-3 text-xs">
            <div className="mb-2">
              ⚠ הסכומים שונים — המסמך <span className="font-bold">{money(docAmount)}</span>, ה-job{" "}
              <span className="font-bold">{money(mismatch.jobAmount)}</span> ({mismatch.label}). לשייך בכל זאת?
            </div>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setMismatch(null)} className="rounded-lg px-3 py-1 border border-[var(--rule)]">ביטול</button>
              <button
                disabled={busy !== null}
                onClick={() => { const jid = mismatch.jobId; setMismatch(null); assign(id, jid); }}
                className="font-bold rounded-lg px-3 py-1 bg-[var(--signal)] text-white disabled:opacity-40"
              >
                שייך בכל זאת
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
