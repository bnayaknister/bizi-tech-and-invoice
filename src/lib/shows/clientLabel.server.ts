import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { showClientNameOn } from "./clientLabel";

// The client name of every show whose "show the client's name" setting is ON.
// SERVICE ROLE on purpose: a client name is otherwise money-gated on the board,
// and for these shows the owner chose to make it part of the show's label for
// everyone who sees the production (owner 20.10). Shows with the setting OFF
// are not resolved at all, so nothing more than before leaves for them.
export async function loadClientLabels(admin: SupabaseClient<Database>, showIds?: string[]): Promise<Map<string, string>> {
  let q = admin.from("shows").select("id,client_id,settings").not("client_id", "is", null);
  if (showIds) q = q.in("id", showIds.length ? showIds : ["00000000-0000-0000-0000-000000000000"]);
  const { data: shows } = await q;
  const on = (shows ?? []).filter((s) => showClientNameOn(s.settings) && s.client_id);
  if (on.length === 0) return new Map();
  // A merge moves the show to the surviving client (B24), so this is the client
  // clients-status: by id — the one a show already points to, not a list to choose from
  const { data: clients } = await admin
    .from("clients")
    .select("id,name")
    .in("id", Array.from(new Set(on.map((s) => s.client_id as string))));
  const nameById = new Map((clients ?? []).map((c) => [c.id, c.name as string]));
  const out = new Map<string, string>();
  for (const s of on) {
    const n = nameById.get(s.client_id as string);
    if (n) out.set(s.id, n);
  }
  return out;
}
