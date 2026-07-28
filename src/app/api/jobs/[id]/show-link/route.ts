import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// The current show/production links of a finance job + any tax receipt already
// linked to it (owner spec — Feature 4: "show the linked מס-קבלה and don't
// break it"). Read-only; can_view_money. The relinking itself is /api/jobs/link.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_view_money").eq("id", user.id).single();
  if (!profile?.can_view_money) return NextResponse.json({ error: "אין הרשאת צפייה בכספים" }, { status: 403 });

  const admin = createAdminClient();
  const [{ data: links }, { data: job }, { data: taxInvoices }] = await Promise.all([
    admin.from("job_productions").select("production_id").eq("job_id", params.id),
    admin.from("jobs").select("invoice_tax").eq("id", params.id).maybeSingle(),
    admin.from("invoices").select("doc_number,pdf_url").eq("job_id", params.id).eq("type", "מס"),
  ]);

  const prodIds = (links ?? []).map((l) => l.production_id as string);
  let current: { production_id: string; show: string | null; guest: string | null; date: string | null }[] = [];
  if (prodIds.length) {
    const [{ data: prods }, { data: shows }] = await Promise.all([
      admin.from("productions").select("id,show_id,podcast_name,guest,record_date").in("id", prodIds),
      admin.from("shows").select("id,name"),
    ]);
    const showName = new Map((shows ?? []).map((s) => [s.id as string, s.name as string]));
    current = (prods ?? []).map((p) => ({
      production_id: p.id as string,
      show: (p.show_id ? showName.get(p.show_id as string) : null) ?? (p.podcast_name as string) ?? null,
      guest: (p.guest as string | null) ?? null,
      date: (p.record_date as string | null) ?? null,
    }));
  }

  return NextResponse.json({
    current,
    invoiceTax: (job?.invoice_tax as string | null) ?? null,
    taxDocs: (taxInvoices ?? []).map((t) => ({ number: t.doc_number as string | null, pdf: t.pdf_url as string | null })),
  });
}
