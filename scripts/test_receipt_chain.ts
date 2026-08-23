/**
 * jobsBehindReceipt — the chain a 400 walks to find the jobs it settles.
 *
 * Run:  npx tsx scripts/test_receipt_chain.ts
 *
 * TOUCHES MORNING: never. This calls the resolver directly against real rows;
 * nothing is issued.
 *
 * Why this is a separate script from test_auto_paid.ts: that one is pure and
 * says so. This one needs real rows in both parent tables, because the whole
 * point of the function is that a parent can live in EITHER — pending_documents
 * when the app issued it, documents when the pull brought it in, both when the
 * app issued it (issue.ts writes through under the same morning_doc_id).
 *
 * Why it is not in the Python suite: the receipt branch's non-dry path cannot
 * be driven end-to-end at all — issuing for real means a real Morning document,
 * and a dry run deliberately stops before the jobs write. So the chain is
 * verified where it can be: the resolver, on real data, with the ambiguity
 * (two parents sharing one job) that makes the dedupe matter.
 *
 * Cases:
 *   1. app-issued parent  — pending_documents row carries the jobs
 *   2. pulled parent      — documents row carries the job
 *   3. both tables, one document — the union must not double-count
 *   4. two parents sharing a job — deduped to one id (a duplicate would mean a
 *      duplicate job_marked_paid, and the radar counts those as payment timing)
 *   5. parent with no jobs — empty, which is an ordinary answer
 *   6. unknown / empty ids — empty, no throw
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { jobsBehindReceipt } from "../src/lib/documents/issue";

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

const TAG = `ZZ_TEST_RCHAIN_${Date.now()}`;
const made = { clients: [] as string[], jobs: [] as string[], pending: [] as string[], documents: [] as string[] };
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (!ok && detail ? `  [${detail}]` : ""));
  if (!ok) failures++;
}

const same = (got: string[], want: string[]) =>
  got.length === want.length && [...got].sort().join() === [...want].sort().join();

async function ins(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.id as string;
}

// A parent's Morning id. Deliberately NOT prefixed 'dry-': the receipt builder
// refuses those outright, so a dry parent can never reach this resolver.
const mid = (n: string) => `${TAG}-mid-${n}`;

async function main() {
  const clientId = await ins("clients", {
    name: `${TAG} client`,
    normalized_name: TAG.toLowerCase(),
  });
  made.clients.push(clientId);

  const mkJob = async (n: string) => {
    const id = await ins("jobs", { client_id: clientId, campaign: `${TAG} ${n}`, amount: 100, paid: "לא" });
    made.jobs.push(id);
    return id;
  };
  const jobA = await mkJob("A");
  const jobB = await mkJob("B");
  const jobC = await mkJob("C");

  // ---- 1. app-issued parent: a pending_documents row holding a bundle -------
  const pendMid = mid("app");
  made.pending.push(
    await ins("pending_documents", {
      doc_type: "tax_invoice",
      status: "issued",
      client_id: clientId,
      morning_doc_id: pendMid,
      morning_doc_number: "900001",
      job_id: null,
      bundle_job_ids: [jobA, jobB],
      payload: { type: 305 },
    })
  );
  check("1. app-issued parent → its bundled jobs", same(await jobsBehindReceipt(admin, [pendMid]), [jobA, jobB]));

  // ---- 2. pulled parent: a documents row holding a single job --------------
  const pullMid = mid("pull");
  made.documents.push(
    await ins("documents", {
      morning_doc_id: pullMid,
      morning_doc_number: "900002",
      type: 305,
      client_id: clientId,
      job_id: jobC,
      source: "pull",
    })
  );
  check("2. pulled parent → its linked job", same(await jobsBehindReceipt(admin, [pullMid]), [jobC]));

  // ---- 3. the same document in BOTH tables (what issue.ts leaves behind) ----
  made.documents.push(
    await ins("documents", {
      morning_doc_id: pendMid, // same Morning id as the pending row above
      morning_doc_number: "900001",
      type: 305,
      client_id: clientId,
      job_id: jobA, // overlaps the bundle
      bundle_job_ids: [jobA, jobB],
      source: "app",
    })
  );
  check("3. a parent present in BOTH tables is not double-counted",
    same(await jobsBehindReceipt(admin, [pendMid]), [jobA, jobB]));

  // ---- 4. two parents sharing a job ----------------------------------------
  // The receipt bundles them into one document ("קבלה מאוגדת"), so the union has
  // to dedupe — a repeated id would mean a second job_marked_paid for one
  // payment, and the radar reads those events as its payment-timing signal.
  const shareMid = mid("share");
  made.documents.push(
    await ins("documents", {
      morning_doc_id: shareMid,
      morning_doc_number: "900003",
      type: 305,
      client_id: clientId,
      job_id: jobB, // already reachable through the first parent
      source: "pull",
    })
  );
  check("4. two parents sharing a job → that job appears ONCE",
    same(await jobsBehindReceipt(admin, [pendMid, shareMid]), [jobA, jobB]));

  // ---- 5. a parent with no jobs at all -------------------------------------
  const barrenMid = mid("barren");
  made.documents.push(
    await ins("documents", {
      morning_doc_id: barrenMid,
      morning_doc_number: "900004",
      type: 305,
      client_id: clientId,
      job_id: null,
      source: "pull",
    })
  );
  check("5. a pulled parent never matched to a job → empty, not an error",
    same(await jobsBehindReceipt(admin, [barrenMid]), []));
  check("5b. and it contributes nothing when bundled with a parent that HAS jobs",
    same(await jobsBehindReceipt(admin, [barrenMid, pullMid]), [jobC]));

  // ---- 6. degenerate input --------------------------------------------------
  check("6. no linked ids → empty", same(await jobsBehindReceipt(admin, []), []));
  check("6b. an id matching nothing → empty",
    same(await jobsBehindReceipt(admin, [`${TAG}-nope`]), []));
}

async function cleanup() {
  console.log("\n--- cleanup ---");
  for (const id of made.pending) await admin.from("pending_documents").delete().eq("id", id);
  for (const id of made.documents) await admin.from("documents").delete().eq("id", id);
  for (const id of made.jobs) await admin.from("jobs").delete().eq("id", id);
  for (const id of made.clients) await admin.from("clients").delete().eq("id", id);

  const left: string[] = [];
  const gone = async (table: string, ids: string[]) => {
    if (!ids.length) return;
    const { data } = await admin.from(table).select("id").in("id", ids);
    if (data?.length) left.push(`${table}: ${data.length}`);
  };
  await gone("pending_documents", made.pending);
  await gone("documents", made.documents);
  await gone("jobs", made.jobs);
  await gone("clients", made.clients);
  if (left.length) {
    console.log("  LEFTOVER ROWS — DELETE BY HAND: " + left.join(", "));
    failures++;
  } else {
    console.log("  verified: every test row removed");
  }
}

main()
  .catch((e) => {
    console.error("\nERROR:", e instanceof Error ? e.message : e);
    failures++;
  })
  .finally(async () => {
    await cleanup();
    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  });
