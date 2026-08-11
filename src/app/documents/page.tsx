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
  // Read for every row that COULD need it at approval, which is not the same as
  // every row that needs it as stored. A tax row is always queued as 305
  // (DEFAULT_TAX_VARIANT — this app creates nothing else), and the bookkeeper
  // flips it to 320 in the modal. Keying this off the STORED type meant the
  // gross was never read for the one path that ends up needing it: choosing 320
  // left parent_gross null, the modal called that "the parent has not been
  // pulled yet" — about a parent that had been pulled, whose raw carried the
  // amount all along — and disabled the issue button. No 320 could be approved
  // at all. Same defect family as the description label: a value derived from
  // what the row IS instead of from what it is about to BECOME.
  //
  // One read each, and this queue holds pending/failed rows only, so widening
  // it costs a handful of lookups.
  const mayCarryPayment = (docType: PendingDocType): boolean =>
    requiresPayment(DOC_TYPE_TO_MORNING_CODE[docType]) || docType === "tax_invoice";

  const grossByRow = new Map<string, { gross: number | null; error: string | null }>();
  for (const r of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    if (!mayCarryPayment(r.doc_type as PendingDocType)) continue;
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
