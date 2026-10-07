// The /clients list: everything it computes, as pure functions.
//
// Nothing here touches supabase. The screen's server component does the six
// `client_id` reads and hands the rows in; this module turns them into the
// list, and that is what makes the search / sort / filter / debt arithmetic
// testable without a database (F19 is still open).
//
// 🔴 THE DEBT NUMBER IS NOT SPELLED HERE. It comes from `isUnpaidDebt`
// (lib/finance/state.ts), the same function the /finance summary card and the
// radar's debtToCollect use. A client's debt that does not add up to the
// /finance total is a bug found with a calculator, and the only defence is for
// the three surfaces to call one function rather than three copies of a
// comparison. See the note on isUnpaidDebt for why it is `=== "לא"` and not
// `!== "כן"`.

import { isUnpaidDebt } from "@/lib/finance/state";

export type ClientRow = {
  id: string;
  name: string;
  normalized_name: string;
  morning_client_id: string | null;
  merged_into: string | null;
};

export type ShowRow = { id: string; name: string; client_id: string | null; active: boolean | null };

export type JobRow = {
  id: string;
  client_id: string | null;
  amount: number | null;
  paid: string | null;
  due_date: string | null;
  date: string | null;
  dismissed: boolean | null;
};

export type ClientListRow = {
  id: string;
  name: string;
  normalized_name: string;
  /** names of this client's ACTIVE shows — what makes the client "active" */
  activeShows: string[];
  /** sum of amount over unpaid, non-dismissed jobs. 0 means no open debt. */
  debt: number;
  /** how many of those are past their due date */
  overdueCount: number;
  /** worst overdue in days, or null when nothing is past due */
  worstOverdueDays: number | null;
  mapped: boolean;
  merged: boolean;
  /** the client's most recent job date (YYYY-MM-DD), or null */
  lastActivity: string | null;
};

export type ListScope = "active" | "all" | "merged";
export type ListSort = "name" | "debt" | "activity";

const amount = (v: number | null) => v ?? 0;

/**
 * Days past due, positive when overdue. Dates are compared as plain YYYY-MM-DD
 * calendar days through Date.UTC on the parsed parts — NOT `new Date(due) -
 * Date.now()`, which drifts by a day for an Asia/Jerusalem operator looking at
 * a UTC server near midnight. `today` is injected rather than read so the
 * arithmetic is a pure function of its inputs and the tests can pin a date.
 */
export function overdueDays(due: string, today: string): number | null {
  const a = parseDay(due);
  const b = parseDay(today);
  if (a == null || b == null) return null;
  return Math.round((b - a) / 86_400_000);
}

function parseDay(d: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * One row per client. `jobs` is filtered on `dismissed` HERE and nowhere else:
 * a soft-removed job is out of every money surface (0041), and letting it reach
 * the sum is how a dismissed test row turns into debt on a client's card.
 *
 * A job whose `client_id` is null belongs to no client and is dropped — it is
 * not "everyone's" debt. Those rows are the /documents/gaps population and
 * have their own screen.
 */
export function buildClientList(
  clients: ClientRow[],
  shows: ShowRow[],
  jobs: JobRow[],
  today: string
): ClientListRow[] {
  const showsByClient = new Map<string, string[]>();
  for (const s of shows) {
    if (!s.client_id || !s.active) continue;
    const arr = showsByClient.get(s.client_id) ?? [];
    arr.push(s.name);
    showsByClient.set(s.client_id, arr);
  }

  const debtByClient = new Map<string, { debt: number; overdueCount: number; worst: number | null }>();
  const lastByClient = new Map<string, string>();
  for (const j of jobs) {
    if (!j.client_id) continue;
    if (j.dismissed) continue;
    if (j.date && (lastByClient.get(j.client_id) ?? "") < j.date) lastByClient.set(j.client_id, j.date);
    if (!isUnpaidDebt(j)) continue;
    const acc = debtByClient.get(j.client_id) ?? { debt: 0, overdueCount: 0, worst: null };
    acc.debt += amount(j.amount);
    if (j.due_date) {
      const od = overdueDays(j.due_date, today);
      if (od != null && od > 0) {
        acc.overdueCount += 1;
        if (acc.worst == null || od > acc.worst) acc.worst = od;
      }
    }
    debtByClient.set(j.client_id, acc);
  }

  return clients.map((c) => {
    const d = debtByClient.get(c.id);
    return {
      id: c.id,
      name: c.name,
      normalized_name: c.normalized_name,
      activeShows: showsByClient.get(c.id) ?? [],
      debt: d?.debt ?? 0,
      overdueCount: d?.overdueCount ?? 0,
      worstOverdueDays: d?.worst ?? null,
      mapped: !!c.morning_client_id,
      merged: !!c.merged_into,
      lastActivity: lastByClient.get(c.id) ?? null,
    };
  });
}

/**
 * Scope, then search — in that order, because the counts the operator reads
 * ("5 לקוחות") must be the counts of what the table shows.
 *
 * ⚠️ MERGED ROWS ARE THEIR OWN SCOPE, never mixed into "all". A row with
 * `merged_into` was retired by a client merge (0051): it must not be billed and
 * must not be mapped to Morning, and the mapping screen learned the hard way
 * that counting those as ordinary clients made eight of nine rows look like
 * work waiting to be done (MorningClientsClient.tsx:84-86). So "הכול" means
 * every LIVE client, and the merged ones are a deliberate third view.
 */
export function filterClients(rows: ClientListRow[], scope: ListScope, q: string): ClientListRow[] {
  const inScope = rows.filter((r) => {
    if (scope === "merged") return r.merged;
    if (r.merged) return false;
    if (scope === "active") return r.activeShows.length > 0;
    return true;
  });
  const needle = normalizeSearch(q);
  if (!needle) return inScope;
  // matched against `normalized_name`, which is what the owner asked for and
  // what the unique index is built on (clients_normalized_name_idx): it already
  // collapses double spaces and niqud, so "גל  אורן" finds "גל אורן". The raw
  // name is matched too, so a search for a character normalisation strips still
  // works.
  return inScope.filter(
    (r) => r.normalized_name.includes(needle) || normalizeSearch(r.name).includes(needle)
  );
}

/** the same collapse `normalizeClientName` applies, for the query side */
function normalizeSearch(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Stable in every mode: the comparator always falls through to the name, so two
 * clients with the same debt (very common — zero) never swap places between
 * renders. `localeCompare("he")` so א comes before ב rather than by code point.
 */
export function sortClients(rows: ClientListRow[], sort: ListSort): ClientListRow[] {
  const byName = (a: ClientListRow, b: ClientListRow) => a.name.localeCompare(b.name, "he");
  const out = [...rows];
  if (sort === "debt") {
    // biggest debt first — the reason someone sorts by debt is to call them
    out.sort((a, b) => b.debt - a.debt || byName(a, b));
  } else if (sort === "activity") {
    // most recent first; never-active last, not first. A client with no job at
    // all is not "the most recently active", which is what a null-high sort
    // would say.
    out.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "") || byName(a, b));
  } else {
    out.sort(byName);
  }
  return out;
}

export const EMPTY_LIST = "אין לקוחות שמתאימים לחיפוש.";
export const NO_DEBT = "אין חוב פתוח";
export const NOT_MAPPED = "לא ממופה למורנינג";
