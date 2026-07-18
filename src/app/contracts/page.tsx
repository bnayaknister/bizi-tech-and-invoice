import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import { deriveMilestoneState } from "@/lib/finance/milestone";
import ContractsClient, { type ContractCard } from "./ContractsClient";

export const dynamic = "force-dynamic";

export default async function ContractsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_money) redirect("/"); // money-only screen

  const admin = createAdminClient();
  const [{ data: contracts }, { data: milestones }, { data: clients }, { data: jobs }] = await Promise.all([
    admin.from("contracts").select("id,name,client_id,total_amount,status").order("created_at"),
    admin
      .from("contract_milestones")
      .select("id,contract_id,name,amount,expected_date,is_estimated,status,job_id")
      .order("expected_date", { nullsFirst: true }),
    admin.from("clients").select("id,name"),
    admin.from("jobs").select("id,invoice_biz,invoice_tax,date,paid"),
  ]);

  const clientName = new Map((clients ?? []).map((c) => [c.id, c.name]));
  const jobById = new Map((jobs ?? []).map((j) => [j.id, j]));

  const cards: ContractCard[] = (contracts ?? []).map((c) => {
    const ms = (milestones ?? []).filter((m) => m.contract_id === c.id);
    const milestoneCards = ms.map((m) => {
      const job = m.job_id ? jobById.get(m.job_id) : null;
      const state = deriveMilestoneState({
        status: m.status,
        expected_date: m.expected_date,
        is_estimated: m.is_estimated,
        jobPaid: job?.paid ?? null,
      });
      const invoiceNumber =
        state === "paid" ? job?.invoice_tax ?? job?.invoice_biz ?? null : job?.invoice_biz ?? null;
      return {
        id: m.id,
        name: m.name,
        amount: m.amount as number,
        expected_date: m.expected_date,
        is_estimated: m.is_estimated,
        state,
        invoice_number: invoiceNumber,
        invoice_date: state === "paid" || state === "invoiced" ? job?.date ?? null : null,
      };
    });
    const paidSum = milestoneCards.filter((m) => m.state === "paid").reduce((t, m) => t + m.amount, 0);
    return {
      id: c.id,
      name: c.name,
      client_name: c.client_id ? clientName.get(c.client_id) ?? null : null,
      total_amount: c.total_amount as number,
      paid_sum: paidSum,
      milestones: milestoneCards,
    };
  });

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main>
        <ContractsClient
          contracts={cards}
          clients={(clients ?? []) as { id: string; name: string }[]}
          canEditMoney={profile.can_edit_money}
        />
      </main>
    </div>
  );
}
