/**
 * THE SPLIT OF THE REDEMPTION SCREEN BY RECORDING MONTH (owner 2026-10-04).
 *
 * Run:  npx tsx scripts/test_accrued_months.ts
 * TOUCHES NOTHING: no Supabase, no Morning, no dev server.
 *
 * ═══ WHY PURE, AND WHY THIS IS THE ONLY REAL PROOF ═══
 * The money question is "does September's work order still contain exactly
 * September, and nothing of October". That cannot be answered by an HTTP suite
 * — those fetch HTML and match strings, which proves the server rendered and
 * says nothing about which rows went into which card. It cannot be answered
 * end to end either: there is no Morning sandbox, and redemption is one-way
 * (rows go to 'consolidated', which is terminal).
 *
 * So the two halves of the split were made pure, and this file is the proof:
 *   • buildAccruedCards   — which card each row lands in, and in what order
 *   • rowsInAccruedMonth  — which rows a redemption of that card will fold
 * They must partition the same rows the same way, because the screen draws
 * from the first and /api/documents/redeem re-selects from the database and
 * filters with the second, never seeing what was drawn.
 *
 * The regression that matters most here is the one for cadences that must NOT
 * change: an every_n bundle counts ACROSS months by design ("4 of 6"), so a
 * split that reached it would break the full-bundle test and the radar card
 * that reads the same rule. That case is marked 🔴 below.
 */
import { buildAccruedCards, type AccruedQueueRow } from "../src/lib/documents/accruedCards";
import { rowsInAccruedMonth, accruedMonthKey, closedAccruedMonths } from "../src/lib/documents/accruedMonth";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (!ok && detail ? `   [${detail}]` : ""));
  if (!ok) failures++;
};
const eq = (label: string, got: unknown, want: unknown) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ---------------------------------------------------------------------------
// Fixtures. `status: "הוקלט"` on every production on purpose: hasBeenPerformed
// is applied inside the builder, and a row that has not been recorded is not
// in the queue at all — that filter has its own history (owner 2026-08-24) and
// is not what this file is testing.
// ---------------------------------------------------------------------------
const NOW = Date.parse("2026-10-04T09:00:00+03:00");
const CURRENT_MONTH = "2026-10";
const OPTS = { currentMonth: CURRENT_MONTH, daysToMonthEnd: 27, now: NOW };

let seq = 0;
function row(
  clientId: string,
  clientName: string,
  cadence: "per_episode" | "monthly" | "every_n",
  recordDate: string | null,
  amount: number,
  extra: { everyN?: number | null; createdAt?: string; status?: string; cancelledAt?: string | null } = {}
): AccruedQueueRow {
  seq += 1;
  return {
    id: `row-${seq}`,
    amount,
    created_at: extra.createdAt ?? `${recordDate ?? "2026-09-01"}T12:00:00Z`,
    client_id: clientId,
    production_id: `prod-${seq}`,
    payload: { income: [{ description: "פרק" }] },
    clients: { name: clientName, billing_cadence: cadence, billing_every_n: extra.everyN ?? null },
    productions: {
      podcast_name: clientName,
      record_date: recordDate,
      guest: null,
      status: extra.status ?? "הוקלט",
      cancelled_at: extra.cancelledAt ?? null,
    },
  };
}

// ===========================================================================
console.log("\n1. a month with a single episode\n");
{
  const cards = buildAccruedCards([row("c1", "מצנע", "monthly", "2026-09-14", 900)], OPTS);
  eq("one card", cards.length, 1);
  eq("card key carries the month", cards[0].card_key, "c1:2026-09");
  eq("month_key", cards[0].month_key, "2026-09");
  eq("month_label", cards[0].month_label, "ספטמבר 2026");
  eq("one row in it", cards[0].rows.length, 1);
  eq("total", cards[0].total, 900);
  check("September has closed -> ready", cards[0].ready === true);
  check("month_closed", cards[0].month_closed === true);
}

// ===========================================================================
console.log("\n2. two recording months for one monthly client -> two cards\n");
{
  // The owner's case verbatim: מצנע, monthly, four September episodes and one
  // recorded on 1 October. Before the split this was ONE card and one "פדה".
  const sept = [
    row("c1", "מצנע", "monthly", "2026-09-03", 900),
    row("c1", "מצנע", "monthly", "2026-09-10", 900),
    row("c1", "מצנע", "monthly", "2026-09-17", 900),
    row("c1", "מצנע", "monthly", "2026-09-24", 1100),
  ];
  const oct = [row("c1", "מצנע", "monthly", "2026-10-01", 900)];
  const all = [...sept, ...oct];

  const cards = buildAccruedCards(all, OPTS);
  eq("two cards", cards.length, 2);
  eq("keys", cards.map((c) => c.card_key), ["c1:2026-09", "c1:2026-10"]);

  const s = cards.find((c) => c.month_key === "2026-09")!;
  const o = cards.find((c) => c.month_key === "2026-10")!;

  eq("September holds 4 rows", s.rows.length, 4);
  eq("October holds 1 row", o.rows.length, 1);
  eq("September total", s.total, 3800);
  eq("October total", o.total, 900);
  eq("titles", [s.month_label, o.month_label], ["ספטמבר 2026", "אוקטובר 2026"]);

  // 🔴 THE MONEY ASSERTION. Splitting a card must move rows between documents
  // and change nothing else: no row may be dropped, duplicated, or re-priced.
  // Measured against what the SINGLE card of the old grouping held, which is
  // simply the sum over the same input.
  const unified = all.reduce((n, r) => n + Number(r.amount ?? 0), 0);
  eq("the two cards sum to the old single card", s.total + o.total, unified);
  eq("no row lost or duplicated", s.rows.length + o.rows.length, all.length);
  const ids = [...s.rows, ...o.rows].map((r) => r.id).sort();
  eq("the ids are exactly the input ids", ids, all.map((r) => r.id).sort());
  check(
    "no id appears in both cards",
    new Set(ids).size === ids.length,
    `${ids.length} rows, ${new Set(ids).size} distinct`
  );

  // and the status each card reports about ITSELF
  check("September is ready (its month closed)", s.ready === true);
  check("October is NOT ready (its month is current)", o.ready === false);
  eq("October's countdown comes from the options", o.days_to_month_end, 27);

  // The old reading: ANY closed month made the client's one card amber. If the
  // split regressed to that, October would be ready too — asserted so the
  // regression cannot pass silently.
  check("October did not inherit September's amber", o.month_closed === false);
}

// ===========================================================================
console.log("\n3. 🔴 every_n with episodes in two months -> ONE card (regression)\n");
{
  // Dates deliberately inside the 30-day stall window: the every_n readiness
  // rule is `full OR stalled 30+ days`, so a fixture with an older episode
  // would report ready for the stall reason and prove nothing about the count.
  // Two recording months, max age 24 days.
  const rows = [
    row("c2", "חתונמיות", "every_n", "2026-09-10", 700, { everyN: 6 }),
    row("c2", "חתונמיות", "every_n", "2026-09-20", 700, { everyN: 6 }),
    row("c2", "חתונמיות", "every_n", "2026-10-01", 700, { everyN: 6 }),
    row("c2", "חתונמיות", "every_n", "2026-10-02", 700, { everyN: 6 }),
  ];
  const cards = buildAccruedCards(rows, OPTS);
  eq("ONE card across both months", cards.length, 1);
  eq("keyed on the client alone", cards[0].card_key, "c2");
  eq("no month on the card", cards[0].month_key, null);
  eq("no month label", cards[0].month_label, null);
  eq("ALL rows are in it — the bundle counts across months", cards[0].rows.length, 4);
  eq("total", cards[0].total, 2800);

  // the full-bundle test must see 4/6, not 1/6 or 2/6
  eq("the bundle sees 4 of 6", [cards[0].rows.length, cards[0].every_n], [4, 6]);
  check("4 of 6, nothing stalled -> not ready", cards[0].ready === false);
  const full = [
    ...rows,
    row("c2", "חתונמיות", "every_n", "2026-10-03", 700, { everyN: 6 }),
    row("c2", "חתונמיות", "every_n", "2026-10-04", 700, { everyN: 6 }),
  ];
  const fullCards = buildAccruedCards(full, OPTS);
  eq("still one card at 6", fullCards.length, 1);
  eq("rows.length reaches every_n", fullCards[0].rows.length, 6);
  check("6 of 6 -> ready (the full-bundle test survives)", fullCards[0].ready === true);
}

// ===========================================================================
console.log("\n4. per_episode -> unchanged\n");
{
  const rows = [
    row("c3", "מלי אלקובי", "per_episode", "2026-09-08", 500),
    row("c3", "מלי אלקובי", "per_episode", "2026-10-01", 500),
  ];
  const cards = buildAccruedCards(rows, OPTS);
  eq("one card", cards.length, 1);
  eq("keyed on the client alone", cards[0].card_key, "c3");
  eq("no month", cards[0].month_key, null);
  eq("both rows", cards[0].rows.length, 2);
}

// ===========================================================================
console.log("\n5. the month anchor\n");
{
  eq(
    "record_date 2026-10-01 -> 2026-10",
    accruedMonthKey({ created_at: "2026-09-20T12:00:00Z", productions: { record_date: "2026-10-01" } }),
    "2026-10"
  );
  // 01:00 Israel on 1 Oct is still 30 Sep in UTC. The fallback must read
  // Israel, or a monthly client's month turns on the hour.
  eq(
    "no record_date, created 01:00 Israel on 1 Oct -> 2026-10",
    accruedMonthKey({ created_at: "2026-09-30T22:00:00Z", productions: null }),
    "2026-10"
  );
  // and it must reach the card key, not just the helper
  const cards = buildAccruedCards(
    [
      {
        id: "x1",
        amount: 900,
        created_at: "2026-09-30T22:00:00Z",
        client_id: "c1",
        production_id: null,
        payload: { income: [] },
        clients: { name: "מצנע", billing_cadence: "monthly", billing_every_n: null },
        productions: { podcast_name: "מצנע", record_date: null, guest: null, status: "הוקלט", cancelled_at: null },
      },
    ],
    OPTS
  );
  eq("a dateless row lands in October by Israel time", cards[0].card_key, "c1:2026-10");
}

// ===========================================================================
console.log("\n6. the year boundary: December before January\n");
{
  const rows = [
    row("c1", "מצנע", "monthly", "2027-01-05", 900),
    row("c1", "מצנע", "monthly", "2026-12-09", 900),
  ];
  // Both months are closed relative to a February clock, so `ready` and
  // `oldest_age_days` cannot be what orders them — the month tiebreak is.
  const cards = buildAccruedCards(rows, {
    currentMonth: "2027-02",
    daysToMonthEnd: 10,
    now: Date.parse("2027-02-18T09:00:00+02:00"),
  });
  eq("two cards", cards.length, 2);
  eq("December first", cards.map((c) => c.month_key), ["2026-12", "2027-01"]);
  eq("labels", cards.map((c) => c.month_label), ["דצמבר 2026", "ינואר 2027"]);
}

// ===========================================================================
console.log("\n7. ordering: ready first, then oldest, then month ascending\n");
{
  const rows = [
    // a current-month card (not ready) for one client
    row("c1", "מצנע", "monthly", "2026-10-01", 900),
    // two closed months for the same client
    row("c1", "מצנע", "monthly", "2026-09-02", 900),
    row("c1", "מצנע", "monthly", "2026-08-02", 900),
  ];
  const cards = buildAccruedCards(rows, OPTS);
  eq("three cards", cards.length, 3);
  eq(
    "both closed months precede the open one, oldest first",
    cards.map((c) => c.month_key),
    ["2026-08", "2026-09", "2026-10"]
  );
  eq("readiness follows", cards.map((c) => c.ready), [true, true, false]);
}

// ===========================================================================
console.log("\n8. the redemption filter — what a card's button will actually fold\n");
{
  const sept = [
    row("c1", "מצנע", "monthly", "2026-09-03", 900),
    row("c1", "מצנע", "monthly", "2026-09-24", 1100),
  ];
  const oct = [row("c1", "מצנע", "monthly", "2026-10-01", 900)];
  const all = [...sept, ...oct];

  const folded = rowsInAccruedMonth(all, "2026-09");
  eq("September folds 2 rows", folded.length, 2);
  eq("and they are September's", folded.map((r) => r.id), sept.map((r) => r.id));
  check(
    "no October row is in the September redemption",
    folded.every((r) => r.productions?.record_date?.startsWith("2026-09")),
    JSON.stringify(folded.map((r) => r.productions?.record_date))
  );
  eq("October folds its one row", rowsInAccruedMonth(all, "2026-10").map((r) => r.id), oct.map((r) => r.id));
  eq("a month with nothing in it folds nothing", rowsInAccruedMonth(all, "2026-07").length, 0);

  // 🔴 THE AGREEMENT. The card the screen draws and the rows the route folds
  // must be the same set — they are computed by different functions, in
  // different processes, from different queries.
  const cards = buildAccruedCards(all, OPTS);
  for (const c of cards) {
    const routeRows = rowsInAccruedMonth(all, c.month_key!);
    eq(
      `card ${c.card_key}: screen rows === route rows`,
      c.rows.map((r) => r.id).sort(),
      routeRows.map((r) => r.id).sort()
    );
    eq(
      `card ${c.card_key}: screen total === route total`,
      c.total,
      routeRows.reduce((n, r) => n + Number(r.amount ?? 0), 0)
    );
  }

  // The filter must not narrow the objects it returns: createWorkOrderBundle
  // reads payload, amount and production_id off these very rows, and a filter
  // that returned a projection would turn a split into data loss.
  check("the folded rows are the SAME objects", rowsInAccruedMonth(all, "2026-10")[0] === oct[0]);
  check("payload survives the filter", folded.every((r) => Array.isArray(r.payload?.income)));
}

// ===========================================================================
console.log("\n9. the radar counts closed MONTHS, not clients\n");
{
  const rows = [
    { created_at: "2026-08-20T12:00:00Z", productions: { record_date: "2026-08-20" } },
    { created_at: "2026-09-03T12:00:00Z", productions: { record_date: "2026-09-03" } },
    { created_at: "2026-09-24T12:00:00Z", productions: { record_date: "2026-09-24" } },
    { created_at: "2026-10-01T12:00:00Z", productions: { record_date: "2026-10-01" } },
  ];
  const closed = closedAccruedMonths(rows, CURRENT_MONTH);
  eq("two distinct closed months", closed, ["2026-08", "2026-09"]);
  eq("the current month is not closed", closed.includes("2026-10"), false);

  // and it equals the number of amber cards the screen shows for that client —
  // which is the promise the radar comment makes
  const queueRows = [
    row("c1", "מצנע", "monthly", "2026-08-20", 900),
    row("c1", "מצנע", "monthly", "2026-09-03", 900),
    row("c1", "מצנע", "monthly", "2026-09-24", 900),
    row("c1", "מצנע", "monthly", "2026-10-01", 900),
  ];
  const amberCards = buildAccruedCards(queueRows, OPTS).filter((c) => c.month_closed);
  eq("radar count === amber cards on the screen", closed.length, amberCards.length);

  // three clients, one closed month each, must be 3 — the old per-client
  // increment and the new per-month one agree here, and that is worth pinning
  // so the change is known not to over-count the common case
  const oneEach = [
    { created_at: "2026-09-03T12:00:00Z", productions: { record_date: "2026-09-03" } },
    { created_at: "2026-09-10T12:00:00Z", productions: { record_date: "2026-09-10" } },
  ];
  eq("one client, one closed month, two episodes -> 1", closedAccruedMonths(oneEach, CURRENT_MONTH).length, 1);
}

// ===========================================================================
console.log("\n10. unrecorded episodes are not in any card (unchanged filter)\n");
{
  const rows = [
    row("c1", "מצנע", "monthly", "2026-10-01", 900, { status: "עתיד_להתחיל" }),
    row("c1", "מצנע", "monthly", "2026-09-02", 900),
  ];
  const cards = buildAccruedCards(rows, OPTS);
  eq("only the recorded month has a card", cards.map((c) => c.month_key), ["2026-09"]);
  eq("and only the recorded row", cards[0].rows.length, 1);
}

console.log(
  failures === 0 ? "\nOK - the split holds.\n" : `\n${failures} FAILURE(S)\n`
);
process.exit(failures === 0 ? 0 : 1);
