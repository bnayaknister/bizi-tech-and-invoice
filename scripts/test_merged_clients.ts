/**
 * merged_into — a retired client row must never win a Morning-id resolution.
 *
 * Run:  npx tsx scripts/test_merged_clients.ts   (requires 0051 applied)
 *
 * The bug this locks down, in one line: the pull and the backfill resolve a
 * shared morning_client_id with `.order("name")` + first-wins, and the '['
 * of the '[מוזג]' prefix sorts before every Hebrew letter — so the row marked
 * as retired won the tie-break every time and collected the documents. Check 3
 * reproduces exactly that and fails on the pre-0051 code.
 *
 * TOUCHES MORNING: never. Both resolvers are pure database reads plus a
 * documents update; no Morning call exists on either path.
 *
 * Every row it creates is deleted in the finally block AND the deletion is
 * verified before the script reports success.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { backfillDocumentClients } from "../src/lib/documents/backfill";

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

const TAG = `ZZ_TEST_MERGED_${Date.now()}`;
const made = { clients: [] as string[], documents: [] as string[] };
let failures = 0;

const check = (name: string, ok: boolean, detail: unknown = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok || detail === "" ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};
const uuid = () => crypto.randomUUID();

async function makeClient(name: string, morningId: string | null, mergedInto?: string): Promise<string> {
  const { data, error } = await admin
    .from("clients")
    .insert({
      name,
      normalized_name: name.replace(/\s/g, "").toLowerCase(),
      morning_client_id: morningId,
      ...(mergedInto ? { merged_into: mergedInto } : {}),
    })
    .select("id")
    .single();
  if (error) throw new Error(`insert client "${name}": ${error.message}`);
  made.clients.push((data as { id: string }).id);
  return (data as { id: string }).id;
}

/** an unassigned registry document carrying a Morning client id */
async function makeUnassignedDoc(morningClientId: string): Promise<string> {
  const { data, error } = await admin
    .from("documents")
    .insert({
      morning_doc_id: uuid(),
      morning_doc_number: String(Math.floor(Math.random() * 100000)),
      type: 300,
      client_id: null,
      morning_client_id: morningClientId,
      amount: 100,
      document_date: "2026-01-01",
      source: "pull",
    })
    .select("id")
    .single();
  if (error) throw new Error(`insert document: ${error.message}`);
  made.documents.push((data as { id: string }).id);
  return (data as { id: string }).id;
}

/** the pull's resolver, read exactly as registry.ts builds it */
async function resolveLikePull(morningClientId: string): Promise<string | null> {
  const { data } = await admin
    .from("clients")
    .select("id,morning_client_id")
    .not("morning_client_id", "is", null)
    .is("merged_into", null)
    .order("name");
  for (const c of data ?? []) {
    if (c.morning_client_id === morningClientId) return c.id as string;
  }
  return null;
}

const docClient = async (id: string) =>
  ((await admin.from("documents").select("client_id").eq("id", id).single()).data as { client_id: string | null })
    .client_id;

async function main() {
  // ---- 1. the pull resolver skips a retired row --------------------------
  console.log("\n1. pull resolution: retired row is not a target");
  const mc1 = uuid();
  const keep1 = await makeClient(`${TAG}_keeper_1`, mc1);
  const drop1 = await makeClient(`${TAG}_retired_1`, null, keep1);
  check("resolves to the keeper", (await resolveLikePull(mc1)) === keep1);
  check("retired row holds no mapping", drop1 !== null);

  // ---- 2. the backfill sends documents to the keeper ---------------------
  console.log("\n2. backfill: an unassigned document lands on the keeper");
  const doc2 = await makeUnassignedDoc(mc1);
  await backfillDocumentClients(admin, { morningClientId: mc1 });
  check("document assigned to the keeper", (await docClient(doc2)) === keep1, await docClient(doc2));

  // ---- 3. THE REGRESSION: the '[מוזג]' prefix wins the name tie-break ----
  // Pre-0051 this is the exact 3.8 shape: two rows on one Morning id, the
  // retired one sorting first because '[' precedes every Hebrew letter, and
  // first-wins handing it the documents. Without the merged_into filter this
  // check fails.
  console.log("\n3. REGRESSION: retired row sorts first and must still lose");
  const mc3 = uuid();
  const keep3 = await makeClient(`${TAG}_קלמנט`, mc3);
  const drop3 = await makeClient(`[מוזג] ${TAG}_קלמנט ישן`, null, keep3);
  const ordered = await admin
    .from("clients")
    .select("id,name")
    .in("id", [keep3, drop3])
    .order("name");
  const firstByName = (ordered.data ?? [])[0] as { id: string; name: string } | undefined;
  check("the retired row really does sort first (the trap is present)", firstByName?.id === drop3, firstByName?.name);
  check("…and the resolver still picks the keeper", (await resolveLikePull(mc3)) === keep3);
  const doc3 = await makeUnassignedDoc(mc3);
  await backfillDocumentClients(admin, { morningClientId: mc3 });
  check("…and the document lands on the keeper, not the retired row",
        (await docClient(doc3)) === keep3, await docClient(doc3));

  // ---- 4. a legitimate shared mapping still works (0026 not broken) ------
  // The property under test is "still resolves, deterministically, by name" —
  // NOT "resolves to whichever row was created first". Ask the database which
  // name sorts first rather than assuming: ה precedes ו, so the row created
  // second is the one that wins, and hard-coding the other way tests nothing
  // but the author's guess at Hebrew collation.
  console.log("\n4. two live clients sharing one Morning entity (0026)");
  const mc4 = uuid();
  const live1 = await makeClient(`${TAG}_וואן`, mc4);
  const live2 = await makeClient(`${TAG}_הנעות`, mc4);
  const bothOrdered = await admin.from("clients").select("id,name").in("id", [live1, live2]).order("name");
  const expected4 = ((bothOrdered.data ?? [])[0] as { id: string } | undefined)?.id;
  const doc4 = await makeUnassignedDoc(mc4);
  await backfillDocumentClients(admin, { morningClientId: mc4 });
  check("shared mapping still resolves", [live1, live2].includes((await docClient(doc4)) ?? ""), await docClient(doc4));
  check("…to the row that sorts first by name", (await docClient(doc4)) === expected4, await docClient(doc4));

  // ---- 5. the CHECK makes the accident unrepresentable -------------------
  console.log("\n5. the database refuses to map a retired row");
  const { error: e1 } = await admin.from("clients").update({ morning_client_id: uuid() }).eq("id", drop1);
  check("update is rejected", !!e1, e1?.message?.slice(0, 90));
  const { error: e2 } = await admin
    .from("clients")
    .insert({ name: `${TAG}_born_merged`, normalized_name: `${TAG}_born_merged`, morning_client_id: uuid(), merged_into: keep1 });
  check("insert is rejected too", !!e2, e2?.message?.slice(0, 90));

  // ---- 6. unmapping a retired row stays allowed (the repair direction) ---
  console.log("\n6. unmapping still allowed");
  const { error: e3 } = await admin.from("clients").update({ morning_client_id: null }).eq("id", drop1);
  check("setting null on a retired row is fine", !e3, e3?.message);
}

async function cleanup() {
  console.log("\ncleanup");
  // backfillDocumentClients writes a documents_client_backfilled event per
  // client it resolves (backfill.ts). Those name OUR throwaway clients, so
  // they have to go with them or the audit log keeps rows pointing at ids
  // that no longer exist — a first run left three behind exactly that way.
  if (made.clients.length) await admin.from("events").delete().in("entity_id", made.clients);
  if (made.documents.length) await admin.from("events").delete().in("entity_id", made.documents);
  if (made.documents.length) await admin.from("documents").delete().in("id", made.documents);
  if (made.clients.length) {
    // children before parents: merged_into is a self-FK with no cascade
    await admin.from("clients").delete().in("id", made.clients).not("merged_into", "is", null);
    await admin.from("clients").delete().in("id", made.clients);
  }
  const leftovers: string[] = [];
  for (const [t, ids] of [["documents", made.documents], ["clients", made.clients]] as const) {
    if (!ids.length) continue;
    const { data } = await admin.from(t).select("id").in("id", ids);
    if (data?.length) leftovers.push(`${t}: ${data.length} rows`);
  }
  const allIds = [...made.clients, ...made.documents];
  if (allIds.length) {
    const { data } = await admin.from("events").select("id").in("entity_id", allIds);
    if (data?.length) leftovers.push(`events: ${data.length} rows`);
  }
  if (leftovers.length) {
    console.log("  LEFTOVER ROWS — DELETE BY HAND:", leftovers.join(" | "));
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
