import { validateDuration, type BookingDuration } from "@/lib/booking/duration";
import { validateStudio, type BookableRoom } from "@/lib/booking/request";
import { STUDIOS } from "@/lib/calendar/studios";
import { addIsraelDays } from "@/lib/calendar/availability";
import { weekdayOf } from "@/app/calendar/availability/booking";

// ═══════════════════════════════════════════════════════════════════════════
// E14 — the free-language layer's PARSER. PURE: no fetch, no clock read
// (`todayIsrael` is a parameter), no env.
// ═══════════════════════════════════════════════════════════════════════════
//
// 🔴 THE OWNER'S RULE FOR THIS LAYER (TICKETS.md, E14): IT IS SHARP. A
// request that was not parsed with certainty is NOT executed — the bot asks,
// or stays on the current step. So every function here returns null for
// "not understood", and anything recognised-but-ambiguous is named in
// `dropped` so the bot can SAY it did not use it, instead of silently
// narrowing the client's words into a wrong certainty.
//
// Two parsers, one per step the layer serves (owner, 16.10):
//   parseAvailabilityText — at the MENU: "תגיד לי מה פנוי שבוע הבא בין יום
//                           ראשון לרביעי אחרי השעה אחת בצהריים, חדר החשמונאים"
//   parseEditText         — at the SUMMARY: "אורח: יהודה לוי", "3 שעות",
//                           "יום רביעי", "15:00" — edits BEFORE the client
//                           confirms. Nothing here ever confirms a booking;
//                           the "✅ לקבוע" button stays the only way in.

/** What the menu parser understood. Any field may be absent — see the rule above. */
export type ParsedAvailability = {
  studio: BookableRoom | null;
  duration: BookingDuration | null;
  /** YYYY-MM-DD (Israel), inclusive. dateTo === dateFrom for a single day. */
  dateFrom: string | null;
  dateTo: string | null;
  /** HH:MM — only starts at/after this time are offered. */
  timeFrom: string | null;
  /** HH:MM — only starts before this time are offered. */
  timeTo: string | null;
  /** recognised-but-ambiguous fragments the parse deliberately did NOT use */
  dropped: string[];
};

export type ParsedEdit =
  | { field: "guest"; value: string; alsoConfirm: boolean }
  | { field: "note"; value: string; alsoConfirm: boolean }
  | { field: "duration"; minutes: BookingDuration; alsoConfirm: boolean }
  | { field: "studio"; studio: BookableRoom; alsoConfirm: boolean }
  | { field: "day"; date: string; alsoConfirm: boolean }
  /** the client named a start time: re-offer that day's hours from it up */
  | { field: "time-from"; hhmm: string; alsoConfirm: boolean }
  /** E14-2b: an EXACT start ("ב-10", "בשעה 10", "15:00") — kept if free, else that day's hours */
  | { field: "time-at"; hhmm: string; alsoConfirm: boolean }
  /** E14-2c: "החדר הקבוע שלי" / "האולפן הרגיל" — the show's default room, resolved by the machine */
  | { field: "studio-default"; alsoConfirm: boolean }
  /** "כן" / "מאשר" with no edit: confirmation stays with the button */
  | { field: "confirm-hint" };

// ─── shared pieces ─────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, "0");

/** every weekday word, for the range regexes below */
const WEEKDAY_TOKEN = "ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת";

/** 0 = Sunday … 6 = Saturday. "יום" optional; one-word forms only. */
const WEEKDAY_WORDS: [RegExp, number][] = [
  [/ראשון/, 0],
  [/שני/, 1],
  [/שלישי/, 2],
  [/רביעי/, 3],
  [/חמישי/, 4],
  [/שישי/, 5],
  [/שבת/, 6],
];

/** The date of the next occurrence of `target` (0=Sunday) ON OR AFTER `fromIsrael`. */
export function nextWeekday(fromIsrael: string, target: number): string {
  const wd = weekdayOf(fromIsrael);
  return addIsraelDays(fromIsrael, (target - wd + 7) % 7);
}

/** The date of the next occurrence of `target` STRICTLY AFTER `fromIsrael`. */
export function comingWeekday(fromIsrael: string, target: number): string {
  const wd = weekdayOf(fromIsrael);
  return addIsraelDays(fromIsrael, ((target - wd + 6) % 7) + 1);
}

/** dd.mm / dd.mm.yy / dd.mm.yyyy / dd/mm — a real date or null. Year defaults to today's. */
function parseExplicitDate(text: string, todayIsrael: string): string | null {
  const m = /(?<!\d)(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?!\d)/.exec(text);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let y = m[3] ? Number(m[3]) : Number(todayIsrael.slice(0, 4));
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${pad2(mo)}-${pad2(d)}`;
  // a real calendar day? (2026-02-31 must not parse)
  if (weekdayOf(iso) === -1) return null;
  const back = new Date(Date.UTC(y, mo - 1, d));
  if (back.getUTCMonth() !== mo - 1) return null;
  return iso;
}

/**
 * "אחת בצהריים" -> 13, "9 בערב" -> 21, "בוקר" as-is. WITHOUT a daypart only
 * 7-23 are certain (studio hours are daytime; 1-6 bare is morning or
 * afternoon — exactly the guess the sharpness rule forbids), so those return
 * null and the caller names the fragment in `dropped`.
 */
function resolveHour(h: number, daypart: string | null): number | null {
  if (h < 1 || h > 24) return null;
  if (daypart) {
    if (/בוקר/.test(daypart)) return h < 12 ? h : null;
    // צהריים/ערב/לילה: 12 stays 12, 1-11 go up
    return h === 12 ? 12 : h + 12 <= 23 ? h + 12 : null;
  }
  return h >= 7 && h <= 23 ? h : null;
}

const DAYPART_WORDS = "בצהריים|בערב|בבוקר|בלילה";

/** Clients write hours as digits ("13:00", "1") and as words ("אחת בצהריים"). */
const HOUR_WORDS: Record<string, number> = {
  "אחת": 1,
  "אחד": 1,
  "שתיים": 2,
  "שניים": 2,
  "שלוש": 3,
  "ארבע": 4,
  "חמש": 5,
  "שש": 6,
  "שבע": 7,
  "שמונה": 8,
  "תשע": 9,
  "עשר": 10,
  "אחת עשרה": 11,
  "אחד עשר": 11,
  "שתים עשרה": 12,
};

/** longest first, so "אחת עשרה" is tried before "אחת" */
const HOUR_TOKEN = "\\d{1,2}(?::\\d{2})?|אחת עשרה|אחד עשר|שתים עשרה|אחת|אחד|שתיים|שניים|שלוש|ארבע|חמש|שש|שבע|שמונה|תשע|עשר";
const HOUR_FRAG = `(?:${HOUR_TOKEN})(?:\\s*(?:${DAYPART_WORDS}))?`;

/** One hour fragment, e.g. "אחת בצהריים" -> 13:00. */
function hourPhrase(frag: string): { hhmm: string; ambiguous: boolean; options?: string[] } | null {
  const m = new RegExp(`^(${HOUR_TOKEN})\\s*(${DAYPART_WORDS})?$`).exec(frag.trim());
  if (!m) return null;
  const tok = m[1];
  let h: number;
  let minutes = "00";
  const dm = /^(\d{1,2})(?::(\d{2}))?$/.exec(tok);
  if (dm) {
    h = Number(dm[1]);
    minutes = dm[2] ?? "00";
  } else {
    h = HOUR_WORDS[tok] ?? 0;
  }
  if (Number(minutes) > 59) return null;
  const resolved = resolveHour(h, m[2] ?? null);
  if (resolved === null) {
    // a daypart with an impossible hour is not an hour at all
    if (m[2] || h < 1 || h > 24) return null;
    // E14-2b: both readings, so a step that SHOWS hours can match its list
    return { hhmm: "", ambiguous: true, options: [`${pad2(h)}:${minutes}`, `${pad2(h + 12)}:${minutes}`] };
  }
  return { hhmm: `${pad2(resolved)}:${minutes}`, ambiguous: false };
}

/**
 * Every bookable room named in the text, canonical names, longest variant
 * first so "גבעון גדול" wins over "גבעון" (the same ordering rule the
 * calendar parser lives by). Two DIFFERENT rooms in one message -> null:
 * "גבעון או חשמונאים" is a question the bot must ask, not a pick.
 */
function studiosIn(text: string): { studio: BookableRoom | null; ambiguous: boolean } {
  const variants: { variant: string; canonical: string }[] = [];
  for (const s of STUDIOS) {
    if (!s.bookable) continue;
    for (const v of s.variants) variants.push({ variant: v, canonical: s.canonical });
  }
  variants.sort((a, b) => b.variant.length - a.variant.length);
  // longest variant first, and a matched span is REMOVED before the next
  // variant is tried — otherwise "גבעון גדול" also matches bare "גבעון" and
  // every large-room request reads as two different rooms (an ambiguity)
  let work = text;
  const found = new Set<string>();
  for (const { variant, canonical } of variants) {
    // [ובהלמשכ]? — the one-letter prefixes attach with no space ("בחשמונאים")
    const re = new RegExp(`(?<![\\p{L}'])[ובהלמשכ]?${variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}'])`, "u");
    if (re.test(work)) {
      found.add(canonical);
      work = work.replace(re, " ");
    }
  }
  if (found.size === 1) {
    const only = validateStudio(Array.from(found)[0]);
    return { studio: only, ambiguous: false };
  }
  if (found.size > 1) return { studio: null, ambiguous: true };
  return { studio: null, ambiguous: false };
}

/** "שעה וחצי" / "3 שעות" / "פרק כפול" / "90 דקות" -> one of the three, or null. */
function durationIn(text: string): BookingDuration | null {
  const t = text.replace(/\s+/g, " ");
  if (/שעה\s+וחצי|שעתיים\s+וחצי/.test(t)) return 90;
  if (/פרק\s+כפול/.test(t)) return 180;
  const m = /(\d)\s*שעות/.exec(t);
  if (m) {
    const mins = Number(m[1]) * 60;
    const d = validateDuration(mins);
    if (d === mins) return d;
    return null;
  }
  if (/שלוש\s+שעות/.test(t)) return 180;
  if (/ארבע\s+שעות/.test(t)) return 240;
  const mins = /(\d{2,3})\s*דקות/.exec(t);
  if (mins) {
    const d = validateDuration(Number(mins[1]));
    if (d === Number(mins[1])) return d;
  }
  return null;
}

// ─── the menu parser ───────────────────────────────────────────────────────

/**
 * Free text at the MENU -> the constraints it certainly carries, or null
 * when nothing was understood (the machine then re-sends the menu, exactly
 * as today).
 *
 * Returning an object with all-null constraints is impossible BY
 * CONSTRUCTION: at least one certain constraint is required, or the result
 * is null. `dropped` never blocks by itself — it is reported, not acted on.
 */
export function parseAvailabilityText(raw: string, todayIsrael: string): ParsedAvailability | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text === "") return null;
  const dropped: string[] = [];

  let dateFrom: string | null = null;
  let dateTo: string | null = null;
  let work = text; // the text minus the consumed day-range span
  let dayRange: RegExpExecArray | null = null;

  // ── explicit date wins over every relative word ──
  const explicit = parseExplicitDate(text, todayIsrael);
  if (explicit) {
    dateFrom = explicit;
    dateTo = explicit;
  } else {
    // ── week anchors ──
    const nextWeek = /שבוע\s+הבא/.test(text);
    const thisWeek = !nextWeek && /השבוע/.test(text);

    // ── a day range: "בין יום ראשון לרביעי" / "מראשון עד רביעי" / "ראשון עד
    // רביעי" — "יום" and "בין/מ" are optional; BOTH endpoints must be weekday
    // words or this is not a day range at all. The consumed span is removed
    // from `work` so nothing below reads it twice. ──
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;
    dayRange = new RegExp(
      `(?<![\\p{L}'])(?:בין\\s+|מ-?\\s*)?(?:יום\\s+)?(${WEEKDAY_TOKEN})(?![\\p{L}'])\\s+(?:ל|עד)-?\\s*(?:יום\\s+)?(${WEEKDAY_TOKEN})(?![\\p{L}'])`,
      "u"
    ).exec(text);
    if (dayRange) {
      const dr = dayRange; // a const, so the find callbacks keep the narrowing
      rangeFrom = WEEKDAY_WORDS.find(([re]) => re.test(dr[1]))?.[1] ?? null;
      rangeTo = WEEKDAY_WORDS.find(([re]) => re.test(dr[2]))?.[1] ?? null;
      work = (text.slice(0, dr.index) + " " + text.slice(dr.index + dr[0].length)).replace(/\s+/g, " ");
    }

    if (rangeFrom !== null && rangeTo !== null) {
      const anchor = nextWeek ? comingWeekday(todayIsrael, 0) : nextWeekday(todayIsrael, rangeFrom);
      dateFrom = addIsraelDays(anchor, 0);
      dateTo = addIsraelDays(anchor, (rangeTo - rangeFrom + 7) % 7);
    } else if (nextWeek) {
      dateFrom = comingWeekday(todayIsrael, 0);
      dateTo = addIsraelDays(dateFrom, 4); // Sunday..Thursday — the booking week
    } else if (thisWeek) {
      const wd = weekdayOf(todayIsrael);
      if (wd <= 4) {
        dateFrom = todayIsrael;
        dateTo = addIsraelDays(todayIsrael, 4 - wd);
      } else {
        // Friday/Saturday: "השבוע" has no bookable days left — too easy to
        // misunderstand as "next week", so it is asked, not assumed
        dropped.push("השבוע");
      }
    } else if (/מחרתיים/.test(work)) {
      dateFrom = dateTo = addIsraelDays(todayIsrael, 2);
    } else if (/מחר/.test(work)) {
      dateFrom = dateTo = addIsraelDays(todayIsrael, 1);
    } else if (/היום/.test(work)) {
      dateFrom = dateTo = todayIsrael; // the window itself refuses today
    } else {
      // one weekday word: "ביום רביעי" -> the coming Wednesday
      for (const [re, wd] of WEEKDAY_WORDS) {
        if (new RegExp(`(?:יום|ב|-)\\s*${re.source}`).test(work) || new RegExp(`^${re.source}`).test(work)) {
          dateFrom = dateTo = comingWeekday(todayIsrael, wd);
          break;
        }
      }
    }
  }

  // ── a date constraint that was NOT used is SAID, never silently ignored:
  // "מחר עד רביעי" takes מחר and names the "עד רביעי" it did not apply ──
  if (!dayRange) {
    const leftover = new RegExp(`(?:ל|עד)-?\\s*(?:יום\\s+)?(${WEEKDAY_TOKEN})(?![\\p{L}'])`, "u").exec(work);
    if (leftover && !dropped.includes(leftover[0].trim())) dropped.push(leftover[0].trim());
  }

  // ── times ──
  let timeFrom: string | null = null;
  let timeTo: string | null = null;
  // a range first: "בין 9:00 ל-10:00" / "מ-9 בבוקר עד 5 בערב" — each endpoint
  // must itself be certain, or that endpoint is named in `dropped`
  const trange = new RegExp(`(?:בין\\s*|מ-?\\s*)(?:השע(?:ה|ות)\\s+)?(${HOUR_FRAG})\\s+(?:ל|עד)-?\\s*(?:השעה\\s+)?(${HOUR_FRAG})`).exec(text);
  if (trange) {
    const from = hourPhrase(trange[1]);
    const to = hourPhrase(trange[2]);
    if (from && !from.ambiguous) timeFrom = from.hhmm;
    else dropped.push(`השעה "${trange[1].trim()}"`);
    if (to && !to.ambiguous) timeTo = to.hhmm;
    else dropped.push(`השעה "${trange[2].trim()}"`);
  }
  const after = new RegExp(`אחרי\\s+(?:השעה\\s+)?(${HOUR_FRAG})`).exec(text);
  if (after && !trange) {
    const p = hourPhrase(after[1]);
    if (p?.ambiguous || !p) dropped.push(`השעה "${after[1].trim()}"`);
    else timeFrom = p.hhmm;
  }
  const before = new RegExp(`לפני\\s+(?:השעה\\s+)?(${HOUR_FRAG})`).exec(text);
  if (before && !trange) {
    const p = hourPhrase(before[1]);
    if (p?.ambiguous || !p) dropped.push(`השעה "${before[1].trim()}"`);
    else timeTo = p.hhmm;
  }

  // ── room and length ──
  const rooms = studiosIn(text);
  if (rooms.ambiguous) dropped.push("האולפן");
  const duration = durationIn(text);

  // `dropped` alone is enough to answer: an all-null query offers the plain
  // list (no constraint invented) while SAYING what was not understood
  if (!rooms.studio && !dateFrom && !timeFrom && !timeTo && !duration && dropped.length === 0) return null;
  return { studio: rooms.studio, duration, dateFrom, dateTo, timeFrom, timeTo, dropped };
}

// ─── the summary parser ────────────────────────────────────────────────────

const CONFIRM_WORD_RE = /(^|\s)(כן|מאשר|לאשר|אשר|סבבה|מעולה|בסדר\s+גמור|יופי)([.,!]?)(\s|$)/;

/** What the summary parser made of one message: EVERY certain edit, and every
 *  fragment it recognised but could not be certain of. Nothing is silently
 *  dropped — `dropped` is said out loud by the machine. */
export type ParsedEditSet = {
  edits: ParsedEdit[];
  dropped: string[];
  /**
   * E14-2b (owner, 21.10): an exact start that is not certain ("ב-4": 04:00 or
   * 16:00?). Still named in `dropped`; the HOUR step resolves it against the
   * hours it shows — one match is taken, none or both are asked.
   */
  maybe?: { label: string; options: string[] }[];
};

/** Every duration value stated, distinct. Two different ones -> the caller asks. */
function durationsIn(text: string): BookingDuration[] {
  const out = new Set<BookingDuration>();
  if (/שעה\s+וחצי|שעתיים\s+וחצי/.test(text)) out.add(90);
  if (/פרק\s+כפול/.test(text)) out.add(180);
  if (/שלוש\s+שעות/.test(text)) out.add(180);
  if (/ארבע\s+שעות/.test(text)) out.add(240);
  for (const m of Array.from(text.matchAll(/(\d)\s*שעות/g))) {
    const d = validateDuration(Number(m[1]) * 60);
    if (d === Number(m[1]) * 60) out.add(d);
  }
  for (const m of Array.from(text.matchAll(/(\d{2,3})\s*דקות/g))) {
    const d = validateDuration(Number(m[1]));
    if (d === Number(m[1])) out.add(d);
  }
  return Array.from(out);
}

/** Every date stated (explicit dd.mm wins; otherwise weekday words / מחר), distinct. */
function daysIn(text: string, todayIsrael: string): string[] {
  const out = new Set<string>();
  let explicit = false;
  for (const m of Array.from(text.matchAll(/(?<!\d)(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?!\d)/g))) {
    const d = parseExplicitDate(m[0], todayIsrael);
    if (d) {
      explicit = true;
      out.add(d);
    }
  }
  if (!explicit) {
    for (const [re, wd] of WEEKDAY_WORDS) {
      if (new RegExp(`יום\\s+${re.source}`).test(text)) out.add(comingWeekday(todayIsrael, wd));
    }
    if (/מחרתיים/.test(text)) out.add(addIsraelDays(todayIsrael, 2));
    else if (/מחר/.test(text)) out.add(addIsraelDays(todayIsrael, 1));
  }
  return Array.from(out);
}

/**
 * Every time stated. E14-2b (owner, 20.10): "אחרי 10" is a FROM (re-offer the
 * hours from it); "ב-10", "בשעה 10", "לשעה 10" and a bare "15:00" are an EXACT
 * start. A time that is not certain ("ב-4" — morning or afternoon?) is never
 * guessed: it is named in `vague`, and the bot says so.
 */
function timesIn(text: string): {
  certain: string[];
  at: string[];
  vague: string[];
  maybe: { label: string; options: string[] }[];
} {
  const certain = new Set<string>();
  const at = new Set<string>();
  const vague: string[] = [];
  const maybe: { label: string; options: string[] }[] = [];
  const seen = new Set<string>();
  const say = (frag: string, shown = frag.trim()) => {
    const label = `השעה "${shown}"`;
    if (!seen.has(shown)) {
      seen.add(shown);
      vague.push(label);
    }
    return label;
  };
  // a date like "ב-21.10" is not a time, and "בשבוע" is not "בשבע": the frag
  // may not run into ".10" / "/10", a digit, or another letter
  const END = "(?![\\d\\p{L}]|[./]\\d)";
  const consumed: [number, number][] = [];
  for (const m of Array.from(text.matchAll(new RegExp(`אחרי\\s*(?:השעה\\s+)?(${HOUR_FRAG})${END}`, "gu")))) {
    consumed.push([m.index, m.index + m[0].length]);
    const p = hourPhrase(m[1]);
    if (p && !p.ambiguous) certain.add(p.hhmm);
    else say(m[1]);
  }
  // E14-2b (owner, 21.10): "ב3", "ב 3", "ב-3", "בשעה 3" are the same. A bare
  // "ב" before a WORD ("בשלוש") is read only at the hour step (parseStepText):
  // anywhere else "בשלוש מצלמות" is a note, not a time.
  for (const m of Array.from(text.matchAll(new RegExp(`(?<![\\p{L}])(?:(?:בשעה|לשעה|ב-|ל-)\\s*(?:השעה\\s+)?(${HOUR_FRAG})|ב\\s*(\\d{1,2}(?::\\d{2})?(?:\\s*(?:${DAYPART_WORDS}))?))${END}`, "gu")))) {
    if (consumed.some(([a, b]) => m.index >= a && m.index < b)) continue;
    consumed.push([m.index, m.index + m[0].length]);
    const frag = m[1] ?? m[2];
    const p = hourPhrase(frag);
    if (p && !p.ambiguous) at.add(p.hhmm);
    else {
      const label = say(frag);
      if (p?.options && !maybe.some((x) => x.label === label)) maybe.push({ label, options: p.options });
    }
  }
  // "עד 11" / "עד 11:00" asks for an END time, which an edit does not
  // support — always named vague, and shielded from the colon scan below
  for (const m of Array.from(text.matchAll(new RegExp(`עד\\s+(?:השעה\\s+)?(${HOUR_FRAG})`, "g")))) {
    consumed.push([m.index, m.index + m[0].length]);
    say(m[1], `עד ${m[1].trim()}`);
  }
  for (const m of Array.from(text.matchAll(/(?<![\d.\/])(\d{1,2}:\d{2})(?!\d)/g))) {
    if (consumed.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const p = hourPhrase(m[1]);
    if (p && !p.ambiguous) at.add(p.hhmm);
    else if (p?.options) {
      const label = say(m[1]);
      if (!maybe.some((x) => x.label === label)) maybe.push({ label, options: p.options });
    }
  }
  return { certain: Array.from(certain), at: Array.from(at), vague, maybe };
}

/**
 * A guest/note value runs to the end of the message, so a following clause
 * belongs to it unless another FIELD clearly starts there. Cut at the first
 * comma that starts one ("אורח: יהודה, וגם 3 שעות" -> "יהודה"); a note's own
 * comma ("שלוש מצלמות, תאורה דרמטית") stays, because no field follows it.
 */
function cutValueAtFieldBoundary(value: string, todayIsrael: string): string {
  const clause = /[,،]\s*(?:וגם\s+)?(?:הערה|הערות|אורח|אורחת|בקשה|בקשות|אולפן|חדר|שעה|משך|אורך|יום|תאריך)\s*:/.exec(value);
  if (clause) return value.slice(0, clause.index).trim();
  const comma = /[,،]| וגם /.exec(value);
  if (comma) {
    const tail = value.slice(comma.index);
    const tailTimes = timesIn(tail);
    const fieldFollows =
      durationsIn(tail).length > 0 ||
      studiosIn(tail).studio !== null ||
      daysIn(tail, todayIsrael).length > 0 ||
      tailTimes.certain.length > 0 ||
      tailTimes.at.length > 0 ||
      tailTimes.vague.length > 0;
    if (fieldFollows) return value.slice(0, comma.index).trim();
  }
  // E14-2b: "עם אורח דני ביום ראשון ב-10" — no comma, but a day or a time
  // clearly starts there. Cut only where the tail really parses as one.
  const clause2 = new RegExp("\\s(?=(?:ביום|יום|בשעה|לשעה|מחר|מחרתיים|אחרי|ב-?\\d|ל-\\d))", "g");
  for (const m of Array.from(value.matchAll(clause2))) {
    const tail = value.slice(m.index);
    const tt = timesIn(tail);
    if (daysIn(tail, todayIsrael).length > 0 || tt.certain.length > 0 || tt.at.length > 0 || tt.vague.length > 0) {
      return value.slice(0, m.index).trim();
    }
  }
  return value.trim();
}

/**
 * Free text at the SUMMARY -> EVERY certain edit, or null (the machine then
 * asks what to change — it never guesses, and it never confirms from text).
 *
 * Several non-conflicting edits in one message are ALL returned ("אורח:
 * יהודה, וגם 3 שעות" is a guest AND a length). Two values for the SAME field
 * ("יום רביעי או יום חמישי") are a question, not a pick: that field lands in
 * `dropped`. A message mixing approval with edits ("מאשר, ותוסיף אורח יהודה")
 * returns the edits with alsoConfirm — the machine applies the edits and says
 * that confirmation itself stays with the button.
 */
export function parseEditText(raw: string, todayIsrael: string): ParsedEditSet | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text === "") return null;
  const alsoConfirm = CONFIRM_WORD_RE.test(text);
  const edits: ParsedEdit[] = [];
  const dropped: string[] = [];

  // ── "שדה: ערך" / verb clauses for the two free-value fields ──
  const guest =
    /^(?:אורח|אורחת|האורח|האורחת|שם\s+האורח)\s*[:\-–]?\s*(.+)$/.exec(text) ??
    /(?:^|\s)(?:אורח|אורחת)\s*:\s*(.+)$/.exec(text) ??
    /(?:^|\s)ו?(?:להוסיף|תוסיף|תוסיפי|להזמין)\s+(?:אורח|אורחת)\s*[:\-–]?\s*(.+)$/.exec(text) ??
    // E14-2b: "בעצם ביום ראשון ב-10 עם אורח דני"
    /(?:^|\s)עם\s+(?:ה)?(?:אורח|אורחת)\s*[:\-–]?\s*(.+)$/.exec(text);
  if (guest) edits.push({ field: "guest", value: cutValueAtFieldBoundary(guest[1], todayIsrael), alsoConfirm });
  const note =
    /^(?:הערה|הערות|בקשה|בקשות)\s*[:\-–]?\s*(.+)$/.exec(text) ??
    /(?:^|\s)(?:הערה|הערות)\s*:\s*(.+)$/.exec(text) ??
    /(?:^|\s)ו?(?:להוסיף|תוסיף|תוסיפי)\s+(?:הערה|הערות|בקשה)\s*[:\-–]?\s*(.+)$/.exec(text);
  if (note) edits.push({ field: "note", value: cutValueAtFieldBoundary(note[1], todayIsrael), alsoConfirm });

  // ── the slot fields: one value each, or that field is asked about ──
  const durs = durationsIn(text);
  if (durs.length === 1) edits.push({ field: "duration", minutes: durs[0], alsoConfirm });
  else if (durs.length > 1) dropped.push("משך ההקלטה");

  const rooms = studiosIn(text);
  if (rooms.studio) edits.push({ field: "studio", studio: rooms.studio, alsoConfirm });
  if (rooms.ambiguous) dropped.push("האולפן");

  const days = daysIn(text, todayIsrael);
  if (days.length === 1) edits.push({ field: "day", date: days[0], alsoConfirm });
  else if (days.length > 1) dropped.push("היום");

  const times = timesIn(text);
  dropped.push(...times.vague);
  // an exact start wins over a "from"; two different values of either = asked
  if (times.at.length === 1 && times.certain.length === 0) edits.push({ field: "time-at", hhmm: times.at[0], alsoConfirm });
  else if (times.at.length === 0 && times.certain.length === 1) edits.push({ field: "time-from", hhmm: times.certain[0], alsoConfirm });
  else if (times.at.length + times.certain.length > 1) dropped.push("השעה");

  if (edits.length === 0 && dropped.length === 0) {
    return alsoConfirm ? { edits: [{ field: "confirm-hint" }], dropped: [] } : null;
  }
  return times.maybe.length ? { edits, dropped, maybe: times.maybe } : { edits, dropped };
}

// ─── E14-2b: free text at every choice step ────────────────────────────────

/** The steps where a typed answer is read by the layer (the menu and the summary have their own). */
export type ChoiceStep = "duration" | "studio-default" | "studio" | "day" | "hour" | "guest" | "note";

const CHANGE_MARKER_RE = new RegExp("^\\s*(?:בעצם|תשנה|תשני|לשנות)(?![\\p{L}])\\s*[,:]?\\s*", "u");
const FIELD_LABEL_RE = new RegExp("(?:^|\\s)(?:אורח|אורחת|הערה|הערות)\\s*:", "u");
const POLITE_RE = new RegExp("(?<![\\p{L}])(?:בבקשה|תודה|רבה)(?![\\p{L}])", "gu");

/**
 * At the guest and note steps any text is the VALUE (owner, 20.10) — unless it
 * says it is a change: it opens with "בעצם" / "תשנה" / "לשנות", or names a
 * field ("אורח:", "הערה:").
 */
export function hasChangeMarker(raw: string): boolean {
  return CHANGE_MARKER_RE.test(raw) || FIELD_LABEL_RE.test(raw);
}

const DAY_PHRASE_RE = new RegExp(`(?<![\\p{L}])ב?יום\\s+(?:${WEEKDAY_TOKEN})(?![\\p{L}])`, "u");
const EXPLICIT_DATE_RE = /(?<!\d)\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?(?!\d)/;
const TIME_PHRASE_RE = new RegExp(`(?<![\\p{L}])(?:(?:בשעה|לשעה)\\s*(?:${HOUR_TOKEN})|ב-?\\s*\\d)`, "u");

/**
 * Owner, 21.10 — at the GUEST step a day or time PHRASE is a change even
 * without "בעצם": "ביום שני" / "יום שני" / "26.10" / "בשעה 10" / "ב-10". A
 * single word ("שני", "ראשון") or a bare "10" stays the guest's name. The
 * note step keeps the marker-only rule: a note may well mention a day.
 */
export function isSlotPhrase(raw: string): boolean {
  return DAY_PHRASE_RE.test(raw) || EXPLICIT_DATE_RE.test(raw) || TIME_PHRASE_RE.test(raw);
}

/**
 * Free text at a choice step -> every certain edit, or null (the step is sent
 * again, exactly as today). The summary parser does the work; the step only
 * adds what a bare answer means THERE (owner, 20.10):
 *   duration — "3" / "שלוש" / "4" / "ארבע" are hours, only here
 *   hour     — "10" / "10:30" / "עשר" is an exact start; "4" is not certain
 * A "כן"/"מאשר" alone is not a choice: null. Confirming stays a button.
 */
export function parseStepText(raw: string, todayIsrael: string, step: ChoiceStep): ParsedEditSet | null {
  const text = raw.replace(CHANGE_MARKER_RE, "").replace(POLITE_RE, " ").replace(/[!?.]+$/, "").replace(/\s+/g, " ").trim();
  if (text === "") return null;

  if (step === "duration") {
    const bare = /^(?:(3|4|שלוש|ארבע)(?:\s*שעות)?|(שעה\s+וחצי|1\.5))$/.exec(text);
    if (bare) {
      const minutes = bare[2] ? 90 : bare[1] === "3" || bare[1] === "שלוש" ? 180 : 240;
      const d = validateDuration(minutes);
      if (d === minutes) return { edits: [{ field: "duration", minutes: d, alsoConfirm: false }], dropped: [] };
    }
  }
  if (step === "hour") {
    // owner, 21.10: "10", "ב10", "ב 10", "ב-10", "בעשר", "בשעה עשר" — one answer
    const bare = text.replace(/^(?:בשעה|לשעה|ב-?|ל-)\s*(?:השעה\s+)?/, "");
    const p = new RegExp(`^(${HOUR_TOKEN})(?:\\s*(${DAYPART_WORDS}))?$`).test(bare) ? hourPhrase(bare) : null;
    if (p && !p.ambiguous) return { edits: [{ field: "time-at", hhmm: p.hhmm, alsoConfirm: false }], dropped: [] };
    if (p && p.ambiguous) {
      const label = `השעה "${bare}"`;
      return { edits: [], dropped: [label], ...(p.options ? { maybe: [{ label, options: p.options }] } : {}) };
    }
  }

  const parsed = parseEditText(text, todayIsrael);
  if (!parsed) return null;
  const edits = parsed.edits.filter((e) => e.field !== "confirm-hint");
  if (edits.length === 0 && parsed.dropped.length === 0) return null;
  return parsed.maybe ? { edits, dropped: parsed.dropped, maybe: parsed.maybe } : { edits, dropped: parsed.dropped };
}
