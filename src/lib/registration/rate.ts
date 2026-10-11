/**
 * Owner decision 11.10: a podcast billed PER EPISODE must carry a price, and
 * the price must be above 0 — on the approval screen and on "new podcast"
 * under a matched registration. PURE, and shared by the form (before the
 * request) and by `validateShowInput` (the server), so both say the same.
 */
export const RATE_REQUIRED_ERROR = "בחיוב לפי פרק חובה למלא מחיר גדול מ-0.";

export function perEpisodeRateError(billingMode: unknown, rate: unknown): string | null {
  if (billingMode !== "per_episode") return null;
  if (rate === null || rate === undefined || (typeof rate === "string" && rate.trim() === "")) return RATE_REQUIRED_ERROR;
  const n = Number(rate);
  return Number.isFinite(n) && n > 0 ? null : RATE_REQUIRED_ERROR;
}
