import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Active shows with the fields a document needs: who the client is, whether
// that client can be billed at all, and what an episode costs.
//
// A route rather than a server prop because the only caller is a modal that
// opens on demand inside an already-rendered client screen. Nothing else in the
// app returns a shows list to the browser — the two existing pickers are fed
// from the server (entity route:101, productions/page.tsx:174) — so there was
// nothing to reuse.
//
// can_edit_money, not can_view_stages: morning_client_id and default_rate are
// billing facts, and this list exists to raise a document. Same gate as the
// route it feeds (documents/bundle-from-show).
export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת כספים" }, { status: 403 });

  // service role: clients is money-gated by RLS and the join below needs it
  // for every show, not only the ones this user could read row by row.
  const admin = createAdminClient();
  const { data: shows, error } = await admin
    .from("shows")
    .select("id,name,client_id,default_rate,pricing_model,active")
    .eq("active", true)
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const clientIds = Array.from(new Set((shows ?? []).map((s) => s.client_id).filter(Boolean))) as string[];
  const { data: clients } = clientIds.length
    ? await admin.from("clients").select("id,name,morning_client_id").in("id", clientIds)
    : { data: [] };
  const byId = new Map((clients ?? []).map((c) => [c.id as string, c]));

  return NextResponse.json({
    shows: (shows ?? []).map((s) => {
      const c = s.client_id ? byId.get(s.client_id as string) : null;
      return {
        id: s.id as string,
        name: s.name as string,
        client_id: (s.client_id as string | null) ?? null,
        client_name: (c?.name as string | null) ?? null,
        // the iron rule, surfaced to the picker so the modal can disable a
        // show instead of letting the user fill a form the route will refuse
        client_mapped: !!c?.morning_client_id,
        default_rate: (s.default_rate as number | null) ?? null,
        pricing_model: (s.pricing_model as string | null) ?? "per_episode",
      };
    }),
  });
}
