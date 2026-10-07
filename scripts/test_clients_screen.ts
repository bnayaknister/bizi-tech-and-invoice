/**
 * /clients — the pure half: the access gate, the ח.פ rule, and the list
 * arithmetic (debt, overdue, search, sort, scope).
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_clients_screen.ts
 *
 * ═══ F19 ═══
 * Creates nothing, writes nothing, reads no database, opens no socket, needs no
 * dev server — and in particular makes NO CALL TO MORNING. Everything under
 * test here is a function of its arguments. `validateTaxId` is the rule that
 * runs before any Morning write and it is tested directly; the write itself
 * (updateClient) is never reached from this file and is not imported.
 *
 * ═══ WHY THESE ASSERTIONS COUNT (rule 56) ═══
 * The risk in this screen is arithmetic and permissions, not layout. "The
 * client appears" passes when it appears twice; "debt is shown" passes when
 * debt is wrong. So every assertion is an exact value or an exact count, and
 * the debt rule is additionally pinned to /finance's own function rather than
 * to a number written out here.
 */
import { canSeeClients } from "../src/lib/clients/access";
import { TAX_ID_INVALID, TAX_ID_UNKNOWN, displayTaxId, validateTaxId } from "../src/lib/clients/taxId";
import {
  EMPTY_LIST,
  NOT_MAPPED,
  NO_DEBT,
  buildClientList,
  filterClients,
  overdueDays,
  sortClients,
  type ClientRow,
  type JobRow,
  type ShowRow,
} from "../src/lib/clients/overview";
import { isUnpaidDebt } from "../src/lib/finance/state";
import type { Profile } from "../src/lib/profile";

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}\n       got:  ${g}\n       want: ${w}`);
  }
}

const base: Omit<Profile, "role"> = {
  id: "00000000-0000-0000-0000-000000000000",
  name: "ZTEST",
  email: "ztest@example.com",
  approved: true,
  can_view_money: true,
  can_edit_money: true,
  can_view_stages: true,
  can_edit_stages: true,
  can_manage_users: true,
  can_import: true,
};

console.log("\n=== the gate: owner OR can_view_money, and nothing else ===");
{
  check("owner with money", canSeeClients({ ...base, role: "owner" }), true);
  // the case the owner named: a bookkeeper gets in WITHOUT being an owner.
  // An AND instead of an OR would fail exactly here and nowhere else.
  check(
    "bookkeeper with money, not owner",
    canSeeClients({ ...base, role: "bookkeeper" }),
    true
  );
  check("tech with money", canSeeClients({ ...base, role: "tech" }), true);
  // and the case the owner named the other way: no money sight -> out
  check(
    "tech WITHOUT can_view_money",
    canSeeClients({ ...base, role: "tech", can_view_money: false }),
    false
  );
  check(
    "bookkeeper WITHOUT can_view_money",
    canSeeClients({ ...base, role: "bookkeeper", can_view_money: false }),
    false
  );
  // an OWNER without can_view_money still gets in — that is the OR, stated
  check(
    "owner without can_view_money is still admitted (the OR)",
    canSeeClients({ ...base, role: "owner", can_view_money: false }),
    true
  );
  check("unapproved owner", canSeeClients({ ...base, role: "owner", approved: false }), false);
  check(
    "unapproved money viewer",
    canSeeClients({ ...base, role: "tech", approved: false }),
    false
  );
  check("null role with money", canSeeClients({ ...base, role: null }), true);
  check("null profile", canSeeClients(null), false);
  check("undefined profile", canSeeClients(undefined), false);
  // the 2026-09-15 habit: tsc believed the type, the bundle got undefined
  for (const [label, p] of [
    ["an empty object", {} as Profile],
    ["approved undefined", { ...base, role: "owner", approved: undefined as unknown as boolean }],
    ["can_view_money undefined", { ...base, role: "tech", can_view_money: undefined as unknown as boolean }],
  ] as const) {
    let threw = false;
    let verdict: unknown = null;
    try {
      verdict = canSeeClients(p);
    } catch {
      threw = true;
    }
    check(`${label} -> no throw`, threw, false);
    // a real boolean, never a falsy undefined leaking into a permission answer
    check(`${label} -> a real boolean`, typeof verdict, "boolean");
  }
  check("an empty object is refused", canSeeClients({} as Profile), false);
}

console.log("\n=== ח.פ: exactly 9 digits, or an explicit clear ===");
{
  check("9 digits passes", validateTaxId("516006988"), { ok: true, value: "516006988", clears: false });
  check("8 digits is refused", validateTaxId("51600698"), { ok: false, error: TAX_ID_INVALID });
  check("10 digits is refused", validateTaxId("5160069881"), { ok: false, error: TAX_ID_INVALID });
  check("letters are refused", validateTaxId("51600698a"), { ok: false, error: TAX_ID_INVALID });
  check("hebrew letters are refused", validateTaxId("אבגדהוזחט"), { ok: false, error: TAX_ID_INVALID });
  check("9 digits with a dash is refused", validateTaxId("51600-988"), { ok: false, error: TAX_ID_INVALID });
  // a space in the MIDDLE is a different number; a space AROUND is copy-paste
  check("an inner space is refused", validateTaxId("51600 988"), { ok: false, error: TAX_ID_INVALID });
  check("surrounding space is trimmed, not refused", validateTaxId("  516006988 "), {
    ok: true,
    value: "516006988",
    clears: false,
  });
  // the explicit clear — "" on the wire, which is the ONLY thing that empties a
  // Morning text field (omitting the key means "leave as is")
  check("empty clears", validateTaxId(""), { ok: true, value: "", clears: true });
  check("whitespace clears", validateTaxId("   "), { ok: true, value: "", clears: true });
  // and the non-strings, which must be refused rather than coerced: a number
  // that lost a leading zero in JSON must never reach a tax document
  check("a number is refused, not stringified", validateTaxId(516006988), {
    ok: false,
    error: TAX_ID_INVALID,
  });
  check("null is refused", validateTaxId(null), { ok: false, error: TAX_ID_INVALID });
  check("undefined is refused", validateTaxId(undefined), { ok: false, error: TAX_ID_INVALID });
  check("an array is refused", validateTaxId(["516006988"]), { ok: false, error: TAX_ID_INVALID });
  // a leading zero survives, which is the whole reason strings are required
  check("a leading zero is preserved", validateTaxId("012345678"), {
    ok: true,
    value: "012345678",
    clears: false,
  });

  // the approved message and label, verbatim — asserted so a reword is a failure
  check("the invalid message is the approved wording", TAX_ID_INVALID, "ח.פ / ע.מ צריך להיות 9 ספרות.");
  check("the unknown label is the approved wording", TAX_ID_UNKNOWN, "לא ידוע");
  check("display of a value", displayTaxId("516006988"), "516006988");
  check("display of null", displayTaxId(null), TAX_ID_UNKNOWN);
  check("display of Morning's empty string", displayTaxId(""), TAX_ID_UNKNOWN);
  check("display of undefined", displayTaxId(undefined), TAX_ID_UNKNOWN);
}

console.log("\n=== the debt rule is /finance's, not a second spelling ===");
{
  // THE invariant. If someone "tidies" isUnpaidDebt into `!== "כן"`, the client
  // card and the /finance summary card part ways and this fails.
  check("only 'לא' is debt", isUnpaidDebt({ paid: "לא" }), true);
  check("'כן' is not debt", isUnpaidDebt({ paid: "כן" }), false);
  check("'ללא חיוב' is not debt", isUnpaidDebt({ paid: "ללא חיוב" }), false);
  check("'לא ידוע' is NOT debt (an unknown is not money owed)", isUnpaidDebt({ paid: "לא ידוע" }), false);
  check("null is not debt", isUnpaidDebt({ paid: null }), false);
}

const TODAY = "2026-10-07";

const clients: ClientRow[] = [
  { id: "c1", name: "גל אורן", normalized_name: "גל אורן", morning_client_id: "m1", merged_into: null },
  { id: "c2", name: "ידיעות אחרונות", normalized_name: "ידיעות אחרונות", morning_client_id: null, merged_into: null },
  { id: "c3", name: "זברה", normalized_name: "זברה", morning_client_id: null, merged_into: "c1" },
  { id: "c4", name: "אפרת", normalized_name: "אפרת", morning_client_id: "m4", merged_into: null },
];
const shows: ShowRow[] = [
  { id: "s1", name: "הפודקאסט של גל", client_id: "c1", active: true },
  { id: "s2", name: "תוכנית שנסגרה", client_id: "c1", active: false },
  { id: "s3", name: "ידיעות בבוקר", client_id: "c2", active: true },
  { id: "s4", name: "ללא לקוח", client_id: null, active: true },
];
const jobs: JobRow[] = [
  // c1: 1,000 unpaid and overdue by 7 days, 500 unpaid not yet due, 9,000 paid
  { id: "j1", client_id: "c1", amount: 1000, paid: "לא", due_date: "2026-09-30", date: "2026-09-01", dismissed: false },
  { id: "j2", client_id: "c1", amount: 500, paid: "לא", due_date: "2026-11-30", date: "2026-09-15", dismissed: false },
  { id: "j3", client_id: "c1", amount: 9000, paid: "כן", due_date: "2026-08-01", date: "2026-07-01", dismissed: false },
  // c1: a DISMISSED unpaid job — must not reach the debt, ever (0041)
  { id: "j4", client_id: "c1", amount: 7777, paid: "לא", due_date: "2026-01-01", date: "2026-01-01", dismissed: true },
  // c2: an unknown and a no-charge — neither is debt
  { id: "j5", client_id: "c2", amount: 300, paid: "לא ידוע", due_date: "2026-09-01", date: "2026-09-02", dismissed: false },
  { id: "j6", client_id: "c2", amount: 400, paid: "ללא חיוב", due_date: null, date: "2026-09-20", dismissed: false },
  // c2: an UNPRICED debt — a debt row that adds 0
  { id: "j7", client_id: "c2", amount: null, paid: "לא", due_date: "2026-10-01", date: "2026-10-01", dismissed: false },
  // an orphan job: belongs to nobody and is nobody's debt
  { id: "j8", client_id: null, amount: 5000, paid: "לא", due_date: "2026-01-01", date: "2026-01-01", dismissed: false },
];

console.log("\n=== overdue arithmetic ===");
{
  check("7 days past due", overdueDays("2026-09-30", TODAY), 7);
  check("today is not overdue", overdueDays(TODAY, TODAY), 0);
  check("a future due date is negative", overdueDays("2026-10-10", TODAY), -3);
  // across a month and a year boundary, where a naive day-count drifts
  check("across a month boundary", overdueDays("2026-09-07", TODAY), 30);
  check("across a year boundary", overdueDays("2025-10-07", TODAY), 365);
  check("a malformed date yields null, not NaN", overdueDays("not-a-date", TODAY), null);
}

console.log("\n=== the list rows ===");
{
  const rows = buildClientList(clients, shows, jobs, TODAY);
  check("one row per client, no more", rows.length, clients.length);
  check("row ids are distinct", rows.length, new Set(rows.map((r) => r.id)).size);

  const c1 = rows.find((r) => r.id === "c1")!;
  // 1000 + 500. NOT 10,500 (the paid job) and NOT 8,277 (the dismissed one).
  check("c1 debt is the unpaid, non-dismissed sum", c1.debt, 1500);
  check("c1 counts one overdue", c1.overdueCount, 1);
  check("c1 worst overdue is 7 days", c1.worstOverdueDays, 7);
  check("c1 active shows, by name", c1.activeShows, ["הפודקאסט של גל"]);
  check("c1 inactive show is NOT listed", c1.activeShows.includes("תוכנית שנסגרה"), false);
  check("c1 is mapped", c1.mapped, true);
  check("c1 last activity is the newest job date", c1.lastActivity, "2026-09-15");

  const c2 = rows.find((r) => r.id === "c2")!;
  // only j7, which is unpriced -> a debt row contributing 0
  check("c2 debt is 0 (unknown and no-charge are not debt)", c2.debt, 0);
  check("c2 still counts the unpriced debt as overdue", c2.overdueCount, 1);
  check("c2 is not mapped", c2.mapped, false);
  check("c2 last activity ignores nothing dismissible", c2.lastActivity, "2026-10-01");

  const c4 = rows.find((r) => r.id === "c4")!;
  check("a client with no jobs has 0 debt", c4.debt, 0);
  check("a client with no jobs has null last activity", c4.lastActivity, null);
  check("a client with no shows has an empty list", c4.activeShows, []);

  // the orphan job reached nobody
  check("no row absorbed the client-less job", rows.filter((r) => r.debt === 5000).length, 0);
  check(
    "total debt across rows equals the unpaid, owned, non-dismissed sum",
    rows.reduce((t, r) => t + r.debt, 0),
    1500
  );
}

console.log("\n=== scope: merged rows are their own view ===");
{
  const rows = buildClientList(clients, shows, jobs, TODAY);
  const active = filterClients(rows, "active", "");
  const all = filterClients(rows, "all", "");
  const merged = filterClients(rows, "merged", "");

  check("active = clients with an active show", active.map((r) => r.id), ["c1", "c2"]);
  // c4 has no show, so it is NOT active — but it is a live client
  check("all = every LIVE client, c4 included", all.map((r) => r.id), ["c1", "c2", "c4"]);
  // the one the owner asked for by name: the merged row is not in the main list
  check("a merged client appears 0 times in 'active'", active.filter((r) => r.id === "c3").length, 0);
  check("a merged client appears 0 times in 'all'", all.filter((r) => r.id === "c3").length, 0);
  check("the merged scope holds it exactly once", merged.filter((r) => r.id === "c3").length, 1);
  check("the merged scope holds nothing else", merged.map((r) => r.id), ["c3"]);
}

console.log("\n=== search ===");
{
  const rows = buildClientList(clients, shows, jobs, TODAY);
  const find = (q: string, scope: "active" | "all" = "all") =>
    filterClients(rows, scope, q).map((r) => r.id);

  check("an exact name", find("גל אורן"), ["c1"]);
  check("a prefix", find("ידיעות"), ["c2"]);
  check("a middle substring", find("אחרונות"), ["c2"]);
  // the whole reason the owner asked for normalized_name: a double space must
  // not change the answer (clients_normalized_name_idx collapses it)
  check("a double space still matches", find("גל  אורן"), ["c1"]);
  check("surrounding space still matches", find("  אפרת  "), ["c4"]);
  check("no match returns nothing", find("לא קיים"), []);
  check("an empty query returns the whole scope", find(""), ["c1", "c2", "c4"]);
  check("whitespace-only is an empty query", find("   "), ["c1", "c2", "c4"]);
  // search runs INSIDE the scope, never outside it: a merged client is not
  // findable from the main list
  check("a merged client is not searchable from 'all'", find("זברה"), []);
  check("...but is, in its own scope", filterClients(rows, "merged", "זברה").map((r) => r.id), ["c3"]);
  // scope first, then search — so the count shown is the count of what is shown
  check("search narrows within 'active'", find("אפרת", "active"), []);
}

console.log("\n=== sort ===");
{
  const rows = buildClientList(clients, shows, jobs, TODAY);
  const live = filterClients(rows, "all", "");
  check("by name, hebrew collation", sortClients(live, "name").map((r) => r.name), [
    "אפרת",
    "גל אורן",
    "ידיעות אחרונות",
  ]);
  check("by debt, biggest first", sortClients(live, "debt").map((r) => r.id), ["c1", "c4", "c2"]);
  check("by activity, most recent first", sortClients(live, "activity").map((r) => r.id), [
    "c2", // 2026-10-01
    "c1", // 2026-09-15
    "c4", // never
  ]);
  // never-active LAST, not first — a client with no job at all is not "the most
  // recently active", which is what a null-high sort would claim
  check("a never-active client sorts last", sortClients(live, "activity").at(-1)?.id, "c4");
  // ties fall through to the name, so the order cannot flicker between renders
  const tied = sortClients(live, "debt").filter((r) => r.debt === 0).map((r) => r.name);
  check("zero-debt ties are ordered by name", tied, ["אפרת", "ידיעות אחרונות"]);
  check("sorting does not drop or add rows", sortClients(live, "debt").length, live.length);
  // and it does not mutate its input — the screen re-sorts on every keystroke
  const before = live.map((r) => r.id);
  sortClients(live, "debt");
  check("sortClients does not mutate its argument", live.map((r) => r.id), before);
}

console.log("\n=== the approved wordings, verbatim ===");
{
  check("empty list", EMPTY_LIST, "אין לקוחות שמתאימים לחיפוש.");
  check("no debt", NO_DEBT, "אין חוב פתוח");
  check("not mapped", NOT_MAPPED, "לא ממופה למורנינג");
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
