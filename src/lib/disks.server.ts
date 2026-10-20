import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { hasOwnerAccess } from "@/lib/roles";

// B35 — server half of the disk list. Managing disks is owner/admin only
// (hasOwnerAccess); the writes go through the service role AFTER that check,
// because a rename cascades into productions (trg_disk_rename_cascade) and
// the stages guard there would refuse an admin session without
// can_edit_stages — the role check is the permission, as for a show rename.

export type DiskRow = { id: string; name: string; hidden: boolean; created_at: string; productions: number };

export async function requireDiskManager(): Promise<{ userId: string } | { response: NextResponse }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { response: NextResponse.json({ error: "לא מחובר" }, { status: 401 }) };
  const { data: profile } = await supabase.from("profiles").select("role,approved").eq("id", user.id).single();
  if (!profile?.approved || !hasOwnerAccess(profile)) {
    return { response: NextResponse.json({ error: "ניהול כוננים — לבעלים ולאדמין בלבד" }, { status: 403 }) };
  }
  return { userId: user.id };
}

/** Every disk with the number of productions on it (service role: the count must see every row). */
export async function loadDisks(admin: SupabaseClient<Database> = createTypedAdminClient()): Promise<DiskRow[]> {
  const [{ data: disks, error }, { data: refs }] = await Promise.all([
    admin.from("storage_disks").select("id,name,hidden,created_at"),
    admin.from("productions").select("storage_disk_id").not("storage_disk_id", "is", null),
  ]);
  if (error) throw new Error(error.message);
  const count = new Map<string, number>();
  for (const r of refs ?? []) {
    const id = r.storage_disk_id as string;
    count.set(id, (count.get(id) ?? 0) + 1);
  }
  return (disks ?? [])
    .map((d) => ({ ...d, productions: count.get(d.id) ?? 0 }))
    .sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name, "he"));
}
