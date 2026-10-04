import { israelMonthKey } from "@/lib/dates";
import { hasBeenPerformed } from "@/lib/productions/status";
import { STUDIOS } from "@/lib/calendar/studios";
import { missingGuestLines } from "@/lib/documents/guestFlag";
import type { AccruedGroup, AccruedMonth, AccruedRow } from "@/app/documents/accrued/AccruedClient";

/**
 * THE CARDS OF THE REDEMPTION SCREEN, as a pure function of its rows.
 *
 * Owner decision 2026-10-04: a monthly client gets one card per RECORDING
 * MONTH, and redeeming a card folds only that month. per_episode and every_n
 * are untouched — one card per client, as before.
 *
 * ⚠️ WHY THIS LEFT page.tsx.
 * The grouping lived inside the async server component, which needs a session
 * and the database to run. That made the split unverifiable: F19 forbids
 * touching the database, there is no Morning sandbox, and an HTTP suite that
 * greps the rendered HTML proves the server rendered and nothing about which
 * rows went into which card. The money question here — "does September's work
 * order still contain exactly September" — is answerable only against a pure
 * function, so the grouping became one. scripts/test_accrued_months.ts is that
 * answer; the page now just feeds it rows.
 *
 * It is also the half of the split that has to agree with the OTHER half:
 * /api/documents/redeem re-selects straight from the database and never sees
 * what was rendered, so a card drawn here must correspond to exactly the set
 * of rows rowsInAccruedMonth will fold there. Both read israelMonthKey, and
 * that is the whole of the agreement.
 */

/** One accrued queue row as the screen reads it — the raw Supabase join shape. */
export type AccruedQueueRow = {
  id: string;
  amount: number | null;
  created_at: string;
  client_id: string | null;
  production_id?: string | null;
  payload?: { income?: { description?: string }[] } | null;
  clients?: { name?: string | null; billing_cadence?: string | null; billing_every_n?: number | null } | null;
  productions?: {
    podcast_name?: string | null;
    record_date?: string | null;
    guest?: string | null;
    status?: string | null;
    cancelled_at?: string | null;
  } | null;
};

/**
 * "YYYY-MM" -> "אוקטובר 2026".
 *
 * timeZone UTC against a UTC-midnight string, deliberately: the input is a
 * month, not an instant, and rendering it in Asia/Jerusalem would be asking a
 * zone question about a value that has no time in it. Unchanged from the
 * screen's own formatter.
 */
const MONTH_LABEL = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", month: "long", year: "numeric" });
export const monthLabel = (key: string) => MONTH_LABEL.format(new Date(`${key}-01T00:00:00Z`));

/** The card a row belongs to. The ONLY place the split is decided. */
export function cardKeyFor(clientId: string, cadence: string, monthKey: string): string {
  // every_n's whole point is a count ACROSS months ("4 of 6"), so splitting its
  // rows by month would break the full-bundle test below and the radar's
  // bundleFull, which reads the same rule. per_episode reaches this screen only
  // through a cadence change on rows that were already accrued. Neither may
  // move; the cadence is the only thing allowed to decide this.
  return cadence === "monthly" ? `${clientId}:${monthKey}` : clientId;
}

export type BuildAccruedCardsOptions = {
  /** "YYYY-MM" in Israel time — a month strictly before this one has closed. */
  currentMonth: string;
  /** Days left in the current Israel month; the only "target" a monthly client has. */
  daysToMonthEnd: number;
  /** Clock for the age columns, injected so the tests are not time-dependent. */
  now: number;
};

export function buildAccruedCards(
  rows: AccruedQueueRow[],
  { currentMonth, daysToMonthEnd, now }: BuildAccruedCardsOptions
): AccruedGroup[] {
  const byCard = new Map<string, AccruedGroup>();
  // per CARD: month key -> what accrued in it. For a monthly card that is now
  // exactly one entry (its own month); for the others it is unchanged.
  const monthsByCard = new Map<string, Map<string, { count: number; total: number }>>();

  for (const r of rows) {
    const clientId = r.client_id ?? "—";
    const client = r.clients ?? null;
    const prod = r.productions ?? null;

    // Only work that has actually happened is accrued (owner 2026-08-24). An
    // episode merely scheduled in the calendar already gets its accrued queue
    // row at creation — enqueueDocument decides on billing_cadence alone and
    // never looks at status — so before this filter a future episode sat in
    // the redemption pile as if it were owed. The SAME predicate runs in
    // redeem/route.ts: filtering only here would show four episodes while the
    // redemption folded five.
    if (!hasBeenPerformed(prod?.status ?? null, prod?.cancelled_at ?? null)) continue;

    const ageDays = Math.floor((now - new Date(r.created_at).getTime()) / 86_400_000);
    const cadence = (client?.billing_cadence as AccruedGroup["cadence"]) ?? "per_episode";
    const mk = israelMonthKey(prod?.record_date ?? null, r.created_at);
    const cardKey = cardKeyFor(clientId, cadence, mk);

    let g = byCard.get(cardKey);
    if (!g) {
      g = {
        card_key: cardKey,
        client_id: clientId,
        client_name: client?.name ?? "—",
        cadence,
        every_n: client?.billing_every_n ?? null,
        // Set for a monthly card and null for every other cadence. This is
        // what the client component tests to decide whether to put the month
        // in the title, and what the "פדה" button sends to the route — so a
        // non-monthly card cannot accidentally ask for a month-scoped
        // redemption, because it has no month to ask with.
        month_key: cadence === "monthly" ? mk : null,
        month_label: cadence === "monthly" ? monthLabel(mk) : null,
        total: 0,
        oldest_age_days: 0,
        rows: [],
      };
      byCard.set(cardKey, g);
    }
    g.total += Number(r.amount ?? 0);
    g.oldest_age_days = Math.max(g.oldest_age_days, ageDays);

    let months = monthsByCard.get(cardKey);
    if (!months) {
      months = new Map();
      monthsByCard.set(cardKey, months);
    }
    const bucket = months.get(mk) ?? { count: 0, total: 0 };
    bucket.count += 1;
    bucket.total += Number(r.amount ?? 0);
    months.set(mk, bucket);

    const row: AccruedRow = {
      id: r.id,
      amount: r.amount ?? null,
      show_name: prod?.podcast_name ?? "—",
      record_date: prod?.record_date ?? null,
      guest: prod?.guest ?? null,
      // An accrued work order is always one production and one income line, so
      // `[guest]` against income[0] is the whole check here — the bundle's
      // per-line resolution belongs to the approvals screen, where a bundle can
      // actually appear.
      guest_missing:
        missingGuestLines(
          [prod?.guest ?? null],
          (r.payload?.income ?? []).map((l) => l.description),
          STUDIOS
        ).length > 0,
      age_days: ageDays,
    };
    g.rows.push(row);
  }

  // Ready-to-redeem, per cadence — the two rhythms answer different questions
  // and one shared threshold got both wrong (owner 2026-08-02):
  //   every_n  — the bundle is FULL (its actual target), or it has stalled 30+
  //              days and will plainly never fill (a show that ended at 2/6).
  //   monthly  — a month CLOSED without being redeemed. Not "30 days since the
  //              row", which for an episode recorded on the 30th only fires
  //              almost a month after that month ended.
  const cards = Array.from(byCard.values()).map((g) => {
    const months: AccruedMonth[] = Array.from(monthsByCard.get(g.card_key) ?? [])
      .map(([key, b]) => ({ key, label: monthLabel(key), count: b.count, total: b.total, closed: key < currentMonth }))
      .sort((a, b) => a.key.localeCompare(b.key));
    // A monthly card covers ONE month, so "did it close" is a fact about the
    // card and not a search across months. `has_closed_month` is still derived
    // from `months` for the other cadences, and both are still sent: a browser
    // tab holding the previous JS chunk reads `months` and would crash on its
    // absence (the exact skew scripts/test_projects_render.tsx was written
    // for), so the field is kept rather than removed.
    const monthClosed = g.month_key != null && g.month_key < currentMonth;
    return {
      ...g,
      months,
      month_closed: monthClosed,
      has_closed_month: months.some((m) => m.closed),
      days_to_month_end: daysToMonthEnd,
      ready:
        g.cadence === "every_n"
          ? (g.every_n != null && g.rows.length >= g.every_n) || g.oldest_age_days >= 30
          : g.cadence === "monthly"
            ? // THIS card's month, not "any month of this client's". Under the
              // old reading one closed month turned the client's single card
              // amber and the whole pile looked due; now September is ready
              // and October, correctly, is not.
              monthClosed
            : g.oldest_age_days >= 30,
    };
  });

  // Unchanged ordering rules — ready first, then the oldest — with the month
  // ascending as the tiebreak, so a client's two cards always read oldest
  // month first. localeCompare on "YYYY-MM" puts 2026-12 before 2027-01; a
  // sort on the month NUMBER would put January first and bury the older debt.
  cards.sort(
    (a, b) =>
      Number(b.ready) - Number(a.ready) ||
      b.oldest_age_days - a.oldest_age_days ||
      (a.month_key ?? "").localeCompare(b.month_key ?? "")
  );
  return cards;
}
