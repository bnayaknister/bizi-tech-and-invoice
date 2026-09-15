import type { ModuleDef } from "@/modules/types";
import { deriveMilestoneState } from "@/lib/finance/milestone";

const money = (n: number) => `₪${Math.round(n).toLocaleString("he-IL")}`;

/** null and "" both mean "no document number" — same test as alerts.ts. */
const hasDocNumber = (v: unknown) => v != null && String(v).trim() !== "";

export const contractsModule: ModuleDef = {
  key: "contracts",
  title: "חוזים",
  icon: "contracts",
  href: "/contracts",
  hasAccess: (profile) => profile.approved && profile.can_view_money,
  getMetric: async (supabase) => {
    // Closed contracts are out of the number, same rule as the radar's open
    // commitment (alerts.ts, owner spec 2026-08-22) — the hub tile and the
    // radar must never quote two different open commitments.
    //
    // ═══ THE JOB DECIDES, NOT THE status COLUMN (owner decision 2026-09-15) ═══
    //
    // This tile used to filter `status = 'pending'` server-side, and that column
    // is not maintained: no issuance path advances it. On the day this changed it
    // reported ₪26,500 against ₪21,500 actually owed — the ₪5,000 difference
    // being a milestone invoiced, paid and receipted six days earlier and still
    // sitting at 'pending'. The radar computed the identical wrong number from
    // the identical column, so the two agreed with each other (which the note
    // below demands) while both contradicted /contracts, which had been deriving
    // from the job all along. Agreement between two copies of a bug is not the
    // invariant that note was asking for.
    //
    // The embed keeps this ONE round trip. A second query for the jobs would be
    // the obvious shape and is not needed: the FK lets PostgREST carry them,
    // the same way shows/page.tsx already pulls milestone counts.
    //
    // NOT `state === 'open'`: an invoiced-but-unpaid milestone is still an open
    // commitment, and openSum on /contracts counts it as one. Filtering to
    // 'open' would drop it here and put the two screens back in disagreement,
    // which is the whole failure being fixed.
    const [{ data }, { data: contracts }] = await Promise.all([
      supabase
        .from("contract_milestones")
        .select("amount,contract_id,status,expected_date,is_estimated,job_id,jobs(paid,invoice_biz,invoice_tax)"),
      supabase.from("contracts").select("id").eq("status", "active"),
    ]);
    const active = new Set((contracts ?? []).map((c) => c.id));
    type Embedded = {
      amount: number | null;
      contract_id: string;
      status: string;
      expected_date: string | null;
      is_estimated: boolean;
      job_id: string | null;
      // PostgREST returns a to-one embed as an object; typed loosely because the
      // generated types model it as either shape depending on the FK direction
      jobs: { paid: string | null; invoice_biz: string | null; invoice_tax: string | null } | null;
    };
    const total = ((data ?? []) as unknown as Embedded[])
      .filter((r) => active.has(r.contract_id))
      .filter(
        (r) =>
          deriveMilestoneState({
            status: r.status,
            expected_date: r.expected_date,
            is_estimated: r.is_estimated,
            jobPaid: r.jobs?.paid ?? null,
            jobBilled: hasDocNumber(r.jobs?.invoice_biz) || hasDocNumber(r.jobs?.invoice_tax),
          }) !== "paid"
      )
      .reduce((sum, r) => sum + (r.amount ?? 0), 0);
    return {
      label: "התחייבות פתוחה",
      value: money(total),
      tone: "default",
    };
  },
};
