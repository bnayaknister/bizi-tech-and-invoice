"use client";

import { useMemo, useState } from "react";
import { shortDate } from "@/lib/dates";
import { DOC_TYPES, DOC_TYPE_LABEL } from "@/lib/documents/forProduction";

export type ProjectDoc = {
  type: number;
  number: string | null;
  date: string | null;
  shared: boolean;
  cancelled: boolean;
  path: string;
};

/** Why a row carries no per-episode price. Defined here so the row cell and the
 *  summary answer with the same vocabulary — see classify() in page.tsx. */
export type BillingClass = "priced" | "contract" | "no_billing" | "inactive" | "missing_rate";

export type ProjectRow = {
  id: string;
  billing: BillingClass;
  /** Which contract a contract-billed episode sits under; null when the client
   *  has more than one active contract and naming one would be a guess. */
  contract_name: string | null;
  record_date: string | null;
  podcast_name: string;
  show_name: string | null;
  client_name: string | null;
  guest: string | null;
  status: string;
  episode_no: number | null;
  internal: boolean;
  cancelled: boolean;
  price: number | null;
  docs: ProjectDoc[];
};

export type MonthBucket = {
  key: string;
  label: string;
  rows: ProjectRow[];
  summary: {
    expected: number;
    expectedPriced: number;
    expectedPerEpisode: number;
    expectedTotalRows: number;
    missingRateCount: number;
    missingRateShows: string[];
    contractCount: number;
    contractItems: { show: string; contract: string | null }[];
    inactiveCount: number;
    inactiveShows: string[];
    noBillingCount: number;
    billed: number;
    billedCount: number;
    incoming: number;
    incomingCount: number;
  };
};

const money = (n: number | null) =>
  n == null ? "—" : `₪${Math.round(n).toLocaleString("he-IL")}`;

// the enum stores spaces as underscores ('אושר_ע"י_לקוח')
const statusLabel = (s: string) => s.replace(/_/g, " ");

const NO_PRICE_LABEL: Record<BillingClass, string> = {
  priced: "—",
  contract: "לפי חוזה",
  no_billing: "חיוב מושתק",
  inactive: "תוכנית לא פעילה",
  missing_rate: "חסר תעריף",
};

const NO_PRICE_NOTE: Record<BillingClass, string> = {
  priced: "",
  contract: "התוכנית מחויבת באבני דרך של חוזה, לא פר-פרק — הכסף נספר דרך אבן הדרך",
  no_billing: "חיוב התוכנית מושתק (billing_mode = none)",
  inactive: "התוכנית אינה פעילה, ולכן אינה אמורה לשאת תעריף",
  missing_rate: "תוכנית פעילה שמחויבת פר-פרק ואין לה תעריף — זה חסר שצריך להשלים",
};

const PATH_NOTE: Record<string, string> = {
  production: "משויך ישירות להפקה",
  job: "דרך העבודה (job) של ההפקה",
  bundle: "מסמך מאוגד — דרך רשימת העבודות שלו",
  consolidated: "הזמנת עבודה מאוגדת — ההזמנה של ההפקה קופלה לתוכה בפדיון",
  number: "דרך מספר החשבונית הרשום על העבודה",
  receipt: "קבלה — דרך חשבונית המס שעליה נבנתה",
};

function DocCell({ docs }: { docs: ProjectDoc[] }) {
  if (!docs?.length) return <span className="text-[var(--ink-faint)]">—</span>;
  return (
    <div className="space-y-1">
      {docs.map((d, i) => (
        <div key={`${d.number ?? "x"}-${i}`} className="leading-tight" title={PATH_NOTE[d.path] ?? d.path}>
          <span className={`font-mono text-xs ${d.cancelled ? "line-through opacity-50" : ""}`}>
            {d.number ?? "—"}
          </span>
          {d.shared && (
            <span className="mr-1 rounded-full bg-[var(--cyan)]/20 px-1.5 py-px text-[10px] text-[var(--cyan)]">
              מאוגד
            </span>
          )}
          {d.date && <div className="text-[10px] text-[var(--ink-faint)]">{shortDate(d.date)}</div>}
        </div>
      ))}
    </div>
  );
}

function Row({ r }: { r: ProjectRow }) {
  // same reasoning as safeBucket: a row from a payload shape this chunk
  // does not know about must render, not throw
  const byType = (t: number) => (r.docs ?? []).filter((d) => d.type === t);
  return (
    <tr className={`border-b border-white/5 align-top ${r.cancelled ? "opacity-45" : ""}`}>
      <td className="py-2 pl-3 font-mono text-xs whitespace-nowrap">
        {r.record_date ? shortDate(r.record_date) : "—"}
      </td>
      <td className="py-2 pl-3">
        <div className={`text-sm ${r.cancelled ? "line-through" : ""}`}>
          {r.show_name ?? r.podcast_name}
          {r.episode_no != null && <span className="text-[var(--ink-faint)]"> · פרק {r.episode_no}</span>}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--ink-faint)]">
          {/* an internal production has no client, and the tag beside it
              already says so — printing a fallback here too rendered
              "פנימיפנימי" */}
          {r.client_name ?? (r.internal ? null : "—")}
          {r.internal && (
            <span className="rounded-full bg-white/10 px-1.5 py-px text-[10px] text-[var(--dim)]">פנימי</span>
          )}
          {r.cancelled && (
            <span className="rounded-full bg-[var(--red)]/20 px-1.5 py-px text-[10px] text-[var(--red)]">בוטל</span>
          )}
        </div>
      </td>
      <td className="py-2 pl-3 text-xs text-[var(--dim)]">{r.guest || <span className="text-[var(--ink-faint)]">—</span>}</td>
      <td className="py-2 pl-3 text-xs whitespace-nowrap text-[var(--dim)]">{statusLabel(r.status)}</td>
      {/* A row with no price says WHY, in the same vocabulary the summary uses.
          It used to say "לא מתומחר" for all of them, which was the same
          category error the summary made: an episode billed through a contract
          milestone is not an episode somebody forgot to price. */}
      <td className="py-2 pl-3 font-mono text-xs whitespace-nowrap">
        {r.price != null ? (
          money(r.price)
        ) : r.billing === "contract" ? (
          // Name the contract when it is unambiguous. The sum is deliberately
          // absent: it belongs to the contract as a whole and is on /contracts.
          <span className="font-sans text-[var(--cyan)]" title={NO_PRICE_NOTE.contract}>
            {r.contract_name ? `בחוזה: ${r.contract_name}` : "מחויב בחוזה"}
          </span>
        ) : (
          <span className="font-sans text-[var(--ink-faint)]" title={NO_PRICE_NOTE[r.billing]}>
            {NO_PRICE_LABEL[r.billing]}
          </span>
        )}
      </td>
      {DOC_TYPES.map((t) => (
        <td key={t} className="py-2 pl-3">
          <DocCell docs={byType(t)} />
        </td>
      ))}
    </tr>
  );
}

/**
 * Fill in anything the payload did not carry, once, at the boundary.
 *
 * WHY THIS EXISTS — a real crash, 2026-08-27. The month <option> used to read
 * `b.rows.length + b.undated.length`. When `undated` was removed from the
 * server payload, any browser tab still holding the previous JS chunk kept
 * running the old expression against the new data and threw
 * "Cannot read properties of undefined (reading 'length')" inside this very
 * map. Server and client are versioned separately and a dev tab survives a
 * rebuild, so client code and payload shape ARE allowed to disagree for a
 * moment — every array this component maps over has to survive that moment.
 *
 * Deliberately total rather than a patch on `undated`: the next field to be
 * added or dropped gets the same protection for free. A missing array reads as
 * empty and the screen renders a smaller truth; the alternative is a blank page
 * with a stack trace.
 */
function safeBucket(b: MonthBucket): MonthBucket {
  const s = b?.summary ?? ({} as MonthBucket["summary"]);
  return {
    key: b?.key ?? "",
    label: b?.label ?? "",
    rows: b?.rows ?? [],
    summary: {
      expected: s.expected ?? 0,
      expectedPriced: s.expectedPriced ?? 0,
      expectedPerEpisode: s.expectedPerEpisode ?? 0,
      expectedTotalRows: s.expectedTotalRows ?? 0,
      missingRateCount: s.missingRateCount ?? 0,
      missingRateShows: s.missingRateShows ?? [],
      contractCount: s.contractCount ?? 0,
      contractItems: s.contractItems ?? [],
      inactiveCount: s.inactiveCount ?? 0,
      inactiveShows: s.inactiveShows ?? [],
      noBillingCount: s.noBillingCount ?? 0,
      billed: s.billed ?? 0,
      billedCount: s.billedCount ?? 0,
      incoming: s.incoming ?? 0,
      incomingCount: s.incomingCount ?? 0,
    },
  };
}

export default function ProjectsClient({
  buckets,
  initialMonth,
}: {
  buckets: MonthBucket[];
  initialMonth: string;
}) {
  const [month, setMonth] = useState(initialMonth);
  const safe = useMemo(() => (buckets ?? []).map(safeBucket), [buckets]);
  const bucket = useMemo(() => safe.find((b) => b.key === month) ?? null, [safe, month]);

  const s = bucket?.summary;

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-8" dir="rtl">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold">מעקב פרויקטים</h1>
        <a href="/finance" className="text-sm text-[var(--violet)] hover:underline">
          למסך הכספים ←
        </a>
      </div>
      <p className="mb-5 text-xs text-[var(--ink-faint)]">
        כל ההפקות לפי חודש הקלטה, עם המסמכים החשבונאיים שיצאו לכל אחת. המסך מתחיל ביולי 2026 — לפני כן הנתונים הם
        ייבוא היסטורי שלא עבר את המסלול, והסטטוסים בו אינם אמיתיים.
      </p>

      {/* month picker — a select rather than a button row: it holds its size as
          the months accumulate, and by next year a button row would wrap to
          three lines above the thing people came to read */}
      <div className="mb-5 flex items-center gap-2">
        <label htmlFor="month" className="text-xs text-[var(--ink-faint)]">
          חודש
        </label>
        <select
          id="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="rounded-lg border border-[var(--rule)] bg-[var(--panel3)] px-3 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--violet)]"
        >
          {safe.map((b) => (
            <option key={b.key} value={b.key}>
              {b.label} ({b.rows.length} הפקות)
            </option>
          ))}
        </select>
      </div>

      {!bucket || bucket.rows.length === 0 ? (
        <div className="glass-card rounded-2xl px-6 py-12 text-center text-[var(--dim)]">
          אין הפקות בחודש הזה.
        </div>
      ) : (
        <>
          {/* ── the three numbers, ABOVE the table ───────────────────────────
              "How much project money happened this month" is the first thing
              asked, and it used to sit below 28 rows of table where it had to
              be scrolled to. It leads now.

              They are NOT three views of one quantity and must never be read as
              a chain: "expected" is anchored to these episodes and covers only
              the priced ones; "billed" and "received" are anchored to document
              dates across the whole business and include billing that never
              came from a production. Subtracting one from another produces a
              meaningless number, so each carries the coverage it actually has,
              printed next to it rather than hidden behind an asterisk. */}
          {s && (
            <div className="mb-6 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="glass-card rounded-2xl border border-[var(--violet)]/25 p-5">
                <div className="text-sm text-[var(--dim)]">
                  עבודת פרויקטים בחודש זה — סכום מחירי ההפקות
                </div>
                <div className="mt-1 font-mono text-4xl">{money(s.expected)}</div>
                {/* Coverage of the PER-EPISODE set only. When every per-episode
                    episode carries a price the number is complete, and saying so
                    is the point — the old wording called it partial no matter
                    what, which trained the reader to distrust a correct total. */}
                <div
                  className={`mt-2 text-xs ${
                    s.missingRateCount > 0 ? "text-[var(--amber)]" : "text-[var(--green)]"
                  }`}
                >
                  {s.missingRateCount > 0
                    ? `מספר חלקי — ${s.expectedPriced} מתוך ${s.expectedPerEpisode} הפקות פר-פרק מתומחרות`
                    : `כל ${s.expectedPriced} ההפקות פר-פרק בחודש מתומחרות`}
                </div>

                {/* (א) the real defect — an ACTIVE per-episode show with no rate */}
                {s.missingRateCount > 0 && (
                  <div className="mt-1.5 text-xs text-[var(--amber)]">
                    {s.missingRateCount === 1 ? "הפקה אחת חסרת תעריף" : `${s.missingRateCount} הפקות חסרות תעריף`}
                    {s.missingRateShows.length > 0 && (
                      <span className="text-[var(--ink-faint)]">
                        {" · "}
                        {s.missingRateShows.length === 1 ? "בתוכנית" : `ב-${s.missingRateShows.length} תוכניות`}
                        {": "}
                        {s.missingRateShows.join(", ")}
                      </span>
                    )}
                  </div>
                )}

                {/* (ב) and (ג) — declared, never described as missing. These are
                    not gaps; they are episodes that were never going to carry a
                    per-episode price, and the contract ones are already counted
                    once through their contract milestone. */}
                {(s.contractCount > 0 || s.inactiveCount > 0 || s.noBillingCount > 0) && (
                  <div className="mt-1.5 space-y-0.5 text-[11px] text-[var(--ink-faint)]">
                    {/* Contract work is WORK THAT HAPPENED, and leaving it as a
                        bare exclusion made a month with contract episodes look
                        like a month with less work in it. It gets its own line,
                        with no shekel figure: the amount belongs to the contract
                        as a whole (icr spotlight 8,000, מכירת ביפו 400,000) and
                        splitting it per episode would be a number nobody agreed
                        to. The link is where the real figures live. */}
                    {s.contractCount > 0 && (
                      <div className="text-[var(--cyan)]">
                        עבודת חוזה: {s.contractCount} {s.contractCount === 1 ? "הפקה" : "הפקות"} — ללא מחיר פר-פרק
                        {s.contractItems.length > 0 && (
                          <span className="text-[var(--ink-faint)]">
                            {" · "}
                            {s.contractItems
                              .map((i) => (i.contract ? `${i.show} (בחוזה: ${i.contract})` : i.show))
                              .join(", ")}
                          </span>
                        )}
                        {/* own line: the show list above can run long, and a
                            link tacked onto the end of it gets lost */}
                        <div>
                          <a href="/contracts" className="text-[var(--violet)] hover:underline">
                            הסכומים רשומים בחוזה — למסך החוזים ←
                          </a>
                        </div>
                      </div>
                    )}
                    {s.inactiveCount > 0 && (
                      <div>
                        {s.inactiveCount} בתוכניות לא פעילות — מחוץ לסכום
                        {s.inactiveShows.length > 0 && <span> · {s.inactiveShows.join(", ")}</span>}
                      </div>
                    )}
                    {s.noBillingCount > 0 && <div>{s.noBillingCount} בתוכניות שחיובן מושתק — מחוץ לסכום</div>}
                  </div>
                )}

                <div className="mt-1.5 text-[11px] text-[var(--ink-faint)]">
                  לא כולל הפקות פנימיות ומבוטלות · {s.expectedTotalRows} שורות בחודש בסך הכל
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="glass-card rounded-2xl p-4">
                  <div className="text-xs text-[var(--ink-faint)]">חויב — חשבונות עסקה (300)</div>
                  <div className="mt-1 font-mono text-2xl">{money(s.billed)}</div>
                  <div className="mt-1 text-[11px] text-[var(--ink-faint)]">
                    {s.billedCount} מסמכים לפי תאריך הנפקה · כל העסק, לא רק ההפקות שלמטה
                  </div>
                </div>
                <div className="glass-card rounded-2xl p-4">
                  <div className="text-xs text-[var(--ink-faint)]">נכנס — מס-קבלה וקבלות (320+400)</div>
                  <div className="mt-1 font-mono text-2xl">{money(s.incoming)}</div>
                  <div className="mt-1 text-[11px] text-[var(--ink-faint)]">
                    {s.incomingCount} מסמכים לפי תאריך הנפקה · כל העסק, לא רק ההפקות שלמטה
                  </div>
                </div>
                <div className="text-[11px] text-[var(--ink-faint)] sm:col-span-2">
                  שלושת המספרים אינם ניתנים להשוואה זה מול זה — לכל אחד בסיס אחר.
                </div>
              </div>
            </div>
          )}

          <div className="glass-card overflow-x-auto rounded-2xl">
            <table className="w-full text-right">
              <thead>
                <tr className="border-b border-white/10 text-[11px] text-[var(--ink-faint)]">
                  <th className="py-2 pl-3 font-normal whitespace-nowrap">תאריך הקלטה</th>
                  <th className="py-2 pl-3 font-normal">תוכנית</th>
                  <th className="py-2 pl-3 font-normal">אורח</th>
                  <th className="py-2 pl-3 font-normal">סטטוס</th>
                  <th className="py-2 pl-3 font-normal">מחיר</th>
                  {DOC_TYPES.map((t) => (
                    <th key={t} className="py-2 pl-3 font-normal whitespace-nowrap">
                      {DOC_TYPE_LABEL[t]}
                      <div className="font-mono text-[10px] opacity-50">{t}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* No "undated" group any more: a production with no
                    record_date never reaches this screen. See the range note in
                    page.tsx — the group existed only to hold a legacy import
                    batch that was never July work. */}
                {bucket.rows.map((r) => (
                  <Row key={r.id} r={r} />
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-[11px] text-[var(--ink-faint)]">
            תא ריק בעמודת מסמך פירושו שלא נמצא מסמך המשויך להפקה הזו, לא שלא הונפק מסמך.
          </p>
        </>
      )}
    </main>
  );
}
