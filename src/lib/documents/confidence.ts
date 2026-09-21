import type { Confidence, AmountBasis } from "@/lib/documents/reconcile";

// How a match's confidence is shown to the bookkeeper before she confirms
// (owner rule 2026-07-26: "show the confidence clearly so Shiri knows how much
// to trust it"). The date gap is always surfaced — a perfect client+amount
// match with an 80-day gap is still HIGH confidence here, the gap is just
// disclosed so she can judge.
/**
 * How the amount basis is said, on its own.
 *
 * Split out of confidenceLabel 2026-09-21 (F14 stage B) because the payment
 * approval list wants this phrase WITHOUT the date gap glued to it — it shows
 * the gap in its own column, and `detail` would have printed it twice. Same
 * words, one definition: confidenceLabel below now reads it from here, so the
 * approval screen and the gaps screen cannot drift into two phrasings of one
 * idea. Behaviour of confidenceLabel is unchanged.
 */
export function amountBasisLabel(amountBasis: AmountBasis): string {
  return amountBasis === "vat" ? "סכום מדויק כולל מע״מ" : "סכום מדויק לפני מע״מ";
}

export function confidenceLabel(
  confidence: Confidence,
  dateGapDays: number | null,
  amountBasis: AmountBasis
): { title: string; detail: string; color: string } {
  const gap = dateGapDays == null ? "תאריך לא ידוע" : `${dateGapDays} יום פער`;
  const basis = amountBasisLabel(amountBasis);
  switch (confidence) {
    case "high":
      return { title: "התאמה גבוהה", detail: `לקוח + ${basis} · ${gap}`, color: "var(--green)" };
    case "medium":
      return { title: "התאמה בינונית", detail: `לקוח + ${basis}, כמה מועמדים דומים · ${gap}`, color: "var(--warn)" };
    case "low":
      return { title: "התאמה נמוכה", detail: `${basis}, ללא לקוח מאומת · ${gap}`, color: "var(--faint)" };
  }
}
