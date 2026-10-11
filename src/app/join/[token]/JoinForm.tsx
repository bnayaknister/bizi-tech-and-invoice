"use client";

import { useState } from "react";
import Link from "next/link";
import { JoinDeadLink, JoinShell, JoinThanks } from "./JoinScreens";
import { LIMITS } from "@/lib/registration/validate";

/**
 * The registration form (E17-4). Hebrew, RTL, phone-first.
 *
 * The browser checks only what helps the person typing (required fields, the
 * nine digits). Every rule is re-checked on the server — validate.ts — and its
 * sentences are what appear under each field when the server refuses.
 *
 * 🔴 THE TOKEN TRAVELS IN THE POST BODY to /api/join/submit, not in that
 * route's path, so the request that carries the personal data does not also
 * carry the credential in a URL that request logs keep.
 *
 * A BOT LINK'S FIRST NUMBER IS SHOWN, NOT SENT. It is the number that wrote to
 * the bot; the server takes it from the link and refuses a body that tries to
 * change it.
 */

type Errors = Partial<Record<string, string>>;

export const JOIN_FORM_TITLE = "פתיחת לקוח חדש";
export const JOIN_FORM_INTRO = "כמה פרטים ואנחנו מסדרים לכם כרטיס. אחרי שנאשר — קובעים הקלטות ישירות בבוט.";
export const GENERIC_FAIL = "משהו השתבש. נסו שוב בעוד רגע.";
export const SLOW = "יותר מדי ניסיונות. נסו שוב מאוחר יותר.";

export default function JoinForm({
  token,
  lockedNumber,
  whatsappNumber,
}: {
  token: string;
  /** display form of the bot link's number, or null for a manual link */
  lockedNumber: string | null;
  whatsappNumber: string | null;
}) {
  const [f, setF] = useState({
    legalName: "",
    taxId: "",
    phone: "",
    contactName: "",
    address: "",
    podcastName: "",
    booking1Name: "",
    booking1Phone: "",
    booking2Name: "",
    booking2Phone: "",
    website: "", // honeypot
  });
  const [emails, setEmails] = useState<string[]>([""]);
  const [privacy, setPrivacy] = useState(false);
  const [showSecond, setShowSecond] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"thanks" | "dead" | null>(null);

  if (done === "thanks") return <JoinThanks />;
  if (done === "dead") return <JoinDeadLink whatsappNumber={whatsappNumber} />;

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await fetch("/api/join/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          ...f,
          booking1Phone: lockedNumber ? undefined : f.booking1Phone,
          emails,
          privacyAccepted: privacy,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { result?: string; errors?: Errors };
      if (body.result === "thanks") setDone("thanks");
      else if (body.result === "dead") setDone("dead");
      else if (body.result === "invalid") setErrors(body.errors ?? {});
      else if (body.result === "slow") setFailure(SLOW);
      else setFailure(GENERIC_FAIL);
    } catch {
      setFailure(GENERIC_FAIL);
    } finally {
      setBusy(false);
    }
  }

  const input =
    "w-full bg-transparent border border-[var(--rule)] rounded-xl px-3 py-2.5 text-base focus:outline-none focus:border-[var(--violet-light)]";

  return (
    <JoinShell>
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="text-center space-y-1">
          <h1 className="text-lg font-bold">{JOIN_FORM_TITLE}</h1>
          <p className="text-sm text-[var(--dim)]">{JOIN_FORM_INTRO}</p>
        </div>

        <Field label="שם (עסק או פרטי)" error={errors.legalName} required>
          <input className={input} value={f.legalName} onChange={set("legalName")} maxLength={LIMITS.legalName} autoComplete="organization" />
        </Field>
        <Field label="ח.פ / ע.מ / ת.ז" hint="9 ספרות" error={errors.taxId} required>
          <input className={input} value={f.taxId} onChange={set("taxId")} inputMode="numeric" dir="ltr" maxLength={20} />
        </Field>

        <Field label="מייל" hint="לשם יישלחו החשבוניות" error={errors.emails} required>
          <div className="space-y-2">
            {emails.map((em, i) => (
              <div key={i} className="flex gap-2">
                <input
                  className={input}
                  value={em}
                  type="email"
                  dir="ltr"
                  autoComplete={i === 0 ? "email" : "off"}
                  onChange={(e) => setEmails((p) => p.map((x, j) => (j === i ? e.target.value : x)))}
                />
                {i > 0 && (
                  <button type="button" aria-label="הסרת מייל" className="px-2 text-[var(--dim)]" onClick={() => setEmails((p) => p.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                )}
              </div>
            ))}
            {emails.length < LIMITS.emails && (
              <button type="button" className="text-xs text-[var(--violet-light)]" onClick={() => setEmails((p) => [...p, ""])}>
                + הוספת מייל
              </button>
            )}
          </div>
        </Field>

        <Field label="טלפון" error={errors.phone} required>
          <input className={input} value={f.phone} onChange={set("phone")} type="tel" dir="ltr" autoComplete="tel" />
        </Field>
        <Field label="שם איש קשר" error={errors.contactName}>
          <input className={input} value={f.contactName} onChange={set("contactName")} maxLength={LIMITS.contactName} autoComplete="name" />
        </Field>
        <Field label="כתובת" error={errors.address}>
          <input className={input} value={f.address} onChange={set("address")} maxLength={LIMITS.address} autoComplete="street-address" />
        </Field>
        <Field label="שם הפודקאסט" error={errors.podcastName} required>
          <input className={input} value={f.podcastName} onChange={set("podcastName")} maxLength={LIMITS.podcastName} />
        </Field>

        <fieldset className="rounded-2xl border border-[var(--rule)] p-3 space-y-3">
          <legend className="px-1 text-sm font-bold">מי יכול לקבוע הקלטות בבוט</legend>
          <p className="text-xs text-[var(--dim)]">אחרי השליחה רק הצוות שלנו יכול לשנות את המספרים.</p>
          <Field label="שם" error={errors.booking1Name} required>
            <input className={input} value={f.booking1Name} onChange={set("booking1Name")} maxLength={LIMITS.bookingName} />
          </Field>
          <Field label="מספר וואטסאפ" error={errors.booking1Phone} required>
            {lockedNumber ? (
              <input className={`${input} opacity-70`} value={lockedNumber} disabled dir="ltr" aria-readonly />
            ) : (
              <input className={input} value={f.booking1Phone} onChange={set("booking1Phone")} type="tel" dir="ltr" />
            )}
          </Field>
          {showSecond ? (
            <>
              <Field label="שם (מספר שני)" error={errors.booking2Name}>
                <input className={input} value={f.booking2Name} onChange={set("booking2Name")} maxLength={LIMITS.bookingName} />
              </Field>
              <Field label="מספר וואטסאפ שני" error={errors.booking2Phone}>
                <input className={input} value={f.booking2Phone} onChange={set("booking2Phone")} type="tel" dir="ltr" />
              </Field>
            </>
          ) : (
            <button type="button" className="text-xs text-[var(--violet-light)]" onClick={() => setShowSecond(true)}>
              + הוספת מספר שני
            </button>
          )}
        </fieldset>

        {/* honeypot — hidden from people, filled by bots */}
        <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
          <label>
            Website
            <input tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} name="website" />
          </label>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} />
          <span>
            קראתי ואני מסכים/ה ל
            <Link href="/privacy" target="_blank" rel="noreferrer noopener" className="underline">
              מדיניות הפרטיות
            </Link>
          </span>
        </label>
        {errors.privacy && <p className="text-xs text-red-400">{errors.privacy}</p>}

        {failure && <p className="text-sm text-red-400 text-center">{failure}</p>}
        {Object.keys(errors).length > 0 && <p className="text-sm text-red-400 text-center">יש לתקן את השדות המסומנים.</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl py-3 font-bold text-base disabled:opacity-60"
          style={{ background: "rgba(139,92,246,0.85)", color: "#fff" }}
        >
          {busy ? "שולח…" : "שליחה"}
        </button>
      </form>
    </JoinShell>
  );
}

function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-sm">
        {label}
        {required && <span className="text-[var(--violet-light)]"> *</span>}
        {hint && <span className="text-xs text-[var(--faint)]"> · {hint}</span>}
      </div>
      {children}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
