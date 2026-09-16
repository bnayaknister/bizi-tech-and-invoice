/**
 * c2 guard verification — READ ONLY. Runs the REAL findBilledEvidenceForJobs
 * against the live database and prints what it would answer. Writes nothing:
 * no insert, no update, no queue row, no event.
 *
 * Run:  npx tsx scripts/verify_c2_guard.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { findBilledEvidenceForJobs } from "../src/lib/documents/enqueue";
import { certainBillingMatchIn, type ReconClient, type ReconJob, type ReconDoc } from "../src/lib/documents/reconcile";
import { deriveState } from "../src/lib/finance/state";

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

async function probe(label: string, jobId: string) {
  const { data: job } = await admin
    .from("jobs")
    .select("id,date,amount,paid,invoice_biz,invoice_tax,campaign,client_id,clients(name)")
    .eq("id", jobId)
    .maybeSingle();
  const j = job as Record<string, unknown> | null;
  const state = j
    ? deriveState({
        paid: j.paid as string,
        invoice_biz: j.invoice_biz as string | null,
        invoice_tax: j.invoice_tax as string | null,
      })
    : "?";
  const client = (j?.clients as { name?: string } | null)?.name ?? "—";
  const res = await findBilledEvidenceForJobs(admin, [jobId]);
  console.log(
    `\n── ${label}\n   job ${jobId.slice(0, 8)} · ${client} · ${j?.date} · ₪${j?.amount} · paid=${j?.paid} · state=${state}`
  );
  console.log(`   → ${res ? `BLOCK rule=${res.rule} · ${res.evidence}` : "null (no evidence — would queue)"}`);
  if (res) console.log(`   detail: ${JSON.stringify(res.detail)}${res.needsLink ? " needs_link=true" : ""}`);
  return res;
}

(async () => {
  await probe("1. חברת החשמל — the production that re-fired", "8a1bcf1c-ba2a-4dd5-9edd-7ed22e15bdf4");
  await probe("2. ידידיה ויטל — new work, no documents", "f78be4bb-22a5-411d-a65e-0b9f6162dd45");

  // ---- every purple job: how many would c2 now block, and on what ----------
  // Not five random ones. Purple jobs are the entire population this guard can
  // reach (a job that is not "not billed" is answered by rule a long before c2),
  // and at this size the whole set is cheap — a sample would leave the question
  // "what about the ones you did not draw" open for money.
  const { data: jobs } = await admin
    .from("jobs")
    .select("id,date,amount,paid,invoice_biz,invoice_tax,campaign,client_id,clients(name)")
    .eq("dismissed", false);
  const purple = ((jobs ?? []) as unknown as Array<Record<string, unknown>>).filter(
    (j) =>
      deriveState({
        paid: j.paid as string,
        invoice_biz: j.invoice_biz as string | null,
        invoice_tax: j.invoice_tax as string | null,
      }) === "purple"
  );
  console.log(`\n\n═══ every purple (not-billed) job: ${purple.length} ═══`);
  const blocked: string[] = [];
  for (const j of purple) {
    const res = await findBilledEvidenceForJobs(admin, [j.id as string]);
    if (!res) continue;
    const client = (j.clients as { name?: string } | null)?.name ?? "—";
    const line = `${(j.id as string).slice(0, 8)} · ${client} · ${j.date} · ₪${j.amount} · rule=${res.rule} · ${res.evidence} · ${JSON.stringify(res.detail)}`;
    blocked.push(line);
    console.log("  BLOCK " + line);
  }
  console.log(`\n  blocked: ${blocked.length} / ${purple.length} purple jobs`);

  // ---- c2 on the state that produced the bug -------------------------------
  // 40287 was linked to the job by hand at 20:25 on 16.9, so rule (a) answers
  // first now and c2 is unreachable on live rows. Rewind IN MEMORY to 17:39,
  // the moment the client's approval queued the second 300: the job carried no
  // document number and 40287 carried no job_id. Nothing is written.
  const ELECTRIC = "8a1bcf1c-ba2a-4dd5-9edd-7ed22e15bdf4";
  const DOC_SELECT =
    "id,morning_doc_number,type,client_id,morning_client_id,morning_client_name,amount,document_date,job_id,production_id,source,bundle_job_ids";
  const [{ data: rawClients }, { data: rawJobs }, { data: rawDocs }] = await Promise.all([
    admin.from("clients").select("id,name,morning_client_id"),
    admin
      .from("jobs")
      .select("id,client_id,amount,invoice_biz,invoice_tax,paid,date,due_date,legacy,campaign")
      .eq("dismissed", false),
    admin.from("documents").select(DOC_SELECT).is("cancelled_at", null).is("archived_at", null),
  ]);
  const rewoundJobs = ((rawJobs ?? []) as ReconJob[]).map((j) =>
    j.id === ELECTRIC ? { ...j, invoice_biz: null, invoice_tax: null } : j
  );
  const rewoundDocs = ((rawDocs ?? []) as ReconDoc[]).map((d) =>
    d.job_id === ELECTRIC ? { ...d, job_id: null } : d
  );
  console.log("\n\n═══ c2 on the 17:39 state (in memory, rewound) ═══");
  const m = certainBillingMatchIn((rawClients ?? []) as ReconClient[], rewoundJobs, rewoundDocs, [ELECTRIC]);
  console.log(
    m
      ? `  → c2 MATCH: doc ${m.doc.morning_doc_number} (type ${m.doc.type}) · ₪${m.doc.amount} · basis=${m.amountBasis} · gap=${m.dateGapDays}d`
      : "  → null"
  );
  const ecDocs = ((rawDocs ?? []) as ReconDoc[]).filter(
    (d) => d.morning_doc_number === "50066" || d.morning_doc_number === "40287"
  );
  for (const d of ecDocs) {
    console.log(`  doc ${d.morning_doc_number}: type=${d.type} job_id=${d.job_id ?? "NULL"} amount=${d.amount} date=${d.document_date}`);
  }

  // ---- the ambiguity case: נטע צמח -----------------------------------------
  // The owner named her as the test, and on live rows she cannot be run: 0087
  // set her one job to 'ללא חיוב' with invoice_biz=40267, so it is not purple
  // and c2 is never reached. Rewind that job to not-billed in memory — her
  // eight unlinked ₪708 320s and her ₪708 300 are all still there — and the
  // degree rule has to refuse to pick one. Nothing is written.
  const NETA = "e9eb2d91-47be-427b-8097-0fd1080e7a6f";
  const netaJobs = ((rawJobs ?? []) as ReconJob[]).map((j) =>
    j.id === NETA ? { ...j, paid: "לא", invoice_biz: null, invoice_tax: null } : j
  );
  const netaDocs = ((rawDocs ?? []) as ReconDoc[]).map((d) =>
    d.job_id === NETA ? { ...d, job_id: null } : d
  );
  const nDocs = netaDocs.filter((d) => {
    const c = ((rawClients ?? []) as ReconClient[]).find((x) => x.id === d.client_id);
    return (c?.name ?? "").includes("צמח") && [300, 305, 320, 400].includes(d.type);
  });
  console.log("\n\n═══ ambiguity: נטע צמח rewound to not-billed ═══");
  console.log(`  unlinked billing/payment docs for her: ${nDocs.filter((d) => !d.job_id).length}`);
  console.log(`  of them ₪708: ${nDocs.filter((d) => !d.job_id && Number(d.amount) === 708).length}`);
  const nm = certainBillingMatchIn((rawClients ?? []) as ReconClient[], netaJobs, netaDocs, [NETA]);
  console.log(
    nm
      ? `  → c2 MATCH (UNEXPECTED): ${nm.doc.morning_doc_number} type ${nm.doc.type}`
      : "  → null — ambiguous, does not block ✓"
  );
})();
