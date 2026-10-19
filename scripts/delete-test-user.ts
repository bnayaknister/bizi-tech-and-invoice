/**
 * U1-9: delete ONE test user completely, and prove it.
 *
 * Run:  npx tsx scripts/delete-test-user.ts <email>            (dry-run: shows what would go)
 *       npx tsx scripts/delete-test-user.ts <email> --apply    (deletes)
 *
 * The method used by hand through U1 (19.10.2026), as one tool:
 *   1. find the user in auth.users and its profile;
 *   2. count its rows in EVERY column that references auth.users or
 *      public.profiles (read from pg_constraint at run time, so a new FK is
 *      covered without editing this file), plus auth.refresh_tokens,
 *      auth.flow_state, events.entity_id and the email in auth.users/profiles;
 *   3. --apply: delete the events that point at it (entity_id or actor_id),
 *      then the Auth user through the Admin API (cascades to profiles,
 *      identities, sessions, …), check GET → 404, and recount — every count
 *      must be 0, else exit 1.
 *
 * Guards:
 *   · the email must look like a test user: "+…test…@" (e.g. +u1test7@) or
 *     "@bizi-test.local" — anything else is refused;
 *   · role=owner is refused, always;
 *   · a non-cascading app column other than events (e.g. productions.cancelled_by)
 *     still pointing at the user stops it: deleting would fail or rewrite real
 *     history — that is a decision for the owner, not for this script.
 *
 * Talks to production (.env.local): SQL via the Management API (read-only
 * except the one DELETE of events), the user via the Auth Admin API.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  const k = t.slice(0, i).trim();
  if (!process.env[k]) process.env[k] = t.slice(i + 1).trim().replace(/^"|"$/g, "");
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN!;
const REF = new URL(SUPABASE_URL).hostname.split(".")[0];

const TEST_EMAIL = /(\+[a-z0-9._-]*test[a-z0-9._-]*@)|(@bizi-test\.local$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Row = Record<string, unknown>;

// Management API: a browser User-Agent, or Cloudflare answers 1010
async function sql(query: string): Promise<Row[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`SQL ${res.status}: ${await res.text()}`);
  return (await res.json()) as Row[];
}

// Auth Admin API: the secret key as `apikey` only, and a NON-browser User-Agent
async function authAdmin(method: "GET" | "DELETE", userId: string): Promise<number> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method,
    headers: { apikey: SERVICE_KEY, "User-Agent": "bizi-admin/1.0" },
  });
  return res.status;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function countAll(id: string, email: string): Promise<{ t: string; n: number; cascade: boolean }[]> {
  const fks = (await sql(`
    select c.conrelid::regclass::text as tbl, a.attname as col, c.confdeltype as del
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.contype = 'f' and c.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
    order by 1, 2`)) as { tbl: string; col: string; del: string }[];
  const parts = [
    `select 'auth.users.id' as t, count(*)::int as n, true as cascade from auth.users where id = ${lit(id)}`,
    ...fks.map(
      (f) => `select '${f.tbl}.${f.col}', count(*)::int, ${f.del === "c"} from ${f.tbl} where ${f.col} = ${lit(id)}`
    ),
    `select 'auth.refresh_tokens.user_id', count(*)::int, true from auth.refresh_tokens where user_id = ${lit(id)}`,
    `select 'auth.flow_state.user_id', count(*)::int, true from auth.flow_state where user_id = ${lit(id)}`,
    `select 'events.entity_id', count(*)::int, false from public.events where entity_id = ${lit(id)}`,
    `select 'auth.users.email', count(*)::int, true from auth.users where lower(email) = ${lit(email)}`,
    `select 'profiles.email', count(*)::int, true from public.profiles where lower(email) = ${lit(email)}`,
  ];
  return (await sql(parts.join("\nunion all "))) as { t: string; n: number; cascade: boolean }[];
}

async function main() {
  const email = (process.argv[2] ?? "").trim().toLowerCase();
  const apply = process.argv.includes("--apply");
  if (!email || email.startsWith("--")) {
    console.error("usage: npx tsx scripts/delete-test-user.ts <email> [--apply]");
    process.exit(2);
  }
  if (!TEST_EMAIL.test(email)) {
    console.error(`REFUSED: "${email}" does not look like a test user (+…test…@ or @bizi-test.local).`);
    process.exit(2);
  }

  const found = (await sql(`
    select u.id::text as id, u.email, p.role, p.name
    from auth.users u left join public.profiles p on p.id = u.id
    where lower(u.email) = ${lit(email)}`)) as { id: string; email: string; role: string | null; name: string | null }[];
  if (found.length === 0) {
    console.log(`no auth user with email ${email}.`);
    const left = (await sql(`select count(*)::int as n from public.profiles where lower(email) = ${lit(email)}`))[0];
    console.log(`profiles rows with that email: ${left.n}`);
    process.exit(left.n === 0 ? 0 : 1);
  }
  if (found.length > 1) throw new Error(`more than one auth user with ${email} — stop`);
  const u = found[0];
  if (!UUID.test(u.id)) throw new Error(`unexpected id ${u.id}`);
  if (u.role === "owner") {
    console.error(`REFUSED: ${email} is an owner.`);
    process.exit(2);
  }
  console.log(`user: ${u.email}  id=${u.id}  role=${u.role ?? "-"}  name=${u.name ?? "-"}`);

  const before = await countAll(u.id, email);
  const nonZero = before.filter((r) => r.n > 0);
  console.log("\nrows that point at it now:");
  for (const r of nonZero) console.log(`  ${r.t}: ${r.n}${r.cascade ? "  (cascades)" : ""}`);
  console.log(`  (${before.length - nonZero.length} other columns: 0)`);

  const events = (await sql(`
    select id::text, event_type, entity_type, (entity_id = ${lit(u.id)}) as about_user
    from public.events where entity_id = ${lit(u.id)} or actor_id = ${lit(u.id)}
    order by created_at`)) as { id: string; event_type: string; entity_type: string; about_user: boolean }[];
  console.log(`\nevents to delete: ${events.length}`);
  for (const e of events) console.log(`  ${e.event_type} (${e.entity_type}${e.about_user ? ", about the user" : ", BY the user"})`);

  const blockers = nonZero.filter((r) => !r.cascade && !r.t.startsWith("events."));
  if (blockers.length) {
    console.error(`\nSTOP: non-cascading references outside events: ${blockers.map((b) => b.t).join(", ")}.`);
    console.error("Deleting would fail or rewrite real history — ask the owner.");
    process.exit(1);
  }

  if (!apply) {
    console.log("\nDRY-RUN — nothing deleted. Re-run with --apply to delete.");
    return;
  }

  if (events.length) {
    const del = await sql(
      `delete from public.events where entity_id = ${lit(u.id)} or actor_id = ${lit(u.id)} returning id`
    );
    console.log(`\ndeleted events: ${del.length}`);
  }
  const delStatus = await authAdmin("DELETE", u.id);
  const getStatus = await authAdmin("GET", u.id);
  console.log(`auth DELETE: ${delStatus} | GET after: ${getStatus}`);

  const after = await countAll(u.id, email);
  const left = after.filter((r) => r.n > 0);
  console.log(`\nSELECT after: ${after.length} checks, non-zero: ${left.length}`);
  for (const r of left) console.log(`  STILL THERE ${r.t}: ${r.n}`);
  if (delStatus !== 200 || getStatus !== 404 || left.length) {
    console.error("NOT CLEAN — see above.");
    process.exit(1);
  }
  console.log("CLEAN: 0 rows in every check.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
