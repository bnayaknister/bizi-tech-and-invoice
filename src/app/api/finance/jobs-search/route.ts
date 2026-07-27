import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deriveState, TAB_META } from "@/lib/finance/state";

// Free-text search over ALL jobs, for the "שייך ל-job" manual fallback (owner
// spec 2026-07-27): when the engine can't auto-match a document — e.g. a
// מס-קבלה billed to the GUEST (ליעד הרמן) while the job sits under the CLIENT
// (סינמטק) — the bookkeeper searches by anything (client, show, guest,
// campaign, amount, date) and picks the job herself. can_view_money to read;
// the assignment itself still goes through can_edit_money.
export async function GET(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_view_money").eq("id", user.id).single();
  if (!profile?.can_view_money) return NextResponse.json({ error: "אין הרשאת צפייה בכספים" }, { status: 403 });

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().toLowerCase();
  if (q.length < 2) return NextResponse.json({ jobs: [] });

  const admin = createAdminClient();
  const [{ data: jobs }, { data: clients }, { data: links }, { data: prods }, { data: shows }] = await Promise.all([
    admin
      .from("jobs")
      .select("id,client_id,campaign,amount,date,paid,invoice_biz,invoice_tax")
      .eq("dismissed", false),
    admin.from("clients").select("id,name"),
    admin.from("job_productions").select("job_id,production_id"),
    admin.from("productions").select("id,show_id,podcast_name,guest,record_date"),
    admin.from("shows").select("id,name"),
  ]);

  const clientName = new Map((clients ?? []).map((c) => [c.id as string, c.name as string]));
  const showName = new Map((shows ?? []).map((s) => [s.id as string, s.name as string]));
  const prodById = new Map((prods ?? []).map((p) => [p.id as string, p]));
  const prodByJob = new Map<string, string>();
  for (const l of links ?? []) if (!prodByJob.has(l.job_id as string)) prodByJob.set(l.job_id as string, l.production_id as string);

  const results = (jobs ?? [])
    .map((j) => {
      const prod = prodByJob.get(j.id as string) ? prodById.get(prodByJob.get(j.id as string)!) : null;
      const show = prod ? showName.get((prod.show_id as string) ?? "") ?? (prod.podcast_name as string) ?? null : null;
      const cname = j.client_id ? clientName.get(j.client_id as string) ?? null : null;
      const state = deriveState({ paid: j.paid as string, invoice_biz: j.invoice_biz as string, invoice_tax: j.invoice_tax as string });
      const haystack = [cname, show, prod?.guest, j.campaign, j.amount != null ? String(j.amount) : "", j.date, prod?.record_date]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return {
        match: haystack.includes(q),
        job: {
          id: j.id as string,
          client_name: cname,
          show_name: show,
          guest: (prod?.guest as string) ?? null,
          campaign: (j.campaign as string) ?? null,
          amount: (j.amount as number | null) ?? null,
          date: (j.date as string | null) ?? null,
          status: TAB_META[state].label,
        },
      };
    })
    .filter((r) => r.match)
    .slice(0, 40)
    .map((r) => r.job);

  return NextResponse.json({ jobs: results });
}
