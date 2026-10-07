/**
 * /clients — the rendered half: the hub card's permission, the shared edit
 * component, the ח.פ confirmation window, and the one thing that must appear
 * ZERO times anywhere (`contact_name`).
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_clients_screen_render.tsx
 *
 * ═══ F19, AND THE MORNING RULE ═══
 * Creates nothing, writes nothing, reads no database, opens no socket, needs no
 * dev server — and makes NO CALL TO MORNING. Nothing imported here can reach
 * `updateClient` or `getClientContacts`: the components under test are the pure
 * ones (EntityFieldRows, TaxIdConfirm) plus the registry, and `global.fetch` is
 * replaced with a function that THROWS, so a component that tried to talk to
 * anything would fail this suite rather than quietly reach the network.
 *
 * ═══ WHY THESE ASSERTIONS COUNT (rule 56) ═══
 * Three of the owner's four render requirements are counts, and they are counts
 * for a reason: "the card is hidden for a tech" is proved only by ZERO
 * occurrences, "the window shows old and new" is wrong if it shows one of them
 * twice, and `contact_name` reappearing once is the whole failure.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import EntityFieldRows from "../src/components/EntityFieldRows";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import ClientsScreen from "../src/app/clients/ClientsScreen";
import { EMPTY_LIST, NO_DEBT, NOT_MAPPED, buildClientList } from "../src/lib/clients/overview";
import { TaxIdConfirm } from "../src/components/ClientMorningCard";
import { clientFieldMeta } from "../src/lib/clients/fields";
import { canSeeClients } from "../src/lib/clients/access";
import { morningFailureMessage } from "../src/lib/clients/morningFailure";
import { TAX_ID_UNKNOWN } from "../src/lib/clients/taxId";
import { MODULES } from "../src/modules/registry";
import { clientsModule } from "../src/modules/clients";
import { ENTITY_CONFIG, MORNING_ONLY_CLIENT_FIELDS, MORNING_ONLY_CLIENT_KEYS, selectColumns } from "../src/lib/entities";
import ModuleCard from "../src/components/ModuleCard";
import type { Profile } from "../src/lib/profile";
import type { ModuleMetric } from "../src/modules/types";

// Any network call from a component under test is a bug in this suite, not a
// condition to tolerate. Fail loudly rather than silently reaching Morning.
global.fetch = (() => {
  throw new Error("F19: this suite must not perform any fetch");
}) as unknown as typeof fetch;

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
const bookkeeper: Profile = { ...base, role: "bookkeeper" };
const techNoMoney: Profile = { ...base, role: "tech", can_view_money: false, can_edit_money: false };
// can SEE money but may not EDIT it — the viewer the card must render read-only
const viewerOnly: Profile = { ...base, role: "bookkeeper", can_edit_money: false };

const METRIC: ModuleMetric = { label: "גישה", value: "בדיקה", tone: "default" };

/** exactly what src/app/page.tsx does to build the hub grid */
function renderHub(profile: Profile): string {
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

console.log("\n=== the hub card: owner ✓ · can_view_money ✓ · tech without money → 0 ===");
{
  check("the card's title is the approved wording", clientsModule.title, "לקוחות");
  check("the card's href", clientsModule.href, "/clients");
  // hasAccess is the gate BY REFERENCE, so the card and the screen cannot
  // disagree. A copied condition would pass the role cases below and still be
  // a second place to change.
  check("hasAccess IS canSeeClients, not a copy", clientsModule.hasAccess === canSeeClients, true);

  check("owner: the card appears exactly once", countOf(renderHub(owner), ">לקוחות<"), 1);
  check("owner: the href appears exactly once", countOf(renderHub(owner), 'href="/clients"'), 1);
  check("bookkeeper with money: exactly once", countOf(renderHub(bookkeeper), ">לקוחות<"), 1);
  check("money viewer who cannot edit: exactly once", countOf(renderHub(viewerOnly), ">לקוחות<"), 1);

  // the refusal, counted
  const asTech = renderHub(techNoMoney);
  check("tech without can_view_money: 0 occurrences of the title", countOf(asTech, ">לקוחות<"), 0);
  check("tech without can_view_money: 0 occurrences of the href", countOf(asTech, "/clients"), 0);
  check(
    "unapproved owner: 0 occurrences",
    countOf(renderHub({ ...owner, approved: false }), ">לקוחות<"),
    0
  );

  // registered once, and nothing displaced
  check("registered exactly once", MODULES.filter((m) => m.key === "clients").length, 1);
  check("registry keys stay distinct", MODULES.length, new Set(MODULES.map((m) => m.key)).size);
  check("registry hrefs stay distinct", MODULES.length, new Set(MODULES.map((m) => m.href)).size);
  check("registry titles stay distinct", MODULES.length, new Set(MODULES.map((m) => m.title)).size);
  // the anchor the registry comment states, and the nav suite also asserts
  check(
    "archive and settings still hold the last two slots",
    MODULES.map((m) => m.key).slice(-2),
    ["archive", "settings"]
  );
  // a card for a tech is unchanged by this commit
  const techKeys = MODULES.filter((m) => m.hasAccess(techNoMoney)).map((m) => m.key);
  check("tech without money sees no clients card", techKeys.includes("clients"), false);
  check("tech without money still sees the stage screens", techKeys.includes("productions"), true);
}

console.log("\n=== the screen is reachable from the header menu, by construction ===");
{
  // the nav menu renders MODULES.filter(hasAccess) (7.10, f215f09), so a
  // registered module is a menu item with no further work — asserted rather
  // than assumed, because "add it to the menu too" is the step that gets
  // forgotten when the menu holds its own list
  const header = readFileSync(join(__dirname, "..", "src", "components", "AppHeader.tsx"), "utf8");
  check("AppHeader still builds its items from the registry", header.includes("MODULES.filter"), true);
  check(
    "the owner sees it in the menu's source list exactly once",
    MODULES.filter((m) => m.hasAccess(owner) && m.key === "clients").length,
    1
  );
}

console.log("\n=== the shared edit component: the drawer's rows and the screen's are identical ===");
{
  const fields = clientFieldMeta(owner);
  // the six billing columns the owner named, and nothing else
  check("six fields for an owner", fields.length, 6);
  check(
    "they are the client config's fields, in order",
    fields.map((f) => f.key),
    ENTITY_CONFIG.client.fields.map((f) => f.key)
  );
  check("all six are editable for a money editor", fields.filter((f) => f.editable).length, 6);

  // THE PARITY ASSERTION the owner asked for: the drawer's props and the
  // screen's props go into the same component, so the same input must give
  // byte-identical output. If either side ever grows its own renderer, this is
  // the line that breaks.
  const entity = {
    id: "c1",
    name: "גל אורן",
    billing_mode: "per_episode",
    payment_terms: "net_30",
    default_rate: 1500,
    billing_cadence: "monthly",
    billing_every_n: null,
  };
  const asDrawer = renderToString(
    <EntityFieldRows
      fields={fields}
      entity={entity}
      optionsData={{ clients: [], shows: [] }}
      onSave={() => {}}
    />
  );
  const asScreen = renderToString(
    <EntityFieldRows
      fields={clientFieldMeta(owner)}
      entity={entity}
      optionsData={{ clients: [], shows: [] }}
      onSave={() => {}}
    />
  );
  check("the two renders are byte-identical", asScreen, asDrawer);

  // and the field COUNT is identical — the owner's "ספירה זהה"
  for (const f of ENTITY_CONFIG.client.fields) {
    check(`label "${f.label}" renders exactly once`, countOf(asDrawer, `>${f.label}</label>`), 1);
  }
  check("row count equals field count", countOf(asDrawer, "<label"), fields.length);

  // a viewer who may see money but not edit it gets the same ROWS, no inputs
  const ro = clientFieldMeta(viewerOnly);
  check("the read-only viewer sees the same six fields", ro.length, 6);
  check("none of them is editable", ro.filter((f) => f.editable).length, 0);
  const asReadOnly = renderToString(
    <EntityFieldRows fields={ro} entity={entity} optionsData={{ clients: [], shows: [] }} onSave={() => {}} />
  );
  check("read-only: same row count", countOf(asReadOnly, "<label"), 6);
  check("read-only: zero text inputs", countOf(asReadOnly, "<input"), 0);
  check("read-only: zero selects", countOf(asReadOnly, "<select"), 0);

  // a viewer with NO money sight sees only the fields marked view:"any" — the
  // name — which is the drawer's behaviour and must stay the screen's
  const stageOnly = clientFieldMeta(techNoMoney);
  check("no money sight: only the name is visible", stageOnly.map((f) => f.key), ["name"]);
  check("no money sight: the name is not editable", stageOnly[0].editable, false);
}

console.log("\n=== 🔴 contact_name: zero occurrences, everywhere ===");
{
  // Not a render check alone — a SOURCE check across every file that touches a
  // client, because the column still exists and still holds three values that
  // contradict Morning (entities.ts:159-176). The screen is wider than the
  // drawer and the empty space is the temptation.
  const files = [
    ["src/lib/entities.ts", true], // the comment EXPLAINING the removal lives here
    ["src/lib/clients/fields.ts", true],
    ["src/lib/clients/overview.ts", false],
    ["src/lib/clients/access.ts", false],
    ["src/app/clients/data.ts", false],
    // the screen carries its own warning comment about the retired column —
    // that comment is the thing that stops someone "using the space"
    ["src/app/clients/ClientsScreen.tsx", true],
    ["src/app/clients/page.tsx", false],
    ["src/components/ClientMorningCard.tsx", true], // likewise a warning comment
    ["src/components/EntityFieldRows.tsx", false],
  ] as const;
  for (const [rel, commentsAllowed] of files) {
    const raw = readFileSync(join(__dirname, "..", ...rel.split("/")), "utf8");
    // comments stripped: two files DISCUSS the retired column at length, and a
    // grep over the prose would fail on the documentation that prevents the bug
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check(`${rel}: contact_name appears 0 times in code`, countOf(code, "contact_name"), 0);
    if (!commentsAllowed) {
      check(`${rel}: and 0 times in comments either`, countOf(raw, "contact_name"), 0);
    }
  }
  // the registry itself is the real gate: the column must not be a field, or
  // `selectColumns` would fetch it and the card would have a second איש קשר
  check(
    "contact_name is not a registered client field",
    ENTITY_CONFIG.client.fields.filter((f) => f.key === "contact_name").length,
    0
  );
  check(
    "contact_name is not in the SELECT for any viewer",
    [owner, bookkeeper, techNoMoney, viewerOnly].filter((p) =>
      selectColumns("client", p).includes("contact_name")
    ).length,
    0
  );
  check(
    "contact_name is not a Morning-only field either",
    MORNING_ONLY_CLIENT_KEYS.filter((k) => k === "contact_name").length,
    0
  );
  // the rendered screen, for completeness: the rows carry labels from the
  // registry, so a re-registered column would surface here too
  const asDrawer = renderToString(
    <EntityFieldRows
      fields={clientFieldMeta(owner)}
      entity={{ id: "c1", contact_name: "לא אמור להופיע" }}
      optionsData={{ clients: [], shows: [] }}
      onSave={() => {}}
    />
  );
  check("even with the value in the entity, it renders 0 times", countOf(asDrawer, "לא אמור להופיע"), 0);
}

console.log("\n=== ח.פ is declared where the client card is, and is Morning-only ===");
{
  check(
    "taxId is a Morning-only client field",
    MORNING_ONLY_CLIENT_FIELDS.filter((f) => f.key === "taxId").length,
    1
  );
  check(
    "its label",
    MORNING_ONLY_CLIENT_FIELDS.find((f) => f.key === "taxId")?.label,
    "ח.פ / ע.מ"
  );
  check(
    "it is gated on money, like the client name",
    MORNING_ONLY_CLIENT_FIELDS.find((f) => f.key === "taxId")?.edit,
    "money"
  );
  // 🔴 and it is NOT a column: registering it in `fields` would put it in the
  // SELECT and 400 the entire client card for every viewer
  check(
    "taxId is not a registered column field",
    ENTITY_CONFIG.client.fields.filter((f) => f.key === "taxId").length,
    0
  );
  check("taxId is not in any viewer's SELECT", selectColumns("client", owner).includes("taxId"), false);
  // the derived list the route lifts out of `patch` — one list, four keys
  check("the Morning-only keys", [...MORNING_ONLY_CLIENT_KEYS], [
    "emails",
    "phone",
    "contactPerson",
    "taxId",
  ]);
  // `send` must never be writable: Morning recomputes it and overwrites us
  check("send is NOT a writable Morning field", MORNING_ONLY_CLIENT_KEYS.includes("send"), false);

  // the route derives the list rather than keeping its own copy
  const route = readFileSync(
    join(__dirname, "..", "src", "app", "api", "entity", "[type]", "[id]", "route.ts"),
    "utf8"
  );
  const routeCode = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the route imports the derived key list", routeCode.includes("MORNING_ONLY_CLIENT_KEYS"), true);
  // `if ("contactPerson" in morningOnly)` is a per-field handler and is fine;
  // what must be gone is the LIST the route used to keep beside the registry's.
  check(
    "the route keeps no hard-coded copy of the list",
    /\[\s*"emails"\s*,\s*"phone"\s*,\s*"contactPerson"/.test(routeCode),
    false
  );
  check("the old constant name is gone", routeCode.includes("MORNING_ONLY_KEYS ="), false);
  check("the route validates before the wire", routeCode.includes("validateTaxId("), true);
  // 🔴 the "zero local writes" guarantee the approved failure message rests on:
  // the UPDATE only runs when there are local keys
  check("the local UPDATE is guarded by localKeys", routeCode.includes("if (localKeys.length)"), true);
}

console.log("\n=== the confirmation window shows the old and the new, once each ===");
{
  const html = renderToString(
    <TaxIdConfirm
      clientName="גל אורן"
      from="516006988"
      to="123456789"
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  );
  // the approved title, with the client's name in it
  check("the title, verbatim", countOf(html, "שינוי ח.פ של גל אורן"), 1);
  // 🔴 ONCE EACH. Showing the new number twice (or the old one in both slots)
  // is the mistake that makes the operator confirm a change they misread.
  check("the OLD number appears exactly once", countOf(html, "516006988"), 1);
  check("the NEW number appears exactly once", countOf(html, "123456789"), 1);
  check("the body sentence, verbatim", countOf(html, "כל מסמך שיונפק מכאן והלאה יישא את המספר החדש"), 1);
  check("...and what does not change", countOf(html, "מסמכים שכבר הונפקו לא משתנים"), 1);
  check("the confirm button, verbatim", countOf(html, ">עדכון במורנינג<"), 1);
  check("the cancel button, verbatim", countOf(html, ">ביטול<"), 1);
  // a FIRST-TIME ח.פ has no old value: the approved "לא ידוע" fills the slot
  // rather than an empty gap the operator has to interpret
  const first = renderToString(
    <TaxIdConfirm clientName="אפרת" from={null} to="123456789" onConfirm={() => {}} onCancel={() => {}} />
  );
  check("no previous number renders the approved unknown label once", countOf(first, TAX_ID_UNKNOWN), 1);
  check("the new number still appears once", countOf(first, "123456789"), 1);
  // CLEARING: the new side is empty, so it is the unknown label that fills it
  const cleared = renderToString(
    <TaxIdConfirm clientName="אפרת" from="516006988" to="" onConfirm={() => {}} onCancel={() => {}} />
  );
  check("clearing: the old number once", countOf(cleared, "516006988"), 1);
  check("clearing: the unknown label once", countOf(cleared, TAX_ID_UNKNOWN), 1);
}

console.log("\n=== a Morning failure says what did NOT happen, once ===");
{
  // the approved sentence for a Morning-ONLY edit (ח.פ, contacts): nothing was
  // written locally, so nothing changed anywhere
  const noLocal = morningFailureMessage("401 unauthorized", false);
  check("the approved wording, verbatim", noLocal, "העדכון במורנינג נכשל — 401 unauthorized. לא בוצע שום שינוי.");
  check("it appears once, not twice", countOf(noLocal, "לא בוצע שום שינוי."), 1);
  check("the error is quoted once", countOf(noLocal, "401 unauthorized"), 1);
  // and it must NOT claim a local save
  check("it does not claim anything was saved locally", noLocal.includes("נשמר אצלנו"), false);

  // the other branch is unchanged: a name edit DID write locally
  const withLocal = morningFailureMessage("401 unauthorized", true);
  check("a local write still reports the partial state", withLocal.includes("השינוי נשמר אצלנו"), true);
  check("...and does not claim nothing changed", withLocal.includes("לא בוצע שום שינוי"), false);
  check("the two branches are different sentences", noLocal === withLocal, false);

  // the route uses the shared function rather than composing its own sentence
  const route = readFileSync(
    join(__dirname, "..", "src", "app", "api", "entity", "[type]", "[id]", "route.ts"),
    "utf8"
  );
  check("the route calls morningFailureMessage", route.includes("morningFailureMessage("), true);
  check(
    "the route composes no 502 sentence of its own",
    route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").includes("נשמר אצלנו, אך"),
    false
  );
}

console.log("\n=== the screen does not re-implement what it is given ===");
{
  const screen = readFileSync(join(__dirname, "..", "src", "app", "clients", "ClientsScreen.tsx"), "utf8");
  const code = screen.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("it renders the shared field rows", code.includes("<EntityFieldRows"), true);
  check("it renders the shared Morning card", code.includes("<ClientMorningCard"), true);
  // no second field renderer, and no second debt rule
  check("it has no field-type switch of its own", code.includes('case "select"'), false);
  check("it does not spell the debt rule", code.includes('=== "לא"'), false);
  check("it does not call Morning directly", code.includes("morning/client"), false);
  // the list rows are plain links, so a client opens with JavaScript off
  check("a row is an <a>, not a button", code.includes("<Link"), true);

  const drawer = readFileSync(join(__dirname, "..", "src", "components", "EntityDrawer.tsx"), "utf8");
  const drawerCode = drawer.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the drawer renders the SAME field rows component", drawerCode.includes("<EntityFieldRows"), true);
  check("the drawer renders the SAME Morning card", drawerCode.includes("<ClientMorningCard"), true);
  check("the drawer kept no inline renderValue", drawerCode.includes("function renderValue"), false);
}

console.log("\n=== no client field needs a picker, so the empty optionsData is correct ===");
{
  // ClientsScreen passes `optionsData={{ clients: [], shows: [] }}` because no
  // field of the CLIENT entity is a `clients`/`shows` select. If one is ever
  // added, that empty object silently renders a picker with no options — this
  // is the line that says so before a user finds it.
  const needsPicker = ENTITY_CONFIG.client.fields.filter(
    (f) => f.options === "clients" || f.options === "shows"
  );
  check("zero client fields need a picker", needsPicker.map((f) => f.key), []);
}

console.log("\n=== the screen actually renders (not just returns 200) ===");
{
  /**
   * The 2026-09-15 lesson, written down: an HTML-grep suite passed while the
   * page was blank. These two renders execute the real component — if
   * ClientsScreen throws on a missing field, an undefined row or a null card,
   * it throws HERE rather than in front of the owner.
   *
   * useRouter needs the App Router context; nothing is clicked, so the stub's
   * methods are never called.
   */
  const noop = () => {};
  const stubRouter = {
    back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop,
  } as unknown as React.ContextType<typeof AppRouterContext>;
  const render = (node: React.ReactNode) =>
    renderToString(<AppRouterContext.Provider value={stubRouter}>{node}</AppRouterContext.Provider>);

  const clients = [
    { id: "c1", name: "גל אורן", normalized_name: "גל אורן", morning_client_id: "m1", merged_into: null },
    { id: "c2", name: "ידיעות אחרונות", normalized_name: "ידיעות אחרונות", morning_client_id: null, merged_into: null },
  ];
  const shows = [{ id: "s1", name: "הפודקאסט של גל", client_id: "c1", active: true }];
  const jobs = [
    { id: "j1", client_id: "c1", amount: 1000, paid: "לא", due_date: "2026-09-30", date: "2026-09-01", dismissed: false },
  ];
  const rows = buildClientList(clients, shows, jobs, "2026-10-07");

  // 1. an EMPTY list renders the approved sentence, exactly once
  const empty = render(
    <ClientsScreen data={{ rows: [], card: null, canEditMoney: true, today: "2026-10-07" }} />
  );
  check("empty: the approved sentence appears once", countOf(empty, EMPTY_LIST), 1);
  check("empty: the heading is the approved wording", countOf(empty, ">לקוחות<"), 1);
  check("empty: no row leaked in", countOf(empty, 'href="/clients/'), 0);

  // 2. the list, with no card open
  const listOnly = render(
    <ClientsScreen data={{ rows, card: null, canEditMoney: true, today: "2026-10-07" }} />
  );
  // default scope is "פעילים", so only c1 (it has an active show) is shown —
  // the count the operator reads must be the count of what is rendered
  check("list: the active client appears once", countOf(listOnly, ">גל אורן<"), 1);
  check("list: the show-less client is not in the active scope", countOf(listOnly, ">ידיעות אחרונות<"), 0);
  check("list: exactly one row link", countOf(listOnly, 'href="/clients/'), 1);
  check("list: the row links to that client", countOf(listOnly, 'href="/clients/c1"'), 1);
  check("list: its debt renders once", countOf(listOnly, "₪1,000"), 1);
  check("list: the approved sentence is NOT shown", countOf(listOnly, EMPTY_LIST), 0);

  // 3. a card open — every section the owner asked for, each once
  const card = {
    id: "c1",
    name: "גל אורן",
    entity: {
      id: "c1", name: "גל אורן", billing_mode: "per_episode", payment_terms: "net_30",
      default_rate: 1500, billing_cadence: "monthly", billing_every_n: null,
    },
    fields: clientFieldMeta(owner),
    shows: [{ id: "s1", name: "הפודקאסט של גל", active: true }],
    contracts: [
      { id: "k1", name: "חוזה שנתי", status: "active", total_amount: 60000, start_date: "2026-01-01", end_date: "2026-12-31" },
    ],
    debt: 1000,
    debtJobs: [
      { id: "j1", date: "2026-09-01", campaign: "פרק 12", amount: 1000, paid: "לא", due_date: "2026-09-30", state: "blue" as const, overdueDays: 7 },
    ],
    documents: [
      { id: "d1", type: "חשבונית מס", morning_doc_number: "40339", document_date: "2026-09-02", amount: 1000, pdf_url: null, cancelled_at: null },
    ],
    productions: [{ id: "p1", podcast_name: "פרק 12", record_date: "2026-09-01", status: "נמסר" }],
  };
  const withCard = render(
    <ClientsScreen data={{ rows, card, canEditMoney: true, today: "2026-10-07" }} />
  );
  for (const section of ["סקירה", "תוכניות וחוזים", "כספים", "פעילות"]) {
    check(`card: the "${section}" section renders once`, countOf(withCard, `>${section}<`), 1);
  }
  // the six editable rows are the SHARED component's, inside the card
  check("card: six field labels", countOf(withCard, "<label"), 6);
  for (const f of ENTITY_CONFIG.client.fields) {
    check(`card: "${f.label}" once`, countOf(withCard, `>${f.label}</label>`), 1);
  }
  check("card: the contract renders once", countOf(withCard, ">חוזה שנתי<"), 1);
  check("card: the document number renders once", countOf(withCard, "40339"), 1);
  check("card: the overdue days render once", countOf(withCard, "בפיגור 7 ימים"), 1);
  // the selected row is marked exactly once, the same device the nav menu uses
  check("card: the open client's row is marked once", countOf(withCard, 'aria-current="page"'), 1);

  // 4. a client with NO debt gets the approved sentence rather than ₪0
  const noDebtCard = { ...card, debt: 0, debtJobs: [] };
  const zero = render(
    <ClientsScreen data={{ rows, card: noDebtCard, canEditMoney: true, today: "2026-10-07" }} />
  );
  // once in the card, once on the row of the client that has no debt — but the
  // active scope shows only c1, which HAS debt, so the card is the only one
  check("no debt: the approved sentence appears once", countOf(zero, NO_DEBT), 1);
  check("no debt: no ₪0 is printed", countOf(zero, "₪0"), 0);

  // 5. an UNMAPPED client says so, in the approved words
  const unmappedRows = buildClientList(
    [{ ...clients[1], id: "c2" }],
    [{ id: "s9", name: "ידיעות בבוקר", client_id: "c2", active: true }],
    [],
    "2026-10-07"
  );
  const unmapped = render(
    <ClientsScreen
      data={{ rows: unmappedRows, card: { ...card, id: "c2", name: "ידיעות אחרונות" }, canEditMoney: true, today: "2026-10-07" }}
    />
  );
  check("unmapped: the approved label appears", countOf(unmapped, NOT_MAPPED) >= 1, true);

  // 6. the missing-field cases that used to ship blank screens
  const sparseCard = {
    ...card,
    entity: { id: "c1" }, // every billing column null/absent
    shows: [], contracts: [], debtJobs: [], documents: [], productions: [], debt: 0,
  };
  let threw = false;
  try {
    const sparse = render(
      <ClientsScreen data={{ rows, card: sparseCard, canEditMoney: true, today: "2026-10-07" }} />
    );
    check("sparse card: still renders the six rows", countOf(sparse, "<label"), 6);
    check("sparse card: says there are no shows", countOf(sparse, ">אין תוכניות<"), 1);
    check("sparse card: says there are no contracts", countOf(sparse, ">אין חוזים<"), 1);
    check("sparse card: says there are no documents", countOf(sparse, ">אין מסמכים<"), 1);
    check("sparse card: says there are no productions", countOf(sparse, ">אין הפקות<"), 1);
  } catch (e) {
    threw = true;
    console.log(`       threw: ${(e as Error).message}`);
  }
  check("sparse card: did not throw", threw, false);

  // a card id that matches no row — the stale-link case /clients/[id] allows
  let threw2 = false;
  try {
    render(
      <ClientsScreen data={{ rows: [], card: { ...card, id: "gone" }, canEditMoney: true, today: "2026-10-07" }} />
    );
  } catch (e) {
    threw2 = true;
    console.log(`       threw: ${(e as Error).message}`);
  }
  check("a card with no matching row did not throw", threw2, false);
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
