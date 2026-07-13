import { createClient as createSupabaseClient } from "@supabase/supabase-js";

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
