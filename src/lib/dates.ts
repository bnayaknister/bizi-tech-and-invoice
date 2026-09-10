// Today's date as "YYYY-MM-DD" in Israel time (Asia/Jerusalem), DST-aware.
//
// Why this exists (owner bug 2026-07-29): a Morning document's `date` is its
// ISSUANCE date, not the recording/job date. The studio records in one month
// and bills the next, so sending the production date made Morning reject the
// document ("התאריך שנבחר עתידי או מוקדם מדי לסוג מסמך זה"). The document date
// must always be the real day it is issued — today, in the business's own time
// zone — with the work date living only in the line description.
//
// en-CA formats as ISO (2026-07-29); the timeZone option makes it correct
// across the DST transition without any manual offset math.
export function todayInIsrael(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Which month a production belongs to, "YYYY-MM".
//
// record_date is the business truth — the day the work happened — and
// created_at only stands in when the production carries no date yet. This is
// the same anchor the accrued queue uses to decide whether a monthly client's
// month has closed; it was written inline there (documents/accrued/page.tsx)
// and is lifted here verbatim so the projects screen and the accrued queue can
// never drift into bucketing the same episode into two different months.
//
// BOTH sides are read in Israel time, and that is the whole point of the
// Intl formatter: a row created at 01:00 on the 1st is still LAST month in
// UTC, and for a monthly client that one hour decides which month it lands in.
// record_date is a plain `date` column — no time, no zone — so it is sliced as
// a string and never passed through a Date (see shortDate below for why).
const ISRAEL_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function israelMonthKey(
  recordDate: string | null | undefined,
  createdAt: string
): string {
  if (recordDate) return recordDate.slice(0, 7);
  return ISRAEL_DAY.format(new Date(createdAt)).slice(0, 7);
}

// ═══════════════════════════════════════════════════════════════════════════
// THREE DATE FORMATS LIVE IN THIS CODEBASE AND THEY DO NOT MERGE.
// (owner decision 2026-09-10, after a duplicate-scan proposed folding them.)
//
//   displayDate  "10/09/2026"  here            — OURS. every date on a SCREEN
//   shortDate    "31.07.28"    here (frozen)   — the line text WE author inside
//                                                a Morning document
//   sheetDate    "10/09/2026"  DocumentPreview — MORNING'S OWN print format,
//                                                reproduced from real PDFs
//
// ONE of them is a decision we get to make. TWO of them are anchored to the
// document world and are only allowed to change when that world changes:
//
//   shortDate is frozen because its output is already baked into documents
//   clients have received and kept (buildLineItemText -> enqueue.ts:352).
//   Restyling it would rewrite the studio's paper trail to fix a problem that
//   only ever existed on screen.
//
//   sheetDate is frozen because it is a FACSIMILE. DocumentPreview reproduces
//   what Morning prints, read off 11 real PDFs (see its own header), and the
//   bookkeeper approves an uncorrectable tax document from that page. It
//   currently renders the same shape as displayDate — that is a COINCIDENCE,
//   not a shared rule. The next screen-format change must not follow it there.
//
// The proof that sheetDate and shortDate are also not each other: BOTH appear
// on one rendered facsimile at once — Morning's issuance date in the header
// (DocumentPreview.tsx:163, slashes) and our authored work date inside the line
// description (DocumentPreview.tsx:195, dots). Different fields, different
// owners, and that is exactly how the real PDF looks.
//
// So if a scan ever reports these as duplicates, the scan is right about the
// bytes and wrong about the meaning. The question is never "do they look the
// same" — it is "who decides this format": us, or a document already in a
// client's hands, or Morning.
// ═══════════════════════════════════════════════════════════════════════════

// A stored calendar date, "YYYY-MM-DD", as the Israeli form every SCREEN shows:
// "2026-09-10" -> "10/09/2026". Four-digit year and zero-padded, so it can
// never be read as ISO and never as m/d.
//
// STRING MANIPULATION ONLY, for exactly the reason shortDate documents below —
// `new Date("2026-09-10")` is UTC midnight rendered in the runtime's zone, and
// west of Greenwich that prints the previous day. Same null contract as
// shortDate: anything that is not exactly YYYY-MM-DD yields null, so a caller
// keeps its own "—" placeholder rather than printing a mangled date.
//
// SCREENS ONLY. Never a value: not an <input type="date">, not a sort key, not
// a URL parameter, not anything sent to Morning. Those stay ISO.
export function displayDate(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? "").trim());
  if (!m) return null;
  const [, year, month, day] = m;
  return `${day}/${month}/${year}`;
}

// ───────────────────────────────────────────────────────────────────────────
// TIMESTAMPS — the OPPOSITE rule from displayDate. Read this before reaching
// for the wrong one.
//
//   displayDate      takes a `date` column ("2026-09-10")
//                    -> MUST NOT touch `new Date()`. The value has no time and
//                       no zone; giving it one invents an instant, and west of
//                       Greenwich that prints the previous day.
//
//   displayDateTime  takes a `timestamptz` ("2026-09-10T00:30:00Z")
//   displayStampDate -> MUST go through Date AND name a zone. The value IS a
//                       real instant, so "which day is it" has no answer until
//                       somebody says where. Rendered in the runtime's zone it
//                       is whatever Vercel's box happens to be (UTC), and
//                       00:30 Israel silently displays as the day before.
//
// Same destination, opposite hazards: one must not be given a zone, the other
// must not be left without one. That is why they are separate functions and
// why neither takes the other's input type.
//
// Asia/Jerusalem is the studio's own clock and is DST-aware through Intl, so
// there is no offset arithmetic here and must never be any.
//
// hourCycle 'h23' rather than hour12:false — the latter renders midnight as
// "24:00" in en-GB on some engines, which reads as a different day.
// ───────────────────────────────────────────────────────────────────────────
const ISRAEL_STAMP = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// Assembled from parts rather than printed by the locale: en-GB's own string is
// "10/09/2026, 14:30" and the owner's format has no comma (decision 2026-09-10).
// Parts also keep this immune to a locale's punctuation changing under us.
function israelStampParts(ts: string | null | undefined): Record<string, string> | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const out: Record<string, string> = {};
  for (const p of ISRAEL_STAMP.formatToParts(d)) out[p.type] = p.value;
  return out;
}

// A timestamptz as "10/09/2026 14:30", Israel time. SCREENS ONLY.
export function displayDateTime(ts: string | null | undefined): string | null {
  const p = israelStampParts(ts);
  if (!p) return null;
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

// The DAY a timestamptz falls on in Israel, "10/09/2026" — for the few places
// that deliberately show a date without a time. Not displayDate: the input is
// an instant, not a date column. SCREENS ONLY.
export function displayStampDate(ts: string | null | undefined): string | null {
  const p = israelStampParts(ts);
  if (!p) return null;
  return `${p.day}/${p.month}/${p.year}`;
}

// ───────────────────────────────────────────────────────────────────────────
// YEAR-LESS forms, for the two lists that are genuinely too dense for it
// (owner decision 2026-09-10). Slashes and zero-padding like everything else —
// only the year is dropped. Do NOT reach for these to save space in a table:
// a bare "10/09" is only safe where something else on the row already answers
// "how long ago", which is true in exactly the two places that call them.
// ───────────────────────────────────────────────────────────────────────────

// "10/09" from EITHER a date column or a timestamptz.
//
// Tolerant of both ON PURPOSE, and this is the only formatter here that is.
// The radar's dormant-client list mixes them in one array: `production` comes
// from productions.record_date (a `date`), while `document`, `payment` and
// `event` come from issued_at / created_at (`timestamptz`) — see
// modules/radar/alerts.ts:342-358. One list, two column types, one line of UI.
//
// So it dispatches on shape rather than trusting the caller: an exact
// YYYY-MM-DD is sliced as a string and never given a zone, anything else is an
// instant and is read in Israel time. Both traps handled, neither guessed. The
// local helper this replaces ran every value through `new Date()`, which is
// the documented trap above — on a UTC-behind runtime the record_date arm
// printed the previous day.
export function displayDayMonth(value: string | null | undefined): string | null {
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? "").trim());
  if (plain) return `${plain[3]}/${plain[2]}`;
  const p = israelStampParts(value);
  if (!p) return null;
  return `${p.day}/${p.month}`;
}

// "10/09 · 14:30" — a timestamptz in the drawer's event log, where rows are
// dense and every entry is recent enough that the year says nothing.
export function displayLogTime(ts: string | null | undefined): string | null {
  const p = israelStampParts(ts);
  if (!p) return null;
  return `${p.day}/${p.month} · ${p.hour}:${p.minute}`;
}

// A stored calendar date, "YYYY-MM-DD", as the short form a client reads on a
// document line: "2028-07-31" -> "31.07.28".
//
// FROZEN — see the block above. This is document text, not screen text.
//
// STRING MANIPULATION, DELIBERATELY. Not `new Date(s)` and not Intl. Those
// parse "2028-07-31" as UTC midnight and then render it in the runtime's zone,
// which west of Greenwich prints the PREVIOUS DAY — a recording date silently
// off by one on an invoice the client keeps. That is the same class of bug as
// the one above; the difference is that this value is a plain `date` column,
// carries no time and no zone, and therefore must never be given one.
//
// Returns null rather than throwing or half-formatting: null, empty, or
// anything that is not exactly YYYY-MM-DD yields no date at all. A line with a
// missing date reads fine; a line with a mangled one does not.
export function shortDate(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? "").trim());
  if (!m) return null;
  const [, year, month, day] = m;
  return `${day}.${month}.${year.slice(2)}`;
}
