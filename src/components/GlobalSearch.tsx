"use client";

import { useEffect, useRef, useState } from "react";
import { useDrawer } from "@/components/EntityDrawer";
import LineIcon from "@/components/LineIcon";

type Results = {
  clients: { id: string; name: string }[];
  jobs: { id: string; campaign: string; amount: number | null }[];
  productions: { id: string; podcast_name: string; guest: string | null; storage_disk: string | null }[];
};

const EMPTY: Results = { clients: [], jobs: [], productions: [] };

export default function GlobalSearch() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Results>(EMPTY);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const { openEntity } = useDrawer();

  // a search result is active: clicking opens the entity drawer in place
  function pick(type: string, id: string) {
    setOpen(false);
    openEntity({ type, id });
  }

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults(EMPTY);
      return;
    }
    const t = setTimeout(async () => {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (res.ok) setResults(await res.json());
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const hasResults = results.clients.length + results.jobs.length + results.productions.length > 0;

  return (
    <div ref={boxRef} className="relative w-full max-w-md">
      <span className="absolute inset-y-0 right-3 flex items-center text-[var(--faint)] pointer-events-none">
        <LineIcon name="search" size={16} />
      </span>
      <input
        type="text"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="חיפוש גלובלי — לקוח, חיוב, פודקאסט…"
        className="w-full rounded-xl pr-9 pl-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--faint)] border border-[var(--rule)] focus:border-[var(--violet-light)] outline-none transition-colors"
        style={{ background: "rgba(255,255,255,0.05)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
      />
      {open && q.trim().length >= 2 && (
        <div
          className="absolute z-20 mt-2 w-full border border-[var(--rule2)] rounded-xl shadow-2xl max-h-80 overflow-y-auto"
          style={{ background: "rgba(15,13,28,0.85)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}
        >
          {!hasResults && <div className="p-3 text-xs text-[var(--faint)]">אין תוצאות</div>}
          {results.clients.length > 0 && (
            <div className="p-2">
              <div className="text-[10px] text-[var(--faint)] font-bold px-1 mb-1">לקוחות</div>
              {results.clients.map((c) => (
                <button
                  key={c.id}
                  onClick={() => pick("client", c.id)}
                  className="block w-full text-right px-2 py-1.5 text-sm hover:bg-[var(--panel3)] rounded"
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {results.jobs.length > 0 && (
            <div className="p-2 border-t border-[var(--rule)]">
              <div className="text-[10px] text-[var(--faint)] font-bold px-1 mb-1">חיובים</div>
              {results.jobs.map((j) => (
                <button
                  key={j.id}
                  onClick={() => pick("job", j.id)}
                  className="w-full text-right px-2 py-1.5 text-sm hover:bg-[var(--panel3)] rounded flex justify-between"
                >
                  <span>{j.campaign}</span>
                  {j.amount != null && <span className="text-[var(--dim)]">₪{j.amount.toLocaleString("he-IL")}</span>}
                </button>
              ))}
            </div>
          )}
          {results.productions.length > 0 && (
            <div className="p-2 border-t border-[var(--rule)]">
              <div className="text-[10px] text-[var(--faint)] font-bold px-1 mb-1">הפקות</div>
              {results.productions.map((p) => (
                <button
                  key={p.id}
                  onClick={() => pick("production", p.id)}
                  className="block w-full text-right px-2 py-1.5 text-sm hover:bg-[var(--panel3)] rounded"
                >
                  {p.podcast_name} {p.guest ? `· ${p.guest}` : ""}
                  {p.storage_disk && (
                    <span className="text-[10px] text-[var(--faint)]"> · 💾 {p.storage_disk}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
