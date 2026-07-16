import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import { computeRadar, type RadarAlert, type Severity } from "@/modules/radar/alerts";

export const dynamic = "force-dynamic";

const NIS = new Intl.NumberFormat("he-IL");
const money = (n: number) => `${NIS.format(Math.round(n))} ₪`;

const SEV_LABEL: Record<Severity, string> = { red: "🔴 קריטי", blue: "🔵 לתשומת לב", yellow: "🟡 מעקב" };
const SEV_COLOR: Record<Severity, string> = { red: "var(--red)", blue: "var(--cyan)", yellow: "var(--amber)" };

export default async function RadarPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  // radar is money-only — a technician never sees it at all
  if (!profile.can_view_money) redirect("/");

  const radar = await computeRadar(createAdminClient());
  const maxVu = Math.max(1, ...radar.vu.map((c) => c.amount));

  const bySeverity: Record<Severity, RadarAlert[]> = { red: [], blue: [], yellow: [] };
  for (const a of radar.alerts) bySeverity[a.severity].push(a);

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main className="max-w-4xl mx-auto p-6">
        <h1 className="text-lg font-bold mb-1">רדאר</h1>
        <p className="text-xs text-[var(--faint)] mb-6">מה בוער עכשיו · ספירה ממועד הפירעון, לא מתאריך העבודה</p>

        {/* ---- Part A: two numbers, never summed ---- */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
          <div className="rounded-xl border border-[var(--rule)] bg-[var(--panel2)] p-5">
            <div className="text-xs text-[var(--dim)] mb-2">חוב לגבייה</div>
            <div className="num-glow font-mono text-3xl font-medium" style={{ color: "var(--red)" }}>
              {money(radar.debtToCollect)}
            </div>
            <div className="text-[11px] text-[var(--faint)] mt-1">חויב, טרם שולם</div>
          </div>
          <div className="rounded-xl border border-[var(--rule)] bg-[var(--panel2)] p-5">
            <div className="text-xs text-[var(--dim)] mb-2">התחייבות פתוחה</div>
            <div className="num-glow font-mono text-3xl font-medium" style={{ color: "var(--cyan)" }}>
              {money(radar.openCommitment)}
            </div>
            <div className="text-[11px] text-[var(--faint)] mt-1">טרם חויב</div>
          </div>
        </div>

        {/* ---- Part B: VU meter (gauge of debt age) ---- */}
        <div className="rounded-xl border border-[var(--rule)] bg-[var(--panel2)] p-5 mb-8">
          <div className="text-xs font-bold text-[var(--dim)] mb-4">ערוצי גיל החוב</div>
          <div className="flex items-end justify-between gap-3 sm:gap-6" style={{ minHeight: 140 }}>
            {radar.vu.map((c) => {
              const h = c.amount > 0 ? Math.max(10, Math.round((c.amount / maxVu) * 108)) : 4;
              const critical = c.key === "red" && c.count > 0;
              return (
                <Link key={c.key} href={c.href} className="flex-1 flex flex-col items-center gap-2 group">
                  <div className="font-mono text-xs text-[var(--dim)] group-hover:text-[var(--ink)]">
                    {c.count > 0 ? money(c.amount) : "—"}
                  </div>
                  <div className="w-full flex items-end justify-center" style={{ height: 112 }}>
                    <div
                      className={`w-8 sm:w-12 rounded-t ${critical ? "pulse-crit" : ""}`}
                      style={{
                        height: h,
                        background: c.tone,
                        boxShadow: critical ? "0 0 12px rgba(255,90,110,.6)" : "none",
                        opacity: c.count > 0 ? 1 : 0.35,
                      }}
                    />
                  </div>
                  <div className="text-[11px] text-[var(--faint)] text-center leading-tight">
                    {c.label}
                    <div className="font-mono">{c.count}</div>
                  </div>
                </Link>
              );
            })}
          </div>
          <div className="text-[10px] text-[var(--faint)] mt-3">✅ בזמן = טרם הגיע מועד הפירעון — לא חוב · לחיצה על ערוץ מסננת את מסך הכספים</div>
        </div>

        {/* ---- Part C: alerts by severity ---- */}
        <div className="space-y-5">
          {(["red", "blue", "yellow"] as Severity[]).map((sev) => {
            const items = bySeverity[sev];
            if (items.length === 0) return null;
            return (
              <section key={sev}>
                <h2 className="text-xs font-bold mb-2" style={{ color: SEV_COLOR[sev] }}>
                  {SEV_LABEL[sev]}
                </h2>
                <div className="rounded-xl border border-[var(--rule)] overflow-hidden">
                  {items.map((a) => (
                    <Link
                      key={a.key}
                      href={a.href}
                      className="flex items-center gap-3 px-4 py-3 border-b border-[var(--rule)] last:border-b-0 bg-[var(--panel2)] hover:bg-[var(--panel3)] transition-colors"
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: SEV_COLOR[sev] }} />
                      <span className="flex-1 text-sm">{a.title}</span>
                      {a.amount != null && a.amount > 0 && (
                        <span className="font-mono text-xs text-[var(--dim)]">{money(a.amount)}</span>
                      )}
                      <span className="font-mono text-sm font-bold min-w-8 text-center">{a.count}</span>
                      <span className="text-[var(--faint)]">←</span>
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
          {radar.alerts.length === 0 && (
            <div className="text-center text-sm text-[var(--faint)] py-10 border border-dashed border-[var(--rule)] rounded-xl">
              אין התראות פעילות. הכל תחת שליטה.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
