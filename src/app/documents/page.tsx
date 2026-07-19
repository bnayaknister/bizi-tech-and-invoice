import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import DocumentsClient, { type PendingDocRow } from "./DocumentsClient";
import { isDryRun, morningEnv } from "@/lib/morning/client";

export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_money) redirect("/");

  const admin = createAdminClient();
  const { data } = await admin
    .from("pending_documents")
    .select(
      "id,doc_type,status,amount,created_at,payload,reject_reason,last_error,attempts," +
        "client_id,production_id,job_id,clients(name),productions(podcast_name,record_date,guest,studio)"
    )
    .in("status", ["pending", "failed"])
    .order("created_at", { ascending: true });

  const now = Date.now();
  const rows: PendingDocRow[] = (
    (data ?? []) as unknown as Array<Record<string, unknown>>
  ).map((r) => {
    const created = new Date(r.created_at as string).getTime();
    const ageHours = Math.floor((now - created) / 3_600_000);
    const prod = r.productions as { podcast_name?: string; record_date?: string; guest?: string } | null;
    return {
      id: r.id as string,
      doc_type: r.doc_type as PendingDocRow["doc_type"],
      status: r.status as string,
      amount: (r.amount as number | null) ?? null,
      created_at: r.created_at as string,
      age_hours: ageHours,
      aging: ageHours >= 72 ? "critical" : ageHours >= 24 ? "warning" : null,
      client_name: ((r.clients as { name?: string } | null)?.name as string) ?? "—",
      show_name: prod?.podcast_name ?? "—",
      record_date: prod?.record_date ?? null,
      guest: prod?.guest ?? null,
      payload: r.payload as Record<string, unknown>,
      last_error: (r.last_error as string | null) ?? null,
      attempts: (r.attempts as number | null) ?? 0,
    };
  });

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <DocumentsClient
        rows={rows}
        canApprove={!!profile.can_edit_money}
        dryRun={isDryRun()}
        env={morningEnv()}
      />
    </div>
  );
}
