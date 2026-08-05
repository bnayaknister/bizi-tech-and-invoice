import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import RegistryClient, { type DocRow } from "./RegistryClient";
import { registryTabForType } from "@/lib/morning/types";

export const dynamic = "force-dynamic";

export default async function RegistryPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_money) redirect("/");

  const admin = createAdminClient();
  const BASE_COLS =
    "id,morning_doc_id,morning_doc_number,type,status,client_id,morning_client_name,amount,currency," +
    "document_date,pdf_url,source,production_id,job_id,clients(name),productions(podcast_name)";
  // cancelled_at (0043) + archived_at (0045) columns — read them, but fall back
  // to the base columns if a migration isn't applied yet so the screen keeps
  // rendering.
  const docsQuery = (cols: string) =>
    admin.from("documents").select(cols).order("document_date", { ascending: false, nullsFirst: false }).limit(5000);
  const [docsRes, { data: settings }] = await Promise.all([
    docsQuery(`${BASE_COLS},cancelled_at,cancel_reason,archived_at,archive_reason`),
    admin.from("app_settings").select("documents_pulled_at").eq("id", true).maybeSingle(),
  ]);
  const data = docsRes.error ? (await docsQuery(BASE_COLS)).data : docsRes.data;

  // Which registry rows can raise a tax document. The builder works from a
  // pending_documents row (it inherits that row's frozen income lines), and
  // `documents` has no FK to it — morning_doc_id is the only bridge. A document
  // raised by hand in Morning has no queue row, so it simply gets no button:
  // the v1 scope enforces itself on screen instead of failing on click.
  const { data: parentRows } = await admin
    .from("pending_documents")
    .select("id,morning_doc_id")
    .in("doc_type", ["work_order", "deal_invoice"])
    .eq("status", "issued")
    .not("morning_doc_id", "is", null);
  const pendingIdByMorningId = new Map<string, string>();
  for (const p of (parentRows ?? []) as { id: string; morning_doc_id: string }[]) {
    pendingIdByMorningId.set(p.morning_doc_id, p.id);
  }

  const rows: DocRow[] = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((d) => ({
    id: d.id as string,
    morning_doc_id: (d.morning_doc_id as string | null) ?? null,
    number: (d.morning_doc_number as string | null) ?? null,
    type: d.type as number,
    tab: registryTabForType(d.type as number),
    status: (d.status as number | null) ?? null,
    client_id: (d.client_id as string | null) ?? null,
    client_name:
      ((d.clients as { name?: string } | null)?.name as string) ??
      (d.morning_client_name as string | null) ??
      null,
    morning_client_name: (d.morning_client_name as string | null) ?? null,
    amount: (d.amount as number | null) ?? null,
    currency: (d.currency as string | null) ?? "ILS",
    document_date: (d.document_date as string | null) ?? null,
    pdf_url: (d.pdf_url as string | null) ?? null,
    source: d.source as DocRow["source"],
    production_id: (d.production_id as string | null) ?? null,
    job_id: (d.job_id as string | null) ?? null,
    show_name: ((d.productions as { podcast_name?: string } | null)?.podcast_name as string) ?? null,
    cancelled_at: (d.cancelled_at as string | null) ?? null,
    cancel_reason: (d.cancel_reason as string | null) ?? null,
    archived_at: (d.archived_at as string | null) ?? null,
    archive_reason: (d.archive_reason as string | null) ?? null,
    pending_id: pendingIdByMorningId.get(d.morning_doc_id as string) ?? null,
  }));

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <RegistryClient
        rows={rows}
        canPull={!!profile.can_edit_money}
        lastPull={(settings?.documents_pulled_at as string | null) ?? null}
      />
    </div>
  );
}
