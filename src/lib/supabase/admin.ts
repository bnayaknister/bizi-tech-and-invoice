import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { noStoreFetch } from "./no-store-fetch";

// Service-role client — server only, never import from client components.
// Used for writes RLS intentionally blocks for end users (e.g. the events
// audit log, which users can't insert into directly).
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false }, global: { fetch: noStoreFetch } }
  );
}

// Same client, schema-aware. Kept as a SECOND factory rather than a generic on
// the one above, so adoption is per-file and opt-in: nothing that imports
// createAdminClient changes, and a file moves over by switching this one
// import. Measured 2026-08-12: putting the generic on all three factories at
// once yields 35 tsc errors across 17 files — small, but not something to
// absorb in an unrelated commit.
//
// What it buys: `.select("…")` column names, `.from("…")` table names,
// `.insert()/.update()` payloads and enum values are all checked against
// database.types.ts, which is regenerated with every migration and guarded by
// scripts/check-schema-drift.mjs at prebuild. A column that does not exist
// becomes a build failure instead of a 400/42703 at runtime that reads as an
// empty result (see lib/supabase/unwrap.ts for what that cost).
//
// Where the safety actually lives: the field access, not the `.select()`.
// supabase-js does not validate column names when the query is built — it
// returns a `SelectQueryError` carrying the message, and that only surfaces
// the moment a row's field is touched. Any cast between the call and the
// access (`as QueryResult<…>`, `as Record<string, unknown>[]`) erases it
// completely, leaving a file that looks typed and checks nothing.
//
// Splitting a conditional select into literals is necessary but NOT
// sufficient — a split select behind a cast still checks nothing. Verified
// 13.8: the split was done in full and a nonsense column still passed
// silently; removing the cast is what made it fail.
//
// Acceptance test, per converted file: a wrong column name in `.select()`
// must break the build with `column '<name>' does not exist on '<table>'`.
// A clean `tsc --noEmit` proves nothing on its own.
export function createTypedAdminClient(): SupabaseClient<Database> {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false }, global: { fetch: noStoreFetch } }
  );
}
