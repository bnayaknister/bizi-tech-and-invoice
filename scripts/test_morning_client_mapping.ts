/**
 * B23 — a dry run must never map a synthetic Morning id onto a client. Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_morning_client_mapping.ts
 * No database, no network, no Morning: the admin client is a recorder that
 * logs every call, and `createMorningClient` is called ONLY with
 * MORNING_DRY_RUN forced on, where it makes no network call by construction.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SYNTHETIC_MORNING_ID_PREFIX,
  isSyntheticMorningId,
  mappingDecision,
  persistMorningMapping,
} from "../src/lib/morning/clientMapping";

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}\n       got:  ${g}\n       want: ${w}`);
  }
}

/** A stand-in admin client: records every call, answers every chain with { error: null }. */
function recorder() {
  const calls: string[] = [];
  const chain = (path: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === "then") {
          // awaiting the chain resolves it, like a supabase query builder
          return (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
        }
        return chain(`${path}.${String(prop)}`);
      },
      apply(_t, _this, args) {
        calls.push(`${path}(${JSON.stringify(args)})`);
        return chain(`${path}()`);
      },
    });
  return { admin: chain("admin") as never, calls };
}

const REAL = "4b2f1c9e-1111-2222-3333-444455556666";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

async function main() {
  console.log("\n── the decision");
  check("a real id outside a dry run is written", mappingDecision({ morningId: REAL, dryRun: false }), { write: true });
  check("a dry run is never written", mappingDecision({ morningId: REAL, dryRun: true }), { write: false, reason: "dry-run" });
  check(
    "a synthetic id is refused even when the flag says real",
    mappingDecision({ morningId: "dry-client-123", dryRun: false }),
    { write: false, reason: "synthetic-id" }
  );
  check("prefix detection", [isSyntheticMorningId("dry-client-x"), isSyntheticMorningId("dry-abc"), isSyntheticMorningId(REAL), isSyntheticMorningId(null)], [true, true, false, false]);

  console.log("\n── 🔴 the dry-run branch touches no table");
  {
    const r = recorder();
    const out = await persistMorningMapping(r.admin, { clientId: CLIENT, morningId: "dry-client-1", dryRun: true });
    check("dry run: not written", out, { written: false, reason: "dry-run" });
    check("dry run: ZERO calls to the database", r.calls, []);
  }
  {
    const r = recorder();
    const out = await persistMorningMapping(r.admin, { clientId: CLIENT, morningId: "dry-client-2", dryRun: false });
    check("synthetic id with a lying flag: not written", out, { written: false, reason: "synthetic-id" });
    check("synthetic id: ZERO calls to the database", r.calls, []);
  }
  {
    const r = recorder();
    const out = await persistMorningMapping(r.admin, { clientId: CLIENT, morningId: REAL, dryRun: false });
    check("real id: written", out, { written: true });
    check("real id: exactly clients.update(morning_client_id).eq(id)", r.calls, [
      `admin.from(["clients"])`,
      `admin.from().update([{"morning_client_id":"${REAL}"}])`,
      `admin.from().update().eq(["id","${CLIENT}"])`,
    ]);
  }

  console.log("\n── the synthetic id really carries the prefix");
  {
    process.env.MORNING_DRY_RUN = "true"; // forced: no network call is possible below
    const { createMorningClient, isDryRun } = await import("../src/lib/morning/client");
    check("dry run is on for this call", isDryRun(), true);
    const res = await createMorningClient({ name: "בדיקה" });
    check("createMorningClient in dry run says so", res.dryRun, true);
    check("…and its id starts with the shared prefix", res.id.startsWith(SYNTHETIC_MORNING_ID_PREFIX), true);
    check("…so the decision refuses it", mappingDecision({ morningId: res.id, dryRun: res.dryRun }).write, false);
  }

  console.log("\n── the route goes through the guard");
  {
    const route = readFileSync(join(process.cwd(), "src/app/api/morning/clients/create/route.ts"), "utf8");
    check("the route maps through persistMorningMapping", route.includes("persistMorningMapping(admin"), true);
    check("the route has no direct morning_client_id write of its own", /update\(\{\s*morning_client_id/.test(route), false);
    check("the route answers dry_run", /dry_run: dryRun,/.test(route), true);
    check("the route returns no Morning id when nothing was mapped", route.includes("morning_client_id: mapped.written ? morningId : null"), true);
    check("the route backfills only after a real mapping", route.includes("mapped.written ? await backfillDocumentClients"), true);
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
  if (failed > 0) process.exit(1);
}

main();
