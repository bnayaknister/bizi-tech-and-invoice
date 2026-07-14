import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Linking screen mutations. Writes go through the user's client so RLS
// (can_edit_money) is the actual gate; only the events audit rows go
// through the service client, stamped with the acting user.
//   link:        { action, jobId, productionIds[], confidence?, note? }
//   unlink:      { action, jobId, productionId }
//   manual_only: { action, jobId, value }
// Every action is reversible; every action lands in events.
export async function POST(request: Request) {
  const body = (await request.json()) as {
    action: "link" | "unlink" | "manual_only";
    jobId?: string;
    productionIds?: string[];
    productionId?: string;
    confidence?: string;
    note?: string;
    value?: boolean;
  };
  if (!body.jobId) return NextResponse.json({ error: "חסר מזהה חיוב" }, { status: 400 });

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const admin = createAdminClient();

  if (body.action === "link") {
    const ids = (body.productionIds ?? []).filter(Boolean);
    if (!ids.length) return NextResponse.json({ error: "לא נבחרו הפקות" }, { status: 400 });
    const { error } = await supabase
      .from("job_productions")
      .insert(ids.map((production_id) => ({ job_id: body.jobId, production_id })));
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    await admin.from("events").insert(
      ids.map((production_id) => ({
        entity_type: "job",
        entity_id: body.jobId,
        event_type: "production_linked",
        actor_id: user.id,
        payload: {
          production_id,
          confidence: body.confidence ?? "manual",
          note: body.note ?? null,
          source: "linking_screen",
        },
      }))
    );
    return NextResponse.json({ ok: true, linked: ids.length });
  }

  if (body.action === "unlink") {
    if (!body.productionId) return NextResponse.json({ error: "חסר מזהה הפקה" }, { status: 400 });
    const { error, count } = await supabase
      .from("job_productions")
      .delete({ count: "exact" })
      .eq("job_id", body.jobId)
      .eq("production_id", body.productionId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (count !== 1) return NextResponse.json({ error: "הקישור לא נמצא או שאין הרשאה" }, { status: 403 });
    await admin.from("events").insert({
      entity_type: "job",
      entity_id: body.jobId,
      event_type: "production_unlinked",
      actor_id: user.id,
      payload: { production_id: body.productionId, source: "linking_screen" },
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "manual_only") {
    const { error, count } = await supabase
      .from("jobs")
      .update({ manual_only: body.value === true }, { count: "exact" })
      .eq("id", body.jobId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (count !== 1) return NextResponse.json({ error: "החיוב לא נמצא או שאין הרשאה" }, { status: 403 });
    await admin.from("events").insert({
      entity_type: "job",
      entity_id: body.jobId,
      event_type: body.value ? "marked_manual_only" : "unmarked_manual_only",
      actor_id: user.id,
      payload: { source: "linking_screen" },
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "פעולה לא מוכרת" }, { status: 400 });
}
