import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import { computeReconciliation } from "@/lib/documents/reconcile";
import GapsClient, { type Gap1Row, type Gap2Row, type Gap3Row } from "./GapsClient";

export const dynamic = "force-dynamic";

const DOC_TYPE_LABEL: Record<number, string> = {
  300: "חשבון עסקה",
  305: "חשבונית מס",
  320: "מס / קבלה",
};

export default async function GapsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_money) redirect("/");

  const admin = createAdminClient();
  const recon = await computeReconciliation(admin);

  const { data: clients } = await admin.from("clients").select("id,name");
  const clientName = new Map((clients ?? []).map((c) => [c.id as string, c.name as string]));

  const jobLabel = (j: { client_id: string | null; campaign: string | null }) =>
    [j.client_id ? clientName.get(j.client_id) ?? "—" : "—", j.campaign ?? ""].filter(Boolean).join(" · ");
  const docType = (t: number) => DOC_TYPE_LABEL[t] ?? `סוג ${t}`;

  const gap1: Gap1Row[] = recon.gap1.map(({ job, candidates }) => ({
    jobId: job.id,
    jobLabel: jobLabel(job),
    jobAmount: job.amount,
    jobDate: job.date,
    candidates: candidates.map((c) => ({
      docId: c.doc.id,
      number: c.doc.morning_doc_number,
      typeLabel: docType(c.doc.type),
      amount: c.doc.amount,
      date: c.doc.document_date,
      confidence: c.confidence,
      amountBasis: c.amountBasis,
      dateGapDays: c.dateGapDays,
    })),
  }));

  const gap2: Gap2Row[] = recon.gap2.map(({ doc, candidates }) => ({
    docId: doc.id,
    number: doc.morning_doc_number,
    typeLabel: docType(doc.type),
    amount: doc.amount,
    date: doc.document_date,
    clientName: doc.client_id ? clientName.get(doc.client_id) ?? doc.morning_client_name ?? "—" : doc.morning_client_name ?? "—",
    candidates: candidates.map((c) => ({
      jobId: c.job.id,
      jobLabel: jobLabel(c.job),
      jobAmount: c.job.amount,
      jobDate: c.job.date,
      confidence: c.confidence,
      amountBasis: c.amountBasis,
      dateGapDays: c.dateGapDays,
    })),
  }));

  const gap3: Gap3Row[] = recon.gap3.map((j) => ({
    jobId: j.id,
    jobLabel: jobLabel(j),
    jobAmount: j.amount,
    jobDate: j.date,
  }));

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <GapsClient
        gap1={gap1}
        gap2={gap2}
        gap3={gap3}
        unmatchedDocCount={recon.unmatchedDocCount}
        canEdit={!!profile.can_edit_money}
      />
    </div>
  );
}
