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
  shared_with?: string[];
  suggestion: { id: string; name: string; distance: number } | null;
};

// a mapping the server flagged as shared, held while the operator confirms
type PendingShared = { clientId: string; morningId: string; morningName?: string; sharedWith: string[] };

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
  const [pendingShared, setPendingShared] = useState<PendingShared | null>(null);

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

  async function save(
    clientId: string,
    morningId: string | null,
    morningName?: string,
    confirmShared = false
  ) {
    setBusyId(clientId);
    setError(null);
    try {
      const res = await fetch("/api/morning/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          morning_client_id: morningId,
          morning_client_name: morningName,
          confirm_shared: confirmShared,
        }),
      });
      const body = await res.json();
      if (res.status === 409 && body.needs_confirmation) {
        // shared mapping — warn, don't block. Hold it for the modal.
        setPendingShared({
          clientId,
          morningId: morningId as string,
          morningName,
          sharedWith: body.shared_with ?? [],
        });
        return;
      }
      if (!res.ok) {
        setError(body.error ?? "שמירה נכשלה");
        return;
      }
      setPendingShared(null);
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
                    <>
                      <span className="text-[10px] px-2 py-0.5 rounded-full border border-[var(--signal)] text-[var(--signal)]">
                        ✓ {c.mapped_name}
                        {c.mapped_tax_id ? ` · ${c.mapped_tax_id}` : ""}
                      </span>
                      {c.shared_with && c.shared_with.length > 0 && (
                        <span
                          className="text-[10px] px-2 py-0.5 rounded-full border border-[var(--rule2)] text-[var(--dim)]"
                          title="מחויב לאותו לקוח במורנינג"
                        >
                          משותף עם: {c.shared_with.join(", ")}
                        </span>
                      )}
                    </>
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

      {/* shared-mapping warning — awareness, not a block */}
      {pendingShared && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-[var(--bg)] border border-[var(--rule)] rounded-2xl p-5 max-w-md w-full">
            <h3 className="font-bold text-sm mb-2">לקוח מורנינג משותף</h3>
            <p className="text-sm mb-3">
              לקוח זה כבר משויך ל<span className="font-bold">{pendingShared.sharedWith.join(", ")}</span>. שתי
              הישויות יחויבו לאותו לקוח במורנינג.
            </p>
            <p className="text-[11px] text-[var(--faint)] mb-4">אם זו אותה ישות משלמת עם כמה מותגים — זה תקין.</p>
            <div className="flex gap-2">
              <button
                disabled={busyId === pendingShared.clientId}
                onClick={() =>
                  save(pendingShared.clientId, pendingShared.morningId, pendingShared.morningName, true)
                }
                className="flex-1 bg-[var(--signal)] text-white text-xs font-bold rounded-xl px-4 py-2 disabled:opacity-40"
              >
                כן, זו אותה ישות משלמת
              </button>
              <button
                onClick={() => setPendingShared(null)}
                className="flex-1 text-xs rounded-xl px-4 py-2 border border-[var(--rule)]"
              >
                ביטול
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
