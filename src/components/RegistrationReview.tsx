"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { STUDIOS } from "@/lib/calendar/studios";
import type { RegistrationReview as Review } from "@/lib/registration/review";
import type { ApproveOutcome, SimpleOutcome } from "@/lib/registration/approve";
import { perEpisodeRateError } from "@/lib/registration/rate";

/**
 * E17-5 — the approval screen for one registration, inside the "ממתינים
 * לאישור" tab of /clients. studio_admin only: the tab is drawn only for them,
 * and every route behind this refuses anyone else.
 *
 * Two shapes:
 *   · a NEW registration    -> the editable form + "אישור" / "דחייה";
 *   · a MATCHED one         -> connect the numbers to one of the card's
 *                              podcasts, open a new podcast under it, or reject.
 * Every check and every refusal comes from the server; this file only shows
 * them. The sentences for each outcome are here, in one map.
 */

export const REVIEW_COPY = {
  given: "מה הלקוח מסר",
  checks: "בדיקות לפני אישור",
  taxActive: "הח.פ הזה כבר שייך ללקוח פעיל — אי אפשר לאשר. ",
  nameTaken: "השם הזה כבר תפוס אצל לקוח אחר — יש לשנות את שם הלקוח לפני האישור.",
  morningMatch: "הח.פ קיים במורנינג:",
  morningLink: "לקשר ללקוח הקיים במורנינג במקום ליצור חדש",
  morningUnavailable: "לא ניתן לבדוק מול מורנינג כרגע. האישור יבדוק שוב לפני שהוא כותב.",
  morningSaved: "מזהה מורנינג כבר נשמר מניסיון קודם — לא ייפתח לקוח חדש במורנינג.",
  dryRun: "מורנינג במצב dry-run: האישור הוא חזרה בלבד — לא נוצר לקוח במורנינג, לא נשמר מיפוי והלקוח לא מופעל.",
  noticeTo: (to: string) => `ההודעה תישלח ל-${to}`,
  noticeHeld: "(התבנית ממתינה לאישור Meta — ההודעה לא תישלח)",
  approve: "אישור",
  retry: "נסה שוב",
  reject: "דחייה",
  rejectReason: "סיבה פנימית (רשות)",
  attach: "חיבור",
  approved: "ההרשמה אושרה. הלקוח פעיל, הפודקאסט נפתח והמספרים חוברו.",
  approvedAlready: "ההרשמה כבר אושרה קודם.",
  noticeSent: "הודעת האישור נשלחה ללקוח.",
  noticeSkipped: "הודעת האישור לא נשלחה (התבנית ממתינה לאישור Meta).",
  noticeFailed: "הודעת האישור נכשלה בשליחה — אפשר לכתוב ללקוח ידנית.",
  noticeDry: "הודעת האישור נרשמה בלבד (WhatsApp במצב dry-run).",
  dryRunDone: "חזרה הושלמה (dry-run): לא נכתב כלום והלקוח לא הופעל.",
  morningExists: "הח.פ כבר קיים במורנינג. סמנו \"לקשר ללקוח הקיים\" ולחצו שוב, כדי שלא ייפתח כפיל.",
  morningLinkUnknown: "לקוח המורנינג שנבחר לא נמצא. רעננו את המסך.",
  morningFailed: "מורנינג דחה את פתיחת הלקוח:",
  error: "משהו השתבש. אפשר ללחוץ \"נסה שוב\" — הפעולה בטוחה לחזרה.",
  rejected: "ההרשמה נדחתה. לא נשלחה הודעה ללקוח.",
  attached: "המספרים חוברו לפודקאסט.",
} as const;

const FIELD_LABEL: Record<string, string> = {
  taxId: "ח.פ",
  emails: "מייל",
  phone: "טלפון",
  address: "כתובת",
  clientName: "שם הלקוח",
};

type Form = {
  clientName: string;
  taxId: string;
  emails: string[];
  phone: string;
  address: string;
  show: { name: string; alias: string; billingMode: string; pricingModel: string; rate: string; defaultStudio: string };
  contacts: { name: string; phone: string }[];
};

export default function RegistrationReview({ registrationId, onDone }: { registrationId: string; onDone: () => void }) {
  const [review, setReview] = useState<Review | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [linkMorning, setLinkMorning] = useState(false);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [showId, setShowId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [retry, setRetry] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const r = await fetch(`/api/registrations/${registrationId}`, { cache: "no-store" });
      if (!r.ok) return setLoadFailed(true);
      const data = (await r.json()) as Review;
      setReview(data);
      setForm({
        ...data.prefill,
        emails: data.prefill.emails.length ? data.prefill.emails : [""],
        contacts: data.prefill.contacts.length ? data.prefill.contacts : [{ name: "", phone: "" }],
      });
      setShowId(data.card?.shows[0]?.id ?? "");
      if (data.lastMorningFailure) setRetry(true);
    } catch {
      setLoadFailed(true);
    }
  }, [registrationId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadFailed) return <div className="text-xs text-red-400">לא הצלחתי לטעון את ההרשמה.</div>;
  if (!review || !form) return <div className="text-xs text-[var(--faint)]">טוען…</div>;

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const setShow = (patch: Partial<Form["show"]>) => setForm((f) => (f ? { ...f, show: { ...f.show, ...patch } } : f));
  const blocked = !!review.checks.taxIdActive;
  const isDuplicate = review.status === "duplicate";

  async function post(path: string, body: unknown) {
    setBusy(true);
    setMsg(null);
    setErrors({});
    try {
      const r = await fetch(`/api/registrations/${registrationId}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const b = (await r.json().catch(() => ({}))) as { outcome?: ApproveOutcome | SimpleOutcome; error?: string };
      return b.outcome ?? { kind: "error" as const, step: b.error ?? "http" };
    } catch {
      return { kind: "error" as const, step: "network" };
    } finally {
      setBusy(false);
    }
  }

  function showOutcome(o: ApproveOutcome | SimpleOutcome) {
    switch (o.kind) {
      case "approved": {
        const notice =
          o.notice === "sent" ? REVIEW_COPY.noticeSent
          : o.notice === "skipped-template" ? REVIEW_COPY.noticeSkipped
          : o.notice === "failed" ? REVIEW_COPY.noticeFailed
          : o.notice === "dry-run" ? REVIEW_COPY.noticeDry
          : "";
        setMsg({ tone: "ok", text: `${o.already ? REVIEW_COPY.approvedAlready : REVIEW_COPY.approved} ${notice}`.trim() });
        setRetry(false);
        return onDone();
      }
      case "done":
        setMsg({ tone: "ok", text: REVIEW_COPY.attached });
        return onDone();
      case "dry-run":
        return setMsg({ tone: "warn", text: REVIEW_COPY.dryRunDone });
      case "invalid":
        setErrors(o.errors as Record<string, string>);
        return setMsg({ tone: "err", text: "יש לתקן את השדות המסומנים." });
      case "tax-id-active":
        return setMsg({ tone: "err", text: `${REVIEW_COPY.taxActive}${o.clientName}` });
      case "name-taken":
        setErrors({ clientName: REVIEW_COPY.nameTaken });
        return setMsg({ tone: "err", text: REVIEW_COPY.nameTaken });
      case "morning-exists":
        setRetry(true);
        return setMsg({ tone: "warn", text: `${REVIEW_COPY.morningExists} (${o.morningClient.name})` });
      case "morning-link-unknown":
        return setMsg({ tone: "err", text: REVIEW_COPY.morningLinkUnknown });
      case "morning-failed":
        setRetry(true);
        if (o.field) setErrors({ [o.field]: "מורנינג דחה את השדה הזה" });
        return setMsg({ tone: "err", text: `${REVIEW_COPY.morningFailed} ${o.error}${o.field ? ` (שדה: ${FIELD_LABEL[o.field] ?? o.field})` : ""}` });
      case "refused":
        return setMsg({ tone: "err", text: o.message });
      default:
        setRetry(true);
        return setMsg({ tone: "err", text: REVIEW_COPY.error });
    }
  }

  /** the per-episode price, checked before the request (the server checks it too) */
  function rateBlocked(): boolean {
    const e = form ? perEpisodeRateError(form.show.billingMode, form.show.rate) : null;
    if (e) {
      setMsg(null);
      setErrors({ rate: e });
    }
    return !!e;
  }

  async function approve() {
    if (!form || busy || rateBlocked()) return;
    const match = review?.checks.morning.status === "ok" ? review.checks.morning.match : null;
    showOutcome(
      await post("approve", { ...form, linkMorningId: linkMorning && match ? match.id : null })
    );
  }
  async function attach() {
    if (!form || busy || (mode === "new" && rateBlocked())) return;
    showOutcome(await post("attach", { mode, showId: mode === "existing" ? showId : null, show: form.show, contacts: form.contacts }));
  }
  async function reject() {
    if (busy || !window.confirm("לדחות את ההרשמה? לא תישלח הודעה ללקוח.")) return;
    const o = await post("reject", { reason });
    if (o.kind === "done") {
      setMsg({ tone: "ok", text: REVIEW_COPY.rejected });
      return onDone();
    }
    showOutcome(o);
  }

  const input = "w-full bg-transparent border border-[var(--rule)] rounded-lg px-2 py-1.5 text-xs";
  const morning = review.checks.morning;
  const firstPhone = form.contacts[0]?.phone || review.noticeTo;

  return (
    <div className="rounded-xl border border-[var(--violet-light)] p-3 space-y-3 text-xs" dir="rtl">
      {/* ── מה הלקוח מסר ── */}
      <div>
        <div className="font-bold text-[var(--dim)] mb-1">{REVIEW_COPY.given}</div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt className="text-[var(--faint)]">שם</dt><dd>{review.given.legalName}</dd>
          <dt className="text-[var(--faint)]">ח.פ</dt><dd className="font-mono">{review.given.taxId}</dd>
          <dt className="text-[var(--faint)]">מייל</dt><dd dir="ltr" className="text-right">{review.given.emails.join(", ")}</dd>
          <dt className="text-[var(--faint)]">טלפון</dt><dd dir="ltr" className="text-right">{review.given.phone}</dd>
          {review.given.contactName && (<><dt className="text-[var(--faint)]">איש קשר</dt><dd>{review.given.contactName}</dd></>)}
          {review.given.address && (<><dt className="text-[var(--faint)]">כתובת</dt><dd>{review.given.address}</dd></>)}
          <dt className="text-[var(--faint)]">פודקאסט</dt><dd>{review.given.podcastName}</dd>
          {review.given.booking.map((b, i) => (
            <span key={i} className="contents">
              <dt className="text-[var(--faint)]">מורשה {i + 1}</dt>
              <dd>
                {b.name} · <span dir="ltr">{b.display}</span> {b.verified ? "✓ אומת בבוט" : "· לא אומת"}
              </dd>
            </span>
          ))}
          <dt className="text-[var(--faint)]">מקור</dt><dd>{review.source === "bot" ? "הבוט" : "קישור ידני"} · {review.createdAt.slice(0, 10)}</dd>
          <dt className="text-[var(--faint)]">פרטיות</dt><dd>אושרה, גרסה {review.given.privacyVersion}</dd>
        </dl>
      </div>

      {/* ── בדיקות ── */}
      <div className="space-y-1">
        <div className="font-bold text-[var(--dim)]">{REVIEW_COPY.checks}</div>
        {review.checks.taxIdActive && (
          <div className="text-red-400">
            {REVIEW_COPY.taxActive}
            <Link className="underline" href={`/clients/${review.checks.taxIdActive.id}`}>{review.checks.taxIdActive.name}</Link>
          </div>
        )}
        {review.checks.nameTaken && !isDuplicate && <div className="text-amber-400">{REVIEW_COPY.nameTaken}</div>}
        {review.morningIdSaved && <div className="text-emerald-400">{REVIEW_COPY.morningSaved}</div>}
        {morning.status === "ok" && morning.match && (
          <label className="flex items-center gap-2 text-amber-400">
            <input type="checkbox" checked={linkMorning} onChange={(e) => setLinkMorning(e.target.checked)} />
            {REVIEW_COPY.morningMatch} {morning.match.name} — {REVIEW_COPY.morningLink}
          </label>
        )}
        {morning.status === "unavailable" && <div className="text-[var(--faint)]">{REVIEW_COPY.morningUnavailable}</div>}
        {review.dryRun && !isDuplicate && <div className="text-amber-400">{REVIEW_COPY.dryRun}</div>}
        {review.lastMorningFailure && (
          <div className="text-red-400">
            {REVIEW_COPY.morningFailed} {review.lastMorningFailure.error}
            {review.lastMorningFailure.field ? ` (שדה: ${FIELD_LABEL[review.lastMorningFailure.field] ?? review.lastMorningFailure.field})` : ""}
          </div>
        )}
        {!review.checks.taxIdActive && !review.checks.nameTaken && morning.status !== "unavailable" && !(morning.status === "ok" && morning.match) && (
          <div className="text-emerald-400">✓ אין התנגשות</div>
        )}
      </div>

      {/* ── הכרטיס הקיים (כפילות) ── */}
      {isDuplicate && review.card && (
        <div className="space-y-2">
          <div>
            הותאמה לכרטיס: <Link className="underline" href={`/clients/${review.card.id}`}>{review.card.name}</Link>
          </div>
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} disabled={review.card.shows.length === 0} />
            חיבור המספרים לפודקאסט קיים:
            <select className={input + " w-auto"} value={showId} onChange={(e) => setShowId(e.target.value)} disabled={mode !== "existing"}>
              {review.card.shows.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} />
            פתיחת פודקאסט חדש תחת הלקוח
          </label>
        </div>
      )}

      {/* ── הטופס ── */}
      {!isDuplicate && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <F label="שם הלקוח הסופי" error={errors.clientName}><input className={input} value={form.clientName} onChange={(e) => set({ clientName: e.target.value })} /></F>
          <F label="ח.פ" error={errors.taxId}><input className={input} dir="ltr" value={form.taxId} onChange={(e) => set({ taxId: e.target.value })} /></F>
          <F label="מיילים" error={errors.emails}>
            {form.emails.map((em, i) => (
              <input key={i} className={input + " mb-1"} dir="ltr" value={em} onChange={(e) => set({ emails: form.emails.map((x, j) => (j === i ? e.target.value : x)) })} />
            ))}
            {form.emails.length < 3 && <button type="button" className="text-[var(--violet-light)]" onClick={() => set({ emails: [...form.emails, ""] })}>+ מייל</button>}
          </F>
          <F label="טלפון" error={errors.phone}><input className={input} dir="ltr" value={form.phone} onChange={(e) => set({ phone: e.target.value })} /></F>
          <F label="כתובת" error={errors.address}><input className={input} value={form.address} onChange={(e) => set({ address: e.target.value })} /></F>
        </div>
      )}
      {(!isDuplicate || mode === "new") && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <F label="שם הפודקאסט" error={errors.showName}><input className={input} value={form.show.name} onChange={(e) => setShow({ name: e.target.value })} /></F>
          <F label="כינוי (חובה)" error={errors.alias}><input className={input} value={form.show.alias} onChange={(e) => setShow({ alias: e.target.value })} /></F>
          <F label="אופן חיוב" error={errors.billingMode}>
            <select className={input} value={form.show.billingMode} onChange={(e) => setShow({ billingMode: e.target.value })}>
              <option value="per_episode">לפי פרק</option>
              <option value="contract">חוזה</option>
              <option value="none">ללא חיוב</option>
            </select>
          </F>
          <F label={form.show.billingMode === "per_episode" ? "תמחור ומחיר (חובה)" : "תמחור ומחיר"} error={errors.pricingModel || errors.rate}>
            <div className="flex gap-1">
              <select className={input} value={form.show.pricingModel} onChange={(e) => setShow({ pricingModel: e.target.value })}>
                <option value="per_episode">לפרק</option>
                <option value="per_hour">לשעה</option>
              </select>
              <input className={input} dir="ltr" inputMode="decimal" placeholder="₪" value={form.show.rate} onChange={(e) => setShow({ rate: e.target.value })} />
            </div>
          </F>
          <F label="אולפן ברירת מחדל">
            <select className={input} value={form.show.defaultStudio} onChange={(e) => setShow({ defaultStudio: e.target.value })}>
              <option value="">—</option>
              {STUDIOS.map((s) => (
                <option key={s.canonical} value={s.canonical}>{s.canonical}</option>
              ))}
            </select>
          </F>
        </div>
      )}
      <div className="space-y-1">
        <div className="text-[var(--faint)]">מספרים מורשים</div>
        {[0, 1].map((i) => {
          const c = form.contacts[i] ?? { name: "", phone: "" };
          const upd = (patch: Partial<{ name: string; phone: string }>) => {
            const next = [...form.contacts];
            next[i] = { ...c, ...patch };
            set({ contacts: next });
          };
          return (
            <div key={i} className="grid grid-cols-2 gap-1">
              <input className={input} placeholder={`שם ${i + 1}`} value={c.name} onChange={(e) => upd({ name: e.target.value })} />
              <input className={input} dir="ltr" placeholder="05X-XXXXXXX" value={c.phone} onChange={(e) => upd({ phone: e.target.value })} />
              {(errors[`contact${i + 1}Name`] || errors[`contact${i + 1}Phone`]) && (
                <p className="col-span-2 text-red-400">{errors[`contact${i + 1}Name`] ?? errors[`contact${i + 1}Phone`]}</p>
              )}
            </div>
          );
        })}
      </div>

      {!isDuplicate && (
        <div className="text-[var(--dim)]">
          {REVIEW_COPY.noticeTo(firstPhone)} {!review.templateApproved && <span className="text-amber-400">{REVIEW_COPY.noticeHeld}</span>}
        </div>
      )}

      {msg && <div className={msg.tone === "ok" ? "text-emerald-400" : msg.tone === "warn" ? "text-amber-400" : "text-red-400"}>{msg.text}</div>}

      <div className="flex flex-wrap items-center gap-2">
        {isDuplicate ? (
          <button disabled={busy} onClick={() => void attach()} className="rounded-lg px-3 py-1.5 font-bold disabled:opacity-60" style={{ background: "rgba(139,92,246,0.85)", color: "#fff" }}>
            {REVIEW_COPY.attach}
          </button>
        ) : (
          <button disabled={busy || blocked} onClick={() => void approve()} className="rounded-lg px-3 py-1.5 font-bold disabled:opacity-60" style={{ background: "rgba(139,92,246,0.85)", color: "#fff" }}>
            {retry ? REVIEW_COPY.retry : REVIEW_COPY.approve}
          </button>
        )}
        <input className={input + " flex-1 min-w-[8rem]"} placeholder={REVIEW_COPY.rejectReason} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        <button disabled={busy} onClick={() => void reject()} className="rounded-lg px-3 py-1.5 border border-red-400 text-red-400 disabled:opacity-60">
          {REVIEW_COPY.reject}
        </button>
      </div>
    </div>
  );
}

function F({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-0.5">
      <span className="text-[var(--faint)]">{label}</span>
      {children}
      {error && <span className="block text-red-400">{error}</span>}
    </label>
  );
}
