"use client";

import type { RequestView } from "@/lib/booking/publicView";
import {
  clickableDays,
  dayPhrase,
  hoursFor,
  monthGrid,
  monthLabel,
  monthsInWindow,
  sameMonth,
  weekdayOf,
  OPEN_WEEKDAYS,
  type FreeSlot,
  type Month,
} from "./booking";

/**
 * The booking screen — PURE. No hooks, no fetch, no router: every value arrives
 * as a prop and every action leaves as a callback. AvailabilityClient owns the
 * fetch and all six selections.
 *
 * Same split, and the same reason, as RecordBilledBody: the render check here is
 * `renderToString` under tsx, so EFFECTS NEVER RUN. A component that fetched its
 * own data could only ever be tested mid-load, and every state that matters on
 * this screen — no default room, a refused room, an empty month, a picked hour —
 * would be unreachable.
 *
 * ═══ TWO AUDIENCES IN ONE FILE, AND THE LINE BETWEEN THEM ═══
 * Everything under `PreviewBar` is for the owner and will NOT exist in stage 3.
 * Everything under `ClientScreen` is what a client would see. The boundary is
 * deliberate and visual: the preview bar is a dashed, tinted strip so the owner
 * can never mistake their own controls for the client's screen.
 *
 * ⚠️ EVERY FIXED SENTENCE IS APPROVED COPY, WORD FOR WORD (owner, 2026-09-22).
 * Do not reword, do not append. The render suite asserts each appears EXACTLY
 * ONCE (rule 56) — a substring check stays green while a paragraph renders
 * twice, which is what happened in F14 and was caught by eye, not by a suite.
 */

export const COPY = {
  // preview bar — owner only
  previewLead: "תצוגה מקדימה — כך יראה הלקוח של:",
  warningsIntro:
    "האירועים האלה לא נספרו כתפוסים. אם אחד מהם תופס חדר, צריך להוסיף את שם החדר לכותרת שלו ביומן.",
  warningsEmpty: "אין אירועים בלי חדר בטווח הזה.",
  stepHalf: "התחלה כל חצי שעה",
  stepFull: "התחלה כל שעה וחצי",
  skippedTitle: "אירועים שלא נקראו",
  // preview bar — owner only, the booking link
  copyLink: "העתק קישור הזמנה",
  copied: "הקישור הועתק",
  // client screen
  bookingTitle: "הזמנת הקלטה",
  studioLabel: "אולפן",
  pickStudio: "בחרו אולפן כדי לראות מועדים פנויים",
  durationNote: "הקלטה של שעה וחצי",
  error: "לא הצלחתי לקרוא את היומן. לא מוצגת שום זמינות.",
  // ── public screen only (3ב) ──────────────────────────────────────────────
  // ⚠️ `error` above is the OWNER'S sentence and says "no availability is
  // shown", which is the right thing to tell the person who can go and fix the
  // feed. A client can fix nothing and should not be told about a calendar
  // they have never heard of, so the public failure is its own sentence.
  publicLoadFailed: "לא הצלחנו לטעון את המועדים. נסו שוב בעוד כמה דקות.",
  guestLabel: "שם האורח/ת",
  guestHint: "אפשר להשאיר ריק אם אין אורח",
  notePlaceholder: "הערה (לא חובה)",
  submit: "שליחת בקשה",
  sent: "הבקשה נשלחה. נאשר ונחזור אליכם.",
  whatsapp: "עדכנו אותנו בוואטסאפ",
  myRequestsTitle: "הבקשות שלכם",
} as const;

/** 0097's CHECK, as the input's own ceiling — the client is stopped before the server has to say no. */
export const GUEST_INPUT_MAX = 120;

/**
 * One row of "הבקשות שלכם": day, date, time, room, and the guest when there is
 * one. The STATUS is not in here — it renders as its own element beside the
 * line, so the suite can count a status word without matching it inside a
 * sentence that happens to contain it.
 */
export function requestLine(r: RequestView): string {
  const parts = [`יום ${r.dowHe} ${r.dayMonth}`, r.timeIsrael, `אולפן ${r.studio}`];
  if (r.guest) parts.push(`אורח/ת: ${r.guest}`);
  return parts.join(" · ");
}

export const SKIPPED_REASON: Record<string, string> = {
  "no-end": "אין שעת סיום",
  "zero-length": "אורך אפס",
};

/**
 * The collapsed warnings row. Approved copy, 2026-09-22, and it INFLECTS:
 *
 *   n = 1   אירוע אחד בלי חדר בכותרת — לא נחסם
 *   n ≥ 2   {n} אירועים בלי חדר בכותרת — לא נחסמו
 *
 * Note that both halves change, not just the noun: the verb goes from נחסם to
 * נחסמו as well. The singular is a whole separate sentence rather than a
 * template with a swapped word, which is why it is written out.
 *
 * n = 0 never reaches here — the bar renders the flat "אין אירועים…" sentence
 * with no disclosure control at all.
 */
export function warningsSummary(n: number): string {
  if (n === 1) return "אירוע אחד בלי חדר בכותרת — לא נחסם";
  return `${n} אירועים בלי חדר בכותרת — לא נחסמו`;
}

/** "{חדר} לא מוצג: יש ביומן סדרה חוזרת "{כותרת}". ..." — unchanged from part B */
export function refusedLine(room: string, seriesTitle: string): string {
  return `${room} לא מוצג: יש ביומן סדרה חוזרת "${seriesTitle}". המערכת לא מפרקת סדרות חוזרות, ולכן לא יכולה לדעת מתי החדר פנוי.`;
}

/** "יום ג׳ 29.9 — שעות פנויות" */
export function hoursHeading(dateIsrael: string): string {
  return `${dayPhrase(dateIsrael)} — שעות פנויות`;
}

/** "יום ג׳ 29.9 · 11:00–12:30 · אולפן גבעון" */
export function summaryLine(dateIsrael: string, slot: FreeSlot, room: string): string {
  return `${dayPhrase(dateIsrael)} · ${slot.startIsrael}–${slot.endIsrael} · אולפן ${room}`;
}

/** "אין מועדים פנויים בחודש הזה באולפן גבעון. אפשר לבחור אולפן אחר או חודש אחר." */
export function emptyMonthLine(room: string): string {
  return `אין מועדים פנויים בחודש הזה באולפן ${room}. אפשר לבחור אולפן אחר או חודש אחר.`;
}

const DOW_HEADS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

export type Show = { id: string; name: string; defaultRoom: string | null };
export type UnknownBlock = { uid: string; title: string; startIsrael: string | null; allDay: boolean; isSeries: boolean };
export type Refused = { room: string; seriesUid: string; seriesTitle: string };
export type Skipped = { uid: string; title: string; reason: string };

export default function AvailabilityBody({
  loading,
  error,
  fromIsrael,
  toIsrael,
  rooms,
  free,
  unknownRoomBlocks,
  roomsRefused,
  skipped,
  step,
  shows,
  selectedShowId,
  selectedRoom,
  selectedDate,
  selectedStart,
  visibleMonth,
  warningsOpen,
  onStepChange,
  onShowChange,
  onRoomChange,
  onDateChange,
  onStartChange,
  onMonthChange,
  onToggleWarnings,
  publicMode = false,
  onCopyLink,
  copyState = "idle",
  copyError = null,
  guest = "",
  note = "",
  onGuestChange,
  onNoteChange,
  onSubmit,
  submitting = false,
  submitError = null,
  submitted = null,
  whatsappHref = null,
  myRequests = [],
}: {
  loading: boolean;
  error: string | null;
  fromIsrael: string | null;
  toIsrael: string | null;
  rooms: string[];
  free: FreeSlot[];
  unknownRoomBlocks: UnknownBlock[];
  roomsRefused: Refused[];
  skipped: Skipped[];
  step: 30 | 90;
  shows: Show[];
  selectedShowId: string | null;
  selectedRoom: string | null;
  selectedDate: string | null;
  selectedStart: string | null;
  visibleMonth: Month | null;
  warningsOpen: boolean;
  onStepChange: (s: 30 | 90) => void;
  onShowChange: (id: string) => void;
  onRoomChange: (room: string) => void;
  onDateChange: (d: string | null) => void;
  onStartChange: (s: string | null) => void;
  onMonthChange: (m: Month) => void;
  onToggleWarnings: () => void;
  /**
   * ⚠️ THE ONE SWITCH BETWEEN TWO AUDIENCES, and it defaults to the owner's
   * screen. Every prop below it is optional for the same reason: the preview
   * page passes none of them, renders byte-for-byte what it rendered before,
   * and its 165 assertions keep meaning what they meant.
   *
   * In public mode the preview bar is not rendered at all — not hidden with
   * CSS, not emptied, ABSENT. The render suite asserts "תצוגה מקדימה" appears
   * zero times on the public page, and a hidden element would still be in the
   * HTML a client can read.
   */
  publicMode?: boolean;
  // owner only — the booking link button
  onCopyLink?: () => void;
  copyState?: "idle" | "copied" | "error";
  copyError?: string | null;
  // public only — the request form, its outcome, and the client's own history
  guest?: string;
  note?: string;
  onGuestChange?: (v: string) => void;
  onNoteChange?: (v: string) => void;
  onSubmit?: () => void;
  submitting?: boolean;
  submitError?: string | null;
  submitted?: { dateIsrael: string; startIsrael: string; studio: string; guest: string | null } | null;
  whatsappHref?: string | null;
  myRequests?: RequestView[];
}) {
  // every array from the server is defaulted before it is walked — the habit
  // from 2026-09-15, where an undefined the TYPE promised took a page down
  const slots = free ?? [];
  const warnings = unknownRoomBlocks ?? [];
  const refusals = roomsRefused ?? [];
  const unread = skipped ?? [];
  const showList = shows ?? [];
  const bookable = rooms ?? [];
  const show = showList.find((s) => s.id === selectedShowId) ?? null;
  const refusal = refusals.find((r) => r.room === selectedRoom) ?? null;

  const mine = myRequests ?? [];

  // ABSENT in public mode, not hidden — see the note on `publicMode`.
  const preview = publicMode ? null : (
    <PreviewBar
      shows={showList}
      selectedShowId={selectedShowId}
      onShowChange={onShowChange}
      step={step}
      onStepChange={onStepChange}
      warnings={warnings}
      warningsOpen={warningsOpen}
      onToggleWarnings={onToggleWarnings}
      skipped={unread}
      showWarnings={!error}
      onCopyLink={onCopyLink}
      copyState={copyState}
      copyError={copyError}
    />
  );

  // ─── the error state shows the sentence and NO availability whatsoever ───
  // A calendar beside "I could not read the calendar" reads as availability,
  // whatever the sentence above it says.
  if (error) {
    return (
      <Shell>
        {preview}
        <p className="text-sm text-[var(--red)] border border-[var(--red)]/40 rounded-lg p-3">
          {publicMode ? COPY.publicLoadFailed : COPY.error}
        </p>
      </Shell>
    );
  }

  if (loading || !fromIsrael || !toIsrael) {
    return (
      <Shell>
        {preview}
        <p className="text-sm text-[var(--faint)]">טוען…</p>
      </Shell>
    );
  }

  const months = monthsInWindow(fromIsrael, toIsrael);
  const month = visibleMonth ?? months[0];
  const monthIndex = months.findIndex((m) => sameMonth(m, month));
  const open = clickableDays(slots, selectedRoom, fromIsrael, toIsrael);
  const openSet = new Set(open);
  const grid = monthGrid(month);
  const daysThisMonth = grid.filter((d): d is string => d !== null && openSet.has(d));
  const hours = hoursFor(slots, selectedRoom, selectedDate);
  const picked = hours.find((h) => h.startIsrael === selectedStart) ?? null;

  return (
    <Shell>
      {preview}

      <h1 className="text-sm font-bold text-[var(--faint)]">{COPY.bookingTitle}</h1>
      <p className="text-lg font-bold leading-tight">{show?.name ?? "—"}</p>

      <label className="block space-y-1">
        <span className="text-xs text-[var(--dim)]">{COPY.studioLabel}</span>
        <select
          value={selectedRoom ?? ""}
          onChange={(e) => onRoomChange(e.target.value)}
          className="w-full rounded-lg bg-[var(--panel)] border border-[var(--rule)] px-3 py-2 text-sm"
        >
          {/* An empty option only while nothing is chosen. Once a room is
              selected there is no way back to "nothing", which is correct: the
              client has no reason to un-choose. */}
          {selectedRoom === null ? <option value="">—</option> : null}
          {/* TLV is absent BY CONSTRUCTION: `rooms` is the route's bookable list
              (STUDIOS.filter(bookable)), never STUDIOS. Filtering it here would
              be a second gate that could drift from the first. */}
          {bookable.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>

      <p className="text-xs text-[var(--faint)]">{COPY.durationNote}</p>

      {/* "הבקשות שלכם" sits ABOVE the board (owner, 23.9) and only on the
          public page. With no future requests it is not rendered at all — an
          empty heading is a promise of a list that is not there. */}
      {publicMode && mine.length > 0 ? <MyRequests rows={mine} /> : null}

      {selectedRoom === null ? (
        <p className="text-sm text-[var(--dim)]">{COPY.pickStudio}</p>
      ) : (
        <>
          {/* ⚠️ NEVER IN PUBLIC MODE. This sentence quotes the TITLE of a
              recurring series in the owner's calendar — another client's show
              name, as often as not. The public route already strips the title
              from the payload; this is the second lock, so that a title
              arriving anyway still cannot reach a client's screen.

              A refused room then simply offers nothing, and the client reads
              the approved emptyMonthLine instead — "no slots this month in
              this studio, try another studio or month", which is true and
              says nothing about whose series it is. */}
          {refusal && !publicMode ? (
            <p className="text-sm border border-[var(--amber)]/40 rounded-lg p-3 text-[var(--amber)]">
              {refusedLine(refusal.room, refusal.seriesTitle)}
            </p>
          ) : null}

          <div className="space-y-2">
            {/* ⚠️ THE ARROW GLYPHS MUST NOT BE BIDI-MIRRORED CHARACTERS.
                This row previously used ‹ and › (U+2039 / U+203A). Both carry
                Unicode's Bidi_Mirrored property, so inside this dir="rtl"
                subtree the renderer FLIPS them: "חודש קודם" on the right drew a
                left-pointing glyph and "חודש הבא" on the left drew a
                right-pointing one — each arrow pointing away from the month it
                goes to. The button ORDER was always correct (RTL flex puts the
                first child on the right); only the characters lied.
                → and ← (U+2192 / U+2190) have Bidi_Mirrored=0 — verified
                against unicodedata, 2026-09-22 — so they render as written in
                either direction. Do not "tidy" them back into angle quotes.

                The arrows walk `months` and nothing else, so a client can never
                page outside the window. */}
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                disabled={monthIndex <= 0}
                onClick={() => onMonthChange(months[monthIndex - 1])}
                aria-label="חודש קודם"
                className="px-2 py-1 text-sm rounded disabled:opacity-30 disabled:cursor-not-allowed"
              >
                →
              </button>
              <span className="text-sm font-semibold">{monthLabel(month)}</span>
              <button
                type="button"
                disabled={monthIndex < 0 || monthIndex >= months.length - 1}
                onClick={() => onMonthChange(months[monthIndex + 1])}
                aria-label="חודש הבא"
                className="px-2 py-1 text-sm rounded disabled:opacity-30 disabled:cursor-not-allowed"
              >
                ←
              </button>
            </div>

            <div className="grid grid-cols-7 gap-1 text-center">
              {DOW_HEADS.map((d) => (
                <div key={d} className="text-[10px] text-[var(--faint)] py-1">
                  {d}
                </div>
              ))}
              {grid.map((date, i) => {
                if (!date) return <div key={`pad-${i}`} />;
                const clickable = openSet.has(date);
                const dayNum = Number(date.slice(8, 10));
                const isSelected = date === selectedDate;
                return (
                  <button
                    key={date}
                    type="button"
                    disabled={!clickable}
                    onClick={() => {
                      onDateChange(date);
                      onStartChange(null);
                    }}
                    className={
                      "aspect-square rounded-lg text-sm flex items-center justify-center " +
                      (clickable
                        ? isSelected
                          ? "bg-[var(--cyan)] text-[#0f0d1c] font-bold"
                          : "bg-[var(--cyan)]/10 hover:bg-[var(--cyan)]/20"
                        : "text-[var(--faint)] opacity-30 cursor-not-allowed")
                    }
                  >
                    {dayNum}
                  </button>
                );
              })}
            </div>

            {daysThisMonth.length === 0 ? (
              <p className="text-sm text-[var(--dim)]">{emptyMonthLine(selectedRoom)}</p>
            ) : null}
          </div>

          {selectedDate && hours.length > 0 ? (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold">{hoursHeading(selectedDate)}</h2>
              <div className="grid grid-cols-3 gap-2">
                {hours.map((h) => (
                  <button
                    key={h.startIsrael}
                    type="button"
                    onClick={() => onStartChange(h.startIsrael)}
                    className={
                      "py-2 rounded-lg text-sm " +
                      (h.startIsrael === selectedStart
                        ? "bg-[var(--cyan)] text-[#0f0d1c] font-bold"
                        : "bg-[var(--panel)] border border-[var(--rule)] hover:border-[var(--cyan)]")
                    }
                    dir="ltr"
                  >
                    {h.startIsrael}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* ⚠️ THE OWNER'S CARD STILL CARRIES NO BUTTON. In preview mode there
              is nothing to submit — the owner is looking at a client's screen,
              not using it — and a live button there would send a real request
              from a rehearsal. The form below renders only in public mode. */}
          {submitted && publicMode ? (
            <SentCard whatsappHref={whatsappHref} />
          ) : picked && selectedDate ? (
            <div className="rounded-lg border border-[var(--cyan)]/50 bg-[var(--cyan)]/5 p-3 space-y-3">
              <p className="text-sm font-semibold">{summaryLine(selectedDate, picked, selectedRoom)}</p>

              {publicMode ? (
                <>
                  <label className="block space-y-1">
                    <span className="text-xs text-[var(--dim)]">{COPY.guestLabel}</span>
                    <input
                      type="text"
                      value={guest}
                      onChange={(e) => onGuestChange?.(e.target.value)}
                      /* 0097's ceiling, restated where the typing happens. The
                         server still checks it — this only means the client is
                         never told "too long" after the fact. */
                      maxLength={GUEST_INPUT_MAX}
                      className="w-full rounded-lg bg-[var(--panel)] border border-[var(--rule)] px-3 py-2 text-sm"
                    />
                    <span className="block text-[11px] text-[var(--faint)]">{COPY.guestHint}</span>
                  </label>

                  <textarea
                    value={note}
                    onChange={(e) => onNoteChange?.(e.target.value)}
                    placeholder={COPY.notePlaceholder}
                    rows={2}
                    maxLength={500}
                    className="w-full rounded-lg bg-[var(--panel)] border border-[var(--rule)] px-3 py-2 text-sm"
                  />

                  {submitError ? (
                    <p className="text-sm text-[var(--red)] border border-[var(--red)]/40 rounded-lg p-2">{submitError}</p>
                  ) : null}

                  <button
                    type="button"
                    onClick={() => onSubmit?.()}
                    disabled={submitting}
                    className="w-full py-2 rounded-lg text-sm font-bold bg-[var(--cyan)] text-[#0f0d1c] disabled:opacity-50"
                  >
                    {COPY.submit}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Shell>
  );
}

/**
 * What the client sees once the request is in. It REPLACES the summary card
 * rather than sitting under it: the card carries a live form, and leaving a
 * form on screen next to "your request was sent" invites a second identical
 * request — which the server would answer as a duplicate, correctly, and which
 * would still read as a failure to the person pressing it.
 *
 * It takes no slot details on purpose: the approved copy for this state is one
 * sentence, and re-printing "יום א׳ 27.9 · 11:00–12:30 · אולפן גבעון" under it
 * would be copy nobody approved. The details the client needs to keep are in
 * the WhatsApp message and in "הבקשות שלכם" above.
 */
function SentCard({ whatsappHref }: { whatsappHref: string | null }) {
  return (
    <div className="rounded-lg border border-[var(--cyan)]/50 bg-[var(--cyan)]/5 p-3 space-y-3">
      <p className="text-sm font-semibold">{COPY.sent}</p>
      {/* No number in the repository: unset STUDIO_WHATSAPP_NUMBER yields a
          null href and NO element at all, rather than a dead link or a default
          number that would route a client's booking to a stranger. */}
      {whatsappHref ? (
        <a
          href={whatsappHref}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full text-center py-2 rounded-lg text-sm font-bold border border-[var(--cyan)]/60"
        >
          {COPY.whatsapp}
        </a>
      ) : null}
    </div>
  );
}

/** The client's own requests from today onward. Public page only. */
function MyRequests({ rows }: { rows: RequestView[] }) {
  return (
    <div className="space-y-1">
      <h2 className="text-sm font-semibold">{COPY.myRequestsTitle}</h2>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-2 text-xs rounded-lg border border-[var(--rule)] px-2 py-1.5"
          >
            <span>{requestLine(r)}</span>
            <span className="text-[var(--dim)]">{r.statusLabel}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Mobile-first, ~420px, centred — a phone screen even on a desktop. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div dir="rtl" className="mx-auto w-full max-w-[420px] px-4 py-5 space-y-4">
      {children}
    </div>
  );
}

function PreviewBar({
  shows,
  selectedShowId,
  onShowChange,
  step,
  onStepChange,
  warnings,
  warningsOpen,
  onToggleWarnings,
  skipped,
  showWarnings,
  onCopyLink,
  copyState,
  copyError,
}: {
  shows: Show[];
  selectedShowId: string | null;
  onShowChange: (id: string) => void;
  step: 30 | 90;
  onStepChange: (s: 30 | 90) => void;
  warnings: UnknownBlock[];
  warningsOpen: boolean;
  onToggleWarnings: () => void;
  skipped: Skipped[];
  showWarnings: boolean;
  onCopyLink?: () => void;
  copyState: "idle" | "copied" | "error";
  copyError: string | null;
}) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--violet-light)]/50 bg-[var(--violet-light)]/5 p-3 space-y-2">
      <p className="text-xs font-semibold text-[var(--violet-light)]">{COPY.previewLead}</p>

      <select
        value={selectedShowId ?? ""}
        onChange={(e) => onShowChange(e.target.value)}
        className="w-full rounded bg-[var(--panel)] border border-[var(--rule)] px-2 py-1.5 text-xs"
      >
        {shows.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>

      {/* ⚠️ THE BUTTON NEVER RENDERS THE LINK ITSELF. The URL contains the
          token, the token IS the credential, and a link printed on the owner's
          screen is a link over their shoulder and in every screenshot. It goes
          to the clipboard and nowhere else — which is also why this needs a
          server route at all (0096 made the column unreadable from a session).

          The failure sentence renders in PLACE of "הקישור הועתק", never beside
          it: a show with no clean alias has nothing on the clipboard, and two
          messages at once would leave the owner unsure which one happened. */}
      <div className="space-y-1">
        <button
          type="button"
          onClick={() => onCopyLink?.()}
          /* ⚠️ violet, NOT border-[var(--cyan)]/50 — and not only for looks.
             The render suite locates the client's summary card by the FIRST
             occurrence of that exact class string and slices to the end of the
             document to prove the card holds no button. A second element
             wearing the same class earlier in the page moves the anchor to
             itself and the assertion silently starts measuring the whole
             screen. Violet is also the preview bar's own colour, so the two
             reasons agree. */
          className="w-full rounded border border-[var(--violet-light)]/60 px-2 py-1.5 text-xs font-semibold"
        >
          {COPY.copyLink}
        </button>
        {copyState === "copied" ? <p className="text-[11px] text-[var(--cyan)]">{COPY.copied}</p> : null}
        {copyState === "error" && copyError ? <p className="text-[11px] text-[var(--red)]">{copyError}</p> : null}
      </div>

      <div className="flex items-center gap-3 text-[11px]" role="radiogroup">
        {([30, 90] as const).map((s) => (
          <label key={s} className="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              name="step"
              checked={step === s}
              onChange={() => onStepChange(s)}
              className="accent-[var(--cyan)]"
            />
            <span className={step === s ? "text-[var(--ink)]" : "text-[var(--faint)]"}>
              {s === 30 ? COPY.stepHalf : COPY.stepFull}
            </span>
          </label>
        ))}
      </div>

      {showWarnings ? (
        warnings.length === 0 ? (
          // n=0 renders the sentence flat, with no disclosure to open — there is
          // nothing behind it, and a collapsed row promising nothing is noise
          <p className="text-[11px] text-[var(--faint)]">{COPY.warningsEmpty}</p>
        ) : (
          <div className="space-y-1">
            <button
              type="button"
              onClick={onToggleWarnings}
              aria-expanded={warningsOpen}
              className="text-[11px] text-[var(--amber)] underline text-right w-full"
            >
              {warningsSummary(warnings.length)}
            </button>
            {warningsOpen ? (
              <div className="space-y-1">
                <p className="text-[11px] text-[var(--faint)]">{COPY.warningsIntro}</p>
                <ul className="text-[11px] space-y-0.5">
                  {warnings.map((w) => (
                    <li key={w.uid} className="flex flex-wrap gap-1.5">
                      <span className="text-[var(--faint)]" dir="ltr">
                        {w.startIsrael ?? "—"}
                      </span>
                      <span>{w.title}</span>
                      {w.isSeries ? <span className="text-[var(--amber)]">סדרה חוזרת</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )
      ) : null}

      {showWarnings && skipped.length > 0 ? (
        <div className="space-y-0.5">
          <p className="text-[11px] font-semibold">{COPY.skippedTitle}</p>
          <ul className="text-[11px] space-y-0.5">
            {skipped.map((s) => (
              <li key={s.uid} className="flex flex-wrap gap-1.5">
                <span className="text-[var(--faint)]">{SKIPPED_REASON[s.reason] ?? s.reason}</span>
                <span>{s.title}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// re-exported so the suite and the container share one definition
export type { FreeSlot, Month };
export { OPEN_WEEKDAYS, weekdayOf };
