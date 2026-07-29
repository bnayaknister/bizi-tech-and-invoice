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
