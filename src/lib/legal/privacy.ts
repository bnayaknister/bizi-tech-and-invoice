// ═══════════════════════════════════════════════════════════════════════════
// The privacy policy — THE ONLY PLACE ITS WORDS LIVE.
// ═══════════════════════════════════════════════════════════════════════════
//
// Required by Meta to publish the WhatsApp app (Bizi Booking Bot): the app's
// settings take a privacy-policy URL and a data-deletion URL, and both point
// here — /privacy and /privacy#deletion.
//
// To change the wording: edit this file, and bump UPDATED_AT. Nothing in
// src/app/privacy carries a sentence of its own; the page only lays out what
// is here.
//
// ⚠️ THE `deletion` ID IS AN ADDRESS, NOT A LABEL. Meta stores the URL
// /privacy#deletion; renaming the id breaks that link without breaking the
// build. scripts/test_privacy_render.tsx asserts it.

export const PRIVACY_CONTACT_EMAIL = "bn@bi-zi.co.il";

/** shown as "עודכן לאחרונה"; bump on every change to the wording below */
export const PRIVACY_UPDATED_AT = "10.10.2026";

export const PRIVACY_TITLE = "מדיניות פרטיות";

export const PRIVACY_INTRO =
  "המדיניות הזו מסבירה איזה מידע אנחנו אוספים דרך בוט הוואטסאפ ומסך הזמנת ההקלטות שלנו, למה, כמה זמן הוא נשמר ואיך מבקשים למחוק אותו.";

export type PrivacySection = {
  /** anchor id; `deletion` is load-bearing (see header) */
  id: string;
  title: string;
  paragraphs: string[];
  bullets?: string[];
};

export const PRIVACY_SECTIONS: PrivacySection[] = [
  {
    id: "who",
    title: "מי אנחנו",
    paragraphs: [
      "השירות מופעל על ידי BIZI STUDIO LTD (ביזי פודקלאב), אולפן הקלטות פודקאסטים בתל אביב.",
    ],
  },
  {
    id: "data",
    title: "איזה מידע נאסף",
    paragraphs: ["כשאתם פונים לבוט הוואטסאפ שלנו או מזמינים הקלטה במסך ההזמנה, נשמר המידע הבא:"],
    bullets: [
      "מספר הטלפון שממנו נשלחה ההודעה.",
      "שם.",
      "תוכן ההודעות שנשלחו לבוט.",
      "פרטי הזמנת ההקלטה: תאריך, שעה, אולפן, שם האורח והערה, אם נמסרו.",
    ],
  },
  {
    id: "use",
    title: "למה אנחנו משתמשים במידע",
    paragraphs: [
      "המידע משמש לזיהוי הלקוח, לקביעת הקלטות ולשליחת עדכונים על ההזמנה.",
      "אנחנו לא מוכרים את המידע ולא מעבירים אותו לצד שלישי, מלבד ספקי התשתית שמפעילים את השירות: Meta (WhatsApp), Google (יומן Google) וספק האחסון של המערכת. הם מעבדים את המידע רק כדי להפעיל את השירות.",
    ],
  },
  {
    id: "retention",
    title: "כמה זמן המידע נשמר",
    paragraphs: ["המידע נשמר כל עוד אתם לקוחות פעילים של האולפן, או כל עוד החוק מחייב אותנו לשמור אותו."],
  },
  {
    id: "deletion",
    title: "מחיקת מידע",
    paragraphs: [
      `אפשר לבקש למחוק את המידע שלכם בכל עת: במייל לכתובת ${PRIVACY_CONTACT_EMAIL}, או בהודעה לבוט הוואטסאפ.`,
      "נטפל בבקשה תוך 30 יום ונאשר לכם כשהמחיקה בוצעה. מידע שהחוק מחייב אותנו לשמור (למשל מסמכים חשבונאיים) יישמר רק לתקופה הנדרשת.",
    ],
  },
  {
    id: "contact",
    title: "יצירת קשר",
    paragraphs: [`לכל שאלה על המדיניות או על המידע שלכם: ${PRIVACY_CONTACT_EMAIL}`],
  },
];
