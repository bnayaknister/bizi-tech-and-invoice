"use client";

import { useEffect, useState } from "react";
import { confidenceLabel } from "@/lib/documents/confidence";
import type { Confidence, AmountBasis } from "@/lib/documents/reconcile";

// The in-context "שייך מסמך קיים" / "שייך ל-job" picker (owner spec step 3):
// the system proposes ranked candidates with a clearly shown confidence, the
// bookkeeper confirms in one click. Used from the finance red tab (mode
// "job": fix a job, pick a document) and the registry (mode "doc": fix a
// document, pick a job). Both post to the same reconcile endpoint.

type Conf = { confidence: Confidence; amountBasis: AmountBasis; dateGapDays: number | null };
type DocCand = { docId: string; number: string | null; typeLabel: string; amount: number | null; date: string | null; clientName: string } & Conf;
type JobCand = { jobId: string; jobLabel: string; jobAmount: number | null; jobDate: string | null } & Conf;

const money = (n: number | null) =>
  n === null ? "—" : new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n);

export default function AssignDocModal({
  mode,
  id,
  heading,
  onClose,
  onAssigned,
}: {
  mode: "job" | "doc"; // "job": fix a job, pick a doc · "doc": fix a doc, pick a job
  id: string;
  heading: string;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [docs, setDocs] = useState<DocCand[]>([]);
  const [jobs, setJobs] = useState<JobCand[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const q = mode === "job" ? `jobId=${id}` : `docId=${id}`;
    fetch(`/api/documents/reconcile?${q}`)
      .then((r) => r.json())
      .then((b) => {
        if (mode === "job") setDocs(b.candidates ?? []);
        else setJobs(b.candidates ?? []);
      })
      .catch(() => setErr("שגיאת רשת"))
      .finally(() => setLoading(false));
  }, [mode, id]);

  async function pick(docId: string, jobId: string) {
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

  const empty = !loading && (mode === "job" ? docs.length === 0 : jobs.length === 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="glass-card w-full max-w-lg max-h-[80vh] overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold">{heading}</h2>
          <button onClick={onClose} className="text-[var(--faint)] text-lg leading-none">×</button>
        </div>
        {err && <div className="mb-3 text-xs text-[var(--red)] border border-[var(--red)] rounded-xl px-3 py-2">{err}</div>}
        {loading && <div className="text-xs text-[var(--faint)] py-6 text-center">טוען מועמדים…</div>}
        {empty && (
          <div className="text-xs text-[var(--faint)] py-6 text-center border border-dashed border-[var(--rule)] rounded-xl">
            לא נמצאו מסמכים מתאימים ברג׳יסטרי.
          </div>
        )}

        <div className="flex flex-col gap-2">
          {mode === "job" &&
            docs.map((d) => {
              const { title, detail, color } = confidenceLabel(d.confidence, d.dateGapDays, d.amountBasis);
              return (
                <div key={d.docId} className="flex items-center justify-between gap-3 border border-[var(--rule)] rounded-xl px-3 py-2 text-xs">
                  <span className="flex flex-col gap-0.5">
                    <span>
                      <span className="font-mono font-bold">#{d.number ?? "—"}</span> · {d.typeLabel} · {money(d.amount)} · {d.date ?? "—"}
                    </span>
                    <span className="text-[10px]" style={{ color }} title={detail}>● {title} <span className="text-[var(--faint)]">· {detail}</span></span>
                  </span>
                  <button
                    disabled={busy !== null}
                    onClick={() => pick(d.docId, id)}
                    className="shrink-0 font-bold rounded-lg px-3 py-1 bg-[var(--signal)] text-white disabled:opacity-40"
                  >
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
                  <button
                    disabled={busy !== null}
                    onClick={() => pick(id, j.jobId)}
                    className="shrink-0 font-bold rounded-lg px-3 py-1 bg-[var(--signal)] text-white disabled:opacity-40"
                  >
                    {busy === id + j.jobId ? "…" : "שייך"}
                  </button>
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
