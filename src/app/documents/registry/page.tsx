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
  const [{ data }, { data: settings }] = await Promise.all([
    admin
      .from("documents")
      .select(
        "id,morning_doc_number,type,status,client_id,morning_client_name,amount,currency," +
          "document_date,pdf_url,source,production_id,job_id,clients(name),productions(podcast_name)"
      )
      .order("document_date", { ascending: false, nullsFirst: false })
      .limit(5000),
    admin.from("app_settings").select("documents_pulled_at").eq("id", true).maybeSingle(),
  ]);

  const rows: DocRow[] = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((d) => ({
    id: d.id as string,
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
