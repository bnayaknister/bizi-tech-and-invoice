"use client";

import { useCallback, useEffect, useState } from "react";
import { TAX_ID_UNKNOWN, displayTaxId, validateTaxId } from "@/lib/clients/taxId";

/**
 * The client's MORNING-HELD facts: email addresses, phone, contact person, the
 * read-only `send` flag — and, since 7.10, the ח.פ / ע.מ.
 *
 * ═══ WHY A BLOCK AND NOT ROWS IN THE FIELD REGISTRY ═══
 * None of these is a column. `clients` has no email, no phone, no tax id, and
 * `selectColumns` turns every registered key straight into the PostgREST
 * select list — so registering them would 400 the entire client card for every
 * viewer. They are declared in entities.ts as MORNING_ONLY_CLIENT_FIELDS, a
 * list beside the client config rather than inside it, and rendered here.
 *
 * ═══ WHY IT IS SHARED (owner 7.10) ═══
 * The drawer and /clients both render THIS component. The owner's rule was
 * "אנשי קשר: ממורנינג בלבד, כמו היום" and "אותו רכיב בדיוק … לא שכפול שדות" —
 * and the reason is sharper than reuse: every save here is a remote write to
 * the books, behind a confirmation, with a measured emails/`send` coupling and
 * a nine-digit rule. A second copy of this file is a second chance to get one
 * of those wrong on a tax document.
 *
 * ═══ SELF-FETCHING, AND THAT IS THE POINT ═══
 * Like AddonsSection: the DB fields render immediately and this arrives beside
 * them, so Morning being slow or down costs the block and never the card. A
 * Morning read has a 15s deadline (morning/client.ts MORNING_TIMEOUT_MS). The
 * server hands back `canEdit` — this component never infers a permission.
 *
 * 🔴 `contact_name` (the old `clients` column) IS NOT HERE AND MUST NOT BE.
 * It still holds three values that contradict Morning's contactPerson, and it
 * was removed from the registry on 2026-09-09 for exactly that reason
 * (entities.ts:159-176). A full screen is wider than a drawer and the empty
 * space is the temptation; there is no reader for that column anywhere.
 */
export type ContactsData = {
  linked: boolean;
  morningClientId?: string;
  contacts: {
    emails: string[];
    phone: string | null;
    contactPerson: string | null;
    send: boolean | null;
    taxId: string | null;
  } | null;
  clientFetchFailed: boolean;
  canEdit: boolean;
  recipientCap: number;
};

export default function ClientMorningCard({
  clientId,
  clientName,
  onChanged,
}: {
  clientId: string;
  /** shown in the ח.פ confirmation window's approved title */
  clientName: string;
  onChanged: () => void;
}) {
  const [data, setData] = useState<ContactsData | null>(null);
  const [emails, setEmails] = useState<string[]>([]);
  const [phone, setPhone] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the last-email warning, held until the operator answers it
  const [confirmLast, setConfirmLast] = useState<number | null>(null);
  // ---- ח.פ: its own typed value, its own error line, its own window ----
  const [taxId, setTaxId] = useState("");
  const [taxError, setTaxError] = useState<string | null>(null);
  const [taxConfirm, setTaxConfirm] = useState<{ from: string | null; to: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/clients/${clientId}/contacts`);
    if (!res.ok) return;
    const d: ContactsData = await res.json();
    setData(d);
    setEmails(d.contacts?.emails ?? []);
    setPhone(d.contacts?.phone ?? "");
    setContactPerson(d.contacts?.contactPerson ?? "");
    setTaxId(d.contacts?.taxId ?? "");
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  // One save path for the three contact fields. NO DIRTY-CHECKING: everything
  // the block holds goes on the wire every time. Measured 2026-09-09 — a field
  // resent at its current value does not register as a change, and three fields
  // in one body move exactly those three. Sending the whole block is both safe
  // and safer than diffing, because a wrong diff writes the wrong thing.
  //
  // `emails` is always the COMPLETE list (Morning replaces the array wholesale;
  // there is no add/remove). Empty strings clear phone/contactPerson — the
  // route turns null into "" for exactly that reason.
  //
  // ⚠️ taxId is NOT part of this body, deliberately. It has its own window and
  // its own validation, and a failed ח.פ write must not be reported as "the
  // contact details failed" — nor must correcting a phone silently resend a tax
  // number the operator never looked at.
  async function save(nextEmails: string[], nextPhone: string, nextContact: string, confirm = false) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/entity/client/${clientId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patch: { emails: nextEmails, phone: nextPhone.trim(), contactPerson: nextContact.trim() },
        ...(confirm ? { confirm_morning: true } : {}),
      }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    // the same double-confirmation the client NAME goes through — one click,
    // then the same request again with confirm_morning
    if (res.status === 409 && body?.needs_morning_confirmation) {
      return save(nextEmails, nextPhone, nextContact, true);
    }
    if (!res.ok) {
      setError(body?.error ?? "השמירה נכשלה");
      // pull the truth back rather than leave the form showing what did not save
      await load();
      return false;
    }
    await load();
    onChanged();
    return true;
  }

  /**
   * 🔴 The ח.פ write. Three things make it different from the block above, and
   * all three are the owner's 7.10 decision:
   *
   * 1. VALIDATED BEFORE THE WINDOW OPENS. Nine digits, or an explicit empty to
   *    clear. An invalid value never reaches a confirmation the operator could
   *    click through — the same rule runs again on the server, which is what
   *    actually enforces it.
   * 2. CONFIRMED, with the old and the new number both on screen. The window's
   *    wording is approved and says what it costs: documents issued from here
   *    on carry the new number, and the ones already issued do not change.
   * 3. POSTED ALONE, with confirm_morning already set. Alone because there is
   *    no local column: when `patch` holds nothing but Morning-only keys the
   *    route performs NO local write, so a Morning failure leaves zero changes
   *    anywhere — which is exactly what the approved failure message claims.
   *    Bundling it with a DB field would make that sentence false.
   */
  function askTaxId() {
    setTaxError(null);
    const verdict = validateTaxId(taxId);
    if (!verdict.ok) {
      setTaxError(verdict.error);
      return;
    }
    const current = data?.contacts?.taxId ?? null;
    if ((current ?? "") === verdict.value) return; // nothing to confirm
    setTaxConfirm({ from: current, to: verdict.value });
  }

  async function commitTaxId() {
    if (!taxConfirm) return;
    setBusy(true);
    setTaxError(null);
    const res = await fetch(`/api/entity/client/${clientId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: { taxId: taxConfirm.to }, confirm_morning: true }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    setTaxConfirm(null);
    if (!res.ok) {
      // The route's own sentence, not one composed here: it is the only layer
      // that knows whether a local write happened, and for a Morning-only
      // patch it says "לא בוצע שום שינוי".
      setTaxError(body?.error ?? "העדכון במורנינג נכשל.");
      await load(); // put the real remote value back in the box
      return;
    }
    await load();
    onChanged();
  }

  function removeEmail(i: number) {
    // The ONLY moment the emails/send coupling fires: the list dropping to zero.
    // Measured 2026-09-09 and one-way — emptying turns `send` off, refilling
    // does NOT turn it back on. So the warning is here, before the act, and
    // nowhere else.
    if (emails.length === 1) {
      setConfirmLast(i);
      return;
    }
    const next = emails.filter((_, j) => j !== i);
    setEmails(next);
    void save(next, phone, contactPerson);
  }

  function addEmail() {
    const e = newEmail.trim();
    if (!e) return;
    const next = [...emails, e];
    setNewEmail("");
    setEmails(next);
    void save(next, phone, contactPerson);
  }

  if (!data) return null;

  // Unmapped client: shown, locked, and told why. No creation path from here.
  if (!data.linked) {
    return (
      <div className="rounded-lg border border-[var(--rule)] px-2.5 py-2">
        <div className="text-[11px] font-bold text-[var(--dim)] mb-1">פרטי קשר</div>
        <div className="text-[10px] text-[var(--faint)]">
          הלקוח אינו מקושר למורנינג. פרטי הקשר נשמרים במורנינג בלבד, ולכן אין מה להציג או לערוך כאן.
        </div>
      </div>
    );
  }

  if (data.clientFetchFailed) {
    return (
      <div
        className="rounded-lg border border-amber-500/40 px-2.5 py-2"
        style={{ background: "rgba(251,191,36,0.08)" }}
      >
        <div className="text-[11px] font-bold text-amber-400 mb-1">פרטי קשר</div>
        <div className="text-[10px] text-[var(--dim)]">
          לא ניתן לקרוא את פרטי הקשר ממורנינג כרגע. שאר פרטי הלקוח מוצגים כרגיל.
        </div>
        {/* the ח.פ is read on the same call, so it is unknown too — stated, not
            guessed, and NOT offered for editing over an unknown remote value */}
        <div className="text-[10px] text-[var(--dim)] mt-1">
          ח.פ / ע.מ: <span className="text-[var(--faint)]">{TAX_ID_UNKNOWN}</span>
        </div>
        <button onClick={() => void load()} className="mt-1.5 text-[10px] underline text-[var(--signal)]">
          נסי שוב
        </button>
      </div>
    );
  }

  const canEdit = data.canEdit;
  const overCap = emails.length > data.recipientCap;
  const taxDirty = (data.contacts?.taxId ?? "") !== taxId.trim();

  return (
    <div className="rounded-lg border border-[var(--rule)] px-2.5 py-2 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold text-[var(--dim)]">פרטי קשר</div>
        <div className="text-[9px] text-[var(--faint)]">מתוך מורנינג</div>
      </div>

      {/* ---- 🔴 ח.פ / ע.מ ---- */}
      <div className="grid grid-cols-[70px_1fr_auto] items-center gap-2">
        <label className="text-[10px] text-[var(--dim)]">ח.פ / ע.מ</label>
        {canEdit ? (
          <input
            value={taxId}
            onChange={(ev) => {
              setTaxId(ev.target.value);
              setTaxError(null);
            }}
            disabled={busy}
            inputMode="numeric"
            placeholder={TAX_ID_UNKNOWN}
            className="bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1 text-[11px] font-mono disabled:opacity-60"
          />
        ) : (
          <span className="text-[11px] font-mono">{displayTaxId(data.contacts?.taxId)}</span>
        )}
        {/* An explicit button, not a blur save. A blur save is right for a
            phone number and wrong here: this field opens a confirmation window
            that costs a click to dismiss, and Tab-ing past the box must not
            open it. */}
        {canEdit && taxDirty && (
          <button
            onClick={askTaxId}
            disabled={busy}
            className="shrink-0 text-[10px] underline text-[var(--signal)]"
          >
            עדכון
          </button>
        )}
      </div>
      {taxError && <div className="text-[10px] text-red-400">{taxError}</div>}

      {/* ---- emails ---- */}
      <div className="space-y-1">
        {emails.length === 0 && <div className="text-[10px] text-[var(--faint)]">אין כתובות מייל</div>}
        {emails.map((e, i) => (
          <div key={`${e}-${i}`} className="flex items-center gap-2">
            <span className="text-[11px] flex-1 min-w-0 break-all">{e}</span>
            {canEdit && (
              <button
                onClick={() => removeEmail(i)}
                disabled={busy}
                className="shrink-0 text-[10px] text-[var(--faint)] hover:text-rose-400"
                title="הסרת כתובת"
              >
                הסר
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <div className="flex items-center gap-1.5 pt-0.5">
            <input
              value={newEmail}
              onChange={(ev) => setNewEmail(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") addEmail();
              }}
              placeholder="הוספת מייל"
              inputMode="email"
              className="flex-1 min-w-0 bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1 text-[11px]"
            />
            <button
              onClick={addEmail}
              disabled={busy || !newEmail.trim()}
              className="shrink-0 text-[10px] underline text-[var(--signal)]"
            >
              הוסף
            </button>
          </div>
        )}
        {/* NOT a block. Three is the cap Morning applies to a DOCUMENT request
            (recipients.ts), not to a client record — measured: a client in this
            very account holds four. So the card states the consequence and lets
            the operator decide. */}
        {overCap && (
          <div className="text-[10px] text-amber-400">
            בהנפקת מסמך מורנינג מקבל עד {data.recipientCap} כתובות — הראשונות ברשימה.
          </div>
        )}
      </div>

      {/* ---- phone + contact person ---- */}
      <div className="grid grid-cols-[70px_1fr] items-center gap-2">
        <label className="text-[10px] text-[var(--dim)]">טלפון</label>
        <input
          value={phone}
          onChange={(ev) => setPhone(ev.target.value)}
          onBlur={() => {
            if ((data.contacts?.phone ?? "") !== phone.trim()) void save(emails, phone, contactPerson);
          }}
          disabled={!canEdit || busy}
          inputMode="tel"
          className="bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1 text-[11px] disabled:opacity-60"
        />
        <label className="text-[10px] text-[var(--dim)]">איש קשר</label>
        <input
          value={contactPerson}
          onChange={(ev) => setContactPerson(ev.target.value)}
          onBlur={() => {
            if ((data.contacts?.contactPerson ?? "") !== contactPerson.trim())
              void save(emails, phone, contactPerson);
          }}
          disabled={!canEdit || busy}
          className="bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1 text-[11px] disabled:opacity-60"
        />
      </div>

      {/* ---- send: READ-ONLY, and that is the whole mitigation ----
          Morning recomputes this from `emails` and overwrites anything we pass
          (measured), so we never send it. Showing it is what stops the silent
          change: the flag was invisible until 2026-09-09, and an invisible flag
          is what let it be knocked off without anyone noticing. */}
      <div className="flex items-center gap-2 pt-0.5 border-t border-[var(--rule)]">
        <span className="text-[10px] text-[var(--dim)]">שליחה אוטומטית של מסמכים</span>
        {data.contacts?.send == null ? (
          <span className="text-[10px] text-[var(--faint)]">לא ידוע</span>
        ) : data.contacts.send ? (
          <span className="text-[10px] text-emerald-400">פעילה</span>
        ) : (
          <span className="text-[10px] text-amber-400">כבויה</span>
        )}
        <span className="text-[9px] text-[var(--faint)]">· נקבע במורנינג</span>
      </div>

      {error && <div className="text-[10px] text-red-400">{error}</div>}

      {taxConfirm && (
        <TaxIdConfirm
          clientName={clientName}
          from={taxConfirm.from}
          to={taxConfirm.to}
          busy={busy}
          onConfirm={() => void commitTaxId()}
          onCancel={() => setTaxConfirm(null)}
        />
      )}

      {confirmLast !== null && (
        <div
          className="rounded-lg border border-amber-500/50 px-2.5 py-2"
          style={{ background: "rgba(251,191,36,0.10)" }}
        >
          <div className="text-[10px] text-amber-200 leading-relaxed">
            זהו המייל האחרון של הלקוח. מחיקתו תכבה במורנינג את השליחה האוטומטית של מסמכים ללקוח הזה — והדגל לא
            יידלק בחזרה כשתוסיפי מייל. להדליק אותו שוב אפשר רק ידנית, בכרטיס הלקוח במורנינג.
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            <button
              onClick={() => {
                const i = confirmLast;
                setConfirmLast(null);
                const next = emails.filter((_, j) => j !== i);
                setEmails(next);
                void save(next, phone, contactPerson);
              }}
              disabled={busy}
              className="text-[10px] rounded-lg px-2 py-1 border border-amber-500/60 text-amber-300"
            >
              מחק בכל זאת
            </button>
            <button onClick={() => setConfirmLast(null)} className="text-[10px] text-[var(--faint)] underline">
              ביטול
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 🔴 THE ח.פ CONFIRMATION WINDOW. Wording approved by the owner, 7.10 — title,
 * body and both buttons. Nothing here is composed at runtime except the client
 * name and the two numbers.
 *
 * Its own component, and pure: no state, no fetch, no hooks. That is what lets
 * the suite render it and COUNT that the old number and the new number each
 * appear exactly once — the assertion the owner asked for. A window buried in
 * the parent's state could only be checked by reading it.
 *
 * `displayTaxId` on both sides, so "there was no number before" renders as the
 * approved "לא ידוע" rather than an empty gap the operator has to interpret.
 */
export function TaxIdConfirm({
  clientName,
  from,
  to,
  busy = false,
  onConfirm,
  onCancel,
}: {
  clientName: string;
  from: string | null;
  to: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="rounded-lg border border-amber-500/50 px-2.5 py-2"
      style={{ background: "rgba(251,191,36,0.10)" }}
    >
      <div className="text-[11px] font-bold text-amber-200 mb-1">שינוי ח.פ של {clientName}</div>
      <div className="text-[10px] text-amber-100 leading-relaxed">
        הח.פ ישתנה במורנינג מ-<span className="font-mono">{displayTaxId(from)}</span> ל-
        <span className="font-mono">{displayTaxId(to)}</span>. כל מסמך שיונפק מכאן והלאה יישא את המספר
        החדש. מסמכים שכבר הונפקו לא משתנים.
      </div>
      <div className="flex items-center gap-2 mt-1.5">
        <button
          onClick={onConfirm}
          disabled={busy}
          className="text-[10px] rounded-lg px-2 py-1 border border-amber-500/60 text-amber-300"
        >
          עדכון במורנינג
        </button>
        <button onClick={onCancel} className="text-[10px] text-[var(--faint)] underline">
          ביטול
        </button>
      </div>
    </div>
  );
}
