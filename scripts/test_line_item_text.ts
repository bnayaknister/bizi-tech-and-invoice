/**
 * buildLineItemText + shortDate — the printed line of a document (owner spec
 * 2026-08-20).
 *
 * Run:  npx tsx scripts/test_line_item_text.ts
 *
 * TOUCHES NOTHING. No database, no network, no env. Both functions are pure,
 * so this file is arguments in / strings out.
 *
 * The contract under test:
 *   with a guest     {podcast} · {guest} · {DD.MM.YY}
 *   without a guest  {podcast} {DD.MM.YY}
 * and, above all, NO ORPHANS: no input may produce " · · ", a dangling
 * separator, or the word "undefined".
 */
import { buildLineItemText } from "../src/lib/documents/enqueue";
import { shortDate } from "../src/lib/dates";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`)
  );
}

// ---------------------------------------------------------------------------
console.log("shortDate — string manipulation only, never Date()");
// ---------------------------------------------------------------------------
eq("the spec's own example", shortDate("2028-07-31"), "31.07.28");
eq("a real record_date", shortDate("2026-08-11"), "11.08.26");
eq("turn of the century keeps two digits", shortDate("2001-01-05"), "05.01.01");
eq("day 01 is not trimmed", shortDate("2026-12-01"), "01.12.26");
// The one that string manipulation gets right and `new Date()` does not: west
// of Greenwich, new Date("2026-01-01") renders as 31.12.25.
eq("no timezone shift on a January 1st", shortDate("2026-01-01"), "01.01.26");
eq("null", shortDate(null), null);
eq("undefined", shortDate(undefined), null);
eq("empty", shortDate(""), null);
eq("whitespace only", shortDate("   "), null);
eq("not a date", shortDate("לא תאריך"), null);
eq("wrong shape (single-digit month)", shortDate("2026-8-11"), null);
eq("a timestamp is refused, not truncated", shortDate("2026-08-11T00:00:00Z"), null);
eq("surrounding whitespace tolerated", shortDate("  2026-08-11  "), "11.08.26");

// ---------------------------------------------------------------------------
console.log("\nbuildLineItemText — the six shapes");
// ---------------------------------------------------------------------------
const P = "דעה לא פופולרית";
const G = "חיים ילדין";
const D = "2028-07-31";

eq(
  "all three -> · separated",
  buildLineItemText({ podcast_name: P, guest: G, record_date: D }),
  "דעה לא פופולרית · חיים ילדין · 31.07.28"
);
eq(
  "no guest -> space separated, no orphan ·",
  buildLineItemText({ podcast_name: "אסתטיטוקס", guest: null, record_date: "2026-08-11" }),
  "אסתטיטוקס 11.08.26"
);
eq(
  "no date -> no trailing separator",
  buildLineItemText({ podcast_name: P, guest: G, record_date: null }),
  "דעה לא פופולרית · חיים ילדין"
);
eq("show only", buildLineItemText({ podcast_name: P, guest: null, record_date: null }), P);
eq(
  "no show -> no leading separator",
  buildLineItemText({ podcast_name: null, guest: G, record_date: D }),
  "חיים ילדין · 31.07.28"
);
eq("nothing at all -> empty string", buildLineItemText({}), "");

// ---------------------------------------------------------------------------
console.log("\nbuildLineItemText — the ways it could go wrong");
// ---------------------------------------------------------------------------
eq(
  "guest with surrounding and doubled internal whitespace",
  buildLineItemText({ podcast_name: "  SFI  ", guest: "  אלי   בוך  ", record_date: D }),
  "SFI · אלי בוך · 31.07.28"
);
eq(
  "whitespace-only guest counts as no guest (space, not ·)",
  buildLineItemText({ podcast_name: P, guest: "   ", record_date: D }),
  "דעה לא פופולרית 31.07.28"
);
eq(
  "empty-string guest counts as no guest",
  buildLineItemText({ podcast_name: P, guest: "", record_date: D }),
  "דעה לא פופולרית 31.07.28"
);
eq(
  "unparseable date is dropped, not printed raw",
  buildLineItemText({ podcast_name: P, guest: G, record_date: "11/08/2026" }),
  "דעה לא פופולרית · חיים ילדין"
);
eq(
  "a guest whose name contains the separator survives",
  buildLineItemText({ podcast_name: P, guest: "יוסי · כהן", record_date: D }),
  "דעה לא פופולרית · יוסי · כהן · 31.07.28"
);
eq(
  "an em dash inside the show name is left alone",
  buildLineItemText({ podcast_name: "עומר חן — The Communicators", guest: null, record_date: D }),
  "עומר חן — The Communicators 31.07.28"
);

// No input may leak these. Checked over the whole cross product rather than
// case by case: this is the invariant the whole design exists to hold.
console.log("\nno-orphan invariant over every combination");
const shows = [null, undefined, "", "  ", P];
const guests = [null, undefined, "", "  ", G];
const dates = [null, undefined, "", "bad", D];
let checked = 0;
let violations: string[] = [];
for (const podcast_name of shows)
  for (const guest of guests)
    for (const record_date of dates) {
      const out = buildLineItemText({ podcast_name, guest, record_date });
      checked++;
      if (
        out !== out.trim() ||
        out.includes("undefined") ||
        out.includes("null") ||
        out.includes("· ·") ||
        out.startsWith("·") ||
        out.endsWith("·") ||
        /\s{2,}/.test(out)
      ) {
        violations.push(`${JSON.stringify({ podcast_name, guest, record_date })} -> ${JSON.stringify(out)}`);
      }
    }
eq(`${checked} combinations, zero orphans`, violations.length, 0);
for (const v of violations) console.log("        " + v);

console.log(`\n${failed === 0 ? "all checks passed" : `${failed} FAILED`}`);
process.exit(failed ? 1 : 0);
