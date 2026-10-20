import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { diskCollision, diskWriteError, validateDiskName } from "@/lib/disks";
import { loadDisks, requireDiskManager } from "@/lib/disks.server";

// B35: the disk list. GET for the settings screen, POST adds a disk.
// Owner/admin only (requireDiskManager).

export async function GET() {
  const gate = await requireDiskManager();
  if ("response" in gate) return gate.response;
  return NextResponse.json({ disks: await loadDisks() });
}

export async function POST(request: Request) {
  const gate = await requireDiskManager();
  if ("response" in gate) return gate.response;

  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
  const check = validateDiskName(body.name);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  const admin = createTypedAdminClient();
  const existing = await loadDisks(admin);
  const clash = diskCollision(check.name, existing);
  if (clash) {
    return NextResponse.json({ error: `כבר יש כונן "${clash.name}" — אותו שם בלי תלות ברווחים ובאותיות` }, { status: 409 });
  }

  const { data, error } = await admin
    .from("storage_disks")
    .insert({ name: check.name, created_by: gate.userId })
    .select("id,name,hidden,created_at")
    .single();
  if (error) return NextResponse.json({ error: diskWriteError(error) }, { status: error.code === "23505" ? 409 : 400 });

  await admin.from("events").insert({
    entity_type: "storage_disk",
    entity_id: data.id,
    event_type: "storage_disk_created",
    actor_id: gate.userId,
    payload: { name: data.name },
  });
  return NextResponse.json({ ok: true, disk: { ...data, productions: 0 } });
}
