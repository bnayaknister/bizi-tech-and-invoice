import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import { deriveState, type FinanceState } from "@/lib/finance/state";
import FinanceClient, { type FinanceJob, type FinanceSummary } from "./FinanceClient";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;

export default async function FinancePage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_money) redirect("/"); // technicians never see this screen

  // money-only aggregate screen — read through the service role, same as radar
  const admin = createAdminClient();
  const [{ data: jobs }, { data: clients }, { data: links }, { data: prods }, { data: shows }, { data: invoices }] =
    await Promise.all([
      admin.from("jobs").select("id,client_id,date,campaign,amount,invoice_biz,invoice_tax,paid,due_date,notes"),
      admin.from("clients").select("id,name,payment_terms"),
      admin.from("job_productions").select("job_id,production_id"),
      admin.from("productions").select("id,show_id,podcast_name"),
      admin.from("shows").select("id,name"),
      admin.from("invoices").select("id,job_id,type,doc_number,source,pdf_url,issued_at"),
    ]);

  const clientName = new Map((clients ?? []).map((c) => [c.id, c.name]));
  const showById = new Map((shows ?? []).map((s) => [s.id, s.name]));
  const prodById = new Map((prods ?? []).map((p) => [p.id, p]));
  const prodByJob = new Map<string, string>(); // job -> first production id
  for (const l of links ?? []) if (!prodByJob.has(l.job_id)) prodByJob.set(l.job_id, l.production_id);
  const invByJob = new Map<string, { type: string; doc_number: string | null; source: string; pdf_url: string | null }[]>();
  for (const inv of invoices ?? []) {
    if (!inv.job_id) continue;
    const arr = invByJob.get(inv.job_id) ?? [];
    arr.push({ type: inv.type, doc_number: inv.doc_number, source: inv.source, pdf_url: inv.pdf_url });
    invByJob.set(inv.job_id, arr);
  }

  const now = Date.now();
  const rows: FinanceJob[] = (jobs ?? []).map((j) => {
    const state = deriveState(j);
    const prodId = prodByJob.get(j.id);
    const showName = prodId
      ? showById.get(prodById.get(prodId)?.show_id ?? "") ?? prodById.get(prodId)?.podcast_name ?? null
      : null;
    let dueDays: number | null = null;
    if (j.due_date) dueDays = Math.round((new Date(j.due_date).getTime() - now) / DAY);
    const docs = invByJob.get(j.id) ?? [];
    const bizDoc = docs.find((d) => d.type === "עסקה");
    const taxDoc = docs.find((d) => d.type === "מס");
    return {
      id: j.id,
      date: j.date,
      client_name: j.client_id ? clientName.get(j.client_id) ?? null : null,
      show_name: showName,
      campaign: j.campaign,
      amount: j.amount,
      paid: j.paid,
      due_days: dueDays,
      due_estimated: !j.due_date,
      state,
      biz: {
        number: j.invoice_biz ?? bizDoc?.doc_number ?? null,
        pdf: bizDoc?.pdf_url ?? null,
        manual: bizDoc ? bizDoc.source === "manual" : null,
      },
      tax: {
        number: j.invoice_tax ?? taxDoc?.doc_number ?? null,
        pdf: taxDoc?.pdf_url ?? null,
        manual: taxDoc ? taxDoc.source === "manual" : null,
      },
    };
  });

  const num = (v: number | null) => v ?? 0;
  const byState = (s: FinanceState) => rows.filter((r) => r.state === s);
  const sum = (rs: FinanceJob[]) => rs.reduce((t, r) => t + num(r.amount), 0);
  const unpaid = rows.filter((r) => r.paid === "לא");
  const overdue60 = unpaid.filter((r) => r.due_days != null && r.due_days < -60);

  const summary: FinanceSummary = {
    debt: unpaid.reduce((t, r) => t + num(r.amount), 0),
    overdue60Count: overdue60.length,
    overdue60Sum: sum(overdue60),
    missingTaxCount: byState("red").length,
    missingTaxSum: sum(byState("red")),
    closedCount: byState("closed").length,
    closedSum: sum(byState("closed")),
  };

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main>
        <FinanceClient rows={rows} summary={summary} canEditMoney={profile.can_edit_money} />
      </main>
    </div>
  );
}
