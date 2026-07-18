import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import ApprovalsClient, { type ApprovalRow } from "./ApprovalsClient";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_manage_users) redirect("/");

  const admin = createAdminClient();
  const { data: reqs } = await admin
    .from("approval_requests")
    .select("id,requested_by,action_type,entity_type,entity_id,payload,reason,status,reviewed_at,review_note,created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  // resolve requester names (profiles is manager-readable, but names for the
  // list come through the service client to keep it one round trip)
  const ids = Array.from(new Set((reqs ?? []).map((r) => r.requested_by).filter(Boolean)));
  const { data: people } = ids.length
    ? await admin.from("profiles").select("id,name,email").in("id", ids)
    : { data: [] as { id: string; name: string; email: string }[] };
  const nameById = new Map((people ?? []).map((p) => [p.id, p.name || p.email || "—"]));

  const rows: ApprovalRow[] = (reqs ?? []).map((r) => ({
    id: r.id,
    requested_by_name: nameById.get(r.requested_by) ?? "—",
    action_type: r.action_type,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    payload: r.payload as Record<string, unknown>,
    reason: r.reason,
    status: r.status,
    reviewed_at: r.reviewed_at,
    review_note: r.review_note,
    created_at: r.created_at,
  }));

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main>
        <ApprovalsClient rows={rows} />
      </main>
    </div>
  );
}
