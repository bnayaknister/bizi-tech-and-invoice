"use client";

import { useEffect, useRef, useState } from "react";
import { useDrawer } from "@/components/EntityDrawer";

type Results = {
  clients: { id: string; name: string }[];
  jobs: { id: string; campaign: string; amount: number | null }[];
  productions: { id: string; podcast_name: string; guest: string | null }[];
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
      <input
        type="text"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="חיפוש גלובלי — לקוח, חיוב, פודקאסט…"
        className="w-full bg-[var(--panel)] border border-[var(--rule)] rounded px-3 py-2 text-sm"
      />
      {open && q.trim().length >= 2 && (
        <div className="absolute z-20 mt-1 w-full bg-[var(--panel2)] border border-[var(--rule2)] rounded shadow-lg max-h-80 overflow-y-auto">
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
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
