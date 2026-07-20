"use client";

import { useEffect, useMemo, useState } from "react";

// One client at a time is the point (owner, 2026-07-20): unmapped clients
// can't bill at all, so this screen is the tap the owner opens deliberately.
// Auto-match is a SUGGESTION only — every mapping is a manual confirm.

type OurClient = {
  id: string;
  name: string;
  morning_client_id: string | null;
  mapped_name?: string | null;
  mapped_tax_id?: string | null;
  mapped_missing?: boolean;
  suggestion: { id: string; name: string; distance: number } | null;
};

type MorningClient = { id: string; name: string; taxId: string | null };

export default function MorningClientsClient() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsCreds, setNeedsCreds] = useState(false);
  const [clients, setClients] = useState<OurClient[]>([]);
  const [morning, setMorning] = useState<MorningClient[]>([]);
  const [filter, setFilter] = useState("");
  const [onlyUnmapped, setOnlyUnmapped] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  // per-row chosen morning id before confirm (defaults to the suggestion)
  const [choice, setChoice] = useState<Record<string, string>>({});

  async function load() {
    setLoading(true);
    setError(null);
    setNeedsCreds(false);
    try {
      const res = await fetch("/api/morning/clients");
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "טעינה נכשלה");
        setNeedsCreds(!!body.needs_credentials);
        return;
      }
      setClients(body.clients);
      setMorning(body.morning_clients);
      const seed: Record<string, string> = {};
      for (const c of body.clients as OurClient[]) {
        if (!c.morning_client_id && c.suggestion) seed[c.id] = c.suggestion.id;
      }
      setChoice(seed);
    } catch {
      setError("שגיאת רשת");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const morningById = useMemo(() => new Map(morning.map((m) => [m.id, m])), [morning]);

  const shown = useMemo(() => {
    const q = filter.trim();
    return clients.filter((c) => {
      if (onlyUnmapped && c.morning_client_id) return false;
      if (!q) return true;
      return c.name.includes(q) || (c.mapped_name ?? "").includes(q);
    });
  }, [clients, filter, onlyUnmapped]);

  const mappedCount = clients.filter((c) => c.morning_client_id).length;

  async function save(clientId: string, morningId: string | null, morningName?: string) {
    setBusyId(clientId);
    setError(null);
    try {
      const res = await fetch("/api/morning/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, morning_client_id: morningId, morning_client_name: morningName }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "שמירה נכשלה");
        return;
      }
      await load();
    } catch {
      setError("שגיאת רשת");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return <main className="max-w-3xl mx-auto p-6 text-sm text-[var(--faint)]">טוען לקוחות ממורנינג…</main>;
  }

  return (
    <main className="max-w-3xl mx-auto p-6">
      <h1 className="text-lg font-bold mb-1">מיפוי לקוחות למורנינג</h1>
      <p className="text-xs text-[var(--faint)] mb-4">
        לקוח בלי מיפוי לא ניתן לחיוב — אף מסמך לא ייצא עבורו. ההתאמה האוטומטית היא הצעה בלבד; כל שיוך מאושר ידנית.
      </p>

      {error && (
        <div className="mb-4 text-xs text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2">
          {error}
          {needsCreds && <div className="mt-1">מפתחות מורנינג לא מוגדרים בשרת — אי אפשר למשוך לקוחות.</div>}
        </div>
      )}

      <div className="flex items-center gap-3 mb-4 text-xs">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="חיפוש לקוח…"
          className="flex-1 bg-transparent border border-[var(--rule)] rounded-xl px-3 py-1.5"
        />
        <label className="flex items-center gap-1.5 shrink-0">
          <input type="checkbox" checked={onlyUnmapped} onChange={(e) => setOnlyUnmapped(e.target.checked)} />
          רק לא ממופים
        </label>
        <span className="text-[var(--faint)] shrink-0">
          {mappedCount}/{clients.length} ממופים
        </span>
      </div>

      {shown.length === 0 && (
        <div className="text-center text-sm text-[var(--faint)] py-10 border border-dashed border-[var(--rule)] rounded-2xl">
          {onlyUnmapped ? "כל הלקוחות המוצגים ממופים 🎉" : "אין לקוחות תואמים"}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {shown.map((c) => {
          const sel = choice[c.id] ?? "";
          return (
            <div key={c.id} className="rounded-2xl border border-[var(--rule)] p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-bold text-sm flex-1">{c.name}</span>
                {c.morning_client_id ? (
                  c.mapped_missing ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full border border-[var(--peak)] text-[var(--peak)]">
                      ממופה למזהה שנמחק במורנינג
                    </span>
                  ) : (
                    <span className="text-[10px] px-2 py-0.5 rounded-full border border-[var(--signal)] text-[var(--signal)]">
                      ✓ {c.mapped_name}
                      {c.mapped_tax_id ? ` · ${c.mapped_tax_id}` : ""}
                    </span>
                  )
                ) : (
                  <span className="text-[10px] px-2 py-0.5 rounded-full border border-[var(--warn)] text-[var(--warn)]">
                    לא ממופה
                  </span>
                )}
              </div>

              {c.morning_client_id ? (
                <div className="flex items-center gap-2">
                  <button
                    disabled={busyId === c.id}
                    onClick={() => save(c.id, null)}
                    className="text-[11px] rounded-lg px-3 py-1 border border-[var(--rule)] text-[var(--dim)] disabled:opacity-40"
                  >
                    בטל מיפוי
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  <select
                    value={sel}
                    onChange={(e) => setChoice((s) => ({ ...s, [c.id]: e.target.value }))}
                    className="flex-1 min-w-[200px] bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1.5 text-xs"
                  >
                    <option value="">— בחר לקוח במורנינג —</option>
                    {morning.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.taxId ? ` (${m.taxId})` : ""}
                      </option>
                    ))}
                  </select>
                  {c.suggestion && sel === c.suggestion.id && (
                    <span className="text-[10px] text-[var(--faint)]">הצעה אוטומטית</span>
                  )}
                  <button
                    disabled={busyId === c.id || !sel}
                    onClick={() => save(c.id, sel, morningById.get(sel)?.name)}
                    className="text-[11px] bg-[var(--signal)] text-white font-bold rounded-lg px-3 py-1.5 disabled:opacity-40"
                  >
                    שייך
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}
