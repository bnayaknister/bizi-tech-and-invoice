"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDrawer } from "@/components/EntityDrawer";

export type DocCandidate = { docId: string; number: string | null; typeLabel: string; amount: number | null; date: string | null };
export type JobCandidate = { jobId: string; jobLabel: string; jobAmount: number | null; jobDate: string | null };

export type Gap1Row = { jobId: string; jobLabel: string; jobAmount: number | null; jobDate: string | null; candidates: DocCandidate[] };
export type Gap2Row = {
  docId: string;
  number: string | null;
  typeLabel: string;
  amount: number | null;
  date: string | null;
  clientName: string;
  candidates: JobCandidate[];
};
export type Gap3Row = { jobId: string; jobLabel: string; jobAmount: number | null; jobDate: string | null };

const money = (n: number | null) =>
  n === null ? "—" : new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n);

export default function GapsClient({
  gap1,
  gap2,
  gap3,
  unmatchedDocCount,
  canEdit,
}: {
  gap1: Gap1Row[];
  gap2: Gap2Row[];
  gap3: Gap3Row[];
  unmatchedDocCount: number;
  canEdit: boolean;
}) {
  const router = useRouter();
  const { openEntity } = useDrawer();
  // rows the bookkeeper has resolved or dismissed this session, hidden until refresh
  const [doneJobs, setDoneJobs] = useState<Set<string>>(new Set());
  const [doneDocs, setDoneDocs] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function assign(docId: string, jobId: string, hideKey: { job?: string; doc?: string }) {
    setBusy(docId + jobId);
    setErr(null);
    try {
      const res = await fetch("/api/documents/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId, jobId }),
      });
      const body = await res.json();
      if (!res.ok) {
        setErr(body.error ?? "השיוך נכשל");
        return;
      }
      if (hideKey.job) setDoneJobs((s) => new Set(s).add(hideKey.job!));
      if (hideKey.doc) setDoneDocs((s) => new Set(s).add(hideKey.doc!));
      router.refresh();
    } catch {
      setErr("שגיאת רשת");
    } finally {
      setBusy(null);
    }
  }

  const v1 = gap1.filter((r) => !doneJobs.has(r.jobId));
  const v2 = gap2.filter((r) => !doneDocs.has(r.docId));
  const v3 = gap3.filter((r) => !doneJobs.has(r.jobId));
  const total = v1.length + v2.length + v3.length;

  return (
    <main className="max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-bold">פערים לטיפול</h1>
        <button
          onClick={() => router.push("/documents/registry")}
          className="text-xs font-bold rounded-xl px-4 py-1.5 border border-[var(--rule2)]"
        >
          כל המסמכים →
        </button>
      </div>
      <p className="text-xs text-[var(--faint)] mb-4">
        המערכת מציעה, את מאשרת. כל שיוך = לחיצה אחת. {total === 0 ? "אין כרגע פערים פתוחים." : `${total} פערים ממתינים.`}
      </p>
      {err && <div className="mb-3 text-xs text-[var(--red)] border border-[var(--red)] rounded-xl px-3 py-2">{err}</div>}
      {!canEdit && (
        <div className="mb-3 text-xs text-[var(--faint)] border border-[var(--rule)] rounded-xl px-3 py-2">
          צפייה בלבד — שיוך דורש הרשאת עריכת כספים.
        </div>
      )}

      {/* Gap 1 — red job with a matching unlinked tax doc */}
      {v1.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-bold mb-2 flex items-center gap-2">
            <span className="text-[var(--red)]">●</span> חסרה חשבונית מס — יש מסמך תואם ({v1.length})
          </h2>
          <div className="flex flex-col gap-2">
            {v1.map((r) => (
              <div key={r.jobId} className="border border-[var(--red)]/40 rounded-2xl px-4 py-3 text-xs">
                <button onClick={() => openEntity({ type: "job", id: r.jobId })} className="font-bold hover:underline">
                  {r.jobLabel}
                </button>
                <span className="text-[var(--faint)]"> · {money(r.jobAmount)} · {r.jobDate ?? "—"}</span>
                <div className="mt-2 flex flex-col gap-1.5">
                  {r.candidates.map((d) => (
                    <div key={d.docId} className="flex items-center justify-between gap-3 bg-[var(--hover)] rounded-xl px-3 py-2">
                      <span>
                        נראה שמסמך <span className="font-mono font-bold">#{d.number ?? "—"}</span> ({d.typeLabel},{" "}
                        {money(d.amount)}, {d.date ?? "—"}) שייך לכאן
                      </span>
                      {canEdit && (
                        <button
                          disabled={busy !== null}
                          onClick={() => assign(d.docId, r.jobId, { job: r.jobId })}
                          className="shrink-0 font-bold rounded-lg px-3 py-1 bg-[var(--signal)] text-white disabled:opacity-40"
                        >
                          {busy === d.docId + r.jobId ? "…" : "שייך"}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {canEdit && (
                  <button
                    onClick={() => setDoneJobs((s) => new Set(s).add(r.jobId))}
                    className="mt-1.5 text-[10px] text-[var(--faint)] hover:underline"
                  >
                    לא — הסתר
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Gap 2 — unlinked document, suggest jobs */}
      {v2.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-bold mb-2 flex items-center gap-2">
            <span className="text-[var(--warn)]">●</span> מסמך לא משויך — הצעות לשיוך ({v2.length})
          </h2>
          <div className="flex flex-col gap-2">
            {v2.map((r) => (
              <div key={r.docId} className="border border-[var(--warn)]/40 rounded-2xl px-4 py-3 text-xs">
                <span className="font-bold">
                  מסמך <span className="font-mono">#{r.number ?? "—"}</span> · {r.typeLabel}
                </span>
                <span className="text-[var(--faint)]"> · {r.clientName} · {money(r.amount)} · {r.date ?? "—"}</span>
                <div className="mt-2 flex flex-col gap-1.5">
                  {r.candidates.map((j) => (
                    <div key={j.jobId} className="flex items-center justify-between gap-3 bg-[var(--hover)] rounded-xl px-3 py-2">
                      <button onClick={() => openEntity({ type: "job", id: j.jobId })} className="text-right hover:underline">
                        {j.jobLabel} <span className="text-[var(--faint)]">· {money(j.jobAmount)} · {j.jobDate ?? "—"}</span>
                      </button>
                      {canEdit && (
                        <button
                          disabled={busy !== null}
                          onClick={() => assign(r.docId, j.jobId, { doc: r.docId })}
                          className="shrink-0 font-bold rounded-lg px-3 py-1 bg-[var(--signal)] text-white disabled:opacity-40"
                        >
                          {busy === r.docId + j.jobId ? "…" : "שייך"}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {canEdit && (
                  <button
                    onClick={() => setDoneDocs((s) => new Set(s).add(r.docId))}
                    className="mt-1.5 text-[10px] text-[var(--faint)] hover:underline"
                  >
                    לא — הסתר
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Gap 3 — old not-billed jobs */}
      {v3.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-bold mb-2 flex items-center gap-2">
            <span className="text-[var(--warn)]">●</span> לא חויב מעל 30 יום ({v3.length})
          </h2>
          <p className="text-[11px] text-[var(--faint)] mb-2">אולי חויב ידנית במורנינג? פתחי את החיוב כדי לטפל.</p>
          <div className="flex flex-col gap-1.5">
            {v3.map((r) => (
              <button
                key={r.jobId}
                onClick={() => openEntity({ type: "job", id: r.jobId })}
                className="text-right border border-[var(--rule)] rounded-xl px-4 py-2.5 text-xs hover:bg-[var(--hover)]"
              >
                <span className="font-bold">{r.jobLabel}</span>
                <span className="text-[var(--faint)]"> · {money(r.jobAmount)} · {r.jobDate ?? "—"}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {total === 0 && (
        <div className="text-center text-sm text-[var(--faint)] py-12 border border-dashed border-[var(--rule)] rounded-2xl">
          אין פערים פתוחים — הכול מסונכרן.
        </div>
      )}

      {unmatchedDocCount > 0 && (
        <p className="mt-6 text-[11px] text-[var(--faint)]">
          בנוסף: {unmatchedDocCount} מסמכים ברג׳יסטרי ללא לקוח ממופה (דורשים מיפוי לקוח, לא שיוך ל-job) —{" "}
          <button onClick={() => router.push("/documents/registry")} className="underline">
            לשונית "לא משויך"
          </button>
        </p>
      )}
    </main>
  );
}
