"use client";

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
  // client screen
  bookingTitle: "הזמנת הקלטה",
  studioLabel: "אולפן",
  pickStudio: "בחרו אולפן כדי לראות מועדים פנויים",
  durationNote: "הקלטה של שעה וחצי",
  error: "לא הצלחתי לקרוא את היומן. לא מוצגת שום זמינות.",
} as const;

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

  const preview = (
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
    />
  );

  // ─── the error state shows the sentence and NO availability whatsoever ───
  // A calendar beside "I could not read the calendar" reads as availability,
  // whatever the sentence above it says.
  if (error) {
    return (
      <Shell>
        {preview}
        <p className="text-sm text-[var(--red)] border border-[var(--red)]/40 rounded-lg p-3">{COPY.error}</p>
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

      {selectedRoom === null ? (
        <p className="text-sm text-[var(--dim)]">{COPY.pickStudio}</p>
      ) : (
        <>
          {refusal ? (
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

          {/* The summary card carries NO button. There is nothing to submit in
              stage 2 — the request itself is stage 3 — and a disabled or dead
              button would read as a broken flow rather than an absent one. */}
          {picked && selectedDate ? (
            <div className="rounded-lg border border-[var(--cyan)]/50 bg-[var(--cyan)]/5 p-3">
              <p className="text-sm font-semibold">{summaryLine(selectedDate, picked, selectedRoom)}</p>
            </div>
          ) : null}
        </>
      )}
    </Shell>
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
