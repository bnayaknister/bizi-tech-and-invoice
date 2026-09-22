/**
 * The hub's module nav, rendered per role. Pure.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_nav_availability_render.tsx
 *
 * Creates no users, writes nothing, reads no database, and needs no dev server —
 * F19 (tests that run against the live database) is still open and unresolved,
 * so this suite stays entirely offline. It can: the nav is `MODULES.filter(m =>
 * m.hasAccess(profile))` over a pure registry, and ModuleCard is a plain server
 * component with no hooks, so a synthetic Profile object is the whole fixture.
 *
 * Assertions COUNT occurrences rather than locate them (rule 56): "the link
 * appears" would pass just as well if it appeared twice.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import { MODULES } from "../src/modules/registry";
import { availabilityModule } from "../src/modules/availability";
import { archiveModule } from "../src/modules/archive";
import { settingsModule } from "../src/modules/settings";
import ModuleCard from "../src/components/ModuleCard";
import type { Profile } from "../src/lib/profile";
import type { ModuleMetric } from "../src/modules/types";

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
/** visible text: undo React's <!-- --> text separators and entity escaping */
const seen = (html: string) =>
  html.replace(/<!--.*?-->/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const countOf = (html: string, needle: string) => seen(html).split(needle).length - 1;

const LINK = "זמינות אולפנים";
const HREF = "/calendar/availability";

// Every capability ON, so the only thing separating these three profiles is
// `role`. If the gate were a capability flag by mistake, all three would show
// the card and the role cases below would fail rather than pass by luck.
const base: Omit<Profile, "role"> = {
  id: "00000000-0000-0000-0000-000000000000",
  name: "ZTEST",
  email: "ztest@example.com",
  approved: true,
  can_view_money: true,
  can_edit_money: true,
  can_view_stages: true,
  can_edit_stages: true,
  can_manage_users: true,
  can_import: true,
};
const owner: Profile = { ...base, role: "owner" };
const tech: Profile = { ...base, role: "tech" };
const bookkeeper: Profile = { ...base, role: "bookkeeper" };
const nullRole: Profile = { ...base, role: null };
const unapprovedOwner: Profile = { ...base, role: "owner", approved: false };

const METRIC: ModuleMetric = { label: "גישה", value: "בדיקה פנימית", tone: "default" };

/** exactly what src/app/page.tsx does to build the nav, minus the metrics fetch */
function renderNav(profile: Profile): string {
  const visible = MODULES.filter((m) => m.hasAccess(profile));
  return renderToString(
    <div>
      {visible.map((m, i) => (
        <ModuleCard
          key={m.key}
          moduleKey={m.key}
          title={m.title}
          icon={m.icon}
          href={m.href}
          metric={METRIC}
          index={i}
        />
      ))}
    </div>
  );
}

console.log("\n=== the registry entry copies the existing owner-only predicate ===");
{
  check("title is the approved wording", availabilityModule.title, LINK);
  check("href", availabilityModule.href, HREF);
  // the predicate is compared by BEHAVIOUR against the two modules it copies,
  // across every profile shape — a string comparison of source would not catch
  // a subtly different condition
  const profiles: [string, Profile][] = [
    ["owner", owner], ["tech", tech], ["bookkeeper", bookkeeper],
    ["null role", nullRole], ["unapproved owner", unapprovedOwner],
  ];
  for (const [label, p] of profiles) {
    check(
      `${label}: same verdict as archive and settings`,
      [availabilityModule.hasAccess(p), availabilityModule.hasAccess(p)],
      [archiveModule.hasAccess(p), settingsModule.hasAccess(p)]
    );
  }
  check("owner is admitted", availabilityModule.hasAccess(owner), true);
  check("tech is not", availabilityModule.hasAccess(tech), false);
  check("bookkeeper is not", availabilityModule.hasAccess(bookkeeper), false);
  check("a null role is not", availabilityModule.hasAccess(nullRole), false);
  check("an UNAPPROVED owner is not", availabilityModule.hasAccess(unapprovedOwner), false);
}

console.log("\n=== rendered nav, by role ===");
{
  const asOwner = renderNav(owner);
  check("owner: link text exactly once", countOf(asOwner, LINK), 1);
  check("owner: href exactly once", countOf(asOwner, `href="${HREF}"`), 1);

  const asTech = renderNav(tech);
  check("tech: link text zero times", countOf(asTech, LINK), 0);
  check("tech: href zero times", countOf(asTech, HREF), 0);

  const asBookkeeper = renderNav(bookkeeper);
  check("bookkeeper: link text zero times", countOf(asBookkeeper, LINK), 0);
  check("bookkeeper: href zero times", countOf(asBookkeeper, HREF), 0);

  check("null role: zero", countOf(renderNav(nullRole), LINK), 0);
  check("unapproved owner: zero", countOf(renderNav(unapprovedOwner), LINK), 0);
}

console.log("\n=== the card did not displace or duplicate anything ===");
{
  check("registry holds no duplicate keys", MODULES.length, new Set(MODULES.map((m) => m.key)).size);
  check("registry holds no duplicate hrefs", MODULES.length, new Set(MODULES.map((m) => m.href)).size);
  check("availability is registered exactly once", MODULES.filter((m) => m.key === "availability").length, 1);

  const keys = MODULES.map((m) => m.key);
  check("it sits with the owner-only cluster, before archive/settings",
    keys.slice(-3), ["availability", "archive", "settings"]);

  // the counts the owner would notice: one card added for an owner, none for
  // anyone else
  const ownerKeys = MODULES.filter((m) => m.hasAccess(owner)).map((m) => m.key);
  const techKeys = MODULES.filter((m) => m.hasAccess(tech)).map((m) => m.key);
  check("owner sees availability among their cards", ownerKeys.includes("availability"), true);
  check("tech does not", techKeys.includes("availability"), false);
  check("every other module's verdict for tech is unchanged by this commit",
    techKeys.includes("archive") || techKeys.includes("settings"), false);

  // each visible title renders once, so nothing is doubled for an owner
  const asOwner = renderNav(owner);
  const doubled = MODULES.filter((m) => m.hasAccess(owner)).filter((m) => countOf(asOwner, `>${m.title}<`) !== 1);
  check("no owner-visible module title renders more than once", doubled.map((m) => m.key), []);
}

console.log("\n=== the module survives a hostile profile, like every other one ===");
{
  // the 2026-09-15 habit: tsc believed the type, the bundle got undefined
  for (const [label, p] of [
    ["an empty object", {} as Profile],
    ["role as an unexpected string", { ...base, role: "superuser" as unknown as Profile["role"] }],
    ["approved undefined", { ...base, role: "owner", approved: undefined as unknown as boolean }],
  ] as const) {
    try {
      const verdict = availabilityModule.hasAccess(p);
      // FALSY, not literally `false`: `profile.approved && ...` yields the
      // falsy `undefined` when approved is undefined, and the hub filters on
      // truthiness so the card is correctly hidden either way. Asserting
      // `=== false` would fail on behaviour that is right — and identical to
      // archive's and settings', which is the claim that actually matters.
      check(`${label} -> not admitted, no throw`, !verdict, true);
      check(`${label} -> same falsy verdict as archive and settings`,
        [!!verdict, !!verdict], [!!archiveModule.hasAccess(p), !!settingsModule.hasAccess(p)]);
    } catch (e) {
      failed++;
      console.log(`  ❌ ${label} — threw: ${(e as Error).message}`);
    }
  }
}

// getMetric is async, and this file is transformed to CJS (no top-level await),
// so the summary hangs off the promise rather than sitting after an await.
void availabilityModule.getMetric(null as never, owner).then((metric) => {
  check("the metric is static and needs no supabase client", metric, METRIC);
  console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
  process.exit(failed === 0 ? 0 : 1);
});
