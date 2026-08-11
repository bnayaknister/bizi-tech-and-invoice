import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import DocumentsClient, { type PendingDocRow } from "./DocumentsClient";
import { isDryRun, morningEnv } from "@/lib/morning/client";
import { DOC_TYPE_TO_MORNING_CODE, requiresPayment, type PendingDocType } from "@/lib/morning/types";
import { sumParentGross } from "@/lib/documents/parentGross";

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

  // A 320 or a 400 declares money that moved, and the payment block it carries
  // has to total the gross Morning computed on the parent. Read that here, once,
  // through the SAME helper the approval gate uses — the modal must not show a
  // figure the server would then reject.
  //
  // Only for rows that need it, and one read each: this queue holds pending and
  // failed rows only, and payment-bearing ones are the rare case.
  const grossByRow = new Map<string, { gross: number | null; error: string | null }>();
  for (const r of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    if (!requiresPayment(DOC_TYPE_TO_MORNING_CODE[r.doc_type as PendingDocType])) continue;
    const payload = (r.payload ?? {}) as { linkedDocumentIds?: string[] };
    const linked = Array.isArray(payload.linkedDocumentIds) ? payload.linkedDocumentIds : [];
    if (!linked.length) {
      grossByRow.set(r.id as string, { gross: null, error: "למסמך אין מסמך מקור — לא ניתן לאמת את סכום התקבול" });
      continue;
    }
    const res = await sumParentGross(admin, linked);
    grossByRow.set(r.id as string, res.ok ? { gross: res.gross, error: null } : { gross: null, error: res.error });
  }

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
      parent_gross: grossByRow.get(r.id as string)?.gross ?? null,
      parent_gross_error: grossByRow.get(r.id as string)?.error ?? null,
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
