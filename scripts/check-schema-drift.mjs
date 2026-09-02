#!/usr/bin/env node
// Schema drift check — runs as `prebuild`, so a stale types file fails the
// build instead of lying quietly.
//
// WHY: src/lib/supabase/database.types.ts is generated from the live schema
// and committed by hand. Migrations are applied manually in the SQL Editor
// (see supabase/migrations/README.md), so nothing forces the two to stay in
// step. A types file that has fallen behind is worse than no types file:
//   • column added, types stale  -> tsc rejects a column that really exists.
//     Loud and annoying, but safe.
//   • column dropped, types stale -> the old name still type-checks and you
//     get a 42703 at runtime. That is the exact failure this whole effort is
//     meant to prevent, now with a types file vouching for it.
// This script catches both by comparing the committed file against the live
// schema, read from PostgREST's OpenAPI root.
//
// WHY THAT ENDPOINT: GET /rest/v1/ returns the full public schema — every
// table and view, every column, nullability (`required`), defaults, and enum
// values — using the service-role key the app already has. No Supabase CLI,
// no personal access token, no database password, no direct DB connection.
// It is a plain read.
//
// ⚠️ WHAT IT DOES **NOT** CHECK — read this before trusting a green tick.
// The comparison covers TABLES, VIEWS, COLUMNS and ENUM VALUES. Nothing else.
// Two whole sections of the generated file are invisible to it:
//
//   • Constants — the enums appear TWICE in database.types.ts: once as a type
//     under `Enums`, once as a runtime array under `Constants`. This script
//     reads the first and never looks at the second.
//   • Functions — every exposed RPC, its Args and its Returns.
//
// This is not theoretical; both were caught in the same hour on 2026-09-02,
// while the check was reporting ✅:
//   • Constants.show_pricing_model was missing after 0067's enum was added to
//     `Enums` by hand and not to `Constants`. Green.
//   • ensure_job_for_production — an exposed RPC (/rpc/ensure_job_for_production)
//     since 0060 on 2026-08-24 — was absent from `Functions` for a fortnight.
//     Green that whole time, and it only surfaced because 0067 replaced the
//     function and the file was regenerated for an unrelated reason.
//
// So: a ✅ here means "no table, view, column or enum value has drifted". It is
// NOT a substitute for running the generator, and it never confirms that the
// committed file equals what the generator would produce today:
//   npx supabase gen types typescript --project-id teobjwdszasavvmvukfb > src/lib/supabase/database.types.ts
// Widening this to Functions and Constants is an open ticket (docs/TICKETS.md).
//
// FAIL-OPEN BY DESIGN. The only condition that returns a non-zero exit is a
// successfully-fetched, confirmed divergence. Missing key, unreachable
// endpoint, non-200, timeout, unparseable file, no types file yet — all warn
// and return 0. A network hiccup must never block a deploy: this check exists
// to catch a human forgetting a step, not to add a new way for the build to
// die. Set SKIP_SCHEMA_DRIFT_CHECK=1 to bypass entirely.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES_PATH = join(ROOT, "src/lib/supabase/database.types.ts");
const TIMEOUT_MS = 10_000;

const OK = 0;
const DRIFT = 1;

function skip(msg) {
  console.log(`\n⚠️  בדיקת סכימה דולגה — ${msg}`);
  console.log("   (הבדיקה fail-open בכוונה: רק פער מאומת מפיל בילד)\n");
  process.exit(OK);
}

// ---------- env ----------
// .env.local for local runs; on Vercel the vars are already in process.env.
function loadEnvLocal() {
  const p = join(ROOT, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = t.slice(i + 1).trim();
  }
}

// ---------- the committed types file ----------
// The generated format is machine-produced and highly regular, so a balanced
// brace scan is enough and avoids pulling in a TS parser. If the shape ever
// changes and parsing yields nothing, we skip rather than block — never let
// our own parser become a deploy blocker.
// `key: {` … matching `}`. The key is matched on a word boundary: a plain
// indexOf("public: {") would also hit inside "graphql_public: {", which the
// CLI emits whenever that schema is exposed.
function sliceBlock(src, key, from = 0) {
  const re = new RegExp(`(?:^|[^A-Za-z0-9_])${key}\\s*:\\s*\\{`, "g");
  re.lastIndex = from;
  const m = re.exec(src);
  if (!m) return null;
  let i = src.indexOf("{", m.index);
  if (i === -1) return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return { body: src.slice(i + 1, j), end: j };
    }
  }
  return null;
}

// top-level `name: {` entries inside a block
function topLevelObjects(body) {
  const out = new Map();
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0) {
      const m = /^[\s\r\n]*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{/.exec(body.slice(i));
      if (m) {
        const name = m[1];
        const blk = sliceBlock(body, name, i);
        if (blk) {
          out.set(name, blk.body);
          i = blk.end + 1;
          continue;
        }
      }
    }
    i++;
  }
  return out;
}

// property names at depth 0 of a Row block
function propNames(body) {
  const names = new Set();
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (depth === 0) {
      const m = /^[\s\r\n]*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(body.slice(i));
      if (m) {
        names.add(m[1]);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return names;
}

function parseCommitted(src) {
  const pub = sliceBlock(src, "public");
  if (!pub) return null;
  const columns = new Map();
  for (const section of ["Tables", "Views"]) {
    const blk = sliceBlock(pub.body, section);
    if (!blk) continue;
    for (const [table, tableBody] of topLevelObjects(blk.body)) {
      const row = sliceBlock(tableBody, "Row");
      if (row) columns.set(table, propNames(row.body));
    }
  }
  const enums = new Map();
  const enumBlk = sliceBlock(pub.body, "Enums");
  if (enumBlk) {
    const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*((?:"(?:[^"\\]|\\.)*"\s*\|?\s*)+)/g;
    let m;
    while ((m = re.exec(enumBlk.body))) {
      const vals = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((v) => v[1].replace(/\\"/g, '"'));
      enums.set(m[1], new Set(vals));
    }
  }
  return columns.size === 0 ? null : { columns, enums };
}

// ---------- the live schema ----------
function parseLive(spec) {
  const defs = spec.definitions ?? spec.components?.schemas ?? {};
  const columns = new Map();
  const enums = new Map();
  for (const [table, def] of Object.entries(defs)) {
    const props = def.properties ?? {};
    columns.set(table, new Set(Object.keys(props)));
    for (const p of Object.values(props)) {
      // enum columns carry `format: "public.<enum_name>"` plus their values
      if (Array.isArray(p.enum) && typeof p.format === "string" && p.format.startsWith("public.")) {
        enums.set(p.format.slice("public.".length), new Set(p.enum));
      }
    }
  }
  return { columns, enums };
}

// ---------- compare ----------
function diffSets(live, committed) {
  const onlyLive = [...live].filter((x) => !committed.has(x)).sort();
  const onlyCommitted = [...committed].filter((x) => !live.has(x)).sort();
  return { onlyLive, onlyCommitted };
}

async function main() {
  if (process.env.SKIP_SCHEMA_DRIFT_CHECK === "1") skip("SKIP_SCHEMA_DRIFT_CHECK=1");

  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // the anon key gets 401 on this endpoint — verified 2026-08-12 — so the
  // service key is required. On a build host that does not carry it, skip.
  if (!url || !key) skip("חסר NEXT_PUBLIC_SUPABASE_URL או SUPABASE_SERVICE_ROLE_KEY");

  if (!existsSync(TYPES_PATH)) {
    skip("עדיין אין src/lib/supabase/database.types.ts — אין מה להשוות");
  }

  const committed = parseCommitted(readFileSync(TYPES_PATH, "utf8"));
  if (!committed) skip("לא ניתן לנתח את database.types.ts (ייתכן שפורמט ה-CLI השתנה)");

  let spec;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) skip(`PostgREST החזיר HTTP ${res.status}`);
    spec = await res.json();
  } catch (e) {
    skip(`נקודת הקצה לא זמינה (${e?.name ?? "error"})`);
  }

  const live = parseLive(spec);
  if (live.columns.size === 0) skip("ה-OpenAPI הוחזר ריק");

  const problems = [];

  const liveTables = new Set(live.columns.keys());
  const committedTables = new Set(committed.columns.keys());
  const t = diffSets(liveTables, committedTables);
  for (const name of t.onlyLive) problems.push(`  + טבלה/תצוגה במסד ולא בטיפוסים:  ${name}`);
  for (const name of t.onlyCommitted) problems.push(`  - טבלה/תצוגה בטיפוסים ולא במסד:  ${name}`);

  for (const [table, liveCols] of live.columns) {
    const committedCols = committed.columns.get(table);
    if (!committedCols) continue; // already reported as a missing table
    const d = diffSets(liveCols, committedCols);
    for (const c of d.onlyLive) problems.push(`  + עמודה במסד ולא בטיפוסים:  ${table}.${c}`);
    for (const c of d.onlyCommitted) problems.push(`  - עמודה בטיפוסים ולא במסד:  ${table}.${c}`);
  }

  // enum drift — this is what an unrefreshed 0053 ('receipt' added to
  // pending_doc_type) would have looked like
  for (const [name, liveVals] of live.enums) {
    const committedVals = committed.enums.get(name);
    if (!committedVals) continue;
    const d = diffSets(liveVals, committedVals);
    for (const v of d.onlyLive) problems.push(`  + ערך enum במסד ולא בטיפוסים:  ${name} = ${v}`);
    for (const v of d.onlyCommitted) problems.push(`  - ערך enum בטיפוסים ולא במסד:  ${name} = ${v}`);
  }

  if (problems.length === 0) {
    console.log(
      `✅ טיפוסי ה-DB מסונכרנים עם הסכימה החיה (${live.columns.size} טבלאות/תצוגות)`
    );
    process.exit(OK);
  }

  console.error("\n❌ סטיית סכימה — database.types.ts אינו תואם למסד החי:\n");
  for (const p of problems) console.error(p);
  // only explain the dangerous direction when it actually occurred
  if (problems.some((p) => p.trimStart().startsWith("-"))) {
    console.error(
      "\n   שורה שמתחילה ב-'-' היא המסוכנת: הטיפוסים מעידים על משהו שכבר איננו,"
    );
    console.error("   ולכן הקוד עובר tsc ונופל ב-42703 ב-runtime.");
  }
  console.error("");
  // The project id is SPELLED OUT, never "<ref>". This line is copy-pasted at
  // the worst possible moment — the build just failed — and a placeholder there
  // invites either a guess or an omission. Omitting --project-id makes the CLI
  // fall back on supabase/.temp/linked-project.json, which is gitignored and
  // per-machine: on 2026-08-20 it still pointed at the retired Singapore
  // project, months after the move to Frankfurt. That would regenerate the
  // types file from a FOREIGN schema and "fix" the drift silently, with a zero
  // exit code. Frankfurt, explicitly, is the whole point.
  console.error(
    "   תיקון:  npx supabase gen types typescript --project-id teobjwdszasavvmvukfb > src/lib/supabase/database.types.ts"
  );
  console.error("   עקיפה: SKIP_SCHEMA_DRIFT_CHECK=1\n");
  process.exit(DRIFT);
}

main().catch((e) => {
  // even an unexpected crash in this script must not block a deploy
  skip(`הבדיקה נכשלה באופן לא צפוי (${e?.message ?? e})`);
});
