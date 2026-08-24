/**
 * The production -> job link in createTaxFromParents (owner approved 2026-08-24).
 *
 * REVERSIBLE BY CONSTRUCTION: the builder never reaches Morning — it inserts a
 * 'pending' row and nothing else. Every row this script creates (pending
 * documents, the synthetic consolidated set, events) is deleted in `finally`
 * and the deletion is VERIFIED before the script reports success.
 *
 * Run: npx tsx scripts/test_tax_production_link.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTaxFromParents } from "../src/lib/documents/taxFromParent";

for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  if (!process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const admin: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

let pass = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log("  PASS  " + name);
  } else {
    failures.push(name + (detail ? " -- " + detail : ""));
    console.log("  FAIL  " + name + (detail ? "  -- " + detail : ""));
  }
}

// everything created here, torn down in finally
const createdPending: string[] = [];
const createdJobs: string[] = [];
const createdProductions: string[] = [];

async function pendingIdOf(docNumber: string): Promise<string | null> {
  const { data } = await admin
    .from("pending_documents")
    .select("id")
    .eq("morning_doc_number", docNumber)
    .maybeSingle();
  return (data?.id as string) ?? null;
}

async function main() {
  console.log("\n=== 1. THE FIX: 10307 resolves its job through production_id ===");
  // 10307 (אסתטיטוקס): pending.job_id NULL, bundle_job_ids NULL, but its
  // production carries job d39c2148 in job_productions. Open in Morning
  // (ref [200,300,305,320,400]) so the openness gate lets it through.
  const p10307 = await pendingIdOf("10307");
  check("10307 has a queue row", !!p10307, String(p10307));

  const { data: wo } = await admin
    .from("pending_documents")
    .select("job_id,bundle_job_ids,production_id")
    .eq("id", p10307!)
    .single();
  check(
    "10307 carries NEITHER direct job source (so only the new link can find it)",
    !wo!.job_id && !wo!.bundle_job_ids,
    JSON.stringify(wo)
  );

  const { data: jp } = await admin
    .from("job_productions")
    .select("job_id")
    .eq("production_id", wo!.production_id as string);
  const expectedJob = (jp ?? [])[0]?.job_id as string;
  check("its production has a job in job_productions", !!expectedJob, String(expectedJob));

  const res = await createTaxFromParents(admin, [p10307!], null);
  check("build SUCCEEDS (was 409 before the fix)", res.ok, res.ok ? "" : res.error);
  if (res.ok) {
    createdPending.push(res.id);
    const { data: built } = await admin
      .from("pending_documents")
      .select("bundle_job_ids,doc_type,amount,payload")
      .eq("id", res.id)
      .single();
    check(
      "the built row stamps exactly the job reached through the production",
      JSON.stringify(built!.bundle_job_ids) === JSON.stringify([expectedJob]),
      JSON.stringify(built!.bundle_job_ids) + " expected " + JSON.stringify([expectedJob])
    );
    check("child is a 305 (tax_invoice default)", built!.doc_type === "tax_invoice", String(built!.doc_type));
    check(
      "linkedDocumentIds names the parent",
      ((built!.payload as { linkedDocumentIds?: string[] })?.linkedDocumentIds ?? []).length === 1,
      JSON.stringify((built!.payload as { linkedDocumentIds?: string[] })?.linkedDocumentIds)
    );
    // remove it now so the idempotency gate does not block the re-run below
    await admin.from("events").delete().eq("entity_id", res.id);
    await admin.from("pending_documents").delete().eq("id", res.id);
    createdPending.length = 0;
  }

  console.log("\n=== 2. NOT A REGRESSION: a source with no job at all is still refused ===");
  // Was 10315 until the 0060 backfill gave its episode a job — proof the
  // backfill worked, and the reason this assertion had to move. #10311 (SFI)
  // is now the case: work order issued, episode past הוקלט, but deliberately
  // held back from the backfill because an unlinked job of the same client
  // matches its amount. So it still has no job, and the gate must still refuse.
  const pNoJob = await pendingIdOf("10311");
  const resNone = await createTaxFromParents(admin, [pNoJob!], null);
  // REGISTER FOR CLEANUP FIRST, before asserting. A refusal is what we expect,
  // but on 2026-08-24 this assertion failed the other way — the episode had
  // just been given a job by the 0060 backfill, the build SUCCEEDED, and
  // because only the refusal branch was handled the row was never cleaned up.
  // A live 305 for a real client sat in the approval queue until a sweep found
  // it. An unexpected success is exactly when cleanup matters most.
  if (resNone.ok) createdPending.push(resNone.id);
  check("a still-jobless source is refused", !resNone.ok, resNone.ok ? "unexpectedly built" : "");
  if (!resNone.ok) {
    check("refusal is the jobs gate (409)", resNone.status === 409, String(resNone.status));
    check(
      "new wording: names client approval, not a nonexistent button",
      resNone.error.includes("מאשר את הפרק") && !resNone.error.includes("שייך ל-job"),
      resNone.error
    );
  }

  console.log("\n=== 3. BUNDLED: every job of every folded episode comes back ===");
  // No consolidated set exists in the account (0 rows), so build one:
  // two synthetic productions, each with its own job, folded into ONE work
  // order that itself carries production_id = null — the redemption shape.
  const { data: parentWo } = await admin
    .from("pending_documents")
    .select("id,client_id,payload,amount,morning_doc_id,morning_doc_number,status,doc_type")
    .eq("id", p10307!)
    .single();

  const { data: prodRow } = await admin
    .from("productions")
    .select("show_id,client_id,podcast_name")
    .eq("id", wo!.production_id as string)
    .single();

  const synthJobs: string[] = [];
  const synthProds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const { data: prod } = await admin
      .from("productions")
      .insert({
        podcast_name: "TEST bundled link " + i,
        client_id: prodRow!.client_id,
        show_id: prodRow!.show_id,
        kind: "client",
        record_date: "2026-08-24",
      })
      .select("id")
      .single();
    createdProductions.push(prod!.id);
    synthProds.push(prod!.id);

    const { data: job } = await admin
      .from("jobs")
      .insert({
        client_id: prodRow!.client_id,
        campaign: "TEST bundled link " + i,
        amount: 100 + i,
        date: "2026-08-24",
      })
      .select("id")
      .single();
    createdJobs.push(job!.id);
    synthJobs.push(job!.id);

    await admin.from("job_productions").insert({ job_id: job!.id, production_id: prod!.id });
  }

  // the consolidated parent: production_id null, folded children point at it
  const { data: bundleParent } = await admin
    .from("pending_documents")
    .insert({
      doc_type: "work_order",
      status: "issued",
      production_id: null,
      job_id: null,
      bundle_job_ids: null,
      client_id: parentWo!.client_id,
      amount: parentWo!.amount,
      payload: parentWo!.payload,
      morning_doc_id: "TEST-bundle-" + Date.now(),
      morning_doc_number: "TEST" + String(Date.now()).slice(-6),
    })
    .select("id")
    .single();
  createdPending.push(bundleParent!.id);

  for (const pid of synthProds) {
    const { data: kid } = await admin
      .from("pending_documents")
      .insert({
        doc_type: "work_order",
        status: "consolidated",
        production_id: pid,
        client_id: parentWo!.client_id,
        amount: 100,
        payload: {},
        consolidated_into: bundleParent!.id,
      })
      .select("id")
      .single();
    if (kid) createdPending.push(kid.id);
  }

  const resBundle = await createTaxFromParents(admin, [bundleParent!.id], null);
  // The synthetic parent has no documents row, so openness reads "unknown" and
  // is allowed with a warning — exactly the app-issued-awaiting-pull case.
  check("bundled build succeeds", resBundle.ok, resBundle.ok ? "" : resBundle.error);
  if (resBundle.ok) {
    createdPending.push(resBundle.id);
    const { data: built } = await admin
      .from("pending_documents")
      .select("bundle_job_ids")
      .eq("id", resBundle.id)
      .single();
    const got = ((built!.bundle_job_ids as string[]) ?? []).slice().sort();
    check(
      "ALL jobs of ALL folded episodes returned, not one",
      JSON.stringify(got) === JSON.stringify(synthJobs.slice().sort()),
      JSON.stringify(got) + " expected " + JSON.stringify(synthJobs.slice().sort())
    );
  }

  console.log("\n=== 4. REGRESSION: the pre-existing direct job_id path still resolves ===");
  // 10306 is the only real work order carrying job_id directly, but it is
  // CLOSED in Morning (ref []), so the openness gate refuses it before the
  // jobs gate is ever reached — it cannot exercise this path. Prove it
  // synthetically instead: a work order with job_id set and NO production, so
  // only the pre-existing source can satisfy the gate.
  const { data: soloJob } = await admin
    .from("jobs")
    .insert({
      client_id: prodRow!.client_id,
      campaign: "TEST direct job_id",
      amount: 250,
      date: "2026-08-24",
    })
    .select("id")
    .single();
  createdJobs.push(soloJob!.id);

  const { data: soloWo } = await admin
    .from("pending_documents")
    .insert({
      doc_type: "work_order",
      status: "issued",
      production_id: null,
      job_id: soloJob!.id,
      bundle_job_ids: null,
      client_id: parentWo!.client_id,
      amount: parentWo!.amount,
      payload: parentWo!.payload,
      morning_doc_id: "TEST-solo-" + Date.now(),
      morning_doc_number: "TEST" + String(Date.now()).slice(-6),
    })
    .select("id")
    .single();
  createdPending.push(soloWo!.id);

  const resSolo = await createTaxFromParents(admin, [soloWo!.id], null);
  check("direct job_id still builds", resSolo.ok, resSolo.ok ? "" : resSolo.error);
  if (resSolo.ok) {
    createdPending.push(resSolo.id);
    const { data: built } = await admin
      .from("pending_documents")
      .select("bundle_job_ids")
      .eq("id", resSolo.id)
      .single();
    check(
      "it stamps the directly-linked job",
      JSON.stringify(built!.bundle_job_ids) === JSON.stringify([soloJob!.id]),
      JSON.stringify(built!.bundle_job_ids)
    );
  }

  console.log("\n=== 5. REGRESSION: an openness refusal still precedes the jobs gate ===");
  // 10306 is closed in Morning — it must be refused for THAT reason, proving
  // the new lookup did not reorder or weaken any gate above it.
  const p10306 = await pendingIdOf("10306");
  const res06 = await createTaxFromParents(admin, [p10306!], null);
  check(
    "10306 refused as closed in Morning, not by the jobs gate",
    !res06.ok && res06.error.includes("כבר סגור במורנינג"),
    res06.ok ? "built unexpectedly" : res06.error
  );
  if (res06.ok) createdPending.push(res06.id);
}

main()
  .catch((e) => {
    failures.push("THREW: " + (e as Error).message);
    console.error(e);
  })
  .finally(async () => {
    console.log("\n=== CLEANUP ===");
    // LIFO: a folded child is created after its consolidated parent and holds
    // an FK to it, so the parent cannot go first. Reverse order deletes
    // children before parents. Delete errors are REPORTED, not swallowed —
    // that is how the first run's leak went unnoticed until the verify step.
    for (const id of [...createdPending].reverse()) {
      await admin.from("events").delete().eq("entity_id", id);
      const { error } = await admin.from("pending_documents").delete().eq("id", id);
      if (error) console.log("  delete failed for pending " + id + ": " + error.message);
    }
    for (const id of createdProductions) {
      await admin.from("job_productions").delete().eq("production_id", id);
      await admin.from("events").delete().eq("entity_id", id);
      await admin.from("productions").delete().eq("id", id);
    }
    for (const id of createdJobs) {
      await admin.from("job_productions").delete().eq("job_id", id);
      await admin.from("events").delete().eq("entity_id", id);
      await admin.from("jobs").delete().eq("id", id);
    }
    // VERIFY the cleanup rather than trusting it
    let leaked = 0;
    for (const [table, ids] of [
      ["pending_documents", createdPending],
      ["productions", createdProductions],
      ["jobs", createdJobs],
    ] as [string, string[]][]) {
      if (!ids.length) continue;
      const { data } = await admin.from(table).select("id").in("id", ids);
      if ((data ?? []).length) {
        leaked += (data ?? []).length;
        console.log("  LEAKED in " + table + ": " + JSON.stringify((data ?? []).map((r) => r.id)));
      }
    }
    console.log(leaked === 0 ? "  all test rows deleted, verified" : "  *** " + leaked + " ROWS LEAKED ***");

    console.log("\n=== RESULT ===");
    console.log("passed: " + pass + ", failed: " + failures.length);
    for (const f of failures) console.log("  - " + f);
    process.exit(failures.length || leaked ? 1 : 0);
  });
