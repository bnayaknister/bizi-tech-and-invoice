import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import { isStrictOwner } from "@/lib/roles";
import { displayDateTime, israelDate } from "@/lib/dates";
import { FREETEXT_BOOKING_EVENT, FREETEXT_EVENT, MONITOR_DAYS, countDay, type Understood } from "@/lib/whatsapp/freetextMonitor";
import { FreeTextMissList, type MissRow } from "./FreeTextMissList";

// E14-3 — the free-text review screen (owner only, 22.10): the daily counts
// and every message that was not fully understood — its text and what the
// bot answered. No phone number is stored, so none can be shown.

export const dynamic = "force-dynamic";

export default async function FreeTextPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!isStrictOwner(profile)) redirect("/");

  // events are read with the service role AFTER the owner check above
  const admin = createAdminClient();
  const since = new Date(Date.now() - (MONITOR_DAYS + 1) * 86_400_000).toISOString();
  const { data } = await admin
    .from("events")
    .select("event_type,created_at,payload")
    .in("event_type", [FREETEXT_EVENT, FREETEXT_BOOKING_EVENT])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);
  const rows = data ?? [];

  const byDay = new Map<string, typeof rows>();
  for (const r of rows) {
    const d = israelDate(new Date(r.created_at));
    byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }
  const days = Array.from(byDay.keys()).sort().reverse();

  const misses: MissRow[] = rows
    .filter((r) => r.event_type === FREETEXT_EVENT)
    .map((r) => ({ at: r.created_at, p: (r.payload ?? {}) as Record<string, unknown> }))
    .filter(({ p }) => p.understood === "none" || p.understood === "partial")
    .map(({ at, p }) => ({
      at: displayDateTime(at) ?? at,
      step: String(p.step ?? ""),
      understood: p.understood as Understood,
      llm: (p.llm_outcome as string | null) ?? null,
      text: (p.text as string | null) ?? null,
      reply: (p.reply as string | null) ?? null,
    }));

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main className="max-w-3xl mx-auto p-6">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-lg font-bold">טקסט חופשי בבוט — מעקב</h1>
          <Link href="/settings" className="text-xs text-[var(--dim)] hover:underline">
            חזרה להגדרות
          </Link>
        </div>
        <p className="text-xs text-[var(--faint)] mb-4">
          {MONITOR_DAYS} הימים האחרונים. מספרי טלפון לא נשמרים ולא מוצגים. סיכום בוואטסאפ נשלח כל ערב ב-21:30 בשבועיים הראשונים.
        </p>

        <section className="glass-card-secondary mb-4" style={{ padding: "14px 16px" }}>
          <h2 className="text-sm font-bold mb-2">לפי יום</h2>
          {days.length === 0 ? (
            <div className="text-xs text-[var(--faint)]">עוד אין הודעות.</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[var(--faint)]">
                <tr>
                  <th className="text-start font-normal py-1">יום</th>
                  <th className="text-start font-normal">הודעות</th>
                  <th className="text-start font-normal">עברו ל-LLM</th>
                  <th className="text-start font-normal">לא הובנו במלואן</th>
                  <th className="text-start font-normal">הזמנות</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => {
                  const c = countDay(byDay.get(d) ?? []);
                  return (
                    <tr key={d} className="border-t border-[var(--rule)]">
                      <td className="py-1 font-mono">{`${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}`}</td>
                      <td className="font-mono">{c.messages}</td>
                      <td className="font-mono">{c.llm}</td>
                      <td className="font-mono">{c.notUnderstood}</td>
                      <td className="font-mono">{c.bookings}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section className="glass-card-secondary" style={{ padding: "14px 16px" }}>
          <h2 className="text-sm font-bold mb-2">הודעות שלא הובנו במלואן ({misses.length})</h2>
          <FreeTextMissList rows={misses} />
        </section>
      </main>
    </div>
  );
}
