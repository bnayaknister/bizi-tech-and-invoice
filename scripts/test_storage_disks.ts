/**
 * B35 — recording disks as a closed list (0120). Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_storage_disks.ts
 * No users, no database, no network. The database walls (unique key, the
 * sync trigger, FK RESTRICT) were proven by 0120's dryrun/verify; this suite
 * proves the app side: the same key as SQL, the technician's choices, the
 * error sentences, and — by reading the sources — that no free-text path to
 * productions.storage_disk is left and that management is owner/admin only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diskChoices, diskCollision, diskKey, diskWriteError, validateDiskName, DISK_NAME_MAX } from "../src/lib/disks";
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
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const DISKS = [
  { id: "1", name: "kong" },
  { id: "2", name: "wd 3" },
  { id: "3", name: "Mac lobby Pro Max" },
];

console.log("\n=== 1. the key = SQL storage_disk_key (no whitespace, lower case) ===");
check("'wd 3' and 'WD3' share a key", [diskKey("wd 3"), diskKey("WD3"), diskKey(" w d  3 ")], ["wd3", "wd3", "wd3"]);
check("'kong' vs 'kong 3' differ", diskKey("kong") === diskKey("kong 3"), false);
check("Hebrew untouched but spaces dropped", diskKey("מק לובי"), "מקלובי");
const sql = src("supabase/migrations/0120_storage_disks.sql");
check("the SQL key is the same rule (btrim, \\s+ removed, lower)", /lower\(regexp_replace\(btrim\(p\), '\\s\+', '', 'g'\)\)/.test(sql), true);

console.log("\n=== 2. names ===");
check("trimmed, inner spaces collapsed", validateDiskName("  SSD   04 "), { ok: true, name: "SSD 04" });
check("empty refused", validateDiskName("   ").ok, false);
check("not a string refused", validateDiskName(7).ok, false);
check("60 is fine", validateDiskName("א".repeat(DISK_NAME_MAX)).ok, true);
check("61 refused", validateDiskName("א".repeat(DISK_NAME_MAX + 1)).ok, false);
check("collision by key: 'WD3' hits 'wd 3'", diskCollision("WD3", DISKS)?.name, "wd 3");
check("collision by key: 'Kong' hits 'kong'", diskCollision("Kong", DISKS)?.name, "kong");
check("renaming a disk to its own name with other spacing is not a collision with itself", diskCollision("wd3", DISKS, "2"), null);
check("'kong 3' is a new name, no collision", diskCollision("kong 3", DISKS), null);

console.log("\n=== 3. the technician's choices: the list only ===");
check("visible disks, by name", diskChoices(DISKS, { id: "1", name: "kong" }).map((c) => c.label), ["kong", "wd 3", "Mac lobby Pro Max"]);
check("the production's HIDDEN disk is offered too, marked", diskChoices(DISKS, { id: "9", name: "old" }).pop(), { id: "9", label: "old (מוסתר)" });
check("no current disk: nothing extra", diskChoices(DISKS, { id: null, name: null }).length, 3);
check("a hidden disk is never offered to a production that is not on it", diskChoices(DISKS, { id: "1", name: "kong" }).some((c) => c.label.includes("מוסתר")), false);

console.log("\n=== 4. error sentences ===");
check("23505 duplicate", diskWriteError({ code: "23505" }).includes("כבר יש כונן"), true);
check("23503 has productions -> hide instead", diskWriteError({ code: "23503" }).includes("להסתיר"), true);
check("other: the message", diskWriteError({ message: "boom" }), "boom");

console.log("\n=== 5. no free-text path to productions.storage_disk ===");
const f = (k: string) => ENTITY_CONFIG.production.fields.find((x) => x.key === k);
check("generic drawer: storage_disk is read-only", [f("storage_disk")?.type, f("storage_disk")?.edit], ["readonly", "none"]);
check("generic drawer: storage_disk_id editable by stages", f("storage_disk_id")?.edit, "stages");
const drawer = src("src/components/EntityDrawer.tsx");
check("the disk modal writes storage_disk_id", /patch: \{ storage_disk_id: diskValue \|\| null \}/.test(drawer), true);
check("…and never storage_disk", /patch: \{ storage_disk:/.test(drawer), false);
check("…a <select>, no datalist", /<datalist id="disk-options">/.test(drawer), false);
check("…'לא מופיע? בקשו מבניה להוסיף.'", drawer.includes("לא מופיע? בקשו מבניה להוסיף."), true);
check("both disk columns stay out of the generic field rows", /f\.key === "storage_disk" \|\| f\.key === "storage_disk_id"/.test(drawer), true);
const get = src("src/lib/drawer/entityGet.ts");
check("the list comes from storage_disks, visible only", /from\("storage_disks"\)\.select\("id,name"\)\.eq\("hidden", false\)/.test(get), true);
check("…not from the distinct typed values", /select\("storage_disk"\)\.not\("storage_disk"/.test(get), false);

console.log("\n=== 6. management: owner/admin only ===");
const gate = src("src/lib/disks.server.ts");
check("the gate is hasOwnerAccess", /hasOwnerAccess\(profile\)/.test(gate), true);
for (const p of ["src/app/api/storage-disks/route.ts", "src/app/api/storage-disks/[id]/route.ts"]) {
  const r = src(p);
  const handlers = (r.match(/export async function (GET|POST|PATCH|DELETE)/g) ?? []).length;
  const gated = (r.match(/const gate = await requireDiskManager\(\);\n\s+if \("response" in gate\) return gate\.response;/g) ?? []).length;
  check(`${p}: every handler is gated (${handlers})`, gated, handlers);
}
const del = src("src/app/api/storage-disks/[id]/route.ts");
check("delete refuses a disk with productions before the FK does", /if \(disk\.productions > 0\)/.test(del), true);
check("the screen redirects anyone but owner/admin", /if \(!hasOwnerAccess\(profile\)\) redirect\("\/"\)/.test(src("src/app/settings/disks/page.tsx")), true);

console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
