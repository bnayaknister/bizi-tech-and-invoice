import { DURATION_LABEL, DURATION_SHORT, type BookingDuration } from "@/lib/booking/duration";
import { dayMonth, dowHebrew, weekdayOf } from "@/app/calendar/availability/booking";
import { approvedWhatsappText } from "@/lib/booking/title";

// ═══════════════════════════════════════════════════════════════════════════
// Every sentence the bot says TO A CLIENT, in both languages — THE ONLY PLACE
// THEY LIVE. E9-4 wrote the Hebrew; E19 made it a dictionary (he + en).
// ═══════════════════════════════════════════════════════════════════════════
//
// The machine (./machine.ts) and the reply layer (../reply.ts) choose WHICH
// message to send and with which options; the words come from here, through
// `copy(lang)`. Changing a sentence is an edit to this file and nothing else.
// `scripts/test_wa_i18n.ts` enforces it: it walks every leaf of both
// dictionaries, and it scans the bot's source for client text written
// anywhere else.
//
// ═══ 🔴 THE SCOPE (owner decision 11.10) ═══
// Only what the bot sends a CLIENT. The booking screen, the registration page
// (E17) and the notices to the owner and Eli stay Hebrew — so the template
// texts in ../notify.ts are not here, and must not be.
//
// ═══ THE ENGLISH ═══
// Written once, at build time, by Claude Code, and approved by the owner as a
// whole on 11.10 (owner decisions 11.10 — no runtime translation). The Hebrew is the approved copy and
// is unchanged by E19, word for word.
//
// ⚠️ META'S LIMITS SHAPE SOME OF THESE, and they are not style:
//   · a reply-button title is at most 20 characters — so the owner's
//     "📅 לבדוק זמינות ולקבוע" (22) is the button "📅 בדיקת זמינות", and the
//     longer phrase sits in the body above it;
//   · a list-row title is at most 24, a description 72;
//   · a list holds at most 10 rows IN TOTAL — see machine.ts PAGE_SIZE.
// `client.ts` truncates as a last guard; the suite asserts nothing here needs
// it, in EITHER language.
//
// ⚠️ DATES AND TIMES: every `date` here is an Israeli calendar date string
// ("YYYY-MM-DD") and every `start`/`end` an Israeli wall-clock "HH:MM" — both
// already computed in Asia/Jerusalem upstream (israelDateOf / israelHHMM).
// Nothing here goes through a Date in local time: the weekday is pure
// arithmetic on the string (weekdayOf), so the day cannot shift.

export type Lang = "he" | "en";
export const LANGS: readonly Lang[] = ["he", "en"];
export const DEFAULT_LANG: Lang = "he";

export function isLang(v: unknown): v is Lang {
  return v === "he" || v === "en";
}

export const STUDIOS_PHOTOS_URL = "https://www.bi-zi.co.il";

// ─── the shared pieces each language formats its own way ───────────────────

/**
 * The studios' English names — ONE spelling, everywhere the bot writes in
 * English. The Hebrew name stays the identifier (ids, validation, the
 * database); this is display only. An unknown value falls back to itself.
 * Approved by the owner, 11.10.
 */
export const STUDIO_EN: Record<string, string> = {
  "גבעון": "Givon",
  "גבעון גדול": "Givon Large",
  "חשמונאים": "Hashmonaim",
};

const DOW_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 14 Oct" — from the string, like dayMonth: the day cannot shift. */
export function dayEn(dateIsrael: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIsrael ?? "");
  if (!m) return dateIsrael ?? "—";
  const w = weekdayOf(dateIsrael);
  return `${DOW_EN[w]} ${Number(m[3])} ${MON_EN[Number(m[2]) - 1]}`;
}

/** "יום ג׳ 14.10" */
export function dayHe(dateIsrael: string): string {
  return `יום ${dowHebrew(dateIsrael)} ${dayMonth(dateIsrael)}`;
}

const DURATION_SHORT_EN: Record<BookingDuration, string> = {
  90: "1.5 hours",
  180: "3 hours",
  240: "4 hours",
};

const DURATION_LABEL_EN: Record<BookingDuration, string> = {
  90: "1.5 hours (standard)",
  180: "3 hours (double episode)",
  240: "4 hours",
};

type Rec = { showName: string; date: string; start: string; end: string; studio: string };
type MoveFacts = {
  showName: string;
  from: { dateIsrael: string; start: string; end: string; studio: string };
  to: { dateIsrael: string; start: string; end: string; studio: string };
};
type QueryEcho = {
  studio: string | null;
  duration: BookingDuration | null;
  dateFrom: string | null;
  dateTo: string | null;
  timeFrom: string | null;
  timeTo: string | null;
};
/** E14-2: what the client wrote, narrowing a day or hour list */
type AskedRange = {
  dateFrom: string | null;
  dateTo: string | null;
  timeFrom: string | null;
  timeTo: string | null;
};
const askedTimeHe = (f: AskedRange) =>
  [f.timeFrom ? `אחרי ${f.timeFrom}` : "", f.timeTo ? `לפני ${f.timeTo}` : ""].filter(Boolean).join(" ");
const askedWhenHe = (f: AskedRange) => {
  const days =
    f.dateFrom && f.dateTo && f.dateFrom !== f.dateTo
      ? `בין ${dayHe(f.dateFrom)} ל${dayHe(f.dateTo)}`
      : f.dateFrom
        ? `ב${dayHe(f.dateFrom)}`
        : f.dateTo
          ? `עד ${dayHe(f.dateTo)}`
          : "";
  return [days, askedTimeHe(f)].filter(Boolean).join(" ");
};
const askedTimeEn = (f: AskedRange) =>
  [f.timeFrom ? `after ${f.timeFrom}` : "", f.timeTo ? `before ${f.timeTo}` : ""].filter(Boolean).join(" ");
const askedWhenEn = (f: AskedRange) => {
  const days =
    f.dateFrom && f.dateTo && f.dateFrom !== f.dateTo
      ? `between ${dayEn(f.dateFrom)} and ${dayEn(f.dateTo)}`
      : f.dateFrom
        ? `on ${dayEn(f.dateFrom)}`
        : f.dateTo
          ? `until ${dayEn(f.dateTo)}`
          : "";
  return [days, askedTimeEn(f)].filter(Boolean).join(" ");
};

type SummaryFacts = {
  showName: string;
  dateIsrael: string;
  start: string;
  end: string;
  studio: string;
  duration: BookingDuration;
  guest: string | null;
  note: string | null;
};

// ═══════════════════════════════════════════════════════════════════════════
// עברית — the approved copy, unchanged by E19
// ═══════════════════════════════════════════════════════════════════════════

const studioHe = (s: string) => s;
const recLinesHe = (r: Rec) =>
  [`🎙️ ${r.showName}`, `📅 ${dayHe(r.date)}, ${r.start}–${r.end}`, `📍 אולפן ${studioHe(r.studio)}`].join("\n");

const HE = {
  /** the language's own formatters, so the machine never formats by itself */
  fmt: {
    day: dayHe,
    studio: studioHe,
    durationShort: (d: BookingDuration) => DURATION_SHORT[d],
  },

  /** E19: asked before anything else, of a number with no saved language */
  LANG: {
    // the picker is the one message that cannot know the language yet, so it
    // is bilingual — and identical in both dictionaries
    pickerBody: "באיזו שפה נמשיך? 🌐\nWhich language should we continue in?",
    pickHe: "עברית",
    pickEn: "English",
    /** the menu's button to the OTHER language */
    switchButton: "🌐 English",
    /** when the menu has no room for that button (three already) */
    switchHint: "\n\nFor English, type: English",
    switched: "עברנו לעברית 👍",
  },

  /** E9-3: the reply layer's own sentences (../reply.ts) */
  REPLY: {
    /** Approved copy (owner, 8.10), word for word. */
    neutral: "היי! קיבלנו את ההודעה, נחזור אליך בהקדם 🙂",
    /** Approved copy — the one-podcast reply. */
    link: (showName: string, url: string) => `היי! לקביעת הקלטה ל${showName} — בחרו מועד כאן:\n${url}`,
    listBody: "היי! לאיזה פודקאסט לקבוע הקלטה?",
    listButton: "בחירת פודקאסט",
    listSection: "הפודקאסטים שלכם",
  },

  /**
   * E17-4: an unassociated number, when REGISTRATION_ENABLED is on. All six
   * keys, Hebrew and English, approved as written (owner decision 11.10).
   */
  JOIN: {
    offerBody: "היי! 👋 הגעתם לבוט ההזמנות של Bizi Podclub.\nהמספר הזה עוד לא מחובר לאף פודקאסט אצלנו. מה תרצו לעשות?",
    newClient: "פתיחת לקוח חדש",
    existingClient: "אני כבר לקוח",
    link: (url: string) => `מעולה! 🎉 כאן ממלאים את הפרטים (בערך 2 דקות):\n${url}\nהקישור אישי ותקף ל-7 ימים.`,
    existingReply: "תודה! העברנו לצוות שלנו, ונחזור אליכם כאן כדי לחבר את המספר לפודקאסט 🙂",
    linkFailed: "אוי, לא הצלחתי ליצור קישור כרגע 😕 הצוות שלנו יחזור אליכם כאן בהקדם.",
  },

  NAV: {
    back: "↩️ חזרה",
    restart: "🔁 התחלה מחדש",
    sectionChoices: "אפשרויות",
    sectionNav: "ניווט",
  },

  /** Exact words a client may TYPE instead of tapping a navigation button. */
  NAV_WORDS: {
    back: ["חזרה", "אחורה"],
    restart: ["התחלה מחדש", "מחדש", "להתחיל מחדש"],
  },

  /**
   * Typed EXACTLY (trimmed, lower-cased, trailing punctuation dropped) at the
   * guest or the note step: "there is none" — the same as the skip button,
   * never the stored value (owner, 20.10: "לא" was saved as a note).
   */
  SKIP_WORDS: ["לא", "אין", "בלי"],

  MENU: {
    body: (showName: string) =>
      `היי! 🎙️ רוצים לקבוע הקלטה ל${showName}?\n` +
      `אפשר לבדוק זמינות ולקבוע כאן בצ׳אט, או לראות את כל הזמינות במסך.`,
    /**
     * E9-5: with "📋 ההקלטות שלי" in the menu there is no room for a third
     * button and the link button both (Meta: three buttons), so the link moves
     * into the body — WhatsApp makes it tappable all the same.
     */
    bodyWithLink: (showName: string, url: string | null) =>
      `היי! 🎙️ רוצים לקבוע הקלטה ל${showName}?\n` +
      `אפשר לבדוק זמינות ולקבוע כאן בצ׳אט, או לנהל הקלטות שכבר נקבעו.` +
      (url ? `\n\nכל הזמינות במסך:\n${url}` : ""),
    go: "📅 בדיקת זמינות",
    link: "🔗 לראות במסך",
    mine: "📋 ההקלטות שלי",
    switchShow: "🔄 פודקאסט אחר",
  },

  // ─── E9-5: "ההקלטות שלי", cancel and move ───
  MINE: {
    body: "אלה ההקלטות הקרובות שלכם. על איזו מדובר?",
    button: "בחירת הקלטה",
    title: (date: string, start: string) => `${dayHe(date)} · ${start}`,
    description: (showName: string, studio: string) => `${showName} · אולפן ${studioHe(studio)}`,
  },

  MANAGE: {
    body: (r: Rec) => `מה עושים עם ההקלטה הזאת?\n${recLinesHe(r)}`,
    move: "🔁 להזיז",
    cancel: "❌ לבטל",
  },

  CANCEL_CONFIRM: {
    body: (r: Rec) => `בטוח שמבטלים את ההקלטה?\n${recLinesHe(r)}`,
    yes: "✅ כן, לבטל",
  },

  MOVE_SUMMARY: {
    body: (f: MoveFacts) =>
      [
        "רגע לפני שמזיזים:",
        `🎙️ ${f.showName}`,
        `מ־: ${dayHe(f.from.dateIsrael)}, ${f.from.start}–${f.from.end}, אולפן ${studioHe(f.from.studio)}`,
        `ל־: ${dayHe(f.to.dateIsrael)}, ${f.to.start}–${f.to.end}, אולפן ${studioHe(f.to.studio)}`,
      ].join("\n"),
    confirm: "✅ להזיז",
  },

  DURATION: {
    body: "כמה זמן תימשך ההקלטה?",
    button: "בחירת אורך",
    title: (d: BookingDuration) => DURATION_SHORT[d],
    description: (d: BookingDuration) => DURATION_LABEL[d],
  },

  STUDIO_DEFAULT: {
    body: (studio: string) => `באולפן ${studioHe(studio)}, כמו תמיד?`,
    /** E9-5: a move offers the ORIGINAL's room first */
    moveBody: (studio: string) => `להשאיר את ההקלטה באולפן ${studioHe(studio)}?`,
    yes: (studio: string) => `כן, ${studioHe(studio)}`,
    other: "אולפן אחר",
  },

  STUDIO: {
    body: `באיזה אולפן?\nתמונות של האולפנים: ${STUDIOS_PHOTOS_URL}`,
    button: "בחירת אולפן",
    /** a row in the studio list */
    row: (studio: string) => studioHe(studio),
  },

  DAY: {
    body: (studio: string, d: BookingDuration) =>
      `אלה הימים הקרובים שיש בהם מקום ל${DURATION_SHORT[d]} באולפן ${studioHe(studio)}:`,
    /** E14-2: only with a written filter — the list answers what was asked */
    bodyAsked: (studio: string, d: BookingDuration, f: AskedRange) =>
      `${askedWhenHe(f)} יש מקום ל${DURATION_SHORT[d]} באולפן ${studioHe(studio)} בימים האלה:`.trim(),
    button: "בחירת יום",
    title: (dateIsrael: string) => dayHe(dateIsrael),
    description: (n: number) => (n === 1 ? "מועד פנוי אחד" : `${n} מועדים פנויים`),
    more: "➡️ ימים נוספים",
  },

  HOUR: {
    body: (dateIsrael: string) => `באיזו שעה ב${dayHe(dateIsrael)}?`,
    /** E14-2: only with a written filter */
    bodyAsked: (dateIsrael: string, studio: string, d: BookingDuration, f: AskedRange) =>
      `${[`ב${dayHe(dateIsrael)}`, askedTimeHe(f)].filter(Boolean).join(" ")} פנוי ל${DURATION_SHORT[d]} באולפן ${studioHe(studio)}:`,
    button: "בחירת שעה",
    title: (start: string, end: string) => `${start}–${end}`,
    more: "➡️ שעות נוספות",
  },

  GUEST: {
    body: "מי האורח/ת? כתבו את השם כאן בהודעה.\nעוד אין אורח, או שלא יהיה? אפשר להמשיך בלעדיו.",
    skip: "אין אורח עדיין",
    tooLong: "השם ארוך מדי 🙂 אפשר לכתוב אותו בקצרה?",
  },

  NOTE: {
    body: "יש משהו שחשוב שנדע לפני ההקלטה? כתבו כאן הערה, או המשיכו בלי.",
    skip: "בלי הערות",
    tooLong: "ההערה ארוכה מדי (עד 500 תווים). אפשר לקצר?",
  },

  SUMMARY: {
    body: (f: SummaryFacts) =>
      [
        "רגע לפני שקובעים:",
        `🎙️ ${f.showName}`,
        `📅 ${dayHe(f.dateIsrael)}, ${f.start}–${f.end}`,
        `📍 אולפן ${studioHe(f.studio)}`,
        `⏱️ ${DURATION_SHORT[f.duration]}`,
        `👤 אורח/ת: ${f.guest ?? "אין עדיין"}`,
        `📝 הערה: ${f.note ?? "אין"}`,
      ].join("\n"),
    confirm: "✅ לקבוע",
    cancel: "❌ ביטול",
    // ── E14: shown only while the free-text layer is on ──
    /** the length is the DEFAULT, not the client's choice (owner, 16.10) */
    durationDefault:
      "ℹ️ נקבעה שעה וחצי — ברירת המחדל להקלטה. מתאים 3 או 4 שעות? כתבו לפני האישור, למשל: 3 שעות.",
    /** the invitation to add or change in free text before confirming */
    editHint: "תרצו להוסיף משהו או לשנות? אפשר לכתוב כאן ✍️",
  },

  /** E14: what the language layer understood from free text at the menu */
  QUERY: {
    echo: (q: QueryEcho) => {
      const parts: string[] = [];
      if (q.studio) parts.push(`אולפן ${studioHe(q.studio)}`);
      if (q.dateFrom && q.dateTo && q.dateFrom !== q.dateTo) parts.push(`${dayHe(q.dateFrom)} עד ${dayHe(q.dateTo)}`);
      else if (q.dateFrom) parts.push(dayHe(q.dateFrom));
      if (q.timeFrom) parts.push(`אחרי ${q.timeFrom}`);
      if (q.timeTo) parts.push(`לפני ${q.timeTo}`);
      if (q.duration) parts.push(DURATION_SHORT[q.duration]);
      return parts.length ? `רשמתי לי: ${parts.join(" · ")}` : "";
    },
    dropped: (items: string[]) => `(לא בטוח שהבנתי את ${items.join(" ואת ")}, אז זה לא נלקח בחשבון)`,
    /** zero-match filter: broadening is the client's explicit choice */
    broadenDays: "📅 להציג את כל הימים",
    broadenHours: "🕐 להציג את כל השעות",
  },

  OUTCOME: {
    /**
     * The approval itself: in Hebrew it is `approvedWhatsappText`
     * (lib/booking/title.ts), the existing text the owner already sends by
     * hand, so a client reads the same confirmation either way.
     */
    approved: (showName: string, dateIsrael: string, start: string, studio: string) =>
      approvedWhatsappText({ showName, dateIsrael, startIsrael: start, studio }),
    pending: (showName: string, dateIsrael: string, start: string) =>
      `קיבלנו! 🙌 הבקשה ל${showName} ל${dayHe(dateIsrael)} ב-${start} ` + `נשלחה לאולפן ותאושר בהקדם.`,
    cancelled: "בוטל, לא נקבע כלום. כשתרצו לקבוע, פשוט כתבו לנו 🙂",
    alreadySent: "הבקשה כבר נשלחה ✔️ כדי לקבוע הקלטה נוספת, פשוט כתבו לנו.",
    submitting: "רגע, הבקשה בטיפול ⏳",
    // the same sentence the public route answers with (owner, 23.9)
    tooMany: "יש כבר כמה בקשות שממתינות לאישור. נחזור אליכם עליהן קודם.",
    // ── E9-5 ──
    bookingCancelled: (showName: string, date: string, start: string) =>
      `ההקלטה של ${showName} ב${dayHe(date)} ב-${start} בוטלה ✔️ כשתרצו לקבוע מועד חדש, פשוט כתבו לנו.`,
    moved: (showName: string, date: string, start: string, studio: string) =>
      `ההקלטה של ${showName} הוזזה ל${dayHe(date)} ב-${start}, אולפן ${studioHe(studio)} ✔️ נתראה!`,
    movePending: (date: string, start: string) =>
      `קיבלנו! המועד החדש (${dayHe(date)} ב-${start}) נשלח לאישור הצוות. ` +
      `עד שיאושר, ההקלטה המקורית נשארת בתוקף.`,
    moveAbandoned: "בסדר, לא הזזנו כלום. ההקלטה נשארת כמו שהיא 🙂",
    forwardedCancel:
      "ההקלטה מתחילה בעוד פחות מ-24 שעות, אז את הביטול מעבירים לצוות. הבקשה הועברה, ונחזור אליכם בהקדם 🙏",
    forwardedMove:
      "ההקלטה מתחילה בעוד פחות מ-24 שעות, אז את ההזזה מעבירים לצוות. הבקשה הועברה, ונחזור אליכם בהקדם 🙏",
    notActive: "ההקלטה הזאת כבר לא פעילה. אפשר לבדוק שוב ב\"ההקלטות שלי\".",
  },

  /** One-line prefixes, put above a re-sent step. */
  NOTICE: {
    expired: "השיחה הקודמת פגה, אז מתחילים מחדש 🙂",
    stale: "הכפתור הזה כבר לא פעיל. ממשיכים מכאן:",
    pickFromList: "כדי להמשיך, בחרו מהאפשרויות 👇",
    slotTaken: "אוי, המועד הזה נתפס בינתיים 😕 אלה השעות שעוד פנויות באותו יום:",
    dayFull: "היום הזה התמלא בינתיים. אלה הימים שעוד פנויים:",
    noDays: (studio: string, d: BookingDuration) =>
      `אין כרגע מקום ל${DURATION_SHORT[d]} באולפן ${studioHe(studio)} בשבועות הקרובים. אפשר לבחור אולפן אחר, או לחזור ולבחור אורך אחר:`,
    // ── E14-2: a summary edit tried to keep the chosen time, and could not ──
    keepNoHour: (dateIsrael: string, start: string, studio: string, d: BookingDuration) =>
      `עדכנתי ✔️ אבל ב${dayHe(dateIsrael)} ב-${start} אין מקום ל${DURATION_SHORT[d]} באולפן ${studioHe(studio)} — בחרו שעה אחרת באותו יום:`,
    keepNoDay: (dateIsrael: string, studio: string, d: BookingDuration) =>
      `עדכנתי ✔️ אבל ב${dayHe(dateIsrael)} אין מקום ל${DURATION_SHORT[d]} באולפן ${studioHe(studio)} — בחרו יום אחר:`,
    submitFailed: "משהו השתבש ולא הצלחנו לשלוח את הבקשה. אפשר לנסות שוב:",
    feedFailed: "לא הצלחנו לטעון את המועדים כרגע. נסו שוב בעוד דקה 🙏",
    // ── E9-5 ──
    noRecordings: "אין כרגע הקלטות מאושרות קרובות 🙂",
    manageFailed: "משהו השתבש ולא הצלחנו לבצע את זה. אפשר לנסות שוב:",
    // ── E14 ──
    // only the buttons move on from here — free text is not parsed at this step
    noMatchDates: "בימים שביקשתם אין פנוי 😕 אפשר לראות את כל הימים הפנויים, או לחזור אחורה — בכפתורים למטה 👇",
    noMatchHours: "בשעות שביקשתם אין פנוי באותו יום 😕 רוצים לראות את כל השעות הפנויות באותו יום?",
    changed: "עדכנתי ✔️",
    changedRechoose: "עדכנתי ✔️ בחרו מחדש מהמועדים הפנויים:",
    /** when part of the message was NOT understood, the word "updated" must
     *  not read as "everything you wrote was applied" */
    changedPartial: "עדכנתי את מה שהבנתי ✔️",
    changedPartialRechoose: "עדכנתי את מה שהבנתי ✔️ בחרו מחדש מהמועדים הפנויים:",
    /** NOT an "updated" line: it follows one when there was an edit, and
     *  stands alone after a bare "כן" — said once either way */
    confirmByButton: "טקסט לא מאשר את ההקלטה — לאישור סופי לוחצים על \"✅ לקבוע\" 👇",
    /** the message changed nothing: what was unclear follows (QUERY.dropped) */
    unchanged: "לא שיניתי כלום.",
    /** the message only repeated values already set */
    alreadySet: "זה כבר מעודכן — לא היה מה לשנות.",
    editUnclear:
      "לא הבנתי מה לשנות 🤔 אפשר לכתוב למשל: \"אורח: יהודה לוי\", \"הערה: ...\", \"3 שעות\", \"גבעון גדול\", \"יום רביעי\", \"15:00\" — או ללחוץ ✅ לקבוע.",
  },
};

export type BotCopy = typeof HE;

// ═══════════════════════════════════════════════════════════════════════════
// English — written by Claude Code (E19), pending the owner's review
// ═══════════════════════════════════════════════════════════════════════════

const studioEn = (s: string) => STUDIO_EN[s] ?? s;
/**
 * "The booking page is in Hebrew" — owner decision 11.10: it stays.
 */
const SCREEN_IS_HEBREW = " (the page is in Hebrew)";
const recLinesEn = (r: Rec) =>
  [`🎙️ ${r.showName}`, `📅 ${dayEn(r.date)}, ${r.start}–${r.end}`, `📍 ${studioEn(r.studio)} studio`].join("\n");

const EN: BotCopy = {
  fmt: {
    day: dayEn,
    studio: studioEn,
    durationShort: (d: BookingDuration) => DURATION_SHORT_EN[d],
  },

  LANG: {
    pickerBody: HE.LANG.pickerBody,
    pickHe: HE.LANG.pickHe,
    pickEn: HE.LANG.pickEn,
    switchButton: "🌐 עברית",
    switchHint: "\n\nלעברית, כתבו: עברית",
    switched: "Switched to English 👍",
  },

  REPLY: {
    neutral: "Hi! We got your message and will get back to you soon 🙂",
    link: (showName: string, url: string) =>
      `Hi! To book a recording for ${showName}, pick a time here${SCREEN_IS_HEBREW}:\n${url}`,
    listBody: "Hi! Which podcast would you like to book a recording for?",
    listButton: "Choose podcast",
    listSection: "Your podcasts",
  },

  JOIN: {
    offerBody:
      "Hi! 👋 You've reached the Bizi Podclub booking bot.\nThis number isn't connected to any podcast with us yet. What would you like to do?",
    newClient: "Open a new account",
    existingClient: "I'm already a client",
    link: (url: string) =>
      `Great! 🎉 Fill in your details here${SCREEN_IS_HEBREW} — about 2 minutes:\n${url}\nThis link is personal and valid for 7 days.`,
    existingReply: "Thanks! We've passed this on to our team, and we'll get back to you here to connect this number to your podcast 🙂",
    linkFailed: "Oh no, I couldn't create a link right now 😕 Our team will get back to you here soon.",
  },

  NAV: {
    back: "↩️ Back",
    restart: "🔁 Start over",
    sectionChoices: "Options",
    sectionNav: "Navigation",
  },

  NAV_WORDS: {
    back: ["back"],
    restart: ["start over", "restart"],
  },

  SKIP_WORDS: ["no", "none"],

  MENU: {
    body: (showName: string) =>
      `Hi! 🎙️ Want to book a recording for ${showName}?\n` +
      `You can check availability and book right here in the chat, or see all availability on our booking page${SCREEN_IS_HEBREW}.`,
    bodyWithLink: (showName: string, url: string | null) =>
      `Hi! 🎙️ Want to book a recording for ${showName}?\n` +
      `You can check availability and book right here in the chat, or manage recordings you've already booked.` +
      (url ? `\n\nAll availability on our booking page${SCREEN_IS_HEBREW}:\n${url}` : ""),
    go: "📅 See availability",
    link: "🔗 Booking page",
    mine: "📋 My recordings",
    switchShow: "🔄 Other podcast",
  },

  MINE: {
    body: "These are your upcoming recordings. Which one is this about?",
    button: "Choose recording",
    title: (date: string, start: string) => `${dayEn(date)} · ${start}`,
    description: (showName: string, studio: string) => `${showName} · ${studioEn(studio)} studio`,
  },

  MANAGE: {
    body: (r: Rec) => `What would you like to do with this recording?\n${recLinesEn(r)}`,
    move: "🔁 Move",
    cancel: "❌ Cancel",
  },

  CANCEL_CONFIRM: {
    body: (r: Rec) => `Are you sure you want to cancel this recording?\n${recLinesEn(r)}`,
    yes: "✅ Yes, cancel",
  },

  MOVE_SUMMARY: {
    body: (f: MoveFacts) =>
      [
        "Just before we move it:",
        `🎙️ ${f.showName}`,
        `From: ${dayEn(f.from.dateIsrael)}, ${f.from.start}–${f.from.end}, ${studioEn(f.from.studio)} studio`,
        `To: ${dayEn(f.to.dateIsrael)}, ${f.to.start}–${f.to.end}, ${studioEn(f.to.studio)} studio`,
      ].join("\n"),
    confirm: "✅ Move it",
  },

  DURATION: {
    body: "How long will the recording be?",
    button: "Choose length",
    title: (d: BookingDuration) => DURATION_SHORT_EN[d],
    description: (d: BookingDuration) => DURATION_LABEL_EN[d],
  },

  STUDIO_DEFAULT: {
    body: (studio: string) => `At ${studioEn(studio)} studio, as usual?`,
    moveBody: (studio: string) => `Keep the recording at ${studioEn(studio)} studio?`,
    yes: (studio: string) => `Yes, ${studioEn(studio)}`,
    other: "Another studio",
  },

  STUDIO: {
    body: `Which studio?\nPhotos of the studios: ${STUDIOS_PHOTOS_URL}`,
    button: "Choose studio",
    row: (studio: string) => studioEn(studio),
  },

  DAY: {
    body: (studio: string, d: BookingDuration) =>
      `These are the upcoming days with room for ${DURATION_SHORT_EN[d]} at ${studioEn(studio)} studio:`,
    bodyAsked: (studio: string, d: BookingDuration, f: AskedRange) => {
      const when = askedWhenEn(f);
      return `${when ? `${when[0].toUpperCase()}${when.slice(1)}, these` : "These"} days have room for ${DURATION_SHORT_EN[d]} at ${studioEn(studio)} studio:`;
    },
    button: "Choose day",
    title: (dateIsrael: string) => dayEn(dateIsrael),
    description: (n: number) => (n === 1 ? "1 free slot" : `${n} free slots`),
    more: "➡️ More days",
  },

  HOUR: {
    body: (dateIsrael: string) => `What time on ${dayEn(dateIsrael)}?`,
    bodyAsked: (dateIsrael: string, studio: string, d: BookingDuration, f: AskedRange) =>
      `${[`On ${dayEn(dateIsrael)}`, askedTimeEn(f)].filter(Boolean).join(" ")}, ${studioEn(studio)} studio is free for ${DURATION_SHORT_EN[d]} at:`,
    button: "Choose time",
    title: (start: string, end: string) => `${start}–${end}`,
    more: "➡️ More times",
  },

  GUEST: {
    body: "Who's the guest? Type their name here.\nNo guest yet, or none at all? You can continue without one.",
    skip: "No guest yet",
    tooLong: "That name is a bit long 🙂 Could you write it shorter?",
  },

  NOTE: {
    body: "Anything we should know before the recording? Write a note here, or continue without one.",
    skip: "No notes",
    tooLong: "That note is too long (up to 500 characters). Could you shorten it?",
  },

  SUMMARY: {
    body: (f: SummaryFacts) =>
      [
        "Just before we book:",
        `🎙️ ${f.showName}`,
        `📅 ${dayEn(f.dateIsrael)}, ${f.start}–${f.end}`,
        `📍 ${studioEn(f.studio)} studio`,
        `⏱️ ${DURATION_SHORT_EN[f.duration]}`,
        `👤 Guest: ${f.guest ?? "none yet"}`,
        `📝 Note: ${f.note ?? "none"}`,
      ].join("\n"),
    confirm: "✅ Book it",
    cancel: "❌ Cancel",
    // ── E14: shown only while the free-text layer is on ──
    durationDefault:
      "ℹ️ It's set to 1.5 hours — the default recording length. Prefer 3 or 4 hours? Write before confirming, e.g.: 3 hours.",
    editHint: "Want to add or change anything? You can write it here ✍️",
  },

  /** E14: what the language layer understood from free text at the menu */
  QUERY: {
    echo: (q: QueryEcho) => {
      const parts: string[] = [];
      if (q.studio) parts.push(`${studioEn(q.studio)} studio`);
      if (q.dateFrom && q.dateTo && q.dateFrom !== q.dateTo) parts.push(`${dayEn(q.dateFrom)} to ${dayEn(q.dateTo)}`);
      else if (q.dateFrom) parts.push(dayEn(q.dateFrom));
      if (q.timeFrom) parts.push(`after ${q.timeFrom}`);
      if (q.timeTo) parts.push(`before ${q.timeTo}`);
      if (q.duration) parts.push(DURATION_SHORT_EN[q.duration]);
      return parts.length ? `Got it: ${parts.join(" · ")}` : "";
    },
    dropped: (items: string[]) => `(I wasn't sure about ${items.join(" and ")}, so I left it out)`,
    broadenDays: "📅 Show all days",
    broadenHours: "🕐 Show all times",
  },

  OUTCOME: {
    approved: (showName: string, dateIsrael: string, start: string, studio: string) =>
      `Your ${showName} recording is confirmed: ${dayEn(dateIsrael)} at ${start}, ${studioEn(studio)} studio. See you there!`,
    pending: (showName: string, dateIsrael: string, start: string) =>
      `Got it! 🙌 Your request for ${showName} on ${dayEn(dateIsrael)} at ${start} ` +
      `was sent to the studio and will be confirmed shortly.`,
    cancelled: "Cancelled, nothing was booked. Whenever you'd like to book, just message us 🙂",
    alreadySent: "Your request was already sent ✔️ To book another recording, just message us.",
    submitting: "One moment, your request is being processed ⏳",
    tooMany: "There are already a few requests waiting for approval. We'll get back to you on those first.",
    bookingCancelled: (showName: string, date: string, start: string) =>
      `Your ${showName} recording on ${dayEn(date)} at ${start} has been cancelled ✔️ Whenever you'd like a new time, just message us.`,
    moved: (showName: string, date: string, start: string, studio: string) =>
      `Your ${showName} recording has been moved to ${dayEn(date)} at ${start}, ${studioEn(studio)} studio ✔️ See you there!`,
    movePending: (date: string, start: string) =>
      `Got it! The new time (${dayEn(date)} at ${start}) was sent to the team for approval. ` +
      `Until it's approved, your original recording stays as it is.`,
    moveAbandoned: "OK, nothing was moved. Your recording stays as it is 🙂",
    forwardedCancel:
      "The recording starts in less than 24 hours, so cancellations go through the team. We've passed on your request and will get back to you soon 🙏",
    forwardedMove:
      "The recording starts in less than 24 hours, so changes go through the team. We've passed on your request and will get back to you soon 🙏",
    notActive: "This recording is no longer active. You can check again under \"My recordings\".",
  },

  NOTICE: {
    expired: "The previous conversation expired, so we're starting over 🙂",
    stale: "That button is no longer active. Let's continue from here:",
    pickFromList: "To continue, please choose from the options 👇",
    slotTaken: "Oh no, that time was just taken 😕 These are the times still free that day:",
    dayFull: "That day just filled up. These are the days still available:",
    noDays: (studio: string, d: BookingDuration) =>
      `There's no room for ${DURATION_SHORT_EN[d]} at ${studioEn(studio)} studio in the coming weeks. You can choose another studio, or go back and choose a different length:`,
    keepNoHour: (dateIsrael: string, start: string, studio: string, d: BookingDuration) =>
      `Updated ✔️ but on ${dayEn(dateIsrael)} at ${start} there's no room for ${DURATION_SHORT_EN[d]} at ${studioEn(studio)} studio — please choose another time that day:`,
    keepNoDay: (dateIsrael: string, studio: string, d: BookingDuration) =>
      `Updated ✔️ but on ${dayEn(dateIsrael)} there's no room for ${DURATION_SHORT_EN[d]} at ${studioEn(studio)} studio — please choose another day:`,
    submitFailed: "Something went wrong and we couldn't send the request. You can try again:",
    feedFailed: "We couldn't load the available times right now. Please try again in a minute 🙏",
    noRecordings: "You have no upcoming confirmed recordings right now 🙂",
    manageFailed: "Something went wrong and we couldn't do that. You can try again:",
    // ── E14 ──
    noMatchDates: "Nothing is free on the days you asked for 😕 You can see all the free days, or go back — with the buttons below 👇",
    noMatchHours: "Nothing is free at those times on that day 😕 Want to see all the free times that day?",
    changed: "Updated ✔️",
    changedRechoose: "Updated ✔️ Please choose again from the free times:",
    changedPartial: "Updated what I understood ✔️",
    changedPartialRechoose: "Updated what I understood ✔️ Please choose again from the free times:",
    confirmByButton: "Text doesn't confirm the booking — to confirm, tap \"✅ Book it\" 👇",
    unchanged: "I didn't change anything.",
    alreadySet: "That's already set — nothing to change.",
    editUnclear:
      "I didn't understand what to change 🤔 You can write e.g.: \"guest: John\", \"note: ...\", \"3 hours\", \"Givon Large\", \"Wednesday\", \"15:00\" — or tap ✅ Book it.",
  },
};

/** The dictionary — both languages, the same shape (EN is typed as HE's). */
export const COPY: Record<Lang, BotCopy> = { he: HE, en: EN };

/** The words for one language. An unknown value is Hebrew, never a crash. */
export function copy(lang: Lang | null | undefined): BotCopy {
  return COPY[isLang(lang) ? lang : DEFAULT_LANG];
}

/**
 * The words a client may TYPE to switch language at any moment (owner, 11.10:
 * "English" / "עברית"). Matched whole, after trimming and lower-casing.
 */
export const LANG_WORDS: Record<Lang, readonly string[]> = {
  he: ["עברית", "hebrew"],
  en: ["english", "אנגלית"],
};
