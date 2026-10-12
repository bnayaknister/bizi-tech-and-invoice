"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * E22 — "מורשים לקבוע הקלטות" of one show, on the show screen: name, phone
 * and an optional email. For every show, with a client or without one (an
 * internal production). studio_admin only — the screen draws it only for
 * them, and /api/shows/[id]/bookers refuses everyone else.
 *
 * The phone is normalised on the server (toWaId, the rule everywhere else);
 * the email too. A refusal comes back with the field it is about, and the
 * message is drawn beside that field.
 */
export const BOOKERS_COPY = {
  title: "מורשים לקבוע הקלטות",
  intro: "מי שרשום כאן יכול לקבוע הקלטות לתוכנית דרך הבוט, באישור אוטומטי. המייל מקבל זימון ליומן.",
  none: "אין מורשים — הבוט לא יקבע לתוכנית הזו הקלטות.",
  name: "שם",
  phone: "טלפון",
  email: "מייל (רשות)",
  add: "הוספה",
  save: "שמירה",
  edit: "עריכה",
  cancel: "ביטול",
  remove: "מחיקה",
  confirmRemove: "למחוק את המורשה?",
  loadFailed: "לא הצלחתי לטעון את המורשים.",
} as const;

export type BookerView = { id: string; name: string; waId: string; display: string; email: string | null };
type Draft = { name: string; phone: string; email: string };
type FieldError = { field: "name" | "phone" | "email" | null; error: string } | null;

const EMPTY: Draft = { name: "", phone: "", email: "" };
const input = "bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1 text-xs";

export default function ShowBookersCard({ showId, initial }: { showId: string; initial?: BookerView[] }) {
  const [bookers, setBookers] = useState<BookerView[] | null>(initial ?? null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<{ id: string; draft: Draft } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<FieldError>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/shows/${showId}/bookers`, { cache: "no-store" });
      if (!r.ok) return setLoadFailed(true);
      const b = (await r.json()) as { bookers: BookerView[] };
      setBookers(b.bookers);
    } catch {
      setLoadFailed(true);
    }
  }, [showId]);

  useEffect(() => {
    if (!initial) void load();
  }, [initial, load]);

  async function send(method: "POST" | "PATCH", body: Record<string, unknown>, key: string): Promise<BookerView | null> {
    setBusy(key);
    setErr(null);
    try {
      const r = await fetch(`/api/shows/${showId}/bookers`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const b = (await r.json().catch(() => ({}))) as { booker?: BookerView; error?: string; field?: string };
      if (!r.ok || !b.booker) {
        setErr({ field: (b.field as "name" | "phone" | "email" | undefined) ?? null, error: b.error ?? `השמירה נכשלה (${r.status})` });
        return null;
      }
      return b.booker;
    } catch {
      setErr({ field: null, error: "השמירה נכשלה" });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    const b = await send("POST", draft, "new");
    if (b) {
      setBookers((list) => [...(list ?? []), b].sort((x, y) => x.name.localeCompare(y.name, "he")));
      setDraft(EMPTY);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    const b = await send("PATCH", { bookerId: editing.id, ...editing.draft }, editing.id);
    if (b) {
      setBookers((list) => (list ?? []).map((x) => (x.id === b.id ? b : x)));
      setEditing(null);
    }
  }

  async function remove(id: string) {
    if (!window.confirm(BOOKERS_COPY.confirmRemove)) return;
    setBusy(id);
    setErr(null);
    try {
      const r = await fetch(`/api/shows/${showId}/bookers?bookerId=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        setErr({ field: null, error: b.error ?? "המחיקה נכשלה" });
      } else setBookers((list) => (list ?? []).filter((x) => x.id !== id));
    } finally {
      setBusy(null);
    }
  }

  const fieldErr = (scope: string, f: "name" | "phone" | "email") =>
    err && err.field === f && busy === null && scope === (editing ? editing.id : "new") ? (
      <p className="text-[11px] text-rose-400">{err.error}</p>
    ) : null;

  const form = (d: Draft, set: (d: Draft) => void, scope: string) => (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
      <div>
        <input value={d.name} onChange={(e) => set({ ...d, name: e.target.value })} placeholder={BOOKERS_COPY.name} className={`${input} w-full`} />
        {fieldErr(scope, "name")}
      </div>
      <div>
        <input value={d.phone} onChange={(e) => set({ ...d, phone: e.target.value })} placeholder={BOOKERS_COPY.phone} inputMode="tel" dir="ltr" className={`${input} w-full font-mono`} />
        {fieldErr(scope, "phone")}
      </div>
      <div>
        <input value={d.email} onChange={(e) => set({ ...d, email: e.target.value })} placeholder={BOOKERS_COPY.email} inputMode="email" dir="ltr" className={`${input} w-full`} />
        {fieldErr(scope, "email")}
      </div>
    </div>
  );

  if (loadFailed) return <p className="text-xs text-[var(--faint)]">{BOOKERS_COPY.loadFailed}</p>;
  if (!bookers) return null;

  return (
    <div className="rounded-xl border border-[var(--rule)] p-3 space-y-2" data-block="show-bookers">
      <p className="text-xs font-bold text-[var(--dim)]">{BOOKERS_COPY.title}</p>
      <p className="text-[11px] text-[var(--faint)]">{BOOKERS_COPY.intro}</p>

      {bookers.length === 0 ? (
        <p className="text-[11px] text-[var(--amber)]">{BOOKERS_COPY.none}</p>
      ) : (
        <ul className="space-y-1.5">
          {bookers.map((b) =>
            editing?.id === b.id ? (
              <li key={b.id} className="space-y-1.5">
                {form(editing.draft, (d) => setEditing({ id: b.id, draft: d }), b.id)}
                <div className="flex gap-1.5">
                  <button type="button" disabled={busy === b.id} onClick={() => void saveEdit()} className="rounded-lg px-2.5 py-1 text-xs font-bold border border-[var(--cyan)]/60 disabled:opacity-40">
                    {BOOKERS_COPY.save}
                  </button>
                  <button type="button" onClick={() => { setEditing(null); setErr(null); }} className="rounded-lg px-2.5 py-1 text-xs border border-[var(--rule)]">
                    {BOOKERS_COPY.cancel}
                  </button>
                </div>
              </li>
            ) : (
              <li key={b.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">
                  {b.name}
                  <span dir="ltr" className="ms-2 font-mono text-[var(--dim)]">{b.display}</span>
                  {b.email ? <span dir="ltr" className="ms-2 text-[var(--faint)]">{b.email}</span> : null}
                </span>
                <span className="flex gap-1 shrink-0">
                  <button type="button" onClick={() => { setErr(null); setEditing({ id: b.id, draft: { name: b.name, phone: b.display, email: b.email ?? "" } }); }} className="rounded px-2 py-0.5 text-[11px] border border-[var(--rule)]">
                    {BOOKERS_COPY.edit}
                  </button>
                  <button type="button" disabled={busy === b.id} onClick={() => void remove(b.id)} className="rounded px-2 py-0.5 text-[11px] border border-[var(--rule)] disabled:opacity-50">
                    {BOOKERS_COPY.remove}
                  </button>
                </span>
              </li>
            )
          )}
        </ul>
      )}

      {!editing && (
        <div className="space-y-1.5 pt-1 border-t border-[var(--rule2)]">
          {form(draft, setDraft, "new")}
          <button type="button" disabled={busy === "new" || !draft.name.trim() || !draft.phone.trim()} onClick={() => void add()} className="rounded-lg px-2.5 py-1 text-xs font-bold border border-[var(--cyan)]/60 disabled:opacity-40">
            {BOOKERS_COPY.add}
          </button>
        </div>
      )}

      {err && err.field === null ? <p className="text-[11px] text-rose-400">{err.error}</p> : null}
    </div>
  );
}
