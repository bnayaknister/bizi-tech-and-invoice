"use client";

/**
 * The availability screen's content — PURE. No hooks, no fetch, no router:
 * every value arrives as a prop and the one control leaves as a callback. Its
 * container (AvailabilityClient) owns the fetch and the selector.
 *
 * ═══ WHY IT IS SPLIT THIS WAY ═══
 * Same reason RecordBilledBody is. The render check in this project is
 * `renderToString` under tsx — no jsdom, no testing-library — so EFFECTS NEVER
 * RUN. A component that fetched its own data could only ever be rendered in its
 * loading state, and every state worth testing here (the error, a refused room,
 * the empty-warnings sentence, a series warning) would be unreachable. Props
 * are what make them reachable; scripts/test_availability_render.tsx renders
 * each one.
 *
 * ⚠️ EVERY FIXED SENTENCE BELOW IS APPROVED COPY, WORD FOR WORD (owner,
 * 2026-09-22). Do not reword, do not append, do not "clarify". The render suite
 * asserts each one appears EXACTLY ONCE (rule 56) — a substring check passes
 * happily while a whole paragraph renders twice, which is precisely what
 * happened in F14 and was caught by eye rather than by either green suite.
 */

export const COPY = {
  title: "זמינות אולפנים — בדיקה פנימית",
  intro:
    "זה מה שלקוח היה רואה אילו הקישור היה פתוח. מחושב מהיומן בלבד. המסך לא גלוי ללקוחות ולא כותב לשום מקום.",
  stepHalf: "התחלה כל חצי שעה",
  stepFull: "התחלה כל שעה וחצי",
  emptyCell: "אין משבצות פנויות",
  warningsTitle: "אירועים בלי חדר בכותרת — לא נחסמו",
  warningsIntro:
    "האירועים האלה לא נספרו כתפוסים. אם אחד מהם תופס חדר, צריך להוסיף את שם החדר לכותרת שלו ביומן.",
  warningsEmpty: "אין אירועים בלי חדר בטווח הזה.",
  skippedTitle: "אירועים שלא נקראו",
  error: "לא הצלחתי לקרוא את היומן. לא מוצגת שום זמינות.",
} as const;

/** "מ-{תאריך} עד {תאריך} · א׳–ה׳ 9:00–19:00 · משבצת של שעה וחצי" */
export function rangeLine(fromIsrael: string, toIsrael: string): string {
  return `מ-${displayDate(fromIsrael)} עד ${displayDate(toIsrael)} · א׳–ה׳ 9:00–19:00 · משבצת של שעה וחצי`;
}

/** "{חדר} לא מוצג: יש ביומן סדרה חוזרת "{כותרת}". ..." */
export function refusedLine(room: string, seriesTitle: string): string {
  return `${room} לא מוצג: יש ביומן סדרה חוזרת "${seriesTitle}". המערכת לא מפרקת סדרות חוזרות, ולכן לא יכולה לדעת מתי החדר פנוי.`;
}

/** "נקרא מהיומן ב-{שעה} (בשעון ישראל)" */
export function fetchedLine(fetchedAtIso: string | null): string {
  return `נקרא מהיומן ב-${israelClock(fetchedAtIso)} (בשעון ישראל)`;
}

export const SKIPPED_REASON: Record<string, string> = {
  "no-end": "אין שעת סיום",
  "zero-length": "אורך אפס",
};

const DOW = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

/** "23.9" — display only, and never through a Date: the string is already the
 *  Israeli calendar date and converting it to an instant could move the day. */
function displayDate(dateIsrael: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIsrael ?? "");
  if (!m) return dateIsrael ?? "—";
  return `${Number(m[3])}.${Number(m[2])}`;
}

/** Hebrew weekday letter for an Israeli date string. Pure calendar arithmetic. */
function dowOf(dateIsrael: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIsrael ?? "");
  if (!m) return "";
  return DOW[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()] ?? "";
}

function israelClock(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

export type FreeSlot = { room: string; dateIsrael: string; startIsrael: string; endIsrael: string };
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
  fetchedAt,
  onStepChange,
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
  fetchedAt: string | null;
  onStepChange: (s: 30 | 90) => void;
}) {
  // every array from the server is defaulted before it is walked — the habit
  // from 2026-09-15, where an undefined the TYPE promised took a page down
  const slots = free ?? [];
  const warnings = unknownRoomBlocks ?? [];
  const refusals = roomsRefused ?? [];
  const unread = skipped ?? [];
  const roomList = rooms ?? [];
  const refusedByRoom = new Map(refusals.map((r) => [r.room, r]));

  const selector = (
    <div className="flex items-center gap-4 text-xs" role="radiogroup">
      {([30, 90] as const).map((s) => (
        <label key={s} className="flex items-center gap-1.5 cursor-pointer">
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
  );

  // ─── the error state renders the sentence and NOTHING ELSE ───
  // No table, no day names, no hours. A grid beside "I could not read the
  // calendar" reads as availability, whatever the sentence above it says.
  if (error) {
    return (
      <div dir="rtl" className="space-y-4">
        <Header intro />
        <p className="text-sm text-[var(--red)] border border-[var(--red)]/40 rounded-lg p-3">{COPY.error}</p>
      </div>
    );
  }

  if (loading || !fromIsrael || !toIsrael) {
    return (
      <div dir="rtl" className="space-y-4">
        <Header intro />
        {selector}
        <p className="text-sm text-[var(--faint)]">טוען…</p>
      </div>
    );
  }

  // days come from the slots, plus any day a refusal emptied — so a fully
  // refused window still shows its dates rather than collapsing to nothing
  const days = Array.from(new Set(slots.map((s) => s.dateIsrael))).sort();

  const byDayRoom = new Map<string, string[]>();
  for (const s of slots) {
    const k = `${s.dateIsrael}|${s.room}`;
    byDayRoom.set(k, [...(byDayRoom.get(k) ?? []), s.startIsrael]);
  }

  return (
    <div dir="rtl" className="space-y-5">
      <Header intro />
      <p className="text-xs text-[var(--faint)]">{rangeLine(fromIsrael, toIsrael)}</p>
      {selector}

      {refusals.map((r) => (
        <p
          key={r.seriesUid + r.room}
          className="text-sm border border-[var(--amber)]/40 rounded-lg p-3 text-[var(--amber)]"
        >
          {refusedLine(r.room, r.seriesTitle)}
        </p>
      ))}

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b border-[var(--rule)]">
              <th className="text-right p-2 font-semibold whitespace-nowrap">יום</th>
              {roomList.map((room) => (
                <th key={room} className="text-right p-2 font-semibold whitespace-nowrap">
                  {room}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((date) => (
              <tr key={date} className="border-b border-[var(--rule)]/50 align-top">
                <td className="p-2 whitespace-nowrap text-[var(--faint)]">
                  {dowOf(date)} {displayDate(date)}
                </td>
                {roomList.map((room) => {
                  // A refused room is not "full" — it is unknown, and the banner
                  // above says why. Printing the empty-cell sentence here would
                  // claim we checked and found nothing free.
                  if (refusedByRoom.has(room)) {
                    return (
                      <td key={room} className="p-2 text-[var(--faint)]">
                        —
                      </td>
                    );
                  }
                  const hours = byDayRoom.get(`${date}|${room}`) ?? [];
                  return (
                    <td key={room} className="p-2">
                      {hours.length === 0 ? (
                        <span className="text-[var(--faint)]">{COPY.emptyCell}</span>
                      ) : (
                        <span className="flex flex-wrap gap-1" dir="ltr">
                          {hours.map((h) => (
                            <span key={h} className="px-1.5 py-0.5 rounded bg-[var(--cyan)]/10 text-[var(--ink)]">
                              {h}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{COPY.warningsTitle}</h2>
        <p className="text-xs text-[var(--faint)]">{COPY.warningsIntro}</p>
        {warnings.length === 0 ? (
          <p className="text-xs text-[var(--faint)]">{COPY.warningsEmpty}</p>
        ) : (
          <ul className="text-xs space-y-1">
            {warnings.map((w) => (
              <li key={w.uid} className="flex flex-wrap gap-2">
                <span className="text-[var(--faint)] whitespace-nowrap" dir="ltr">
                  {w.startIsrael ?? "—"}
                </span>
                <span>{w.title}</span>
                {w.isSeries ? <span className="text-[var(--amber)]">סדרה חוזרת</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* rendered only when there is something to say — an always-present
          heading over an empty list trains the eye to skip it */}
      {unread.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">{COPY.skippedTitle}</h2>
          <ul className="text-xs space-y-1">
            {unread.map((s) => (
              <li key={s.uid} className="flex flex-wrap gap-2">
                <span className="text-[var(--faint)]">{SKIPPED_REASON[s.reason] ?? s.reason}</span>
                <span>{s.title}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-xs text-[var(--faint)]">{fetchedLine(fetchedAt)}</p>
    </div>
  );
}

function Header({ intro }: { intro: boolean }) {
  return (
    <div className="space-y-1">
      <h1 className="text-lg font-bold">{COPY.title}</h1>
      {intro ? <p className="text-xs text-[var(--faint)] max-w-2xl">{COPY.intro}</p> : null}
    </div>
  );
}
