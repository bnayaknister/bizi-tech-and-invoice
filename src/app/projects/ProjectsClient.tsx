"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { displayDate } from "@/lib/dates";
import { emptyCellAction, type EmptyCellDecision, type SkipWarning } from "@/lib/projects/emptyCellAction";
import { DOC_TYPES, DOC_TYPE_LABEL } from "@/lib/documents/forProduction";
import { type MilestoneState } from "@/lib/finance/milestone";
import { countByMonth, type EmptyReason, type Stuck } from "@/lib/projects/stuck";
import {
  BILL_FILTER_KEYS,
  DATE_MEANING_TITLE,
  EMPTY_FILTER,
  NO_JOB_LABEL,
  ROW_SOURCES,
  SOURCE_LABEL,
  SOURCE_TONE,
  billFilterLabel,
  clientOptions,
  countBySource,
  isFilterActive,
  matchesFilter,
  type BillFilterKey,
  type RowSource,
  type UnifiedFilter,
  type UnifiedRow,
} from "@/lib/projects/unified";
import type { ProjectDoc } from "@/lib/projects/row";
import type { BillingClass } from "@/lib/projects/classify";

// Re-exported so nothing that already imported `ProjectDoc` from this component
// has to change — the type itself moved to lib/projects/row.ts to break a cycle
// (this file imports lib/projects/unified, which carries `docs` on every row).
export type { ProjectDoc };

/** Why a row carries no per-episode price. The TYPE moved to
 *  lib/projects/classify.ts on 2026-10-06, next to the one function that decides
 *  it, and is re-exported here unchanged so every existing importer — page.tsx
 *  among them — keeps working. The row cell and the summary still answer with
 *  one vocabulary; that vocabulary now has one home. */
export type { BillingClass };

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
 * A contract milestone as the SERVER derives it.
 *
 * Not a ProjectRow, and deliberately not made into one. A milestone has no
 * recording date, no guest, no episode number and no production status — six
 * of ProjectRow's fields would have to be filled with invented values, which is
 * the exact category error classify() was written to stop.
 *
 * Since 5.10 it is no longer RENDERED from this shape: page.tsx converts it into
 * a `UnifiedRow` with `source: "milestone"`, and the labelled separator row that
 * used to announce it is gone — five sources interleaved by date cannot be
 * banded without the table ceasing to be chronological, so the announcement
 * moved onto the row itself as a source tag (see SourceTag). The shape stays
 * because the server still builds it and because a browser holding the previous
 * JS chunk still reads `bucket.milestones`.
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
  /**
   * The production rows — STILL HERE, and still the only thing `summary` is
   * derived from. Since 5.10 the TABLE renders `work` instead; these two stay on
   * the payload because the summary cards are computed from them server-side
   * (page.tsx keeps that arithmetic untouched by owner decision) and because the
   * stuck windows read `rows` for their per-row sentences.
   */
  rows: ProjectRow[];
  milestones: MilestoneRow[];
  /** Every piece of work in this month, one row each. The table's data. */
  work: UnifiedRow[];
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

const NO_PRICE_LABEL: Record<BillingClass, string> = {
  priced: "—",
  contract: "לפי חוזה",
  no_billing: "חיוב מושתק",
  inactive: "תוכנית לא פעילה",
  missing_rate: "חסר תעריף",
  internal: "הפקה פנימית",
};

const NO_PRICE_NOTE: Record<BillingClass, string> = {
  priced: "",
  contract: "התוכנית מחויבת באבני דרך של חוזה, לא פר-פרק — הכסף נספר דרך אבן הדרך",
  no_billing: "חיוב התוכנית מושתק (billing_mode = none)",
  inactive: "התוכנית אינה פעילה, ולכן אינה אמורה לשאת תעריף",
  missing_rate: "תוכנית פעילה שמחויבת פר-פרק ואין לה תעריף — זה חסר שצריך להשלים",
  internal: "הפקה פנימית של האולפן — אינה מחויבת לאף לקוח, ולכן אין לה מחיר להציג",
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
function DocCell({
  docs,
  emptyText,
  action,
}: {
  docs: ProjectDoc[];
  emptyText?: string | null;
  /** E10 — what an EMPTY cell offers. Ignored once the cell has a document. */
  action?: EmptyCellDecision;
}) {
  if (!docs?.length) {
    // The TEXT, not the EmptyReason object. The reason's `kind` discriminator is
    // a server-side fact (which branch of emptyReasonFor fired) that no cell
    // reads, and a unified row carries the sentence alone — one less shape on
    // the wire, and one less thing a stale chunk can be wrong about.
    //
    // ═══ E10 — the body is UNCHANGED, the wrapper is the whole feature ═══
    // Owner decision 4 (7.10): an active cell gets a hand cursor and a faint
    // ring ON HOVER ONLY — no permanent marker, because 13 columns of
    // permanent markers is a table nobody reads. An inactive cell looks
    // EXACTLY as it did before this feature, and its reason rides on `title`.
    const body = emptyText ? (
      <span className="text-[10px] text-[var(--ink-faint)] leading-tight">{emptyText}</span>
    ) : (
      <span className="text-[var(--ink-faint)]">—</span>
    );

    // ═══ the skip path asks first (owner decision א, 7.10) ═══
    // A 305/320 raised straight off a work order means the deal invoice is
    // never going to exist, and a blank cell cannot show that. So this one
    // path is a BUTTON that opens a confirmation, and the navigation happens
    // only on "המשך" — everything else about the cell is unchanged.
    if (action?.active && action.href && action.warn) {
      return <SkipCell href={action.href} title={action.reason} warn={action.warn} body={body} />;
    }
    if (action?.active && action.href) {
      return (
        <Link
          href={action.href}
          title={action.reason ?? undefined}
          className="block cursor-pointer rounded px-1 -mx-1 ring-1 ring-transparent hover:ring-[var(--cyan)]/50"
        >
          {body}
        </Link>
      );
    }
    // Inactive. A destination may still exist — the redemption screen for an
    // accruing client, the registry for a bundled issuance, the contract
    // screen for a milestone (decisions 1-3) — and it is reachable, but it
    // gets NO ring and NO pointer: the cell is not offering to create
    // anything, it is explaining where that happens.
    if (action?.href) {
      return (
        <Link href={action.href} title={action.reason ?? undefined} className="block">
          {body}
        </Link>
      );
    }
    return <span title={action?.reason ?? undefined}>{body}</span>;
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

/**
 * The source tag — the one thing that makes a mixed table readable.
 *
 * ═══ 🔴 WHY IT IS NOT OPTIONAL, AND WHY IT REPLACES A SEPARATOR ROW ═══
 * Until 5.10 the milestone rows were announced by a labelled separator row, and
 * the note above it said exactly why: "A milestone row carries a contract name
 * where an episode carries a show, and a document date where an episode carries
 * a recording date. Dropped into the list unannounced it reads as one more
 * episode, and the screen lies quietly — which is worse than the blank it
 * replaces."
 *
 * That argument does not scale to five sources: a separator per source would
 * mean five bands and a fixed order, so a chronological table would have to stop
 * being chronological. The tag moves the same announcement onto the row itself,
 * which is the only place it can live when the rows interleave by date. The
 * sentence the separator also carried — that milestone money is already inside
 * the cards above — survives as the footnote under the table, because it is a
 * statement about the CARDS and not about any one row.
 */
function SourceTag({ source }: { source: RowSource }) {
  const color = SOURCE_TONE[source] ?? "var(--dim)";
  // A source this chunk does not know about renders its own key rather than
  // `undefined` — the version-skew discipline safeBucket exists for.
  const label = SOURCE_LABEL[source] ?? String(source);
  return (
    <span
      className="inline-block rounded-full px-1.5 py-px text-[10px] whitespace-nowrap"
      style={{ color, background: "rgba(255,255,255,0.05)", border: `1px solid ${color}33` }}
    >
      {label}
    </span>
  );
}

/**
 * ONE renderer for all five sources.
 *
 * It replaces `Row` and `MilestoneTableRow`, which were two renderers over two
 * row shapes in one table. Three more shapes would have been five renderers and
 * five chances for a column to drift out of line with its header — the thing
 * that actually goes wrong in a wide table nobody can hold in their head.
 *
 * ═══ THE EM DASH IS A STATEMENT, NOT A PLACEHOLDER ═══
 * Every cell a source genuinely has no answer for renders "—", and that is the
 * rule MilestoneTableRow established and this inherits: "a milestone HAS no
 * guest, and printing anything there would be the invented value this row exists
 * to avoid". A job-only row has no production status; a bundle order has no
 * guest; a milestone has neither. None of those is a gap to be filled later.
 */
function WorkRow({ r }: { r: UnifiedRow }) {
  const byType = (t: number) => (r.docs ?? []).filter((d) => d.type === t);
  const stuck = (r.stuckSentences ?? []).length > 0;
  const dash = <span className="text-[var(--ink-faint)]">—</span>;
  const billing = r.billing as BillingClass | null;
  return (
    <tr
      className={`border-b border-white/5 align-top ${r.cancelled ? "opacity-45" : ""}`}
      style={stuck ? STUCK_ROW : undefined}
      title={stuck ? r.stuckSentences.join(" · ") : undefined}
    >
      {/* ⚠️ ONE COLUMN, FOUR MEANINGS — the title is what keeps it honest.
          DATE_MEANING_TITLE names which date this row is showing; for a
          bundle/import row it says out loud that this is the order's issue date
          and NOT when the work was done, because jobs.date on that path is
          `todayInIsrael()` at creation. The precedent is the milestone cell,
          which has carried `title="תאריך המסמך, לא תאריך הקלטה"` since 15.9. */}
      <td
        className="py-2 pl-3 font-mono text-xs whitespace-nowrap"
        title={DATE_MEANING_TITLE[r.dateMeaning] ?? undefined}
      >
        {r.date ? displayDate(r.date) : dash}
      </td>
      <td className="py-2 pl-3">
        <SourceTag source={r.source} />
      </td>
      <td className="py-2 pl-3 text-xs text-[var(--dim)]">{r.client ?? dash}</td>
      <td className="py-2 pl-3">
        <div className={`text-sm ${r.cancelled ? "line-through" : ""}`}>
          {r.show ?? dash}
          {/* The contract behind a contract-named row. On a milestone it is the
              contract itself and would read twice, so it is printed only when it
              differs from what the column already says. */}
          {r.contractName && r.contractName !== r.show && (
            <span className="text-[var(--ink-faint)]"> · {r.contractName}</span>
          )}
        </div>
        {r.cancelled && (
          <span className="rounded-full bg-[var(--red)]/20 px-1.5 py-px text-[10px] text-[var(--red)]">
            בוטל
          </span>
        )}
      </td>
      <td className="py-2 pl-3 text-xs text-[var(--dim)]">{r.description || dash}</td>
      {/* A row with no amount says WHY, in the same vocabulary the summary uses.
          It used to say "לא מתומחר" for all of them, which was the same category
          error the summary made: an episode billed through a contract milestone
          is not an episode somebody forgot to price. Only production rows can
          answer this question — see `billing` on UnifiedRow. */}
      <td className="py-2 pl-3 font-mono text-xs whitespace-nowrap">
        {r.amount != null ? (
          money(r.amount)
        ) : billing === "contract" ? (
          <span className="font-sans text-[var(--cyan)]" title={NO_PRICE_NOTE.contract}>
            {r.contractName ? `בחוזה: ${r.contractName}` : "מחויב בחוזה"}
          </span>
        ) : billing && NO_PRICE_LABEL[billing] ? (
          <span className="font-sans text-[var(--ink-faint)]" title={NO_PRICE_NOTE[billing]}>
            {NO_PRICE_LABEL[billing]}
          </span>
        ) : (
          dash
        )}
      </td>
      {/* סטטוס הפקה — the row's own vocabulary, or nothing. A production shows
          STATUS_LABEL, a misc job its four-value enum, a milestone its
          MILESTONE_META wording; a bundle or import row has no production at
          all and shows a dash. Each is coloured by its own source's map, so a
          misc 'הושלם' can never be mistaken for a pipeline stage. */}
      <td className="py-2 pl-3 text-xs whitespace-nowrap">
        {r.prodStatus ? (
          <span style={{ color: r.prodStatus.color }}>{r.prodStatus.label}</span>
        ) : (
          dash
        )}
      </td>
      {/* סטטוס חיוב — deriveState's four values via TAB_META, or the absence.
          `state === null` is a row with no job: "טרם חויבה", never "לא חויב".
          The two are different claims and the amber hue says the second one is
          not being made. */}
      <td className="py-2 pl-3 text-xs whitespace-nowrap">
        <span style={{ color: r.billStatus.color }}>{r.billStatus.label}</span>
      </td>
      {DOC_TYPES.map((t) => (
        <td key={t} className="py-2 pl-3">
          {/* The empty-cell label is suppressed on the 100 column and on a stuck
              row, exactly as before: a work order is the START of the chain
              rather than a step in it, and on a row the rule has just raised a
              hand about, the blank IS the problem — the label's whole claim is
              "this blank is expected". */}
          <DocCell
            docs={byType(t)}
            emptyText={t === 100 || stuck ? null : r.emptyReasonText}
            action={emptyCellAction({
              source: r.source,
              docType: t,
              docs: r.docs ?? [],
              cadence: r.cadence,
            })}
          />
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
    // `work` is the array the table maps over, so it gets the same treatment
    // every other array here does — and per-row, because a UnifiedRow carries
    // three fields a renderer walks (`docs`, `stuckSentences`) or indexes
    // (`source`). A payload from a build that predates one of them must render a
    // smaller truth, not a blank page: that is this function's whole job, and
    // the crash it was written for (2026-08-27) was exactly one missing array
    // inside a .map.
    work: (b?.work ?? []).map((r) => ({
      ...r,
      docs: r?.docs ?? [],
      stuckSentences: r?.stuckSentences ?? [],
      // 🔴 billStatus IS DEREFERENCED UNCONDITIONALLY by the row — `.color` and
      // `.label` with no guard, because every row genuinely has a billing
      // status: `billStatusFor` returns the "טרם חויבה" shape rather than null
      // when there is no job. So the cell is right to assume it, and the
      // BOUNDARY is where a payload that predates the field has to be repaired.
      //
      // Caught by test_projects_render on the day this was written — the same
      // crash class, in the same component, as the 2026-08-27 one this function
      // was created for: one missing field inside a .map, and a blank page with
      // a stack trace instead of a smaller truth. `prodStatus` needs nothing
      // because the row already renders a dash when it is falsy.
      billStatus: r?.billStatus ?? { state: null, label: NO_JOB_LABEL, color: "var(--dim)" },
      jobIds: r?.jobIds ?? [],
    })),
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

  // ---- the filters -------------------------------------------------------
  // State lives here and the PREDICATE lives in lib/projects/unified, so the
  // table and every count beside it ask one function. A second spelling of
  // "does this row match" is how a chip comes to claim 4 rows above a table
  // showing 3 — the class of contradiction the stuck windows already had to be
  // fixed for (one counted documents, the other counted rows).
  const [filter, setFilter] = useState<UnifiedFilter>(EMPTY_FILTER);
  // Memoised, and not `bucket?.work ?? []` inline: the fallback literal is a NEW
  // array on every render, so the three useMemos below would recompute every
  // time and the memo would be decoration. Harmless at 40 rows and wrong in
  // principle — react-hooks/exhaustive-deps said so, and it was right.
  const work = useMemo(() => bucket?.work ?? [], [bucket]);
  const shown = useMemo(() => work.filter((r) => matchesFilter(r, filter)), [work, filter]);
  // Counts are of the UNFILTERED month: a chip has to say how many rows it
  // WOULD show, not how many survive the other chips — otherwise every count
  // but the active one reads zero and the bar becomes unusable.
  const sourceCounts = useMemo(() => countBySource(work), [work]);
  const clients = useMemo(() => clientOptions(work), [work]);
  const toggleSource = (src: RowSource) =>
    setFilter((f) => ({
      ...f,
      sources: f.sources.includes(src) ? f.sources.filter((x) => x !== src) : [...f.sources, src],
    }));
  const toggleBill = (k: BillFilterKey) =>
    setFilter((f) => ({
      ...f,
      bills: f.bills.includes(k) ? f.bills.filter((x) => x !== k) : [...f.bills, k],
    }));
  // A month with milestone rows still has to say the thing the old separator
  // row said — that this money is already inside the two cards above. It is a
  // statement about the CARDS, not about a row, so it lives under the table.
  const hasMilestoneRows = shown.some((r) => r.source === "milestone");

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
      {/* Owner-approved wording, 5.10. It replaces "כל ההפקות לפי חודש הקלטה",
          which stopped being true the moment four more sources arrived — and
          "לפי חודש הקלטה" was the specific falsehood: only one of the five is
          placed by a recording date. */}
      <p className="mb-5 text-xs text-[var(--ink-faint)]">
        כל עבודה שמתבצעת במערכת לפי חודש, עם המסמכים החשבונאיים שיצאו לכל אחת — הפקות, הזמנות מרוכזות, רדיו ושונות
        ואבני דרך של חוזים. המסך מתחיל ביולי 2026; לפני כן הנתונים הם ייבוא היסטורי שלא עבר את המסלול.
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
          {/* `work.length`, not `rows.length` — the count has to be of what the
              table will show. A month holding one radio job and no episodes read
              "(0 הפקות)" before 5.10 and was indistinguishable from an empty
              one, so the only month with that work in it looked like a month
              with none. */}
          {safe.map((b) => (
            <option key={b.key} value={b.key}>
              {b.label} ({b.work.length} עבודות)
            </option>
          ))}
        </select>
      </div>

      {!bucket || bucket.work.length === 0 ? (
        <div className="glass-card rounded-2xl px-6 py-12 text-center text-[var(--dim)]">
          אין עבודות בחודש הזה.
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

                {/* ⚠️ "{N} הפקות בחודש", replacing a caption that claimed to
                    count the month's ROWS in total.
                    The number is unchanged — `expectedTotalRows` is still
                    `all.length` over the PRODUCTION rows, and the owner's
                    decision was explicitly that no card arithmetic moves. What
                    changed on 5.10 is the TABLE: it carries five sources now, so
                    a caption claiming to count "rows in the month" sat above a
                    table with more of them. In a month with 28 episodes, one
                    bundle order and one radio job it read "28 שורות" over 30
                    rows — a false statement on a money screen, and the sharpest
                    one the unified table created.

                    The second line is the fix for the real confusion underneath
                    it: the purple card's total covers productions ONLY, and
                    before this nothing on the screen said so. */}
                <div className="mt-1.5 text-[11px] text-[var(--ink-faint)]">
                  לא כולל הפקות פנימיות ומבוטלות · {s.expectedTotalRows} הפקות בחודש
                </div>
                <div className="mt-1 text-[11px] text-[var(--ink-faint)]">
                  הסכום הזה מכסה הפקות בלבד. הזמנות מרוכזות, רדיו ושונות וייבוא מופיעים בטבלה ואינם בתוכו.
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="glass-card rounded-2xl p-4">
                  <div className="text-xs text-[var(--ink-faint)]">חויב — חשבונות עסקה (300)</div>
                  <div className="mt-1 font-mono text-2xl">{money(s.billed)}</div>
                  <div className="mt-1 text-[11px] text-[var(--ink-faint)]">
                    {/* "גם מה שאינו בטבלה שלמטה", replacing a caption that
                        said "not only the productions below". That was accurate
                        while the table held productions alone; now that it holds
                        five sources it reads as if the table were the smaller
                        set and the card merely wider. The real relationship is
                        that these two totals count EVERY document in the month,
                        including the ones no row on this screen can attribute to
                        anybody — 300: 27 of 44 reach no production, 400: 7 of 7
                        (measured 2026-09-15, recorded above monthDocsRes in
                        page.tsx). The new phrasing says that out loud. */}
                    {s.billedCount} מסמכים לפי תאריך הנפקה · כל העסק, גם מה שאינו בטבלה שלמטה
                  </div>
                </div>
                <div className="glass-card rounded-2xl p-4">
                  <div className="text-xs text-[var(--ink-faint)]">נכנס — מס-קבלה וקבלות (320+400)</div>
                  <div className="mt-1 font-mono text-2xl">{money(s.incoming)}</div>
                  <div className="mt-1 text-[11px] text-[var(--ink-faint)]">
                    {/* same change, same reason — see the 300 card above */}
                    {s.incomingCount} מסמכים לפי תאריך הנפקה · כל העסק, גם מה שאינו בטבלה שלמטה
                  </div>
                </div>
                <div className="text-[11px] text-[var(--ink-faint)] sm:col-span-2">
                  שלושת המספרים אינם ניתנים להשוואה זה מול זה — לכל אחד בסיס אחר.
                </div>
              </div>
            </div>
          )}

          {/* ── the filter bar ──────────────────────────────────────────────
              Three axes, and every one of them treats an EMPTY selection as "no
              filter on this axis" rather than "match nothing" — the same
              decision isFinanceFilterKey makes for an unrecognised query string
              (state.ts:117-126): "a money screen must never hide rows because it
              half-recognised a filter". The predicate is matchesFilter, imported;
              the counts beside each chip come from the same row set the table
              maps over, so a chip cannot claim rows the table does not show. */}
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-[var(--ink-faint)]">מקור</span>
              {ROW_SOURCES.map((src) => {
                const on = filter.sources.includes(src);
                const n = sourceCounts[src] ?? 0;
                const color = SOURCE_TONE[src] ?? "var(--dim)";
                return (
                  <button
                    key={src}
                    onClick={() => toggleSource(src)}
                    // A source with no rows this month is disabled rather than
                    // hidden: a chip that appears and vanishes between months
                    // teaches nobody what the screen contains, and "0" is a real
                    // answer to "how much radio work did we do in August".
                    disabled={n === 0 && !on}
                    className="rounded-full px-2 py-0.5 text-[11px] whitespace-nowrap transition-opacity disabled:opacity-30"
                    style={{
                      color: on ? "var(--ink)" : color,
                      background: on ? color : "rgba(255,255,255,0.05)",
                      border: `1px solid ${color}${on ? "" : "33"}`,
                    }}
                  >
                    {SOURCE_LABEL[src] ?? src} {n}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1.5">
              <label htmlFor="client" className="text-[11px] text-[var(--ink-faint)]">
                לקוח
              </label>
              <select
                id="client"
                value={filter.client}
                onChange={(e) => setFilter((f) => ({ ...f, client: e.target.value }))}
                className="rounded-lg border border-[var(--rule)] bg-[var(--panel3)] px-2 py-1 text-xs text-[var(--ink)] outline-none focus:border-[var(--violet)]"
              >
                <option value="">כל הלקוחות</option>
                {clients.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-[var(--ink-faint)]">סטטוס חיוב</span>
              {/* Four TAB_META values plus the absence. "טרם חויבה" is a FILTER
                  key and not a fifth FinanceState — see BillStatus in
                  lib/projects/unified for why extending the enum would have put
                  a new tab on /finance as a side effect. */}
              {BILL_FILTER_KEYS.map((k) => {
                const on = filter.bills.includes(k);
                return (
                  <button
                    key={k}
                    onClick={() => toggleBill(k)}
                    className={`rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap ${
                      on
                        ? "border-[var(--violet)] bg-[var(--violet)]/20 text-[var(--ink)]"
                        : "border-[var(--rule)] text-[var(--dim)]"
                    }`}
                  >
                    {billFilterLabel(k)}
                  </button>
                );
              })}
            </div>

            {isFilterActive(filter) && (
              <button
                onClick={() => setFilter(EMPTY_FILTER)}
                className="text-[11px] text-[var(--violet)] hover:underline"
              >
                נקה סינון ({shown.length} מתוך {work.length})
              </button>
            )}
          </div>

          {shown.length === 0 ? (
            <div className="glass-card rounded-2xl px-6 py-12 text-center text-[var(--dim)]">
              אין עבודות מהמקורות שנבחרו בחודש הזה.
            </div>
          ) : (
          <div className="glass-card overflow-x-auto rounded-2xl">
            <table className="w-full text-right">
              <thead>
                <tr className="border-b border-white/10 text-[11px] text-[var(--ink-faint)]">
                  {/* "תאריך" and no longer "תאריך הקלטה": only one of the five
                      sources is placed by a recording date. Which date a given
                      row is showing is on the cell's own title — see
                      DATE_MEANING_TITLE. */}
                  <th className="py-2 pl-3 font-normal whitespace-nowrap">תאריך</th>
                  <th className="py-2 pl-3 font-normal">מקור</th>
                  <th className="py-2 pl-3 font-normal">לקוח</th>
                  <th className="py-2 pl-3 font-normal">תוכנית / עבודה</th>
                  <th className="py-2 pl-3 font-normal">תיאור</th>
                  <th className="py-2 pl-3 font-normal">סכום</th>
                  <th className="py-2 pl-3 font-normal whitespace-nowrap">סטטוס הפקה</th>
                  <th className="py-2 pl-3 font-normal whitespace-nowrap">סטטוס חיוב</th>
                  {DOC_TYPES.map((t) => (
                    <th key={t} className="py-2 pl-3 font-normal whitespace-nowrap">
                      {DOC_TYPE_LABEL[t]}
                      <div className="font-mono text-[10px] opacity-50">{t}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* ONE list, in date order, with the source on each row. No
                    separator bands: five sources interleaved by date cannot be
                    banded without the table ceasing to be chronological, which
                    is the one property a month view has to keep. The sentence
                    the milestone separator also carried — "this money is already
                    inside the cards above" — is below the table, because it is a
                    statement about the cards rather than about a row. */}
                {shown.map((r) => (
                  <WorkRow key={r.key} r={r} />
                ))}
              </tbody>
            </table>
          </div>
          )}

          <p className="mt-3 text-[11px] text-[var(--ink-faint)]">
            תא ריק בעמודת מסמך פירושו שלא נמצא מסמך המשויך לעבודה הזו, לא שלא הונפק מסמך.
          </p>
          {hasMilestoneRows && (
            <p className="mt-1 text-[11px] text-[var(--ink-faint)]">
              סכומי אבני הדרך כבר בתוך &quot;חויב&quot; ו&quot;נכנס&quot; שלמעלה — הם מוצגים כאן כדי לראות למי הם
              שייכים, ואינם נספרים פעמיים.
            </p>
          )}
        </>
      )}
    </main>
  );
}

/**
 * The one cell that asks before it navigates — the 100 -> 305/320 skip
 * (owner decision א, 7.10).
 *
 * ⚠️ IT STILL ONLY NAVIGATES. "המשך" pushes the same registry href every
 * other active cell links to; nothing here creates, queues or decides
 * anything about a document, and /projects calls no creation route. The
 * dialog exists because the cell is blank and the fact it hides — that the
 * deal invoice will never exist — is the one thing the bookkeeper cannot
 * read off a dash.
 *
 * The panel copies MODAL_OVERLAY / MODAL_PANEL rather than inventing a look:
 * the same two constants every other modal in the app uses, click-outside to
 * dismiss, stopPropagation on the panel.
 */
function SkipCell({
  href,
  title,
  warn,
  body,
}: {
  href: string;
  title: string | null;
  warn: SkipWarning;
  body: React.ReactNode;
}) {
  const [asking, setAsking] = useState(false);

  return (
    <>
      <button
        type="button"
        title={title ?? undefined}
        onClick={() => setAsking(true)}
        className="block w-full cursor-pointer rounded px-1 -mx-1 text-right ring-1 ring-transparent hover:ring-[var(--cyan)]/50"
      >
        {body}
      </button>
      {asking && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={MODAL_OVERLAY}
          onClick={() => setAsking(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-[var(--rule2)] p-5 shadow-2xl"
            style={MODAL_PANEL}
          >
            <h2 className="mb-3 text-sm font-bold">{warn.title}</h2>
            <p className="mb-4 text-sm leading-relaxed">{warn.body}</p>
            <div className="flex gap-2">
              {/* a Link, not router.push: it is the SAME navigation every
                  other active cell performs, and it needs no router hook —
                  which matters because `useRouter` requires an app-router
                  context that `renderToString` has none of, and the offline
                  render suite caught exactly that. */}
              <Link
                href={href}
                className="flex-1 rounded-xl bg-[var(--signal)] px-4 py-2 text-center text-xs font-bold text-white"
              >
                {warn.confirm}
              </Link>
              <button
                onClick={() => setAsking(false)}
                className="flex-1 rounded-xl border border-[var(--rule)] px-4 py-2 text-xs"
              >
                {warn.cancel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
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
  // ONE number across both windows (owner, 2026-09-18). The notice counts
  // distinct things stuck and this header used to count rows, so the same
  // moment read "6 פרויקטים" and then "8 פרויקטים" one click apart. Both were
  // true — כפיר ארביב's two documents reach four episodes — and to the person
  // reading them that is simply a contradiction, which is the worse outcome on
  // a screen whose whole job is to be trusted about money.
  //
  // The LIST below is untouched and still shows every row, because a row is
  // the thing she acts on: the two כפיר ארביב episodes are two projects to
  // look at even though one document is holding both.
  const stuckCount = new Set(rows.flatMap((r) => (r.stuck ?? []).map((s) => s.key))).size;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={MODAL_OVERLAY} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--rule2)] p-5 shadow-2xl"
        style={MODAL_PANEL}
      >
        <h2 className="mb-1 text-sm font-bold">פירוט הפרויקטים שדורשים בדיקה</h2>
        <p className="mb-4 text-[11px] text-[var(--ink-faint)]">
          {stuckCount} פרויקטים שהשרשרת שלהם נעצרה. לכל אחד — איפה בדיוק היא נעצרה.
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
