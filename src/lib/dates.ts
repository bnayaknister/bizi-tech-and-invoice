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

// A stored calendar date, "YYYY-MM-DD", as the short form a client reads on a
// document line: "2028-07-31" -> "31.07.28".
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
