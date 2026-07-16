import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createClient } from "@/lib/supabase/server";
import { MODULES } from "@/modules/registry";
import AppHeader from "@/components/AppHeader";
import ModuleCard from "@/components/ModuleCard";

export default async function Home() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");

  const supabase = createClient();
  const visibleModules = MODULES.filter((m) => m.hasAccess(profile));
  const metrics = await Promise.all(visibleModules.map((m) => m.getMetric(supabase)));

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} animatedLogo />
      <main className="max-w-5xl mx-auto p-6">
        <h1 className="text-sm font-bold text-[var(--dim)] mb-4">מודולים</h1>
        {visibleModules.length === 0 ? (
          <div className="text-center py-20 text-[var(--faint)] text-sm">
            אין לך עדיין הרשאה לאף מודול.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {visibleModules.map((m, i) => (
              <ModuleCard key={m.key} title={m.title} icon={m.icon} href={m.href} metric={metrics[i]} index={i} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
