import type { Confidence, AmountBasis } from "@/lib/documents/reconcile";

// How a match's confidence is shown to the bookkeeper before she confirms
// (owner rule 2026-07-26: "show the confidence clearly so Shiri knows how much
// to trust it"). The date gap is always surfaced — a perfect client+amount
// match with an 80-day gap is still HIGH confidence here, the gap is just
// disclosed so she can judge.
export function confidenceLabel(
  confidence: Confidence,
  dateGapDays: number | null,
  amountBasis: AmountBasis
): { title: string; detail: string; color: string } {
  const gap = dateGapDays == null ? "תאריך לא ידוע" : `${dateGapDays} יום פער`;
  const basis = amountBasis === "vat" ? "סכום מדויק כולל מע״מ" : "סכום מדויק לפני מע״מ";
  switch (confidence) {
    case "high":
      return { title: "התאמה גבוהה", detail: `לקוח + ${basis} · ${gap}`, color: "var(--green)" };
    case "medium":
      return { title: "התאמה בינונית", detail: `לקוח + ${basis}, כמה מועמדים דומים · ${gap}`, color: "var(--warn)" };
    case "low":
      return { title: "התאמה נמוכה", detail: `${basis}, ללא לקוח מאומת · ${gap}`, color: "var(--faint)" };
  }
}
