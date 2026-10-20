import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { diskCollision, diskWriteError, validateDiskName } from "@/lib/disks";
import { loadDisks, requireDiskManager } from "@/lib/disks.server";

// B35: one disk — rename, hide / show (PATCH), delete (DELETE). Owner/admin.
//
// A rename reaches every production on the disk (trg_disk_rename_cascade);
// the production log keeps the name the disk had at the time. A disk with
// productions is never deleted (FK RESTRICT) — it is hidden: it leaves the
// technician's list and history keeps showing its name.

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const gate = await requireDiskManager();
  if ("response" in gate) return gate.response;

  const body = (await request.json().catch(() => ({}))) as { name?: unknown; hidden?: unknown };
  const admin = createTypedAdminClient();
  const disks = await loadDisks(admin);
  const disk = disks.find((d) => d.id === params.id);
  if (!disk) return NextResponse.json({ error: "הכונן לא נמצא" }, { status: 404 });

  const patch: { name?: string; hidden?: boolean } = {};
  if (body.name !== undefined) {
    const check = validateDiskName(body.name);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
    if (check.name === disk.name) return NextResponse.json({ error: "השם לא השתנה" }, { status: 400 });
    const clash = diskCollision(check.name, disks, disk.id);
    if (clash) {
      return NextResponse.json({ error: `כבר יש כונן "${clash.name}" — אותו שם בלי תלות ברווחים ובאותיות` }, { status: 409 });
    }
    patch.name = check.name;
  }
  if (body.hidden !== undefined) {
    if (typeof body.hidden !== "boolean") return NextResponse.json({ error: "ערך הסתרה לא תקין" }, { status: 400 });
    patch.hidden = body.hidden;
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "אין מה לעדכן" }, { status: 400 });

  const { data, error } = await admin
    .from("storage_disks")
    .update(patch)
    .eq("id", params.id)
    .select("id,name,hidden,created_at")
    .single();
  if (error) return NextResponse.json({ error: diskWriteError(error) }, { status: error.code === "23505" ? 409 : 400 });

  const eventType =
    patch.name !== undefined ? "storage_disk_renamed" : patch.hidden ? "storage_disk_hidden" : "storage_disk_shown";
  await admin.from("events").insert({
    entity_type: "storage_disk",
    entity_id: params.id,
    event_type: eventType,
    actor_id: gate.userId,
    payload: patch.name !== undefined ? { from: disk.name, to: patch.name, productions: disk.productions } : { name: disk.name, hidden: patch.hidden },
  });
  return NextResponse.json({ ok: true, disk: { ...data, productions: disk.productions } });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const gate = await requireDiskManager();
  if ("response" in gate) return gate.response;

  const admin = createTypedAdminClient();
  const disk = (await loadDisks(admin)).find((d) => d.id === params.id);
  if (!disk) return NextResponse.json({ error: "הכונן לא נמצא" }, { status: 404 });
  if (disk.productions > 0) {
    return NextResponse.json({ error: `יש ${disk.productions} הפקות על הכונן — אפשר להסתיר אותו, לא למחוק` }, { status: 409 });
  }

  // the FK is the real wall (a production assigned between the count and here)
  const { error } = await admin.from("storage_disks").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: diskWriteError(error) }, { status: error.code === "23503" ? 409 : 400 });

  await admin.from("events").insert({
    entity_type: "storage_disk",
    entity_id: params.id,
    event_type: "storage_disk_deleted",
    actor_id: gate.userId,
    payload: { name: disk.name },
  });
  return NextResponse.json({ ok: true });
}
