/**
 * The PUBLIC privacy policy (/privacy), the page Meta's app settings link to.
 * Pure.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_privacy_render.tsx
 * No users, no database, no dev server, no route — F19 is open and nothing here
 * goes near it.
 *
 * What it guards:
 *   1. the page renders with NO session — PrivacyPage is called as a plain
 *      function, and neither it nor its body imports anything that reads one;
 *   2. the `deletion` anchor exists exactly once — Meta stores
 *      /privacy#deletion, and a renamed id breaks that link silently;
 *   3. the middleware's open list carries /privacy, so an unapproved account
 *      is not bounced to /pending.
 * Text assertions count occurrences (rule 56), not `includes`.
 */
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import PrivacyPage from "../src/app/privacy/page";
import {
  PRIVACY_CONTACT_EMAIL,
  PRIVACY_SECTIONS,
  PRIVACY_TITLE,
  PRIVACY_UPDATED_AT,
} from "../src/lib/legal/privacy";

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
const seen = (html: string) =>
  html.replace(/<!--.*?-->/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const countOf = (html: string, needle: string) => seen(html).split(needle).length - 1;

console.log("\n— renders with no session —");
const html = renderToString(PrivacyPage());
check("rendered something", html.length > 0, true);
check("RTL wrapper", countOf(html, 'dir="rtl"'), 1);
check("title once", countOf(html, PRIVACY_TITLE), 1);
check("updated-at once", countOf(html, PRIVACY_UPDATED_AT), 1);

console.log("\n— anchors —");
check('id="deletion" exactly once', countOf(html, 'id="deletion"'), 1);
check("deletion section is in the content file", PRIVACY_SECTIONS.filter((s) => s.id === "deletion").length, 1);
for (const s of PRIVACY_SECTIONS) {
  check(`section "${s.id}" heading once`, countOf(html, s.title), 1);
  check(`section "${s.id}" id once`, countOf(html, `id="${s.id}"`), 1);
}
check("anchor ids unique", new Set(PRIVACY_SECTIONS.map((s) => s.id)).size, PRIVACY_SECTIONS.length);

console.log("\n— the content Meta's reviewer looks for —");
const deletion = PRIVACY_SECTIONS.find((s) => s.id === "deletion")!;
check("deletion names the email", deletion.paragraphs.join(" ").split(PRIVACY_CONTACT_EMAIL).length - 1, 1);
check("deletion names the 30 days", deletion.paragraphs.join(" ").split("30 יום").length - 1, 1);
check("company name once", countOf(html, "BIZI STUDIO LTD"), 1);
check("mailto link once", countOf(html, `href="mailto:${PRIVACY_CONTACT_EMAIL}"`), 1);

console.log("\n— no session, no database, by construction —");
const FORBIDDEN = /supabase|getSessionAndProfile|next\/headers|cookies\(/;
for (const f of ["src/app/privacy/page.tsx", "src/app/privacy/PrivacyBody.tsx", "src/lib/legal/privacy.ts"]) {
  check(`${f} reads no session/db`, FORBIDDEN.test(readFileSync(f, "utf8")), false);
}
check("page carries no redirect", /redirect\(/.test(readFileSync("src/app/privacy/page.tsx", "utf8")), false);

console.log("\n— middleware open list —");
const mw = readFileSync("src/lib/supabase/middleware.ts", "utf8");
check('middleware opens path === "/privacy"', mw.split('path === "/privacy"').length - 1, 1);

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
if (failed > 0) process.exit(1);
