import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "@/components/AppHeader";
import SettingsClient, { type LastSync } from "./SettingsClient";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (profile.role !== "owner") redirect("/");

  const supabase = createClient();
  const [{ data: settings }, { data: events }] = await Promise.all([
    supabase.from("app_settings").select("calendar_sync_enabled,updated_at").eq("id", true).maybeSingle(),
    supabase
      .from("events")
      .select("event_type,payload,created_at")
      .eq("entity_type", "calendar_cron")
      .in("event_type", ["cron_sync_completed", "manual_sync_completed"])
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  const lastEvent = events?.[0];
  const lastSync: LastSync | null = lastEvent
    ? {
        at: lastEvent.created_at,
        source: lastEvent.event_type === "cron_sync_completed" ? "cron" : "manual",
        created: (lastEvent.payload as { created?: number } | null)?.created ?? 0,
      }
    : null;

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main>
        <SettingsClient calendarSyncEnabled={settings?.calendar_sync_enabled ?? false} lastSync={lastSync} />
      </main>
    </div>
  );
}
