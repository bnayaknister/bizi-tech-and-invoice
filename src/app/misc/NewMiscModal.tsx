"use client";

import { useState } from "react";
import ClientCombobox, { type ComboboxClient } from "@/components/ClientCombobox";
import { todayInIsrael } from "@/lib/dates";
import type { MiscClientOption, Notice } from "./MiscClient";

/**
 * "עבודה חדשה" — the form that fills /misc (step 4).
 *
 * It posts to /api/misc-productions, which does five things in order: the
 * entity, its supplier lines, a job, the job link, and a work order into the
 * approval queue. Nothing here reaches Morning; the queue row is where a human
 * approves what it says.
 *
 * ═══ THREE OUTCOMES, AND ONLY ONE OF THEM IS A FAILURE ═══
 * The route answers 200, 207 or 4xx/5xx, and the 207 is the one worth stating
 * plainly because `fetch` will not flag it: res.ok is TRUE for anything 200-299,
 * so a naive `if (!res.ok)` silently treats a 207 as complete success — which is
 * the opposite of the mistake one might expect, and just as wrong.
 *
 *   200  entity + job + work order. Close, refresh, confirm.
 *   207  THE ENTITY EXISTS. The job or the queue insert failed and the route
 *        deliberately did NOT delete the work (route.ts:186-193, owner decision
 *        2026-09-08: "the entity is a record of work that was agreed; the job
 *        and the work order are an attempt to bill it"). Re-submitting would
 *        create a SECOND entity for the same job, so the modal closes and the
 *        row is left at 'נפתח' with job_id null — exactly the state step 6's
 *        "צור הזמנת עבודה" acts on. Warning tone, not error tone.
 *   4xx  nothing was written. The modal STAYS OPEN with the message, because
 *   5xx  every field the operator typed is still in it and closing would make
 *        her retype all of them, supplier rows included.
 *
 * The 207's reason is carried through as `detail` rather than paraphrased: it
 * has three distinct causes (the job insert, the link update, the queue insert)
 * and which one it was decides whether the retry button will work.
 */

type SupplierDraft = {
  supplierName: string;
  service: string;
  price: string;
  dueDate: string;
};

const blankSupplier = (): SupplierDraft => ({ supplierName: "", service: "", price: "", dueDate: "" });

/** A row the operator opened with "+ הוסף ספק" and never filled. Dropped here
 *  as well as on the server (route.ts:105-107) — the server drops it so the
 *  form cannot force a pointless 400, and the form drops it so the request
 *  says what the operator meant. */
const isBlank = (s: SupplierDraft) =>
  !s.supplierName.trim() && !s.service.trim() && !s.price.trim() && !s.dueDate.trim();

const INPUT =
  "w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2 text-xs outline-none focus:border-[var(--signal)]";
const LABEL = "block text-[11px] text-[var(--dim)] mb-1";

export default function NewMiscModal({
  clients,
  onClose,
  onDone,
}: {
  clients: MiscClientOption[];
  onClose: () => void;
  /** Closes the modal and hands the screen its notice. The parent refreshes —
   *  the new row is server-rendered, so the list cannot update without it. */
  onDone: (notice: Notice) => void;
}) {
  // The combobox can mint a client mid-form, so the option list is state rather
  // than the prop: a client created and immediately selected has to be findable
  // by the very next render or the field would go blank on the operator.
  const [options, setOptions] = useState<MiscClientOption[]>(clients);
  const [clientId, setClientId] = useState<string | null>(null);
  const [name, setName] = useState("");
  // Israel time, not the browser's: the studio's day is the business's day, and
  // a laptop set to another zone must not date a work order a day out. Lazy
  // initialiser — the modal only mounts on a click, so this never runs during
  // SSR and cannot produce a hydration mismatch across midnight.
  const [workDate, setWorkDate] = useState(() => todayInIsrael());
  const [clientOrderRef, setClientOrderRef] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [suppliers, setSuppliers] = useState<SupplierDraft[]>([blankSupplier()]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selected = clientId ? options.find((c) => c.id === clientId) ?? null : null;
  const amountNum = Number(amount);
  const amountOk = amount.trim() !== "" && Number.isFinite(amountNum) && amountNum > 0;
  const canSubmit = !!clientId && name.trim() !== "" && workDate.trim() !== "" && amountOk && !busy;

  function setSupplier(i: number, patch: Partial<SupplierDraft>) {
    setSuppliers((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function submit() {
    if (!canSubmit || !clientId) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/misc-productions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          name: name.trim(),
          workDate,
          clientOrderRef: clientOrderRef.trim() || null,
          amount: amountNum,
          description: description.trim() || null,
          // sent as typed; the route parses and rounds. Empty strings rather
          // than nulls would trip its own ISO-date check, so they are dropped.
          suppliers: suppliers.filter((s) => !isBlank(s)).map((s) => ({
            supplierName: s.supplierName.trim(),
            service: s.service.trim() || null,
            price: s.price.trim() === "" ? null : Number(s.price),
            dueDate: s.dueDate.trim() || null,
          })),
        }),
      });
      const body = await res.json().catch(() => ({}));

      // 207 FIRST, before res.ok — see the header. res.ok is true here, so the
      // order of these two branches is the whole handling, not a nicety.
      if (res.status === 207) {
        onDone({
          tone: "warn",
          text: "העבודה נשמרה, אך לא נוצרה הזמנת עבודה. אפשר ליצור אותה מהמסך.",
          detail: typeof body.error === "string" ? body.error : undefined,
        });
        return;
      }
      if (!res.ok) {
        // stays open, with everything the operator typed still in it
        setErr(body.error ?? `יצירת העבודה נכשלה (${res.status})`);
        return;
      }
      onDone({ tone: "ok", text: "נוצרה עבודה ונשלחה הזמנת עבודה לאישור." });
    } catch {
      setErr("שגיאת רשת — העבודה לא נשמרה. נסו שוב.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="glass-card w-full max-w-xl max-h-[88vh] overflow-y-auto p-5 rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-bold mb-1">עבודה חדשה — רדיו ושונות</h2>
        <p className="text-[11px] text-[var(--dim)] mb-4">
          עבודה שאינה פודקאסט. השמירה יוצרת גם הזמנת עבודה שנכנסת לתור האישורים.
        </p>

        <div className="space-y-3">
          <div>
            <label className={LABEL}>לקוח</label>
            <ClientCombobox
              clients={options as ComboboxClient[]}
              value={clientId}
              onChange={setClientId}
              // The Morning-create flow REPLACES the plain "create client"
              // option inside the combobox (its showCreateOption is gated on
              // !offerMorning), and that is why it is on: this route refuses an
              // unmapped client, so a plain create would mint exactly the one
              // kind of client that cannot be billed. canEditMoney is a
              // constant because the button that opens this modal is already
              // gated on it. Same call shape as ContractsClient.tsx:677.
              morningCreate
              canEditMoney
              onCreated={(c) =>
                // created THROUGH the Morning flow, so it is mapped. A client
                // created any other way cannot reach this callback — the plain
                // create option is not rendered while morningCreate is on.
                setOptions((cs) => [...cs, { id: c.id, name: c.name, morningMapped: true }])
              }
            />
            {selected && !selected.morningMapped && (
              <div className="mt-1 text-[11px] text-[var(--amber)]">
                ⚠️ {selected.name} אינו ממופה למורנינג — לא ניתן יהיה להנפיק את ההזמנה. מפו אותו קודם במסך הלקוחות.
              </div>
            )}
          </div>

          <div>
            <label className={LABEL}>שם העבודה</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="למשל: הפקת תוכנית רדיו — פרק פיילוט"
              className={INPUT}
            />
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className={LABEL}>תאריך עבודה</label>
              <input
                value={workDate}
                onChange={(e) => setWorkDate(e.target.value)}
                type="date"
                className={`${INPUT} font-mono`}
              />
            </div>
            <div className="flex-1">
              <label className={LABEL}>מספר הזמנה של הלקוח (אופציונלי)</label>
              <input
                value={clientOrderRef}
                onChange={(e) => setClientOrderRef(e.target.value)}
                className={`${INPUT} font-mono`}
              />
            </div>
          </div>

          <div>
            <label className={LABEL}>סכום לחיוב (₪, לפני מע״מ)</label>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="0"
              className={`${INPUT} font-mono`}
            />
            {amount.trim() !== "" && !amountOk && (
              <div className="mt-1 text-[11px] text-[var(--peak)]">יש להזין סכום גדול מאפס</div>
            )}
          </div>

          <div>
            <label className={LABEL}>תיאור (אופציונלי)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className={`${INPUT} resize-y`}
            />
            {/* Not a hint — a warning. The route uses this text verbatim as the
                document description (route.ts:255-257), and the 2026-09-07 rule
                is that a work order's own wording is inherited rather than
                rebuilt, because rebuilding it cost two manual repairs on 40318.
                What is typed here is what the client reads. */}
            <div className="mt-1 text-[10px] text-[var(--ink-faint)]">
              הטקסט הזה הוא מה שיופיע בהזמנת העבודה ובחשבון העסקה שייגזר ממנה. אם יישאר ריק, ייכתב &quot;הזמנת עבודה —
              {" "}
              {selected?.name ?? "לקוח"} {name.trim() || "שם העבודה"}&quot;.
            </div>
          </div>

          {/* ---- suppliers ---- */}
          <div className="border-t border-[var(--rule)] pt-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11px] font-bold text-[var(--dim)]">תשלום לספק</span>
              <span className="text-[10px] text-[var(--ink-faint)]">אופציונלי · הוצאה נגדית, לא מנוכה מהסכום לחיוב</span>
            </div>
            <div className="space-y-2">
              {suppliers.map((s, i) => (
                <div key={i} className="flex gap-1.5 items-start">
                  <input
                    value={s.supplierName}
                    onChange={(e) => setSupplier(i, { supplierName: e.target.value })}
                    placeholder="שם הספק"
                    className={`${INPUT} flex-[2]`}
                  />
                  <input
                    value={s.service}
                    onChange={(e) => setSupplier(i, { service: e.target.value })}
                    placeholder="סוג השירות"
                    className={`${INPUT} flex-[2]`}
                  />
                  <input
                    value={s.price}
                    onChange={(e) => setSupplier(i, { price: e.target.value })}
                    inputMode="decimal"
                    placeholder="מחיר"
                    className={`${INPUT} flex-1 font-mono`}
                  />
                  <input
                    value={s.dueDate}
                    onChange={(e) => setSupplier(i, { dueDate: e.target.value })}
                    type="date"
                    className={`${INPUT} flex-1 font-mono`}
                  />
                  <button
                    type="button"
                    onClick={() => setSuppliers((rows) => (rows.length === 1 ? [blankSupplier()] : rows.filter((_, j) => j !== i)))}
                    aria-label="הסר ספק"
                    title="הסר ספק"
                    className="shrink-0 text-[var(--faint)] hover:text-[var(--peak)] px-2 py-2 leading-none"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setSuppliers((rows) => [...rows, blankSupplier()])}
              className="mt-2 text-[11px] text-[var(--signal)] hover:underline"
            >
              + הוסף ספק
            </button>
          </div>
        </div>

        {err && (
          <div className="mt-3 text-[11px] text-[var(--peak)] border border-[var(--peak)] rounded-xl px-3 py-2">{err}</div>
        )}

        <div className="flex items-center justify-end gap-2 mt-4">
          <button onClick={onClose} disabled={busy} className="text-xs rounded-xl px-4 py-1.5 border border-[var(--rule)] disabled:opacity-40">
            ביטול
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="text-xs font-bold rounded-xl px-4 py-1.5 text-white disabled:opacity-40"
            style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 14px rgba(139,92,246,0.3)" }}
          >
            {busy ? "שומר…" : "צור עבודה"}
          </button>
        </div>
      </div>
    </div>
  );
}
