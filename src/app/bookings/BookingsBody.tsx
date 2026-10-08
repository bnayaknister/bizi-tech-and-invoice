"use client";

import { dayMonth, dowHebrew } from "@/app/calendar/availability/booking";
import { namesAnyRoom } from "@/lib/booking/alias";
import { STUDIOS } from "@/lib/calendar/studios";
import {
  approvedWhatsappText,
  declinedWhatsappText,
  whatsappComposeHref,
} from "@/lib/booking/title";
import { DECIDED_LABEL, type QueueView } from "@/lib/booking/queue";

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
  // ⚠️ feat/calendar-write (7.10) — approved wording, word for word.
  calendarCreated: "נוצר ביומן גוגל.",
  calendarDryRunNotice: "מצב בדיקה — האירוע לא נוצר ביומן.",
  retryCalendar: "נסה שוב ליצור ביומן",
  // E9-3 — the approved lead when the event ALREADY exists. The old one
  // ("עכשיו הוסיפו אותה ליומן") is an instruction to do something that is
  // already done, and following it creates a SECOND event.
  approvedLeadCreated: "ההקלטה אושרה ונכתבה ליומן.",
  // ⚠️ NOT `cancel` — that key is already the DIALOG's "ביטול" button
  // (line 38). Two meanings of one word, and the collision was caught by tsc.
  cancelBooking: "בטל הקלטה",
  cancelled: "ההקלטה בוטלה והמשבצת שוחררה.",
  deleteEventReminder: "מחקו את האירוע ביומן",
  openCalendarDay: "פתיחת היום ביומן",
  noEventToDelete: "להקלטה הזו לא נוצר אירוע ביומן — אין מה למחוק.",
  eventLink: "קישור לאירוע",
} as const;

/**
 * "האישור נשמר, אך היצירה ביומן נכשלה — {שגיאה}. אפשר לנסות שוב." — approved
 * wording with the server's own error dropped in. A FUNCTION, not a frozen
 * COPY string, for the same reason approvedWhatsappText/declinedWhatsappText
 * live outside COPY: the sentence carries data COPY cannot hold literally.
 * The render suite checks the two STATIC halves independently, around
 * whatever error text sits between them.
 */
export function calendarFailedText(error: string): string {
  return `האישור נשמר, אך היצירה ביומן נכשלה — ${error}. אפשר לנסות שוב.`;
}

/**
 * The non-standard length, as a tag beside the time range (E9-2, rule ג).
 *
 * ⚠️ RENDERS NOTHING FOR 90 MINUTES — `durationTag` is null there, and that
 * is deliberate: it is the overwhelming majority of rows, the time range
 * already says 09:00–10:30, and a badge on every line would bury the four-hour
 * booking that actually needs the owner's attention.
 */
function DurationTag({ tag }: { tag: string | null }) {
  if (!tag) return null;
  return (
    <span className="ms-2 text-xs rounded px-1.5 py-0.5 bg-[var(--cyan)]/15 text-[var(--cyan)] align-middle">
      {tag}
    </span>
  );
}

/** "לאשר הקלטה של דעה לא פופולרית ביום א׳ 27.9, 09:00–10:30, אולפן גבעון?" */
export function approveQuestion(v: QueueView): string {
  return `לאשר הקלטה של ${v.showName} ביום ${dowHebrew(v.dateIsrael)} ${dayMonth(v.dateIsrael)}, ${
    v.startIsrael
  }–${v.endIsrael}, אולפן ${v.studio}?`;
}

/** "לבטל את ההקלטה של דעה לא פופולרית ביום א׳ 27.9, 09:00–10:30?" */
export function cancelQuestion(v: QueueView): string {
  return `לבטל את ההקלטה של ${v.showName} ביום ${dowHebrew(v.dateIsrael)} ${dayMonth(v.dateIsrael)}, ${
    v.startIsrael
  }–${v.endIsrael}?`;
}

/**
 * "אושר אוטומטית" / "אושר ידנית" — E9-2.
 *
 * ⚠️ ON EVERY APPROVED ROW, both ways round. A badge that appeared only on
 * the automatic ones would leave the owner unable to tell "approved by a human"
 * from "this screen is too old to know".
 */
function DecidedTag({ view }: { view: QueueView }) {
  if (view.status !== "approved") return null;
  const auto = view.autoApproved;
  return (
    <span
      className={
        "ms-2 text-[10px] rounded px-1.5 py-0.5 align-middle " +
        (auto ? "bg-[var(--signal)]/15 text-[var(--signal)]" : "bg-[var(--panel)] text-[var(--dim)]")
      }
    >
      {auto ? DECIDED_LABEL.auto : DECIDED_LABEL.manual}
    </span>
  );
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

/**
 * The calendar write's outcome, for ONE approved row — whether that row is
 * the just-approved ephemeral panel (built fresh from the approve response)
 * or a historical row reloaded from the database (built from QueueView's own
 * three fields). `htmlLink` and `dryRun` are NEVER persisted (0099 does not
 * carry a column for either — see the PR report on why), so a reloaded
 * historical row always carries `htmlLink: null, dryRun: false`: the
 * TEMPLATE "פתיחה ביומן גוגל" button is what stays reliable for it, exactly
 * as the owner's own instruction keeps it as a fallback.
 */
export type CalendarWriteState = {
  status: "created" | "failed" | null;
  error: string | null;
  htmlLink: string | null;
  dryRun: boolean;
};

export function calendarStateFromView(v: QueueView): CalendarWriteState {
  return {
    status: v.calendarWriteStatus,
    error: v.calendarWriteError,
    htmlLink: null,
    dryRun: false,
  };
}

export type ApprovedPanel = {
  view: QueueView;
  /** the title the SERVER built from the stored row */
  title: string;
  googleUrl: string;
  /** the FRESH result from the approve response — `view` itself predates it */
  calendar: CalendarWriteState;
};

/** What a cancellation hands back — see the route for why the flag is here. */
export type CancelledPanel = {
  view: QueueView;
  /**
   * 🔴 Whether an event was EVER written for this booking. The reminder is
   * driven by this and not by "we cancelled something": a booking whose
   * calendar write failed or never ran has no event to delete, and telling the
   * owner to go and delete one sends them looking for something that was never
   * there.
   */
  calendarEventExisted: boolean;
  calendarDayUrl: string;
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
  onRetryCalendar,
  retryingId,
  cancelFor,
  cancelled,
  onAskCancel,
  onConfirmCancel,
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
  /** feat/calendar-write (7.10) — retry a failed/never-attempted write */
  onRetryCalendar: (v: QueueView) => void;
  /** the one row currently retrying, so only ITS button disables */
  retryingId: string | null;
  // ── E9-3: cancelling an approved recording ──────────────────────
  /** the row whose cancel confirmation is open */
  cancelFor: QueueView | null;
  /** the FRESH result of a cancellation — carries whether an event exists */
  cancelled: CancelledPanel | null;
  onAskCancel: (v: QueueView) => void;
  onConfirmCancel: (v: QueueView) => void;
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
          onRetryCalendar={onRetryCalendar}
          retrying={retryingId === approved.view.id}
        />
      ) : null}

      {declined ? <DeclinedCard view={declined} /> : null}
      {cancelled ? <CancelledCard panel={cancelled} /> : null}

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
                onAskCancel={onAskCancel}
                onCopyTitle={onCopyTitle}
                onRetryCalendar={onRetryCalendar}
                retrying={retryingId === v.id}
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
                onAskCancel={onAskCancel}
                onCopyTitle={onCopyTitle}
                onRetryCalendar={onRetryCalendar}
                retrying={retryingId === v.id}
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

      {/* 🔴 A CONFIRMATION, AND NOT OPTIONAL (owner, 9.10). Cancelling destroys
          an approval the CLIENT has already been told about and frees a slot
          somebody else can take within seconds — and unlike a decline there is
          no undo path that puts it back. The warning is the calendar reminder,
          stated at the moment of deciding rather than only afterwards. */}
      {cancelFor ? (
        <ConfirmDialog
          question={cancelQuestion(cancelFor)}
          warning={COPY.deleteEventReminder}
          confirmLabel={COPY.cancelBooking}
          tone="stop"
          busy={busy}
          onConfirm={() => onConfirmCancel(cancelFor)}
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
  onAskCancel,
  onAskApprove,
  onAskDecline,
  onCopyTitle,
  onRetryCalendar,
  retrying,
}: {
  v: QueueView;
  busy: boolean;
  copied: boolean;
  onAskApprove: (v: QueueView) => void;
  onAskDecline: (v: QueueView) => void;
  onAskCancel: (v: QueueView) => void;
  onCopyTitle: (v: QueueView, title: string) => void;
  onRetryCalendar: (v: QueueView) => void;
  retrying: boolean;
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

      <p className="text-sm">
        {v.whenLine}
        <DurationTag tag={v.durationTag} />
      </p>
      {/* guestLine is never empty — it is the guest or the approved "בלי אורח",
          so a guestless request reads as a fact rather than as a missing field */}
      <p className="text-xs text-[var(--dim)]">
        {v.guestLine}
        <DecidedTag view={v} />
      </p>
      {v.note ? <p className="text-xs text-[var(--dim)] whitespace-pre-line">{v.note}</p> : null}
      <p className="text-[11px] text-[var(--faint)]">{v.sentLine}</p>

      {/* ⚠️ APPROVE IS ABSENT, NOT DISABLED, on a request whose moment passed.
          A greyed button invites a click and then explains why it was refused;
          an absent one says the same thing without the detour. `canApprove`
          and `canDecline` are computed in ./queue, not re-derived here. */}
      {v.canApprove || v.canDecline || v.canCancel ? (
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
          {/* ⚠️ ABSENT ON A PAST ROW, not disabled — `canCancel` already says so
              (./queue). Cancelling a recording that has happened frees a slot
              nobody can use and points the owner at an event that documents
              something real. */}
          {v.canCancel ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAskCancel(v)}
              className="rounded-lg px-3 py-1.5 text-xs border border-rose-500/50 text-rose-300 disabled:opacity-50"
            >
              {COPY.cancelBooking}
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
          calendar={calendarStateFromView(v)}
          onRetryCalendar={onRetryCalendar}
          retrying={retrying}
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
  calendar,
  onRetryCalendar,
  retrying,
}: {
  view: QueueView;
  title: string;
  googleUrl: string;
  copied: boolean;
  onCopyTitle: (v: QueueView, title: string) => void;
  calendar: CalendarWriteState;
  onRetryCalendar: (v: QueueView) => void;
  retrying: boolean;
}) {
  const href = whatsappComposeHref(
    approvedWhatsappText({
      showName: view.showName,
      dateIsrael: view.dateIsrael,
      startIsrael: view.startIsrael,
      studio: view.studio,
    })
  );
  // 🔴 E9-3 — THE FIX. When the event ALREADY EXISTS in the calendar, the
  // "פתיחה ביומן גוגל" button must not render: it opens Google's
  // create-event form pre-filled, and pressing it produces a SECOND event for
  // the same recording. E9-1's note said it "stays available in EVERY one of
  // the four states (owner, step 5)" — that was written when the write was new
  // and the manual paste was the proven fallback. The write is now live and
  // verified in production (9.10), so the fallback has become a duplicate
  // generator and the owner asked for it gone.
  //
  // ⚠️ IT STAYS IN EVERY OTHER STATE. A failed write, a dry run, or a row
  // from before the feature all still need a way to get the event in by hand —
  // that is precisely when a human must be able to create it.
  const eventAlreadyCreated = calendar.status === "created" && !calendar.dryRun;

  return (
    <div className="space-y-1.5 pt-1">
      {/* the title is still shown when the event exists — the owner compares it
          against what is in the calendar — but it is no longer a hand-off */}
      <p className="text-xs font-mono bg-[var(--panel)] border border-[var(--rule)] rounded px-2 py-1.5 break-words">
        {title}
      </p>
      <div className="flex flex-wrap gap-2">
        {eventAlreadyCreated ? null : (
          <a
            href={googleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg px-3 py-1.5 text-xs font-bold border border-[var(--cyan)]/60"
          >
            {COPY.openInGoogle}
          </a>
        )}
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

      {/* feat/calendar-write (7.10) — the four states. ⚠️ The sentence that used
          to be here said the Google button stays available in all four; E9-3
          removed it from the `created` state only — see eventAlreadyCreated
          above for why, and why it remains in the other three. */}
      <CalendarStatus
        view={view}
        calendar={calendar}
        onRetryCalendar={onRetryCalendar}
        retrying={retrying}
      />
    </div>
  );
}

/**
 * The calendar write's own state, under the three existing hand-off buttons.
 * Four mutually exclusive renders — dry-run, created, failed, or "nothing to
 * say yet" — and exactly one of them for any row, never two at once.
 */
function CalendarStatus({
  view,
  calendar,
  onRetryCalendar,
  retrying,
}: {
  view: QueueView;
  calendar: CalendarWriteState;
  onRetryCalendar: (v: QueueView) => void;
  retrying: boolean;
}) {
  if (calendar.dryRun) {
    return <p className="text-[11px] text-[var(--faint)] pt-0.5">{COPY.calendarDryRunNotice}</p>;
  }
  if (calendar.status === "created") {
    return (
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <p className="text-[11px] text-[var(--cyan)]">{COPY.calendarCreated}</p>
        {calendar.htmlLink ? (
          <a
            href={calendar.htmlLink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] underline text-[var(--signal)]"
          >
            {COPY.eventLink}
          </a>
        ) : null}
        {/* ⛔ No link to "the production this created" — an approval creates
            no production. The sync creates it on the recording morning, from
            this very event (owner correction 7.10). */}
      </div>
    );
  }
  if (calendar.status === "failed") {
    return (
      <div className="space-y-1 pt-0.5">
        <p className="text-[11px] text-rose-400">{calendarFailedText(calendar.error ?? "")}</p>
        <button
          type="button"
          disabled={retrying}
          onClick={() => onRetryCalendar(view)}
          className="rounded-lg px-2.5 py-1 text-[11px] border border-rose-500/60 text-rose-300 disabled:opacity-50"
        >
          {COPY.retryCalendar}
        </button>
      </div>
    );
  }
  // status === null and not dryRun: a row from before this feature existed,
  // or one whose write genuinely never ran. Nothing to say — the TEMPLATE
  // button above is the only hand-off this row has ever had.
  return null;
}

function ApprovedCard({
  panel,
  copied,
  onCopyTitle,
  onRetryCalendar,
  retrying,
}: {
  panel: ApprovedPanel;
  copied: boolean;
  onCopyTitle: (v: QueueView, title: string) => void;
  onRetryCalendar: (v: QueueView) => void;
  retrying: boolean;
}) {
  return (
    <div className="rounded-lg border border-[var(--cyan)]/50 bg-[var(--cyan)]/5 p-3 space-y-2">
      {/* 🔴 E9-3: the lead depends on whether the event EXISTS. "עכשיו
          הוסיפו אותה ליומן" above a booking that is already in the calendar
          is an instruction whose only effect is a duplicate event. */}
      <p className="text-sm font-semibold">
        {panel.calendar.status === "created" && !panel.calendar.dryRun
          ? COPY.approvedLeadCreated
          : COPY.approvedLead}
      </p>
      <p className="text-sm">
        {panel.view.whenLine}
        <DurationTag tag={panel.view.durationTag} />
      </p>
      <HandoffButtons
        view={panel.view}
        title={panel.title}
        googleUrl={panel.googleUrl}
        copied={copied}
        onCopyTitle={onCopyTitle}
        calendar={panel.calendar}
        onRetryCalendar={onRetryCalendar}
        retrying={retrying}
      />
    </div>
  );
}

/**
 * What the owner sees right after cancelling.
 *
 * 🔴 THE REMINDER IS CONDITIONAL ON AN EVENT HAVING EXISTED. A booking whose
 * calendar write failed, never ran, or ran in dry-run mode has nothing in the
 * calendar — and "מחקו את האירוע ביומן" would send the owner
 * looking for something that was never there, which is how a person stops
 * trusting a reminder.
 *
 * ⚠️ AND THE CODE DOES NOT DELETE IT. lib/calendar/write.ts has no
 * `events.delete` and must not grow one (write.ts:24-32): `writer` on a shared
 * calendar can delete the advertising company's recordings too, so the
 * capability does not exist here at all. A human deletes; this is the nudge.
 */
function CancelledCard({ panel }: { panel: CancelledPanel }) {
  return (
    <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-3 space-y-2">
      <p className="text-sm font-semibold">{COPY.cancelled}</p>
      <p className="text-sm">{panel.view.whenLine}</p>
      {panel.calendarEventExisted ? (
        <div className="space-y-1.5">
          <p className="text-xs font-bold text-rose-300">{COPY.deleteEventReminder}</p>
          <a
            href={panel.calendarDayUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block rounded-lg px-3 py-1.5 text-xs font-bold border border-rose-500/60 text-rose-200"
          >
            {COPY.openCalendarDay}
          </a>
        </div>
      ) : (
        <p className="text-[11px] text-[var(--faint)]">{COPY.noEventToDelete}</p>
      )}
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
