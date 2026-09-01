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
      // Every queue row that can bear on a milestone's buttons. It cannot be
      // read off `jobs`: that table models the deal invoice (invoice_biz) and
      // the tax document (invoice_tax) and has no column for a 100 at all.
      //
      // NO `job_id is not null` filter, and that is the whole trick. A tax row
      // built by taxFromParent carries `job_id: null` and puts its jobs in
      // `bundle_job_ids` instead — verified on the one real 305 in the data
      // (#50068, job_id null). Filtering on job_id would drop every tax row and
      // the screen would offer a tax button for a document already queued.
      //
      // 'pending' is in the status list on purpose: it is what makes a button
      // disappear the moment it is clicked, not only once Shiri approves.
      admin
        .from("pending_documents")
        .select("id,doc_type,status,job_id,bundle_job_ids,morning_doc_id,amount")
        .in("doc_type", ["work_order", "deal_invoice", "tax_invoice", "tax_receipt"])
        .in("status", ["pending", "approved", "issued"]),
    ]);

  const clientName = new Map((clients ?? []).map((c) => [c.id, c.name]));
  const clientMapped = new Map((clients ?? []).map((c) => [c.id, !!c.morning_client_id]));
  const jobById = new Map((jobs ?? []).map((j) => [j.id, j]));

  // null and "" both mean "no document number" — a blank string is not one.
  const present = (v: unknown) => v != null && String(v).trim() !== "";

  type QueueRow = {
    id: string;
    doc_type: string;
    status: string;
    job_id: string | null;
    bundle_job_ids: string[] | null;
    morning_doc_id: string | null;
    amount: number | null;
  };
  // A row bears on a job through EITHER column — job-anchored documents use
  // job_id, tax documents use bundle_job_ids.
  const rowsForJob = new Map<string, QueueRow[]>();
  for (const q of (queued ?? []) as QueueRow[]) {
    const targets = Array.from(
      new Set<string>([...(q.job_id ? [q.job_id] : []), ...(q.bundle_job_ids ?? [])])
    );
    for (const j of targets) rowsForJob.set(j, [...(rowsForJob.get(j) ?? []), q]);
  }

  // "Issued for real": the three conditions taxFromParent enforces server-side
  // before it will link to a parent. A dry-run issuance mints a synthetic
  // "dry-" id that is not a Morning document, so a row carrying one can never
  // father anything — offering a button for it would promise a 409.
  const reallyIssued = (q: QueueRow) =>
    q.status === "issued" && present(q.morning_doc_id) && !String(q.morning_doc_id).startsWith("dry-");

  const cards: ContractCard[] = (contracts ?? []).map((c) => {
    const ms = (milestones ?? []).filter((m) => m.contract_id === c.id);
    const milestoneCards = ms.map((m) => {
      const job = m.job_id ? jobById.get(m.job_id) : null;
      const rows = m.job_id ? rowsForJob.get(m.job_id) ?? [] : [];
      // The amount on the most authoritative issued parent: the deal invoice if
      // one went out, otherwise the work order.
      const issuedParent =
        rows.find((q) => q.doc_type === "deal_invoice" && reallyIssued(q)) ??
        rows.find((q) => q.doc_type === "work_order" && reallyIssued(q)) ??
        null;
      const issuedAmount = issuedParent?.amount ?? null;
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
        // The facts the issue buttons need, kept SEPARATE. The fields above
        // collapse both columns into one string (`invoice_tax ?? invoice_biz`),
        // which is right for display and useless for a decision: it cannot tell
        // a job that has been billed from one that has not.
        has_work_order: rows.some((q) => q.doc_type === "work_order"),
        has_deal_invoice: present(job?.invoice_biz),
        has_tax_document: present(job?.invoice_tax),
        // The parent ids stage 2 issues against. Only a really-issued row can
        // be one; a queued or dry-run parent is not a Morning document.
        work_order_source_id: rows.find((q) => q.doc_type === "work_order" && reallyIssued(q))?.id ?? null,
        deal_invoice_source_id: rows.find((q) => q.doc_type === "deal_invoice" && reallyIssued(q))?.id ?? null,
        // In flight, not yet issued. A queued deal invoice hides the tax button
        // (owner decision): building the tax document on the work order while a
        // 300 is a click away would close the order and strand the 300 open —
        // the `order_not_closed` alert, self-inflicted.
        has_queued_deal_invoice: rows.some((q) => q.doc_type === "deal_invoice" && !reallyIssued(q)),
        has_queued_tax: rows.some((q) => (q.doc_type === "tax_invoice" || q.doc_type === "tax_receipt")),
        // The amount that actually went out, when a parent has been issued —
        // the milestone's own amount can be edited afterwards and then the two
        // disagree. Display only; nothing is blocked on it.
        issued_amount: issuedAmount,
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
