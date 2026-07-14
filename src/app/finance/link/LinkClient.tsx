"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Suggestion } from "@/lib/linking";

export type JobRow = {
  id: string;
  date: string | null;
  client: string;
  campaign: string | null;
  amount: number | null;
  manualOnly: boolean;
  linked: string[]; // production ids
  suggestion: Suggestion | null;
};

export type ProductionOption = {
  id: string;
  date: string | null;
  show: string;
  guest: string | null;
};

const NIS = new Intl.NumberFormat("he-IL");
const CONF_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 };
const CONF_LABEL: Record<string, string> = {
  high: "גבוה",
  medium: "בינוני",
  low: "נמוך",
  none: "לא נמצא",
};
const CONF_STYLE: Record<string, string> = {
  high: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40",
  medium: "bg-amber-500/15 text-amber-400 border-amber-500/40",
  low: "bg-orange-500/15 text-orange-400 border-orange-500/40",
  none: "bg-zinc-500/15 text-[var(--dim)] border-[var(--rule)]",
};

function fmtDate(d: string | null): string {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}.${m}.${y.slice(2)}`;
}

export default function LinkClient({
  jobs,
  productions,
  canEditMoney,
}: {
  jobs: JobRow[];
  productions: ProductionOption[];
  canEditMoney: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"unlinked" | "linked" | "manual">("unlinked");
  const [focusIdx, setFocusIdx] = useState(0);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const listRef = useRef<HTMLDivElement>(null);

  const prodById = useMemo(() => {
    const m: Record<string, ProductionOption> = {};
    for (const p of productions) m[p.id] = p;
    return m;
  }, [productions]);

  const unlinked = useMemo(
    () =>
      jobs
        .filter((j) => !j.manualOnly && j.linked.length === 0 && !skipped[j.id])
        .sort(
          (a, b) =>
            CONF_ORDER[a.suggestion?.confidence ?? "none"] -
              CONF_ORDER[b.suggestion?.confidence ?? "none"] ||
            (a.date ?? "9999").localeCompare(b.date ?? "9999")
        ),
    [jobs, skipped]
  );
  const linked = useMemo(() => jobs.filter((j) => j.linked.length > 0), [jobs]);
  const manual = useMemo(() => jobs.filter((j) => j.manualOnly), [jobs]);

  const focused = tab === "unlinked" ? unlinked[focusIdx] ?? null : null;

  function selectedFor(job: JobRow): string[] {
    return selections[job.id] ?? job.suggestion?.suggested ?? [];
  }

  function toggle(jobId: string, prodId: string, base: string[]) {
    setSelections((prev) => {
      const cur = prev[jobId] ?? base;
      return {
        ...prev,
        [jobId]: cur.includes(prodId) ? cur.filter((x) => x !== prodId) : [...cur, prodId],
      };
    });
  }

  async function call(payload: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/jobs/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "שגיאה");
      return false;
    }
    router.refresh();
    return true;
  }

  async function approve(job: JobRow) {
    if (!canEditMoney || busy) return;
    const ids = selectedFor(job);
    if (!ids.length) {
      setError("לא נבחרו הפקות לקישור");
      return;
    }
    await call({
      action: "link",
      jobId: job.id,
      productionIds: ids,
      confidence: job.suggestion?.confidence ?? "manual",
      note: job.suggestion?.note ?? null,
    });
  }

  // Enter = approve the focused job, Esc = skip it (session-local)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (tab !== "unlinked" || !focused) return;
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
      if (e.key === "Enter" && !typing) {
        e.preventDefault();
        void approve(focused);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setSkipped((prev) => ({ ...prev, [focused.id]: true }));
        setFocusIdx((i) => Math.min(i, Math.max(0, unlinked.length - 2)));
      } else if (e.key === "ArrowDown" && !typing) {
        e.preventDefault();
        setFocusIdx((i) => Math.min(i + 1, unlinked.length - 1));
      } else if (e.key === "ArrowUp" && !typing) {
        e.preventDefault();
        setFocusIdx((i) => Math.max(i - 1, 0));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, focused, unlinked.length, selections, busy]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return productions
      .filter(
        (p) =>
          p.show.toLowerCase().includes(q) ||
          (p.guest ?? "").toLowerCase().includes(q) ||
          (p.date ?? "").includes(q)
      )
      .slice(0, 12);
  }, [search, productions]);

  function prodLine(id: string) {
    const p = prodById[id];
    if (!p) return id;
    return `${fmtDate(p.date)} · ${p.show}${p.guest ? ` · ${p.guest}` : ""}`;
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <h1 className="text-lg font-bold">🔗 קישור חיובים להפקות</h1>
        <span className="text-xs text-[var(--dim)]">
          {unlinked.length} לקישור · {linked.length} מקושרים · {manual.length} כלליים
        </span>
        <div className="flex-1" />
        <span className="text-xs text-[var(--dim)]">Enter=אשר · Esc=דלג · ↑↓=ניווט</span>
      </div>

      <div className="flex gap-2 mb-4">
        {(
          [
            ["unlinked", "לקישור"],
            ["linked", "מקושרים"],
            ["manual", "חיובים כלליים"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`text-xs rounded px-3 py-1.5 border ${
              tab === key
                ? "border-[var(--accent,#888)] font-bold"
                : "border-[var(--rule)] text-[var(--dim)] hover:bg-[var(--panel3)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3 text-sm text-red-400 border border-red-500/40 rounded px-3 py-2">
          {error}
        </div>
      )}

      {tab === "unlinked" && (
        <div ref={listRef} className="space-y-2">
          {unlinked.length === 0 && (
            <div className="text-sm text-[var(--dim)] border border-[var(--rule)] rounded p-4">
              אין חיובים שממתינים לקישור 🎉
            </div>
          )}
          {unlinked.map((job, idx) => {
            const s = job.suggestion;
            const conf = s?.confidence ?? "none";
            const isFocused = idx === focusIdx;
            const selected = selectedFor(job);
            // candidates: the show's window productions + anything already selected
            const candidateIds = Array.from(
              new Set([...(s?.windowCandidates ?? []), ...selected])
            );
            return (
              <div
                key={job.id}
                onClick={() => setFocusIdx(idx)}
                className={`border rounded p-3 cursor-pointer ${
                  isFocused ? "border-[var(--accent,#999)] bg-[var(--panel3)]" : "border-[var(--rule)]"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className={`text-[11px] border rounded px-1.5 py-0.5 ${CONF_STYLE[conf]}`}>
                    {CONF_LABEL[conf]}
                  </span>
                  <span className="text-[var(--dim)] text-xs tabular-nums">{fmtDate(job.date)}</span>
                  <b>{job.client}</b>
                  <span>{job.campaign ?? "—"}</span>
                  <span className="text-[var(--dim)]">·</span>
                  <span className="tabular-nums">{job.amount != null ? `${NIS.format(job.amount)} ₪` : "—"}</span>
                  {s?.expectedEpisodes != null && s.expectedEpisodes > s.windowCandidates.length ? (
                    <span className="text-[11px] text-amber-400 border border-amber-500/40 rounded px-1.5 py-0.5 font-bold">
                      🟡 החיוב מכסה {s.expectedEpisodes} הפקות — במערכת קיימות רק{" "}
                      {s.windowCandidates.length}. עבודה שבוצעה ולא נרשמה?
                    </span>
                  ) : (
                    s?.multiEpisode && (
                      <span className="text-[11px] text-amber-400 border border-amber-500/40 rounded px-1.5 py-0.5">
                        כנראה כמה פרקים — בחר כמה הפקות
                      </span>
                    )
                  )}
                  <div className="flex-1" />
                  {s?.note && <span className="text-xs text-[var(--dim)]">{s.note}</span>}
                </div>

                {isFocused && (
                  <div className="mt-3 border-t border-[var(--rule)] pt-3">
                    {candidateIds.length > 0 ? (
                      <div className="space-y-1 mb-3">
                        {candidateIds.map((pid) => (
                          <label key={pid} className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selected.includes(pid)}
                              onChange={() => toggle(job.id, pid, s?.suggested ?? [])}
                              disabled={!canEditMoney}
                            />
                            <span>{prodLine(pid)}</span>
                            {prodById[pid]?.guest && (
                              <span className="text-[11px] text-emerald-400">🎙 {prodById[pid].guest}</span>
                            )}
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-[var(--dim)] mb-3">אין הצעות — חפש ידנית:</div>
                    )}

                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="חיפוש ידני: תוכנית / אורח / תאריך (YYYY-MM-DD)"
                      className="w-full text-sm bg-transparent border border-[var(--rule)] rounded px-3 py-1.5 mb-2"
                    />
                    {searchResults.length > 0 && (
                      <div className="space-y-1 mb-3 max-h-48 overflow-auto">
                        {searchResults.map((p) => (
                          <label key={p.id} className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selected.includes(p.id)}
                              onChange={() => toggle(job.id, p.id, s?.suggested ?? [])}
                              disabled={!canEditMoney}
                            />
                            <span>{prodLine(p.id)}</span>
                          </label>
                        ))}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => approve(job)}
                        disabled={!canEditMoney || busy || selected.length === 0}
                        className="text-xs rounded px-3 py-1.5 border border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-40"
                      >
                        אשר קישור ({selected.length}) ⏎
                      </button>
                      <button
                        onClick={() => setSkipped((prev) => ({ ...prev, [job.id]: true }))}
                        className="text-xs rounded px-3 py-1.5 border border-[var(--rule)] text-[var(--dim)] hover:bg-[var(--panel3)]"
                      >
                        דלג Esc
                      </button>
                      <button
                        onClick={() => call({ action: "manual_only", jobId: job.id, value: true })}
                        disabled={!canEditMoney || busy}
                        className="text-xs rounded px-3 py-1.5 border border-[var(--rule)] text-[var(--dim)] hover:bg-[var(--panel3)] disabled:opacity-40"
                        title="חיוב כללי — לא לפי פרק. ההתראה 'לא מקושר' לא תופיע עליו לעולם."
                      >
                        סמן כחיוב כללי
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === "linked" && (
        <div className="space-y-2">
          {linked.length === 0 && (
            <div className="text-sm text-[var(--dim)] border border-[var(--rule)] rounded p-4">
              אין עדיין חיובים מקושרים.
            </div>
          )}
          {linked.map((job) => (
            <div key={job.id} className="border border-[var(--rule)] rounded p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[var(--dim)] text-xs tabular-nums">{fmtDate(job.date)}</span>
                <b>{job.client}</b>
                <span>{job.campaign ?? "—"}</span>
                <span className="text-[var(--dim)]">·</span>
                <span className="tabular-nums">{job.amount != null ? `${NIS.format(job.amount)} ₪` : "—"}</span>
              </div>
              <div className="mt-2 space-y-1">
                {job.linked.map((pid) => (
                  <div key={pid} className="flex items-center gap-2 text-xs">
                    <span>↳ {prodLine(pid)}</span>
                    {canEditMoney && (
                      <button
                        onClick={() => call({ action: "unlink", jobId: job.id, productionId: pid })}
                        disabled={busy}
                        className="text-[11px] text-red-400 border border-red-500/40 rounded px-1.5 py-0.5 hover:bg-red-500/10"
                      >
                        בטל קישור
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "manual" && (
        <div className="space-y-2">
          {manual.length === 0 && (
            <div className="text-sm text-[var(--dim)] border border-[var(--rule)] rounded p-4">
              אין חיובים כלליים.
            </div>
          )}
          {manual.map((job) => (
            <div
              key={job.id}
              className="border border-[var(--rule)] rounded p-3 text-sm flex flex-wrap items-center gap-2"
            >
              <span className="text-[var(--dim)] text-xs tabular-nums">{fmtDate(job.date)}</span>
              <b>{job.client}</b>
              <span>{job.campaign ?? "—"}</span>
              <span className="text-[var(--dim)]">·</span>
              <span className="tabular-nums">{job.amount != null ? `${NIS.format(job.amount)} ₪` : "—"}</span>
              <div className="flex-1" />
              {canEditMoney && (
                <button
                  onClick={() => call({ action: "manual_only", jobId: job.id, value: false })}
                  disabled={busy}
                  className="text-xs rounded px-3 py-1.5 border border-[var(--rule)] text-[var(--dim)] hover:bg-[var(--panel3)]"
                >
                  החזר לקישור
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
