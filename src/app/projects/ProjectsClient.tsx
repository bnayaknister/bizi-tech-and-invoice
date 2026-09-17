"use client";

import { useEffect, useMemo, useState } from "react";
import { displayDate } from "@/lib/dates";
import { DOC_TYPES, DOC_TYPE_LABEL } from "@/lib/documents/forProduction";
import { MILESTONE_META, type MilestoneState } from "@/lib/finance/milestone";
import { countByMonth, type EmptyReason, type Stuck } from "@/lib/projects/stuck";

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
  /**
   * Where this project's money chain stopped, if it did (owner spec
   * 2026-09-17). Usually empty; one entry per document that is stuck, or one
   * for a production that was never billed at all.
   */
  stuck: Stuck[];
  /**
   * Why the document columns are blank, when blank is the expected state.
   * null means a dash is the honest answer — something really is missing.
   */
  empty_reason: EmptyReason | null;
};

/**
 * A contract milestone, shown in the SAME table as the episodes and separated
 * from them by a labelled row.
 *
 * Not a ProjectRow, and deliberately not made into one. A milestone has no
 * recording date, no guest, no episode number and no production status — six
 * of ProjectRow's fields would have to be filled with invented values, which is
 * the exact category error classify() was written to stop. It is a different
 * subject that belongs on the same page, so it gets its own shape and its own
 * renderer.
 *
 * `amount` is the ANCHOR DOCUMENT's gross, never the milestone's net: this row
 * exists to attribute a number that is already inside the month cards above,
 * and it has to show the number it is attributing.
 */
export type MilestoneRow = {
  id: string;
  name: string;
  contract_name: string | null;
  client_name: string | null;
  state: MilestoneState;
  amount: number | null;
  anchor_date: string | null;
  /** which month card already holds this money; null for a 305, which sits in neither */
  counted_in: "incoming" | "billed" | null;
  docs: ProjectDoc[];
};

export type MonthBucket = {
  key: string;
  label: string;
  rows: ProjectRow[];
  milestones: MilestoneRow[];
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

/**
 * One document column.
 *
 * The empty-cell label (owner spec 2026-09-17) replaces the dash ONLY where the
 * blank is expected: a monthly client mid-month, an every_n bundle still
 * filling, a contract show, a silenced one. A dash survives wherever a document
 * really is missing, which is the whole point — before this, "—" meant both
 * "nothing is due yet" and "something went wrong" and the screen could not tell
 * the bookkeeper which.
 *
 * Deliberately NOT on the 100 column: a work order is the start of the chain,
 * not a step in it, and "חודשי · ייצא בסוף החודש" printed under it would be
 * describing the wrong document.
 *
 * And NOT on a stuck row at all. The label's whole claim is "this blank is
 * expected"; on a row the rule has just raised a hand about, the blank is the
 * problem. חתונמיות' July episodes are the live case — they would have read
 * "מצטבר · 0 מתוך 6", which is true of the CURRENT bundle and beside the point
 * for an episode that was never enqueued into one.
 */
function DocCell({ docs, emptyReason }: { docs: ProjectDoc[]; emptyReason?: EmptyReason | null }) {
  if (!docs?.length) {
    if (emptyReason) {
      return (
        <span className="text-[10px] text-[var(--ink-faint)] leading-tight">{emptyReason.text}</span>
      );
    }
    return <span className="text-[var(--ink-faint)]">—</span>;
  }
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
          {d.date && <div className="text-[10px] text-[var(--ink-faint)]">{displayDate(d.date)}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * The milestone renderer. Same columns, filled only where they mean something.
 *
 * The three that do not apply — guest, production status, episode — render an
 * em dash. That is not a gap to be filled later: a milestone HAS no guest, and
 * printing anything there would be the invented value this row exists to avoid.
 * The status column instead carries the milestone's own vocabulary from
 * MILESTONE_META ("שולם", "חויב — ממתין לתשלום"), which cannot be
 * mistaken for a production status.
 */
function MilestoneTableRow({ m }: { m: MilestoneRow }) {
  const byType = (t: number) => (m.docs ?? []).filter((d) => d.type === t);
  // same reasoning as safeBucket: a state this chunk does not know about must
  // RENDER, not throw. Caught by test_projects_render.tsx on the day this row
  // was written — indexing MILESTONE_META with an unknown key returns undefined
  // and reading .color off it takes the whole page down, which is the exact
  // version-skew crash that suite exists for.
  const meta = MILESTONE_META[m.state] ?? { label: m.state ?? "—", color: "var(--dim)", dot: "var(--dim)" };
  const dash = <span className="text-[var(--ink-faint)]">—</span>;
  return (
    <tr className="border-b border-white/5 align-top">
      <td className="py-2 pl-3 font-mono text-xs whitespace-nowrap" title="תאריך המסמך, לא תאריך הקלטה">
        {m.anchor_date ? displayDate(m.anchor_date) : dash}
      </td>
      <td className="py-2 pl-3">
        <div className="text-sm">
          {m.name}
          {m.contract_name && <span className="text-[var(--ink-faint)]"> · {m.contract_name}</span>}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--ink-faint)]">
          {m.client_name ?? dash}
          <span className="rounded-full bg-[var(--cyan)]/20 px-1.5 py-px text-[10px] text-[var(--cyan)]">
            אבן דרך
          </span>
        </div>
      </td>
      <td className="py-2 pl-3 text-xs">{dash}</td>
      <td className="py-2 pl-3 text-xs whitespace-nowrap" style={{ color: meta.color }}>
        {meta.label}
      </td>
      <td className="py-2 pl-3 font-mono text-xs whitespace-nowrap">
        {money(m.amount)}
        {/* which card up top already holds it. A 305 sits in neither, and says
            nothing rather than claiming a total it is not in. */}
        {m.counted_in && (
          <div className="text-[10px] text-[var(--ink-faint)]">
            {m.counted_in === "incoming" ? "בתוך נכנס" : "בתוך חויב"}
          </div>
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
 * The stuck highlight.
 *
 * --amber, and chosen against the other three the palette already speaks:
 * --red is errors and overdue debt, --green is "open / fine", --cyan is
 * declared "info / open commitment (never debt)". A stuck chain is none of
 * those — it is work that needs a hand, which is exactly what --warn (= amber)
 * already means everywhere else in the app. A soft inset bar on the leading
 * edge, a low glow, and 5% of the colour behind the row: visible while
 * scanning, and nowhere near the weight of a red error.
 */
const STUCK_ROW: React.CSSProperties = {
  boxShadow: "inset 3px 0 0 var(--amber), 0 0 20px -8px var(--amber)",
  background: "color-mix(in srgb, var(--amber) 5%, transparent)",
};

function Row({ r }: { r: ProjectRow }) {
  // same reasoning as safeBucket: a row from a payload shape this chunk
  // does not know about must render, not throw
  const byType = (t: number) => (r.docs ?? []).filter((d) => d.type === t);
  const stuck = (r.stuck ?? []).length > 0;
  return (
    <tr
      className={`border-b border-white/5 align-top ${r.cancelled ? "opacity-45" : ""}`}
      style={stuck ? STUCK_ROW : undefined}
      title={stuck ? r.stuck.map((s) => s.sentence).join(" · ") : undefined}
    >
      <td className="py-2 pl-3 font-mono text-xs whitespace-nowrap">
        {r.record_date ? displayDate(r.record_date) : "—"}
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
          <DocCell docs={byType(t)} emptyReason={t === 100 || stuck ? null : r.empty_reason} />
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
    rows: (b?.rows ?? []).map((r) => ({ ...r, stuck: r?.stuck ?? [], empty_reason: r?.empty_reason ?? null })),
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
    milestones: b?.milestones ?? [],
  };
}

/**
 * The once-a-day key. Per user, so two people on one machine each get their
 * own first look, and per DAY rather than per session — the notice is a
 * morning briefing, not a nag.
 */
const SEEN_KEY = (userId: string) => `bizi:stuck-seen:${userId}`;

/**
 * Every localStorage touch is wrapped, and none of them decides anything but
 * whether a notice shows.
 *
 * A private window, cleared site data, or a browser set to block storage makes
 * the accessor THROW rather than return null — which would take the whole
 * screen down on a page whose job is to render money. The fallback is
 * deliberate in both directions: read failure shows the notice (better twice
 * than never), write failure shows it again tomorrow.
 */
function seenToday(userId: string, today: string): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY(userId)) === today;
  } catch {
    return false;
  }
}
function markSeen(userId: string, today: string) {
  try {
    window.localStorage.setItem(SEEN_KEY(userId), today);
  } catch {
    /* storage unavailable — the notice simply returns tomorrow */
  }
}

export default function ProjectsClient({
  buckets,
  initialMonth,
  userId,
  today,
}: {
  buckets: MonthBucket[];
  initialMonth: string;
  userId: string;
  today: string;
}) {
  const [month, setMonth] = useState(initialMonth);
  const safe = useMemo(() => (buckets ?? []).map(safeBucket), [buckets]);
  const bucket = useMemo(() => safe.find((b) => b.key === month) ?? null, [safe, month]);

  // ---- the stuck chains, across EVERY month ------------------------------
  // Not the selected bucket: the notice is about the business, and a project
  // that stalled in July is exactly the one nobody is looking at in September.
  const stuckRows = useMemo(
    () => safe.flatMap((b) => (b.rows ?? []).filter((r) => (r.stuck ?? []).length > 0).map((r) => ({ ...r, month: b.key, label: b.label }))),
    [safe]
  );
  const stuckByMonth = useMemo(
    () => countByMonth(safe.flatMap((b) => (b.rows ?? []).map((r) => ({ month: b.label, stuck: r.stuck ?? [] })))),
    [safe]
  );
  const [notice, setNotice] = useState(false);
  const [detail, setDetail] = useState(false);

  // Once a day, and only when there is something to say. Runs in an effect
  // because localStorage does not exist during the server render — reading it
  // in the initial state would throw on the server and hydrate-mismatch on the
  // client.
  useEffect(() => {
    if (!stuckRows.length) return;
    if (seenToday(userId, today)) return;
    setNotice(true);
  }, [stuckRows.length, userId, today]);

  function dismissNotice() {
    markSeen(userId, today);
    setNotice(false);
  }

  const s = bucket?.summary;

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-8" dir="rtl">
      {notice && (
        <StuckNotice
          months={stuckByMonth}
          onDetail={() => {
            dismissNotice();
            setDetail(true);
          }}
          onClose={dismissNotice}
        />
      )}
      {detail && <StuckDetail rows={stuckRows} onClose={() => setDetail(false)} />}

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
                {/* ═══ THE SEPARATOR IS THE POINT, NOT DECORATION ═══
                    A milestone row carries a contract name where an episode
                    carries a show, and a document date where an episode carries
                    a recording date. Dropped into the list unannounced it reads
                    as one more episode, and the screen lies quietly — which is
                    worse than the blank it replaces. The label changes the
                    subject out loud, and the second half states the thing a
                    reader would otherwise have to work out: this money is
                    already inside the two cards above. */}
                {bucket.milestones.length > 0 && (
                  <tr className="border-b border-white/10 bg-white/[0.03]">
                    <td colSpan={5 + DOC_TYPES.length} className="px-3 py-2">
                      <span className="text-xs font-semibold text-[var(--cyan)]">אבני דרך של חוזים</span>
                      <span className="mr-2 text-[11px] text-[var(--ink-faint)]">
                        הסכומים כבר בתוך &quot;חויב&quot; ו&quot;נכנס&quot; שלמעלה — מוצגים כאן כדי לראות למי הם שייכים, ואינם
                        נספרים פעמיים · לפי תאריך המסמך
                      </span>
                    </td>
                  </tr>
                )}
                {bucket.milestones.map((m) => (
                  <MilestoneTableRow key={m.id} m={m} />
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

// ---------------------------------------------------------------------------
// the stuck windows (owner spec 2026-09-17)
// ---------------------------------------------------------------------------

// The panel values every other modal in the app uses — contracts, finance,
// productions, and since 17.9 the two on /documents. Not `bg-[var(--bg)]`:
// that variable does not exist in this project and renders transparent.
const MODAL_OVERLAY: React.CSSProperties = { background: "rgba(3,2,10,0.66)", backdropFilter: "blur(6px)" };
const MODAL_PANEL: React.CSSProperties = {
  background: "rgba(15,13,28,0.94)",
  backdropFilter: "blur(24px)",
  WebkitBackdropFilter: "blur(24px)",
};

/**
 * The once-a-day notice: one line per month that holds a stuck chain.
 *
 * The counts are of DISTINCT things stuck, not of rows showing them — see
 * countByMonth. One bundled 300 reaches four of כפיר ארביב's episodes, and
 * counting rows would announce four stalled projects where two documents are
 * waiting.
 */
function StuckNotice({
  months,
  onDetail,
  onClose,
}: {
  months: { month: string; count: number }[];
  onDetail: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={MODAL_OVERLAY} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-[var(--rule2)] p-5 shadow-2xl"
        style={MODAL_PANEL}
      >
        <h2 className="mb-3 text-sm font-bold">פרויקטים שדורשים בדיקה</h2>
        <div className="mb-4 space-y-1.5 text-sm">
          {months.map((m) => (
            <div key={m.month}>
              בחודש <span className="font-bold">{m.month}</span> יש{" "}
              <span className="font-bold" style={{ color: "var(--amber)" }}>
                {m.count}
              </span>{" "}
              פרויקטים שדורשים בדיקה כי לא קודמו
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onDetail}
            className="flex-1 rounded-xl bg-[var(--signal)] px-4 py-2 text-xs font-bold text-white"
          >
            לפירוט הפרויקטים
          </button>
          <button onClick={onClose} className="flex-1 rounded-xl border border-[var(--rule)] px-4 py-2 text-xs">
            סגור
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The detail window: every stuck project, with the one sentence that says
 * where it stopped and a way to go and look at it.
 *
 * The link goes to the REGISTRY and carries the document number, because that
 * is the screen where the next action lives — issuing the missing child. A
 * project stuck for never having been billed has no document to name, so it
 * links to the accrual queue instead, which is where its work order should
 * have been.
 */
function StuckDetail({
  rows,
  onClose,
}: {
  rows: (ProjectRow & { month: string; label: string })[];
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={MODAL_OVERLAY} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--rule2)] p-5 shadow-2xl"
        style={MODAL_PANEL}
      >
        <h2 className="mb-1 text-sm font-bold">פירוט הפרויקטים שדורשים בדיקה</h2>
        <p className="mb-4 text-[11px] text-[var(--ink-faint)]">
          {rows.length} פרויקטים שהשרשרת שלהם נעצרה. לכל אחד — איפה בדיוק היא נעצרה.
        </p>
        <div className="space-y-3">
          {rows.map((r) =>
            (r.stuck ?? []).map((st, i) => (
              <div
                key={`${r.id}-${i}`}
                className="rounded-xl border border-[var(--rule)] p-3"
                style={{ boxShadow: "inset 3px 0 0 var(--amber)" }}
              >
                <div className="text-sm font-medium">
                  {r.client_name ?? "—"}
                  <span className="text-[var(--ink-faint)]"> · {r.show_name ?? r.podcast_name}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-[var(--ink-faint)]">
                  הוקלט {r.record_date ? displayDate(r.record_date) : "—"} · {r.label}
                </div>
                <div className="mt-1.5 text-xs leading-relaxed">{st.sentence}</div>
                <a
                  href={st.docNumber ? `/documents/registry?q=${encodeURIComponent(st.docNumber)}` : "/documents/accrued"}
                  className="mt-1.5 inline-block text-[11px] text-[var(--violet)] hover:underline"
                >
                  {st.docNumber ? `פתחי את ${st.docNumber} במרשם ←` : "לתור הצבירה ←"}
                </a>
              </div>
            ))
          )}
        </div>
        <button onClick={onClose} className="mt-4 w-full rounded-xl border border-[var(--rule)] px-4 py-2 text-xs">
          סגור
        </button>
      </div>
    </div>
  );
}
