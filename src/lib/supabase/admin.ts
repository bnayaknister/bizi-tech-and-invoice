import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

// Service-role client — server only, never import from client components.
// Used for writes RLS intentionally blocks for end users (e.g. the events
// audit log, which users can't insert into directly).
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
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
// Caveat worth knowing before converting a file: a select built at runtime
// (`const cols: string = …`) silently opts out — it compiles and checks
// nothing. Verified: a nonsense column inside such a select produced zero
// errors. Conditional selects must be split into literals to get any safety.
export function createTypedAdminClient(): SupabaseClient<Database> {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
