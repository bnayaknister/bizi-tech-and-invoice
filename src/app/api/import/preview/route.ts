import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseCsv, detectKind, buildPlan } from "@/lib/import/merge";
import { loadDbRows, archiveIdSet } from "@/lib/import/server";

export async function POST(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_import").eq("id", user.id).single();
  if (!profile?.can_import) return NextResponse.json({ error: "אין הרשאת ייבוא" }, { status: 403 });

  const { text } = (await request.json()) as { text: string };
  const { headers, rows } = parseCsv(text ?? "");
  const kind = detectKind(headers);
  if (!kind) {
    return NextResponse.json(
      { error: "קובץ לא מזוהה — לא נמצאו עמודות של הפקות או של חשבונות" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();
  const dbRows = await loadDbRows(admin, kind);
  const csvIds = rows.map((r) => (r["ID"] || "").trim()).filter(Boolean);
  const archive = await archiveIdSet(admin, kind, csvIds);
  const plan = buildPlan(kind, rows, dbRows, archive);

  // preview never writes — return the plan (trim per-row values to keep it light)
  return NextResponse.json({
    kind: plan.kind,
    counts: plan.counts,
    total: rows.length,
    rows: plan.rows,
  });
}
