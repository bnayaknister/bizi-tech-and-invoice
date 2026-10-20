/**
 * Renaming a show (owner 20.10). Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_show_rename.ts
 * No users, no database, no network. Drives planShowRename (the decision the
 * route writes) and reads the route sources to prove there is exactly ONE way
 * to change shows.name: /api/shows/[id]/rename, owner/admin only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normShowLabel, planShowRename, SHOW_NAME_MAX } from "../src/lib/shows/rename";
import { ENTITY_CONFIG } from "../src/lib/entities";

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

const ME = { id: "a", name: "גיא ואור", aliases: ["גיא אור"] };
const OTHERS = [ME, { id: "b", name: "סדרת חינוך", aliases: ["חינוך"] }, { id: "c", name: "דור הZ", aliases: ["דור ה-z"] }];

console.log("\n=== 1. the old name becomes an alias ===");
check("rename: new name, old name appended", planShowRename(ME, "גיא ואור — העונה השנייה", OTHERS), {
  ok: true, name: "גיא ואור — העונה השנייה", aliases: ["גיא אור", "גיא ואור"], aliasAdded: "גיא ואור",
});
check("no aliases before: the old name is the first", planShowRename({ id: "a", name: "ישן", aliases: [] }, "חדש", []), {
  ok: true, name: "חדש", aliases: ["ישן"], aliasAdded: "ישן",
});
check("null aliases are read as none", planShowRename({ id: "a", name: "ישן", aliases: null }, "חדש", []).ok, true);
check("old name already an alias (same normalisation): not added twice",
  planShowRename({ id: "a", name: "גיא ואור", aliases: ["גיא-ואור"] }, "חדש", []), { ok: true, name: "חדש", aliases: ["גיא-ואור"], aliasAdded: null });
check("renaming TO an existing alias: it leaves the aliases (it is the name now), the old name joins",
  planShowRename(ME, "גיא אור", OTHERS), { ok: true, name: "גיא אור", aliases: ["גיא ואור"], aliasAdded: "גיא ואור" });
check("a spelling-only change (same normalised label): no alias needed",
  planShowRename({ id: "a", name: "דור הZ", aliases: [] }, "דור הz", []), { ok: true, name: "דור הz", aliases: [], aliasAdded: null });
check("spaces are collapsed and trimmed", planShowRename(ME, "  שם   חדש  ", OTHERS).ok && (planShowRename(ME, "  שם   חדש  ", OTHERS) as { name: string }).name, "שם חדש");

console.log("\n=== 2. refused ===");
check("empty", planShowRename(ME, "   ", OTHERS).ok === false && (planShowRename(ME, "   ", OTHERS) as { code: string }).code, "empty");
check("not a string", (planShowRename(ME, 42, OTHERS) as { code: string }).code, "empty");
check("unchanged", (planShowRename(ME, "גיא ואור", OTHERS) as { code: string }).code, "unchanged");
check("too long", (planShowRename(ME, "א".repeat(SHOW_NAME_MAX + 1), OTHERS) as { code: string }).code, "too-long");
check("exactly the limit is fine", planShowRename(ME, "א".repeat(SHOW_NAME_MAX), OTHERS).ok, true);
check("another show's NAME", (planShowRename(ME, "סדרת חינוך", OTHERS) as { code: string }).code, "duplicate");
check("another show's ALIAS", (planShowRename(ME, "חינוך", OTHERS) as { code: string }).code, "duplicate");
check("another show's alias under normalisation (case, dash)", (planShowRename(ME, "דור ה Z", OTHERS) as { code: string }).code, "duplicate");
check("the duplicate message names the other show", (planShowRename(ME, "חינוך", OTHERS) as { error: string }).error.includes("סדרת חינוך"), true);
check("normShowLabel lowercases and strips punctuation", normShowLabel("Dor-HaZ!"), "dor haz");

console.log("\n=== 3. one way in: the rename route, owner/admin ===");
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const update = src("src/app/api/shows/update/route.ts");
const stageBlock = /const STAGE_FIELDS = new Set\(\[([\s\S]*?)\]\)/.exec(update)?.[1] ?? "";
check("/api/shows/update no longer accepts `name`", /"name"/.test(stageBlock), false);
check("…and still accepts aliases", /"aliases"/.test(stageBlock), true);
const showName = ENTITY_CONFIG.show.fields.find((f) => f.key === "name");
check("the entity drawer: show name is read-only", [showName?.type, showName?.edit], ["readonly", "none"]);
const route = src("src/app/api/shows/[id]/rename/route.ts");
check("the rename route checks hasOwnerAccess", /hasOwnerAccess\(profile\)/.test(route), true);
check("…writes through planShowRename", /planShowRename\(/.test(route), true);
check("…conditional on the name it read (no lost alias on a race)", /\.eq\("name", current\.name\)/.test(route), true);
check("…logs show_renamed", /event_type: "show_renamed"/.test(route), true);
check("…touches no production / document / job table", /from\("(productions|stages|jobs|pending_documents|documents)"\)/.test(route), false);

console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
