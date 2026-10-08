"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * "הרשאות הזמנת חדרים" — a table per podcast of who may book a room for it.
 * E9-3, owner decision 8.10 (rule ד).
 *
 * ═══ WHY A SELF-FETCHING BLOCK, LIKE ClientMorningCard ═══
 * The client card's DB fields render immediately and this arrives beside them.
 * Same shape, same reason: a slow or failed read costs the block and never the
 * card. The server hands back `canEdit` — this component never infers a
 * permission from anything it can see.
 *
 * ═══ WHY IT IS SHARED BETWEEN THE DRAWER AND /clients ═══
 * Both render THIS component, the way both already render ClientMorningCard.
 * The owner's standing rule is "אותו רכיב בדיוק … לא שכפול שדות", and here it
 * matters for a specific reason: the phone conversion (`050-…` → `972…`) and
 * its refusal sentences live on the server, and a second copy of this form is a
 * second chance to show a client a number the bot will never match.
 *
 * 🔴 AND IT IS NOT THE MORNING CONTACT BLOCK. Morning's emails/phone/contact
 * person answer "who do we invoice"; this answers "who may book a room". The
 * same human may be in both, in one, or in neither, and the two are never
 * synced — see 0103's header for why conflating them would be wrong.
 *
 * ⚠️ NO EDIT-IN-PLACE, DELIBERATELY. Add and remove only: a permission row is
 * two short fields, and "edit" on a number means the old number stops being
 * authorised and a new one starts — which is a remove plus an add, and reads
 * more honestly as two actions in the audit trail (0103 writes an event for
 * each). Changing a name would be the only genuine edit, and retyping four
 * characters is cheaper than a form mode nobody can see the state of.
 */

const COPY = {
  title: "הרשאות הזמנת חדרים",
  intro: "מי רשאי להזמין אולפן לכל פודקאסט, לפי מספר הטלפון שממנו הוא כותב לבוט.",
  noShows: "ללקוח הזה אין פודקאסטים.",
  noContacts: "אין אנשי קשר מורשים — הבוט לא יזהה אף מספר לפודקאסט הזה.",
  addName: "שם",
  addPhone: "טלפון",
  add: "הוספה",
  remove: "הסרה",
  removeConfirm: "להסיר את ההרשאה?",
  loadFailed: "לא הצלחתי לקרוא את ההרשאות.",
  locked: "לצפייה בלבד.",
  inactive: "לא פעיל",
} as const;

type Contact = { id: string; name: string; waId: string; display: string };
type Show = { id: string; name: string; active: boolean; contacts: Contact[] };
type Data = { canEdit: boolean; shows: Show[] };

export default function ClientBookingContactsCard({ clientId }: { clientId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { name: string; phone: string }>>({});

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await fetch(`/api/clients/${clientId}/booking-contacts`, { cache: "no-store" });
      if (!res.ok) {
        setFailed(true);
        return;
      }
      setData((await res.json()) as Data);
    } catch {
      setFailed(true);
    }
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = useCallback(
    async (showId: string) => {
      const d = draft[showId] ?? { name: "", phone: "" };
      if (!d.name.trim() || !d.phone.trim() || busy) return;
      setBusy(showId);
      setError(null);
      try {
        const res = await fetch(`/api/clients/${clientId}/booking-contacts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ showId, name: d.name, phone: d.phone }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          // The server's sentence verbatim: the phone refusals are approved
          // copy and each one says what is wrong with the number. Rewriting
          // them here would create a second set that drifts from the first.
          setError(body.error ?? COPY.loadFailed);
          return;
        }
        setDraft((p) => ({ ...p, [showId]: { name: "", phone: "" } }));
        await load();
      } catch {
        setError(COPY.loadFailed);
      } finally {
        setBusy(null);
      }
    },
    [clientId, draft, busy, load]
  );

  const remove = useCallback(
    async (contactId: string) => {
      if (busy) return;
      // A browser confirm and not a custom modal: the action is one row, it is
      // reversible by re-adding, and the drawer already has two dialogs of its
      // own competing for the same corner.
      if (!window.confirm(COPY.removeConfirm)) return;
      setBusy(contactId);
      setError(null);
      try {
        const res = await fetch(
          `/api/clients/${clientId}/booking-contacts?contactId=${encodeURIComponent(contactId)}`,
          { method: "DELETE" }
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? COPY.loadFailed);
          return;
        }
        await load();
      } catch {
        setError(COPY.loadFailed);
      } finally {
        setBusy(null);
      }
    },
    [clientId, busy, load]
  );

  if (failed) {
    return (
      <div className="rounded-xl border border-[var(--rule)] p-3">
        <p className="text-xs font-bold text-[var(--dim)]">{COPY.title}</p>
        <p className="text-xs text-[var(--faint)] pt-1">{COPY.loadFailed}</p>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="rounded-xl border border-[var(--rule)] p-3 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-bold text-[var(--dim)]">{COPY.title}</p>
        {!data.canEdit ? <span className="text-[11px] text-[var(--faint)]">{COPY.locked}</span> : null}
      </div>
      <p className="text-[11px] text-[var(--faint)]">{COPY.intro}</p>

      {data.shows.length === 0 ? (
        <p className="text-xs text-[var(--faint)]">{COPY.noShows}</p>
      ) : (
        data.shows.map((show) => {
          const d = draft[show.id] ?? { name: "", phone: "" };
          return (
            <div key={show.id} className="rounded-lg border border-[var(--rule2)] p-2 space-y-1.5">
              <p className="text-xs font-semibold">
                {show.name}
                {!show.active ? (
                  <span className="ms-2 text-[10px] text-[var(--faint)]">{COPY.inactive}</span>
                ) : null}
              </p>

              {show.contacts.length === 0 ? (
                // ⚠️ NOT an empty gap. A podcast with nobody authorised is the
                // interesting case — it is the one where the bot cannot answer
                // anybody — so it says so.
                <p className="text-[11px] text-[var(--amber)]">{COPY.noContacts}</p>
              ) : (
                <ul className="space-y-1">
                  {show.contacts.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate">
                        {c.name}
                        {/* dir="ltr" on the number: a phone number inside an RTL
                            paragraph gets its groups reordered by the bidi
                            algorithm, and "050-1234567" renders as something the
                            owner cannot compare by eye. */}
                        <span dir="ltr" className="ms-2 font-mono text-[var(--dim)]">
                          {c.display}
                        </span>
                      </span>
                      {data.canEdit ? (
                        <button
                          type="button"
                          disabled={busy === c.id}
                          onClick={() => void remove(c.id)}
                          className="shrink-0 rounded px-2 py-0.5 text-[11px] border border-[var(--rule)] disabled:opacity-50"
                        >
                          {COPY.remove}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              {data.canEdit ? (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  <input
                    value={d.name}
                    onChange={(e) => setDraft((p) => ({ ...p, [show.id]: { ...d, name: e.target.value } }))}
                    placeholder={COPY.addName}
                    className="flex-1 min-w-[6rem] bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1 text-xs"
                  />
                  <input
                    value={d.phone}
                    onChange={(e) => setDraft((p) => ({ ...p, [show.id]: { ...d, phone: e.target.value } }))}
                    placeholder={COPY.addPhone}
                    // numeric keypad on a phone, and dir="ltr" so what is typed
                    // reads in the order it was typed
                    inputMode="tel"
                    dir="ltr"
                    className="flex-1 min-w-[7rem] bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1 text-xs font-mono"
                  />
                  <button
                    type="button"
                    disabled={busy === show.id || !d.name.trim() || !d.phone.trim()}
                    onClick={() => void add(show.id)}
                    className="rounded-lg px-2.5 py-1 text-xs font-bold border border-[var(--cyan)]/60 disabled:opacity-40"
                  >
                    {COPY.add}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })
      )}

      {error ? <p className="text-[11px] text-rose-400">{error}</p> : null}
    </div>
  );
}
