import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { mustRows } from "@/lib/supabase/unwrap";
import AppHeader from "@/components/AppHeader";
import MiscClient, { type MiscRow, type SupplierLine, type MiscClientOption } from "./MiscClient";

export const dynamic = "force-dynamic";

/**
 * "רדיו ושונות" — the list screen for non-podcast work (step 3).
 *
 * ═══ PERMISSION: can_view_money, AND THIS SCREEN IS THE WALL ═══
 * Owner decision 2026-09-08: the screen is closed to technicians outright.
 * That is NARROWER than 0074's RLS policy, which is can_view_stages and stays
 * as it is — deliberately, and it does not make this file's gate decorative.
 * Two different questions:
 *
 *   RLS       who may read these tables through THEIR OWN session, e.g. a raw
 *             PostgREST call. Still can_view_stages. Unchanged here.
 *   this gate who may open /misc. can_view_money. The only thing standing
 *             between a request and the data on THIS route.
 *
 * The reason the gate is load-bearing rather than a second opinion: every read
 * below runs on the SERVICE ROLE, which bypasses RLS and every column grant by
 * construction. So the policy is not a safety net underneath this page — on
 * this path it is not consulted at all. The redirect three lines into the
 * component is the whole enforcement, which is exactly how /projects works
 * (projects/page.tsx:236-241, "a service-role read behind a money check").
 * A `can_view_money` check that is not the FIRST thing after the session lookup
 * is a bug in this file, not a style preference.
 *
 * ═══ WHY ONE SERVICE-ROLE READ AND NOT TWO CLIENTS ═══
 * The screen shows amount and supplier price, and 0074 grants SELECT column by
 * column to `authenticated` while deliberately never naming those two — they
 * are unreadable to any user session, including a money user's own. So the
 * service role was already required for the money columns. Once every viewer is
 * a money viewer there is nothing left for a second, RLS-bound client to fetch:
 * splitting the reads would buy a compartment with no one on the other side of
 * it, at the cost of a second round-trip and two code paths to keep in step.
 * clients rides along for the same reason (its RLS is can_view_money, 0021 —
 * satisfied by everyone who gets this far).
 */

type MiscDbRow = {
  id: string;
  client_id: string;
  name: string;
  work_date: string;
  client_order_ref: string | null;
  description: string | null;
  status: string;
  cancel_reason: string | null;
  job_id: string | null;
  amount: number | null;
  created_at: string;
};

type SupplierDbRow = {
  misc_production_id: string;
  supplier_name: string;
  service: string | null;
  price: number | null;
  due_date: string | null;
  paid_at: string | null;
};

/**
 * Paged, like every other unbounded read in this app, for the reason
 * productions/page.tsx states at length: PostgREST silently caps an unbounded
 * select at 1000 rows and returns NO error, so the day the cap is crossed is
 * the day a work list quietly starts omitting jobs. The cap is a PostgREST
 * default, not a privilege — the service role is capped exactly like any other.
 *
 * The table is empty today, so this is pure insurance — and it is the cheap
 * kind: one page is also the last page, and the loop exits after a single
 * round-trip until there is genuinely a second page.
 *
 * .order("id") and NOT .order("work_date"): the sort here exists to make the
 * PAGING sound, not to order the screen. Postgres does not guarantee a stable
 * row order across two requests, so without a unique tiebreak a row can repeat
 * on one page and vanish from another. work_date is not unique — several jobs
 * on one day is the normal case — so it cannot serve. The display sort
 * (work_date descending, as specified) is applied in JS once every page is in
 * hand, which is also the only place it can be correct across page boundaries.
 */
async function fetchAllPages<T>(
  run: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string; code?: string | null } | null }>,
  context: string
): Promise<T[]> {
  const page = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const res = await run(from, from + page - 1);
    const rows = mustRows({ data: res.data as T[] | null, error: res.error }, context);
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

export default async function MiscPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  // THE gate. Everything below is service-role and therefore unguarded by the
  // database — see the header. Nothing may be read before this line returns.
  if (!profile.can_view_money) redirect("/");

  const admin = createTypedAdminClient();

  // ONE wave: no read here takes an id or a filter from another. mustRows
  // (inside fetchAllPages) rather than `?? []`, because these reads ARE the
  // screen — a 42703 because 0074 has not been run on this environment must
  // surface as an error, not as "עדיין לא נרשמו עבודות". That exact swallow
  // cost a debugging round on 2026-08-12 (see lib/supabase/unwrap.ts).
  const [rows, supplierRows, clientsRes] = await Promise.all([
    fetchAllPages<MiscDbRow>(
      (from, to) =>
        admin
          .from("misc_productions")
          .select("id,client_id,name,work_date,client_order_ref,description,status,cancel_reason,job_id,amount,created_at")
          .order("id")
          .range(from, to),
      "טעינת עבודות רדיו ושונות"
    ),
    fetchAllPages<SupplierDbRow>(
      (from, to) =>
        admin
          .from("misc_production_suppliers")
          .select("misc_production_id,supplier_name,service,price,due_date,paid_at")
          .order("id")
          .range(from, to),
      "טעינת הספקים של עבודות רדיו ושונות"
    ),
    // morning_client_id rides along for the create modal, NOT for the table.
    // The route refuses an unmapped client outright — "iron rule: no issuance
    // without a Morning-mapped client" (route.ts:136-140) — and it is the only
    // rejection the operator cannot fix by retyping a field. Carrying the flag
    // lets the form say so while the client is being picked, instead of after
    // eight fields have been filled in. The id itself never leaves the server;
    // only the boolean does.
    admin.from("clients").select("id,name,morning_client_id"),
  ]);

  const clientRows = mustRows(
    clientsRes as {
      data: { id: string; name: string; morning_client_id: string | null }[] | null;
      error: { message: string; code?: string | null } | null;
    },
    "טעינת הלקוחות"
  );

  const clientNameById = new Map<string, string>();
  for (const c of clientRows) clientNameById.set(c.id, c.name);

  const clientOptions: MiscClientOption[] = clientRows
    .map((c) => ({ id: c.id, name: c.name, morningMapped: !!c.morning_client_id }))
    .sort((a, b) => a.name.localeCompare(b.name, "he"));

  const suppliersByJob = new Map<string, SupplierLine[]>();
  for (const s of supplierRows) {
    const arr = suppliersByJob.get(s.misc_production_id) ?? [];
    arr.push({
      supplier_name: s.supplier_name,
      service: s.service,
      price: s.price ?? null,
      due_date: s.due_date,
      paid: s.paid_at != null,
    });
    suppliersByJob.set(s.misc_production_id, arr);
  }

  // work_date descending, as specified. created_at is the tiebreak and NOT a
  // fallback: work_date is NOT NULL in 0074, so there is no dateless row to
  // fall back for — the tiebreak only decides the order of two jobs that
  // genuinely happened on the same day, newest entry first.
  //
  // Sorted on the DB rows, before the mapping, because created_at is not part
  // of what the client component is given: a comparator that had to look the
  // timestamp back up per comparison would be quadratic for a field the row
  // already carries right here.
  const sorted = [...rows].sort((a, b) =>
    a.work_date === b.work_date ? b.created_at.localeCompare(a.created_at) : a.work_date < b.work_date ? 1 : -1
  );

  const misc: MiscRow[] = sorted.map((r) => ({
    id: r.id,
    name: r.name,
    client_name: clientNameById.get(r.client_id) ?? null,
    work_date: r.work_date,
    amount: r.amount ?? null,
    status: r.status,
    client_order_ref: r.client_order_ref,
    description: r.description,
    cancel_reason: r.cancel_reason,
    // job_id alone is the truthful answer, because the create route makes it
    // so: every failure path after the job insert deletes the job and puts
    // job_id back to null (api/misc-productions/route.ts:206-240, :262-318).
    // There is no state in which job_id is set and no work order was queued.
    billed: r.job_id != null,
    suppliers: suppliersByJob.get(r.id) ?? [],
  }));

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      {/* can_edit_money and not can_view_money: the create route checks
          can_edit_money and nothing else (route.ts:57-58), so the button that
          calls it must be gated on the same flag. A viewer who can read this
          screen but not write is a real combination — the two are separate
          columns (0002) — and offering her a button whose only outcome is a
          403 would be a lie told by the UI. */}
      <MiscClient rows={misc} clients={clientOptions} canEditMoney={profile.can_edit_money} />
    </div>
  );
}
