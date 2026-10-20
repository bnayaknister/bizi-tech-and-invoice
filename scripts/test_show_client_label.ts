/**
 * "הצג שם לקוח בשורת ההפקה" (owner 20.10). Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_show_client_label.ts
 * No users, no database, no network: the label and settings helpers, the
 * loader on scripts/_fake_db.ts, and the sources read for the gates.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDb } from "./_fake_db";
import { productionLabel, showClientNameOn, withShowClientName } from "../src/lib/shows/clientLabel";
import { loadClientLabels } from "../src/lib/shows/clientLabel.server";

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
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

async function main() {
  console.log("\n=== 1. the label ===");
  check("ON + client: '<show> – <client>' (show first, en dash)", productionLabel("אסתטיטוקס", "סבטלנה ניקסון", true), "אסתטיטוקס – סבטלנה ניקסון");
  check("OFF: the show name, unchanged", productionLabel("שומעת רגע?", "קורין קיציס", false), "שומעת רגע?");
  check("ON but no client: the show name", productionLabel("שומעת רגע?", null, true), "שומעת רגע?");
  check("ON, blank client: the show name", productionLabel("שומעת רגע?", "  ", true), "שומעת רגע?");

  console.log("\n=== 2. the setting in shows.settings ===");
  check("{} is OFF (every show today)", showClientNameOn({}), false);
  check("null / array / string are OFF", [showClientNameOn(null), showClientNameOn([]), showClientNameOn("x")], [false, false, false]);
  check("only exactly true is ON", [showClientNameOn({ show_client_name: true }), showClientNameOn({ show_client_name: "true" })], [true, false]);
  check("set ON keeps other keys", withShowClientName({ other: 1 }, true), { other: 1, show_client_name: true });
  check("set OFF on {}", withShowClientName({}, false), { show_client_name: false });
  check("bad settings become an object", withShowClientName(null, true), { show_client_name: true });

  console.log("\n=== 3. the loader: only shows with the setting ON, by their client ===");
  const db = fakeDb({
    shows: [
      { id: "s-on", client_id: "c1", settings: { show_client_name: true } },
      { id: "s-off", client_id: "c2", settings: {} },
      { id: "s-on-noclient", client_id: null, settings: { show_client_name: true } },
      { id: "s-on-2", client_id: "c3", settings: { show_client_name: true } },
    ],
    clients: [
      { id: "c1", name: "קורין קיציס" },
      { id: "c2", name: "לא אמור להיקרא" },
      { id: "c3", name: "סבטלנה נקסון" },
    ],
  });
  const all = await loadClientLabels(db.client);
  check("ON shows with a client, and only them", Array.from(all.entries()).sort(), [["s-on", "קורין קיציס"], ["s-on-2", "סבטלנה נקסון"]]);
  const clientReads = db.calls.filter((c) => c.table === "clients");
  check("one clients read", clientReads.length, 1);
  const one = await loadClientLabels(db.client, ["s-off"]);
  check("a show with the setting OFF resolves nothing", one.size, 0);
  const none = fakeDb({ shows: [{ id: "s", client_id: "c", settings: {} }], clients: [] });
  await loadClientLabels(none.client);
  check("nothing ON: clients is not read at all", none.calls.filter((c) => c.table === "clients").length, 0);

  console.log("\n=== 4. gates and wiring (sources) ===");
  const update = src("src/app/api/shows/update/route.ts");
  const stageBlock = /const STAGE_FIELDS = new Set\(\[([\s\S]*?)\]\)/.exec(update)?.[1] ?? "";
  check("/api/shows/update no longer accepts `settings`", /"settings"/.test(stageBlock), false);
  const display = src("src/app/api/shows/[id]/display/route.ts");
  check("the display route is owner/admin (hasOwnerAccess)", /hasOwnerAccess\(profile\)/.test(display), true);
  check("…accepts a boolean only", /typeof body\.show_client_name !== "boolean"/.test(display), true);
  check("…keeps other settings keys (withShowClientName)", /withShowClientName\(show\.settings/.test(display), true);
  check("…logs show_display_updated", /event_type: "show_display_updated"/.test(display), true);
  const shows = src("src/app/shows/ShowsClient.tsx");
  check("the checkbox is behind canRename (owner/admin)", /\{canRename && \(\s*<label[\s\S]{0,200}הצג שם לקוח בשורת ההפקה|\{canRename && \(\s*<label[\s\S]*?הצג שם לקוח בשורת ההפקה/.test(shows), true);
  const board = src("src/app/productions/ProductionsClient.tsx");
  check("the card shows display_name, full name in the tooltip", /title=\{p\.display_name\}>\{p\.display_name\}/.test(board), true);
  check("…truncated with an ellipsis (truncate)", /className="font-bold text-sm truncate flex-1" title=\{p\.display_name\}/.test(board), true);
  check("search matches display_name (the client of an ON show, for everyone)", /p\.display_name\.toLowerCase\(\)\.includes\(q\)/.test(board), true);
  check("search still matches client_name (every show, money viewers)", /\(p\.client_name \?\? ""\)\.toLowerCase\(\)\.includes\(q\)/.test(board), true);
  const page = src("src/app/productions/page.tsx");
  check("the board builds display_name with productionLabel", /display_name: productionLabel\(/.test(page), true);
  const get = src("src/lib/drawer/entityGet.ts");
  check("the drawer title uses the same label", /title: labelTitle \?\?/.test(get) && /productionLabel\(show\.name as string, client, true\)/.test(get), true);
  const drawer = src("src/components/EntityDrawer.tsx");
  check("the drawer title has the full name as a tooltip", /className="text-sm font-bold truncate" title=/.test(drawer), true);

  console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
void main();
