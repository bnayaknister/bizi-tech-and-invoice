import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSessionAndProfile } from "@/lib/profile";

// Production journal writes (§3, owner 2026-07-24). RLS on production_log is the
// real gate: insert needs can_edit_stages + author_id = self; update is
// author-only within 5 minutes (a DB trigger stamps edited_at and forbids
// touching anything but the note). Stage-change and disk-change entries are
// written by DB triggers, not here — this endpoint is the free "+ הערה" and the
// optional note attached when a stage is completed, plus editing one's own note.

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { user, profile } = await getSessionAndProfile();
  if (!user || !profile?.approved) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  if (!profile.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  const body = (await request.json()) as {
    note?: string;
    stage_id?: string | null;
    track?: "episode" | "reels" | null;
    step?: "record" | "edit" | "deliver" | null;
  };
  const note = body.note?.trim();
  if (!note) return NextResponse.json({ error: "הערה ריקה" }, { status: 400 });

  const supabase = createClient();
  const { data, error } = await supabase
    .from("production_log")
    .insert({
      production_id: params.id,
      kind: "note",
      note,
      stage_id: body.stage_id ?? null,
      track: body.track ?? null,
      step: body.step ?? null,
      author_id: user.id,
    })
    .select("id,kind,track,step,stage_status,note,author_id,created_at,edited_at")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, entry: data });
}

// edit one's own note within the 5-minute window (RLS + the guard trigger
// enforce both the window and note-only editing; this just surfaces a clean
// error). No delete — entries are permanent.
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { user, profile } = await getSessionAndProfile();
  if (!user || !profile?.approved) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const body = (await request.json()) as { log_id?: string; note?: string };
  const note = body.note?.trim();
  if (!body.log_id || !note) return NextResponse.json({ error: "חסר מזהה או תוכן" }, { status: 400 });

  const supabase = createClient();
  const { data, error } = await supabase
    .from("production_log")
    .update({ note })
    .eq("id", body.log_id)
    .eq("production_id", params.id)
    .select("id,kind,track,step,stage_status,note,author_id,created_at,edited_at")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data) return NextResponse.json({ error: "לא ניתן לערוך (עברו 5 דקות או לא הכותב)" }, { status: 403 });
  return NextResponse.json({ ok: true, entry: data });
}
