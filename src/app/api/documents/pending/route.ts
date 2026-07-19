import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// The approval queue, read side. can_view_money — the rows carry client
// names and amounts (RLS enforces this too; this is the clean 403).
//
// Aging (owner rule 2026-07-19): 24h -> the bookkeeper is nudged, 72h -> the
// owner is too. Computed here rather than stored so it's always current.
const HOUR = 60 * 60 * 1000;

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase
    .from("profiles")
    .select("can_view_money,can_edit_money")
    .eq("id", user.id)
    .single();
  if (!profile?.can_view_money) return NextResponse.json({ error: "אין הרשאת צפייה בכספים" }, { status: 403 });

  const { data, error } = await supabase
    .from("pending_documents")
    .select(
      "id,doc_type,status,amount,created_at,payload,reject_reason,last_error,morning_doc_number,pdf_url,issued_at," +
        "production_id,job_id,client_id,clients(name),productions(podcast_name,record_date,guest,studio)"
    )
    .in("status", ["pending", "failed"])
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const now = Date.now();
  // the embedded selects widen the row type past what PostgREST's generics
  // can express; the shape is fixed by the select string above
  const raw = (data ?? []) as unknown as Array<Record<string, unknown> & { created_at: string; status: string }>;
  const rows = raw.map((r) => {
    const ageMs = now - new Date(r.created_at).getTime();
    return {
      ...r,
      age_hours: Math.floor(ageMs / HOUR),
      aging: ageMs > 72 * HOUR ? "critical" : ageMs > 24 * HOUR ? "warning" : null,
    };
  });

  return NextResponse.json({
    ok: true,
    can_approve: !!profile.can_edit_money,
    counts: {
      total: rows.length,
      pending: rows.filter((r) => r.status === "pending").length,
      failed: rows.filter((r) => r.status === "failed").length,
      warning: rows.filter((r) => r.aging === "warning").length,
      critical: rows.filter((r) => r.aging === "critical").length,
    },
    rows,
  });
}
