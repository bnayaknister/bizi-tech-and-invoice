"use client";

import { TAX_BUNDLE_NOTICE } from "@/lib/morning/types";
import { sumSourceNet, type SelectableRow } from "@/lib/documents/registrySelection";

/**
 * The registry's bundling bar, as a PURE component.
 *
 * ═══ WHY EXTRACTED ═══
 * Its own row rather than another button in the controls above: it is a MODE
 * the operator entered by ticking boxes, and it has to carry the count and the
 * sum — the two numbers that say what is about to be created. One selected row
 * is not a bundle, so it appears at two and the single-row button keeps that
 * case.
 *
 * It left RegistryClient on 2026-10-04 for the reason CreateJobBody did: the
 * three facts that matter here are all COUNTS — the bundled button appears
 * exactly once, the mixed-selection sentence appears exactly once, and a mixed
 * selection sends nothing — and none of them could be asserted from inside a
 * 1,700-line component behind a provider, a fetch and a click. The mixed case
 * in particular is new, is about money, and was until now visible only by
 * ticking two real rows on a real screen.
 *
 * Every prop is data the caller already holds. No fetch, no router, no state.
 */
export default function BundleBar({
  rows,
  action,
  mixed,
  busy,
  currency,
  onClear,
  onBundle,
}: {
  /** the ticked rows, already re-filtered through the tab's predicate */
  rows: SelectableRow[];
  /** which bundled document a tick means here — the TAB's answer, never the row's */
  action: "tax" | "deal_invoice";
  /** does the selection span both source doors? then it cannot be sent */
  mixed: boolean;
  busy: boolean;
  currency: string;
  onClear: () => void;
  onBundle: () => void;
}) {
  // Fewer than two is not a bundle — the single-row button owns that case.
  if (rows.length < 2) return null;

  const money = (n: number | null) =>
    n === null
      ? "—"
      : new Intl.NumberFormat("he-IL", {
          style: "currency",
          currency: currency || "ILS",
          maximumFractionDigits: 0,
        }).format(n);

  const isDeal = action === "deal_invoice";
  // A mixed selection can only ever reach the DEAL door by accident: every work
  // order has a queue row, so `doorOf` answers 'pending' for all of them. The
  // guard is written for both anyway — a rule that applies to one button only
  // because of a fact about the other door is a rule waiting to be wrong.
  const blocked = mixed;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-3 text-xs border border-[var(--rule2)] rounded-xl px-3 py-2">
      <span>
        <span className="font-bold">
          נבחרו {rows.length} {isDeal ? "הזמנות עבודה" : "חשבונות עסקה"}
        </span>
        <span className="text-[var(--faint)]">
          {" · "}
          {money(sumSourceNet(rows))}
        </span>
      </span>

      {/* The refusal, where the combination was made — not three seconds later
          as a 400 from a server the operator cannot see. The button beside it
          goes dark in the same render, so the sentence and the dead control are
          one statement rather than two. */}
      {blocked && (
        <span className="text-[var(--warn)] basis-full" data-bundle-error="mixed">
          {TAX_BUNDLE_NOTICE.mixed_sources}
        </span>
      )}

      <span className="flex items-center gap-2">
        <button
          onClick={onClear}
          className="rounded-lg px-3 py-1 border border-[var(--rule)] text-[var(--faint)]"
        >
          נקה בחירה
        </button>
        <button
          data-bundle-submit={action}
          onClick={() => {
            // Belt beside the brace: the button is already disabled, and a click
            // that somehow arrives anyway must not start something the server
            // can only refuse.
            if (blocked) return;
            onBundle();
          }}
          disabled={busy || blocked}
          className="font-bold rounded-lg px-3 py-1 bg-[var(--signal)] text-white disabled:opacity-40"
          title={
            blocked
              ? TAX_BUNDLE_NOTICE.mixed_sources
              : isDeal
                ? "חשבון עסקה אחד שסוגר את כל ההזמנות שנבחרו"
                : "חשבונית מס אחת שסוגרת את כל המסמכים שנבחרו"
          }
        >
          {isDeal ? "צור חשבון עסקה מאוגד" : "צור חשבונית מס מאוגדת"} ({rows.length})
        </button>
      </span>
    </div>
  );
}
