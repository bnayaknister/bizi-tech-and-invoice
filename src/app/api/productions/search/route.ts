import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Search productions for the finance "שייך תוכנית" picker (owner spec —
// Feature 4): the bookkeeper fixes which show a billing row belongs to by
// linking its production. Results are labelled by SHOW so she picks the show
// (and its episode). can_view_money to read; the link itself goes through
// /api/jobs/link (can_edit_money).
export async function GET(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_view_money").eq("id", user.id).single();
  if (!profile?.can_view_money) return NextResponse.json({ error: "אין הרשאת צפייה בכספים" }, { status: 403 });

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().toLowerCase();
  if (q.length < 2) return NextResponse.json({ productions: [] });

  const admin = createAdminClient();
  const [{ data: prods }, { data: shows }] = await Promise.all([
    admin.from("productions").select("id,show_id,podcast_name,guest,record_date").order("record_date", { ascending: false, nullsFirst: false }),
    admin.from("shows").select("id,name"),
  ]);
  const showName = new Map((shows ?? []).map((s) => [s.id as string, s.name as string]));

  const results = (prods ?? [])
    .map((p) => {
      const show = (p.show_id ? showName.get(p.show_id as string) : null) ?? (p.podcast_name as string) ?? null;
      return {
        id: p.id as string,
        show,
        guest: (p.guest as string | null) ?? null,
        date: (p.record_date as string | null) ?? null,
      };
    })
    .filter((p) => [p.show, p.guest, p.date].filter(Boolean).join(" ").toLowerCase().includes(q))
    .slice(0, 20);

  return NextResponse.json({ productions: results });
}
