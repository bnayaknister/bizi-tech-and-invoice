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
  const [{ data: contracts }, { data: milestones }, { data: clients }, { data: jobs }, { data: queued }] =
    await Promise.all([
      admin.from("contracts").select("id,name,client_id,total_amount,status").order("created_at"),
      admin
        .from("contract_milestones")
        .select("id,contract_id,name,amount,expected_date,is_estimated,status,job_id")
        .order("expected_date", { nullsFirst: true }),
      // morning_client_id rides along so the screen can say WHY a milestone
      // cannot be issued instead of hiding the button — an unmapped client is
      // the one refusal the bookkeeper can fix herself.
      admin.from("clients").select("id,name,morning_client_id"),
      admin.from("jobs").select("id,invoice_biz,invoice_tax,date,paid"),
      // Whether a work order is already ON ITS WAY for a job. It cannot be read
      // off `jobs`: that table models the deal invoice (invoice_biz) and the tax
      // document (invoice_tax) and has no column for a 100 at all. A queued work
      // order lives only here, and 'pending' is in the list on purpose — it is
      // what makes the button disappear the moment it is clicked, not only once
      // Shiri approves.
      admin
        .from("pending_documents")
        .select("job_id,status")
        .eq("doc_type", "work_order")
        .not("job_id", "is", null)
        .in("status", ["pending", "approved", "issued"]),
    ]);

  const clientName = new Map((clients ?? []).map((c) => [c.id, c.name]));
  const clientMapped = new Map((clients ?? []).map((c) => [c.id, !!c.morning_client_id]));
  const jobById = new Map((jobs ?? []).map((j) => [j.id, j]));
  const jobsWithQueuedWorkOrder = new Set((queued ?? []).map((q) => q.job_id as string));

  // null and "" both mean "no document number" — a blank string is not one.
  const present = (v: unknown) => v != null && String(v).trim() !== "";

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
        status: m.status,
        state,
        job_id: m.job_id,
        // the linked job's number, shown whatever the state — an 'open'
        // milestone with a job attached was invisible before (owner 2026-08-22)
        job_number: job ? job.invoice_tax ?? job.invoice_biz ?? null : null,
        invoice_number: invoiceNumber,
        invoice_date: state === "paid" || state === "invoiced" ? job?.date ?? null : null,
        // The three facts the issue button needs, kept SEPARATE. The fields
        // above collapse both columns into one string (`invoice_tax ??
        // invoice_biz`), which is right for display and useless for a decision:
        // it cannot tell a job that has been billed from one that has not.
        has_work_order: !!(m.job_id && jobsWithQueuedWorkOrder.has(m.job_id)),
        has_deal_invoice: present(job?.invoice_biz),
        has_tax_document: present(job?.invoice_tax),
      };
    });
    const paidSum = milestoneCards.filter((m) => m.state === "paid").reduce((t, m) => t + m.amount, 0);
    return {
      id: c.id,
      name: c.name,
      client_id: c.client_id,
      client_name: c.client_id ? clientName.get(c.client_id) ?? null : null,
      client_mapped: c.client_id ? clientMapped.get(c.client_id) ?? false : false,
      total_amount: c.total_amount as number,
      paid_sum: paidSum,
      status: c.status,
      // derived from the DISPLAY state, never the raw status column: a
      // milestone whose linked job is paid reads 'paid' here while its status
      // column still says 'invoiced' (milestone.ts). A badge only — nothing
      // closes the contract on its own.
      all_paid: milestoneCards.length > 0 && milestoneCards.every((m) => m.state === "paid"),
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
