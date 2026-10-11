import { DURATION_LABEL, DURATION_SHORT, type BookingDuration } from "@/lib/booking/duration";
import { dayMonth, dowHebrew } from "@/app/calendar/availability/booking";

// ═══════════════════════════════════════════════════════════════════════════
// Every sentence the booking conversation says — THE ONLY PLACE THEY LIVE.
// E9-4. DRAFT, pending the owner's approval (see the E9-4 report).
// ═══════════════════════════════════════════════════════════════════════════
//
// The machine (./machine.ts) chooses WHICH message to send and with which
// options; the words come from here. Changing a sentence is an edit to this
// file and nothing else.
//
// ⚠️ META'S LIMITS SHAPE SOME OF THESE, and they are not style:
//   · a reply-button title is at most 20 characters — so the owner's
//     "📅 לבדוק זמינות ולקבוע" (22) is the button "📅 בדיקת זמינות", and the
//     longer phrase sits in the body above it;
//   · a list-row title is at most 24, a description 72;
//   · a list holds at most 10 rows IN TOTAL — see machine.ts PAGE_SIZE.
// `client.ts` truncates as a last guard; the suite asserts nothing here needs it.
//
// The one sentence NOT drafted here is the approval itself: it is
// `approvedWhatsappText` (lib/booking/title.ts), the existing text the owner
// already sends by hand, so a client reads the same confirmation either way.

export const STUDIOS_PHOTOS_URL = "https://www.bi-zi.co.il";

export const NAV = {
  back: "↩️ חזרה",
  restart: "🔁 התחלה מחדש",
  sectionChoices: "אפשרויות",
  sectionNav: "ניווט",
} as const;

/** Exact words a client may TYPE instead of tapping a navigation button. */
export const NAV_WORDS = {
  back: ["חזרה", "אחורה"],
  restart: ["התחלה מחדש", "מחדש", "להתחיל מחדש"],
} as const;

export const MENU = {
  body: (showName: string) =>
    `היי! 🎙️ רוצים לקבוע הקלטה ל${showName}?\n` +
    `אפשר לבדוק זמינות ולקבוע כאן בצ׳אט, או לראות את כל הזמינות במסך.`,
  go: "📅 בדיקת זמינות",
  link: "🔗 לראות במסך",
  switchShow: "🔄 פודקאסט אחר",
} as const;

export const DURATION = {
  body: "כמה זמן תימשך ההקלטה?",
  button: "בחירת אורך",
  title: (d: BookingDuration) => DURATION_SHORT[d],
  description: (d: BookingDuration) => DURATION_LABEL[d],
} as const;

export const STUDIO_DEFAULT = {
  body: (studio: string) => `באולפן ${studio}, כמו תמיד?`,
  yes: (studio: string) => `כן, ${studio}`,
  other: "אולפן אחר",
} as const;

export const STUDIO = {
  body: `באיזה אולפן?\nתמונות של האולפנים: ${STUDIOS_PHOTOS_URL}`,
  button: "בחירת אולפן",
} as const;

export const DAY = {
  body: (studio: string, d: BookingDuration) => `אלה הימים הקרובים שיש בהם מקום ל${DURATION_SHORT[d]} באולפן ${studio}:`,
  button: "בחירת יום",
  title: (dateIsrael: string) => `יום ${dowHebrew(dateIsrael)} ${dayMonth(dateIsrael)}`,
  description: (n: number) => (n === 1 ? "מועד פנוי אחד" : `${n} מועדים פנויים`),
  more: "➡️ ימים נוספים",
} as const;

export const HOUR = {
  body: (dateIsrael: string) => `באיזו שעה ביום ${dowHebrew(dateIsrael)} ${dayMonth(dateIsrael)}?`,
  button: "בחירת שעה",
  title: (start: string, end: string) => `${start}–${end}`,
  more: "➡️ שעות נוספות",
} as const;

export const GUEST = {
  body: "מי האורח/ת? כתבו את השם כאן בהודעה.\nעוד אין אורח, או שלא יהיה? אפשר להמשיך בלעדיו.",
  skip: "אין אורח עדיין",
  tooLong: "השם ארוך מדי 🙂 אפשר לכתוב אותו בקצרה?",
} as const;

export const NOTE = {
  body: "יש משהו שחשוב שנדע לפני ההקלטה? כתבו כאן הערה, או המשיכו בלי.",
  skip: "בלי הערות",
  tooLong: "ההערה ארוכה מדי (עד 500 תווים). אפשר לקצר?",
} as const;

export const SUMMARY = {
  body: (f: {
    showName: string;
    dateIsrael: string;
    start: string;
    end: string;
    studio: string;
    duration: BookingDuration;
    guest: string | null;
    note: string | null;
  }) =>
    [
      "רגע לפני שקובעים:",
      `🎙️ ${f.showName}`,
      `📅 יום ${dowHebrew(f.dateIsrael)} ${dayMonth(f.dateIsrael)}, ${f.start}–${f.end}`,
      `📍 אולפן ${f.studio}`,
      `⏱️ ${DURATION_SHORT[f.duration]}`,
      `👤 אורח/ת: ${f.guest ?? "אין עדיין"}`,
      `📝 הערה: ${f.note ?? "אין"}`,
    ].join("\n"),
  confirm: "✅ לקבוע",
  cancel: "❌ ביטול",
} as const;

export const OUTCOME = {
  pending: (showName: string, dateIsrael: string, start: string) =>
    `קיבלנו! 🙌 הבקשה ל${showName} ליום ${dowHebrew(dateIsrael)} ${dayMonth(dateIsrael)} ב-${start} ` +
    `נשלחה לאולפן ותאושר בהקדם.`,
  cancelled: "בוטל, לא נקבע כלום. כשתרצו לקבוע, פשוט כתבו לנו 🙂",
  alreadySent: "הבקשה כבר נשלחה ✔️ כדי לקבוע הקלטה נוספת, פשוט כתבו לנו.",
  submitting: "רגע, הבקשה בטיפול ⏳",
  // the same sentence the public route answers with (owner, 23.9)
  tooMany: "יש כבר כמה בקשות שממתינות לאישור. נחזור אליכם עליהן קודם.",
} as const;

/** One-line prefixes, put above a re-sent step. */
export const NOTICE = {
  expired: "השיחה הקודמת פגה, אז מתחילים מחדש 🙂",
  stale: "הכפתור הזה כבר לא פעיל. ממשיכים מכאן:",
  pickFromList: "כדי להמשיך, בחרו מהאפשרויות 👇",
  slotTaken: "אוי, המועד הזה נתפס בינתיים 😕 אלה השעות שעוד פנויות באותו יום:",
  dayFull: "היום הזה התמלא בינתיים. אלה הימים שעוד פנויים:",
  noDays: (studio: string, d: BookingDuration) =>
    `אין כרגע מקום ל${DURATION_SHORT[d]} באולפן ${studio} בשבועות הקרובים. אפשר לבחור אולפן אחר, או לחזור ולבחור אורך אחר:`,
  submitFailed: "משהו השתבש ולא הצלחנו לשלוח את הבקשה. אפשר לנסות שוב:",
  feedFailed: "לא הצלחנו לטעון את המועדים כרגע. נסו שוב בעוד דקה 🙏",
} as const;
