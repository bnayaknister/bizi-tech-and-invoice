"use client";

import { dayMonth, dowHebrew } from "@/app/calendar/availability/booking";
import { namesAnyRoom } from "@/lib/booking/alias";
import { STUDIOS } from "@/lib/calendar/studios";
import {
  approvedWhatsappText,
  declinedWhatsappText,
  whatsappComposeHref,
} from "@/lib/booking/title";
import type { QueueView } from "@/lib/booking/queue";

/**
 * The owner's request queue — PURE. No hooks, no fetch, no router: every value
 * arrives as a prop and every action leaves as a callback. BookingsClient owns
 * the two dialogs and the requests.
 *
 * Same split, and the same reason, as AvailabilityBody: the render check is
 * `renderToString` under tsx, so EFFECTS NEVER RUN. A component that fetched
 * or decided for itself could only be tested mid-load, and every state that
 * matters here — an empty queue, a past request, an overlapping pair, the
 * just-approved panel, the guest-names-a-room warning — would be unreachable.
 *
 * ⚠️ EVERY FIXED SENTENCE IS APPROVED COPY, WORD FOR WORD (owner, 24.9). Do not
 * reword, do not append. The render suite asserts each appears EXACTLY ONCE
 * (rule 56) — a substring check stays green while a paragraph renders twice,
 * which is what happened in F14 and was caught by eye, not by a suite.
 */

export const COPY = {
  title: "בקשות הקלטה",
  waitingHeading: "ממתינות",
  historyHeading: "היסטוריה",
  empty: "אין בקשות שממתינות לאישור",
  overlapTag: "חופפת לבקשה אחרת",
  approve: "אישור",
  decline: "דחייה",
  cancel: "ביטול",
  // ⚠️ the warning that stands between a room name in a guest name and a
  // production filed in the wrong studio. See the measurement in ./alias.
  guestRoomWarning: "שם האורח מכיל שם של אולפן. אחרי הסנכרון, בדקו שהאורח בהפקה נכון.",
  approvedLead: "ההקלטה אושרה. עכשיו הוסיפו אותה ליומן:",
  openInGoogle: "פתיחה ביומן גוגל",
  copyTitle: "העתקת הכותרת",
  approvedWhatsapp: "הודעת אישור בוואטסאפ",
  titleCopied: "הכותרת הועתקה",
  declined: "הבקשה נדחתה.",
  declinedWhatsapp: "הודעה בוואטסאפ",
} as const;

/** "לאשר הקלטה של דעה לא פופולרית ביום א׳ 27.9, 09:00–10:30, אולפן גבעון?" */
export function approveQuestion(v: QueueView): string {
  return `לאשר הקלטה של ${v.showName} ביום ${dowHebrew(v.dateIsrael)} ${dayMonth(v.dateIsrael)}, ${
    v.startIsrael
  }–${v.endIsrael}, אולפן ${v.studio}?`;
}

/** "לדחות את הבקשה של דעה לא פופולרית ליום א׳ 27.9 09:00?" */
export function declineQuestion(v: QueueView): string {
  return `לדחות את הבקשה של ${v.showName} ליום ${dowHebrew(v.dateIsrael)} ${dayMonth(v.dateIsrael)} ${
    v.startIsrael
  }?`;
}

/**
 * Does this guest name contain a room name?
 *
 * The SAME predicate that decides whether a show may have a booking link at
 * all (`namesAnyRoom`, one definition in ./alias). Measured 23.9: a title whose
 * guest contains "גבעון גדול" while the room is חשמונאים parses as studio
 * "גבעון גדול" — the longest variant wins — so the production lands in a room
 * the client never booked. The owner cannot be stopped from approving (the
 * booking is real), but they can be told to check the production afterwards.
 */
export function guestWarns(guest: string | null | undefined): boolean {
  return namesAnyRoom(guest, STUDIOS);
}

export type ApprovedPanel = {
  view: QueueView;
  /** the title the SERVER built from the stored row */
  title: string;
  googleUrl: string;
};

export default function BookingsBody({
  waiting,
  history,
  approveFor,
  declineFor,
  approved,
  declined,
  busy,
  error,
  copiedTitleId,
  onAskApprove,
  onAskDecline,
  onConfirmApprove,
  onConfirmDecline,
  onCancelDialog,
  onCopyTitle,
}: {
  waiting: QueueView[];
  history: QueueView[];
  approveFor: QueueView | null;
  declineFor: QueueView | null;
  approved: ApprovedPanel | null;
  declined: QueueView | null;
  busy: boolean;
  error: string | null;
  copiedTitleId: string | null;
  onAskApprove: (v: QueueView) => void;
  onAskDecline: (v: QueueView) => void;
  onConfirmApprove: (v: QueueView) => void;
  onConfirmDecline: (v: QueueView) => void;
  onCancelDialog: () => void;
  onCopyTitle: (v: QueueView, title: string) => void;
}) {
  // every array is defaulted before it is walked — the habit from 2026-09-15,
  // where an undefined the TYPE promised took a page down
  const pending = waiting ?? [];
  const past = history ?? [];

  return (
    <div dir="rtl" className="mx-auto w-full max-w-[560px] px-4 py-5 space-y-5">
      <h1 className="text-lg font-bold">{COPY.title}</h1>

      {error ? (
        <p className="text-sm text-[var(--red)] border border-[var(--red)]/40 rounded-lg p-3">{error}</p>
      ) : null}

      {/* The just-decided panels sit at the TOP, above the lists: they are the
          result of the click the owner just made, and the row they came from has
          already moved out of "ממתינות" by the time this renders. */}
      {approved ? (
        <ApprovedCard
          panel={approved}
          copied={copiedTitleId === approved.view.id}
          onCopyTitle={onCopyTitle}
        />
      ) : null}

      {declined ? <DeclinedCard view={declined} /> : null}

      <section className="space-y-2">
        <h2 className="text-[10px] uppercase tracking-wider font-semibold text-[var(--faint)]">
          {COPY.waitingHeading}
        </h2>
        {pending.length === 0 ? (
          <p className="text-sm text-[var(--dim)]">{COPY.empty}</p>
        ) : (
          <div className="space-y-2">
            {pending.map((v) => (
              <Row
                key={v.id}
                v={v}
                busy={busy}
                copied={copiedTitleId === v.id}
                onAskApprove={onAskApprove}
                onAskDecline={onAskDecline}
                onCopyTitle={onCopyTitle}
              />
            ))}
          </div>
        )}
      </section>

      {/* No heading when there is nothing behind it — an empty "היסטוריה" is a
          promise of a list that is not there. The waiting section keeps its
          heading because its emptiness has its own approved sentence. */}
      {past.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-[10px] uppercase tracking-wider font-semibold text-[var(--faint)]">
            {COPY.historyHeading}
          </h2>
          <div className="space-y-2">
            {past.map((v) => (
              <Row
                key={v.id}
                v={v}
                busy={busy}
                copied={copiedTitleId === v.id}
                onAskApprove={onAskApprove}
                onAskDecline={onAskDecline}
                onCopyTitle={onCopyTitle}
              />
            ))}
          </div>
        </section>
      ) : null}

      {approveFor ? (
        <ConfirmDialog
          question={approveQuestion(approveFor)}
          // ⚠️ the warning lives in the DIALOG, not on the row: it is advice
          // about what to do AFTER approving, and it is only actionable at the
          // moment of deciding.
          warning={guestWarns(approveFor.guest) ? COPY.guestRoomWarning : null}
          confirmLabel={COPY.approve}
          tone="go"
          busy={busy}
          onConfirm={() => onConfirmApprove(approveFor)}
          onCancel={onCancelDialog}
        />
      ) : null}

      {declineFor ? (
        <ConfirmDialog
          question={declineQuestion(declineFor)}
          warning={null}
          confirmLabel={COPY.decline}
          tone="stop"
          busy={busy}
          onConfirm={() => onConfirmDecline(declineFor)}
          onCancel={onCancelDialog}
        />
      ) : null}
    </div>
  );
}

function Row({
  v,
  busy,
  copied,
  onAskApprove,
  onAskDecline,
  onCopyTitle,
}: {
  v: QueueView;
  busy: boolean;
  copied: boolean;
  onAskApprove: (v: QueueView) => void;
  onAskDecline: (v: QueueView) => void;
  onCopyTitle: (v: QueueView, title: string) => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--rule)] p-3 space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-bold">{v.showName}</span>
        <span className="text-xs text-[var(--dim)]">{v.statusLabel}</span>
        {v.overlapping ? (
          <span className="text-[11px] text-[var(--amber)] border border-[var(--amber)]/40 rounded px-1.5 py-0.5">
            {COPY.overlapTag}
          </span>
        ) : null}
      </div>

      <p className="text-sm">{v.whenLine}</p>
      {/* guestLine is never empty — it is the guest or the approved "בלי אורח",
          so a guestless request reads as a fact rather than as a missing field */}
      <p className="text-xs text-[var(--dim)]">{v.guestLine}</p>
      {v.note ? <p className="text-xs text-[var(--dim)] whitespace-pre-line">{v.note}</p> : null}
      <p className="text-[11px] text-[var(--faint)]">{v.sentLine}</p>

      {/* ⚠️ APPROVE IS ABSENT, NOT DISABLED, on a request whose moment passed.
          A greyed button invites a click and then explains why it was refused;
          an absent one says the same thing without the detour. `canApprove`
          and `canDecline` are computed in ./queue, not re-derived here. */}
      {v.canApprove || v.canDecline ? (
        <div className="flex gap-2 pt-1">
          {v.canApprove ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAskApprove(v)}
              className="rounded-lg px-3 py-1.5 text-xs font-bold bg-[var(--cyan)] text-[#0f0d1c] disabled:opacity-50"
            >
              {COPY.approve}
            </button>
          ) : null}
          {v.canDecline ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAskDecline(v)}
              className="rounded-lg px-3 py-1.5 text-xs border border-[var(--rule)] text-[var(--dim)] disabled:opacity-50"
            >
              {COPY.decline}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* The three hand-off controls on EVERY approved row, not only on the one
          just approved (owner, 24.9). The owner approves on the phone and
          pastes into the calendar at a desk an hour later; a panel that only
          existed immediately after the click would have been gone by then. */}
      {v.status === "approved" ? (
        <HandoffButtons
          view={v}
          title={v.title}
          googleUrl={v.googleUrl}
          copied={copied}
          onCopyTitle={onCopyTitle}
        />
      ) : null}
    </div>
  );
}

/**
 * Open-in-Google, copy-the-title, send-the-confirmation.
 *
 * ⚠️ THE TITLE IS RENDERED AS TEXT AS WELL AS COPIED. This is the string that
 * decides which room and which guest the sync will record, and the owner is
 * about to paste it into a calendar; showing it is what lets them notice a
 * wrong room before it becomes a production and then an invoice.
 */
function HandoffButtons({
  view,
  title,
  googleUrl,
  copied,
  onCopyTitle,
}: {
  view: QueueView;
  title: string;
  googleUrl: string;
  copied: boolean;
  onCopyTitle: (v: QueueView, title: string) => void;
}) {
  const href = whatsappComposeHref(
    approvedWhatsappText({
      showName: view.showName,
      dateIsrael: view.dateIsrael,
      startIsrael: view.startIsrael,
      studio: view.studio,
    })
  );
  return (
    <div className="space-y-1.5 pt-1">
      <p className="text-xs font-mono bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1.5 break-words">
        {title}
      </p>
      <div className="flex flex-wrap gap-2">
        <a
          href={googleUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg px-3 py-1.5 text-xs font-bold border border-[var(--cyan)]/60"
        >
          {COPY.openInGoogle}
        </a>
        <button
          type="button"
          onClick={() => onCopyTitle(view, title)}
          className="rounded-lg px-3 py-1.5 text-xs border border-[var(--rule)]"
        >
          {COPY.copyTitle}
        </button>
        {/* no number: the owner picks the podcast's chat — see whatsappComposeHref */}
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg px-3 py-1.5 text-xs border border-[var(--rule)]"
        >
          {COPY.approvedWhatsapp}
        </a>
      </div>
      {copied ? <p className="text-[11px] text-[var(--cyan)]">{COPY.titleCopied}</p> : null}
    </div>
  );
}

function ApprovedCard({
  panel,
  copied,
  onCopyTitle,
}: {
  panel: ApprovedPanel;
  copied: boolean;
  onCopyTitle: (v: QueueView, title: string) => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--cyan)]/50 bg-[var(--cyan)]/5 p-3 space-y-2">
      <p className="text-sm font-semibold">{COPY.approvedLead}</p>
      <p className="text-sm">{panel.view.whenLine}</p>
      <HandoffButtons
        view={panel.view}
        title={panel.title}
        googleUrl={panel.googleUrl}
        copied={copied}
        onCopyTitle={onCopyTitle}
      />
    </div>
  );
}

function DeclinedCard({ view }: { view: QueueView }) {
  const href = whatsappComposeHref(
    declinedWhatsappText({
      showName: view.showName,
      dateIsrael: view.dateIsrael,
      startIsrael: view.startIsrael,
    })
  );
  return (
    <div className="rounded-lg border border-[var(--rule2)] p-3 space-y-2">
      <p className="text-sm font-semibold">{COPY.declined}</p>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block rounded-lg px-3 py-1.5 text-xs border border-[var(--rule)]"
      >
        {COPY.declinedWhatsapp}
      </a>
    </div>
  );
}

function ConfirmDialog({
  question,
  warning,
  confirmLabel,
  tone,
  busy,
  onConfirm,
  onCancel,
}: {
  question: string;
  warning: string | null;
  confirmLabel: string;
  tone: "go" | "stop";
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 z-50"
      style={{ background: "rgba(3,2,10,0.66)", backdropFilter: "blur(6px)" }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
        className="w-full max-w-sm border border-[var(--rule2)] rounded-2xl p-5 shadow-2xl space-y-3"
        style={{ background: "rgba(15,13,28,0.92)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
      >
        <p className="text-sm font-semibold">{question}</p>
        {warning ? (
          <p className="text-xs text-[var(--amber)] border border-[var(--amber)]/40 rounded-lg p-2">{warning}</p>
        ) : null}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={
              "rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50 " +
              (tone === "go" ? "bg-[var(--cyan)] text-[#0f0d1c]" : "text-white")
            }
            style={tone === "stop" ? { background: "linear-gradient(135deg, var(--red), var(--red-dk))" } : undefined}
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="border border-[var(--rule)] rounded-xl px-4 py-2 text-sm text-[var(--dim)]"
          >
            {COPY.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
