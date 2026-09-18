/**
 * /finance/link dry run — what the screen shows and what it pre-ticks.
 *
 * Run:  npx tsx scripts/report_link_suggestions.ts
 *
 * READ-ONLY BY CONSTRUCTION: this file holds no insert/update/delete. It
 * rebuilds the screen's own inputs (the five selects of
 * src/app/finance/link/page.tsx), runs the REAL engine (src/lib/linking.ts,
 * imported rather than re-implemented) and applies the screen's own tab filter
 * — so the counts it prints are the counts the owner sees.
 *
 * Written for the P12 decisions (owner 2026-09-18): the contract gate, the
 * pre-tick rules and the amount guard. The BEFORE column is the old behaviour
 * reconstructed exactly — the tab without the contract gate, and a tick on
 * anything the engine named at any grade.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { shouldPreTick, suggestForJob, SINGLE_PRODUCTION_CEILING, type Suggestion } from "../src/lib/linking";

for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  const k = t.slice(0, i).trim();
  if (!process.env[k]) process.env[k] = t.slice(i + 1).trim();
}

const admin: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const ils = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString("he-IL");

async function main() {
  const [jobsRes, linksRes, prodsRes, showsRes, clientsRes] = await Promise.all([
    admin.from("jobs").select("id,client_id,date,campaign,amount,manual_only,contract_id").order("date"),
    admin.from("job_productions").select("job_id,production_id"),
    admin
      .from("productions")
      .select("id,show_id,record_date,guest,client_id,episode_no")
      .order("record_date", { ascending: false }),
    admin.from("shows").select("id,name,aliases"),
    admin.from("clients").select("id,name"),
  ]);
  for (const r of [jobsRes, linksRes, prodsRes, showsRes, clientsRes]) {
    if (r.error) throw new Error(r.error.message);
  }

  const jobs = jobsRes.data ?? [];
  const productions = prodsRes.data ?? [];
  const shows = showsRes.data ?? [];
  const clientName: Record<string, string> = {};
  for (const c of clientsRes.data ?? []) clientName[c.id] = c.name;
  const showName: Record<string, string> = {};
  for (const s of shows) showName[s.id] = s.name;
  const prodById = new Map(productions.map((p) => [p.id, p]));
  const linked: Record<string, string[]> = {};
  for (const l of linksRes.data ?? []) (linked[l.job_id] ??= []).push(l.production_id);

  const label = (j: (typeof jobs)[number]) =>
    `${j.date}  ${ils(j.amount).padStart(9)} ₪  ${clientName[j.client_id ?? ""] ?? "—"} · ${j.campaign}`;
  const prodLine = (id: string | undefined) => {
    const p = id ? prodById.get(id) : null;
    if (!p) return "—";
    return `${p.record_date} · ${showName[p.show_id ?? ""] ?? "—"}${p.guest ? ` · ${p.guest}` : ""}` +
      `${p.episode_no != null ? ` [פרק ${p.episode_no}]` : ""}`;
  };

  // ---- the tab, before and after the contract gate ------------------------
  const before = jobs.filter((j) => !j.manual_only && !linked[j.id]);
  const after = before.filter((j) => !j.contract_id);
  const gated = before.filter((j) => j.contract_id);

  console.log("=".repeat(76));
  console.log(`1. THE CONTRACT GATE:  ${before.length} -> ${after.length}   (${gated.length} removed)`);
  console.log("=".repeat(76));
  for (const j of gated) console.log(`  - ${label(j)}`);

  // ---- pre-tick, before and after -----------------------------------------
  const sugg = new Map<string, Suggestion>();
  for (const j of before) {
    sugg.set(j.id, suggestForJob(j, j.client_id ? clientName[j.client_id] ?? "" : "", shows, productions));
  }
  // BEFORE = every row of the ungated tab whose suggestion named anything.
  const tickedBefore = before.filter((j) => sugg.get(j.id)!.suggested.length > 0);
  const tickedAfter = after.filter((j) => shouldPreTick(sugg.get(j.id)!));

  console.log("");
  console.log("=".repeat(76));
  console.log(`2. PRE-TICKED:  ${tickedBefore.length} -> ${tickedAfter.length}`);
  console.log(`   (amount ceiling ${ils(SINGLE_PRODUCTION_CEILING)} ₪ per production)`);
  console.log("=".repeat(76));
  console.log("");
  console.log(`no longer pre-ticked (${tickedBefore.length - tickedAfter.length}):`);
  for (const j of tickedBefore) {
    const s = sugg.get(j.id)!;
    if (after.includes(j) && shouldPreTick(s)) continue;
    const why = j.contract_id
      ? "CONTRACT GATE — row left the tab"
      : `${s.confidence}${s.ambiguous ? " + ambiguous" : ""}${s.amountOutlier ? " + AMOUNT OUTLIER" : ""}, ` +
        `${s.windowCandidates.length} in window`;
    console.log(`  ${label(j)}`);
    console.log(`      was ticking: ${prodLine(s.suggested[0])}`);
    console.log(`      why not now: ${why}`);
  }

  // ---- the tab as it now reads --------------------------------------------
  console.log("");
  console.log("=".repeat(76));
  console.log(`3. THE "לקישור" TAB NOW  (${after.length} rows)`);
  console.log("=".repeat(76));
  const conf: Record<string, number> = { high: 0, medium: 0, low: 0, none: 0 };
  for (const j of after) {
    const s = sugg.get(j.id)!;
    conf[s.confidence]++;
    console.log(`${shouldPreTick(s) ? "[x]" : "[ ]"} ${label(j)}`);
    console.log(
      `     ${s.confidence}${s.episodeMatch != null ? ` · EPISODE ${s.episodeMatch}` : ""}` +
        `${s.amountOutlier ? " · AMOUNT-OUTLIER" : ""} · ${s.windowCandidates.length} in window` +
        `${s.suggested.length ? ` · top: ${prodLine(s.suggested[0])}` : ""}`
    );
    console.log(`     ${s.note}`);
  }
  console.log("");
  console.log(
    `confidence: high ${conf.high} · medium ${conf.medium} · low ${conf.low} · none ${conf.none}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
