/**
 * E14 — the rollout gate: WHATSAPP_BOOKING_FREETEXT + WHATSAPP_FREETEXT_ALLOWLIST. Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_wa_freetext_gate.ts
 * No users, no database, no network, no Meta. The env is passed in as an
 * argument everywhere except section 6, which sets it inside this process only.
 *
 * Owner rule (20.10): the free-text layer works only when the switch is
 * exactly "true" AND (the list is empty = everyone, OR the number is on it).
 * Every other number gets the bot exactly as it is today.
 */
import { isFreeTextOnFor, parseFreeTextAllowlist } from "../src/lib/whatsapp/flow/run";

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

const ME = "972528933975"; // the wa_id Meta sends for 052-893-3975
const OTHER = "972501234567";

// the refused-entry log line is expected in some cases; keep the output readable
const realError = console.error;
let errorLines = 0;
console.error = () => {
  errorLines++;
};

console.log("\n=== 1. switch OFF: nobody, whatever the list says ===");
check("unset switch, empty list", isFreeTextOnFor(ME, { flag: undefined, allowlist: undefined }), false);
check("unset switch, me on the list", isFreeTextOnFor(ME, { flag: undefined, allowlist: ME }), false);
check('"false"', isFreeTextOnFor(ME, { flag: "false", allowlist: ME }), false);
check('"TRUE" is not "true" (rule 40)', isFreeTextOnFor(ME, { flag: "TRUE", allowlist: "" }), false);
check('" true" is not "true"', isFreeTextOnFor(ME, { flag: " true", allowlist: "" }), false);
check('"1" is not "true"', isFreeTextOnFor(ME, { flag: "1", allowlist: "" }), false);

console.log("\n=== 2. switch ON + empty list: everyone ===");
check("list unset", isFreeTextOnFor(OTHER, { flag: "true", allowlist: undefined }), true);
check('list ""', isFreeTextOnFor(OTHER, { flag: "true", allowlist: "" }), true);
check("list of blanks and commas", isFreeTextOnFor(OTHER, { flag: "true", allowlist: " , ,  " }), true);
check("parse: unset = all", parseFreeTextAllowlist(undefined), { all: true, numbers: [], rejected: 0 });

console.log("\n=== 3. switch ON + number on the list ===");
check("exact wa_id", isFreeTextOnFor(ME, { flag: "true", allowlist: ME }), true);
check("one of several", isFreeTextOnFor(ME, { flag: "true", allowlist: `${OTHER},${ME}` }), true);
check("Meta's wa_id with a leading + still matches", isFreeTextOnFor(`+${ME}`, { flag: "true", allowlist: ME }), true);

console.log("\n=== 4. switch ON + number NOT on the list ===");
check("another number", isFreeTextOnFor(OTHER, { flag: "true", allowlist: ME }), false);
check("a near miss (one digit off)", isFreeTextOnFor("972528933976", { flag: "true", allowlist: ME }), false);
check("a garbage sender never matches", isFreeTextOnFor("not-a-number", { flag: "true", allowlist: ME }), false);
check("an empty sender never matches", isFreeTextOnFor("", { flag: "true", allowlist: ME }), false);

console.log("\n=== 5. the same number written different ways ===");
for (const spelled of [
  "0528933975",
  "052-893-3975",
  "052 893 3975",
  "+972528933975",
  "+972-52-893-3975",
  "+972 (0)52-893-3975",
  "00972528933975",
  "972528933975",
  " 0528933975 ",
  "052–893–3975", // en dash, as pasted from a contact card
]) {
  check(`"${spelled}" lets ${ME} in`, isFreeTextOnFor(ME, { flag: "true", allowlist: spelled }), true);
}
check(
  "all spellings collapse to one entry",
  parseFreeTextAllowlist("0528933975, +972-52-893-3975,972528933975").numbers,
  [ME]
);
check(
  "a list of two keeps both",
  parseFreeTextAllowlist("0528933975,0501234567").numbers,
  [ME, OTHER]
);

console.log("\n=== 6. typos: refused, counted, never widen the gate ===");
check(
  "one good, one bad: the good one works",
  [isFreeTextOnFor(ME, { flag: "true", allowlist: "0528933975,05289" }), parseFreeTextAllowlist("0528933975,05289").rejected],
  [true, 1]
);
check("one good, one bad: others stay out", isFreeTextOnFor(OTHER, { flag: "true", allowlist: "0528933975,05289" }), false);
check("ONLY typos = nobody (fail closed, not 'everyone')", isFreeTextOnFor(OTHER, { flag: "true", allowlist: "abc,123" }), false);
check("parse: only typos", parseFreeTextAllowlist("abc,123"), { all: false, numbers: [], rejected: 2 });
check("a refused entry is logged (count only)", errorLines > 0, true);

console.log("\n=== 7. the default argument reads the real env ===");
{
  const saved = { f: process.env.WHATSAPP_BOOKING_FREETEXT, a: process.env.WHATSAPP_FREETEXT_ALLOWLIST };
  try {
    delete process.env.WHATSAPP_BOOKING_FREETEXT;
    delete process.env.WHATSAPP_FREETEXT_ALLOWLIST;
    check("env unset -> off", isFreeTextOnFor(ME), false);
    process.env.WHATSAPP_BOOKING_FREETEXT = "true";
    check("switch on, no list -> on for anyone", isFreeTextOnFor(OTHER), true);
    process.env.WHATSAPP_FREETEXT_ALLOWLIST = "0528933975";
    check("switch on, list = me -> me", isFreeTextOnFor(ME), true);
    check("switch on, list = me -> not others", isFreeTextOnFor(OTHER), false);
  } finally {
    if (saved.f === undefined) delete process.env.WHATSAPP_BOOKING_FREETEXT;
    else process.env.WHATSAPP_BOOKING_FREETEXT = saved.f;
    if (saved.a === undefined) delete process.env.WHATSAPP_FREETEXT_ALLOWLIST;
    else process.env.WHATSAPP_FREETEXT_ALLOWLIST = saved.a;
  }
}

console.error = realError;
console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
