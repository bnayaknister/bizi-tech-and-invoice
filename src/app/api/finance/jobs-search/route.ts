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
  const [{ data: jobs }, { data: clients }, { data: links }, { data: prods }, { data: shows }, { data: orders }] =
    await Promise.all([
    admin
      .from("jobs")
      .select("id,client_id,campaign,amount,date,paid,invoice_biz,invoice_tax")
      .eq("dismissed", false),
    admin.from("clients").select("id,name,morning_client_id"),
    admin.from("job_productions").select("job_id,production_id"),
    admin.from("productions").select("id,show_id,podcast_name,guest,record_date"),
    admin.from("shows").select("id,name"),
    // The ISSUED work order behind each production — added 2026-09-17 so the
    // registry's "+ חשבון עסקה חדש" can SHOW what it is about to issue instead
    // of offering an amount field the server now ignores (B14). One more read
    // on a route that already loads five; no filtering by job, because the
    // caller filters afterwards anyway.
    admin
      .from("pending_documents")
      .select("production_id,morning_doc_number,amount")
      .eq("doc_type", "work_order")
      .eq("status", "issued"),
  ]);

  const clientName = new Map((clients ?? []).map((c) => [c.id as string, c.name as string]));
  const clientMapped = new Map((clients ?? []).map((c) => [c.id as string, !!c.morning_client_id]));
  const showName = new Map((shows ?? []).map((s) => [s.id as string, s.name as string]));
  const prodById = new Map((prods ?? []).map((p) => [p.id as string, p]));
  // production -> its issued order. A production with two issued orders is
  // refused downstream by resolveParentWorkOrderLink; here the first is shown,
  // and the refusal still fires on submit — the screen never promises what the
  // server will not do.
  const orderByProd = new Map<string, { number: string | null; amount: number | null }>();
  for (const o of orders ?? []) {
    const pid = o.production_id as string | null;
    if (!pid || orderByProd.has(pid)) continue;
    orderByProd.set(pid, {
      number: (o.morning_doc_number as string | null) ?? null,
      amount: (o.amount as number | null) ?? null,
    });
  }
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
          client_id: (j.client_id as string | null) ?? null,
          client_name: cname,
          client_mapped: j.client_id ? clientMapped.get(j.client_id as string) ?? false : false,
          show_name: show,
          guest: (prod?.guest as string) ?? null,
          campaign: (j.campaign as string) ?? null,
          amount: (j.amount as number | null) ?? null,
          date: (j.date as string | null) ?? null,
          status: TAB_META[state].label,
          work_order_number: prod ? orderByProd.get(prod.id as string)?.number ?? null : null,
          work_order_amount: prod ? orderByProd.get(prod.id as string)?.amount ?? null : null,
        },
      };
    })
    .filter((r) => r.match)
    .slice(0, 40)
    .map((r) => r.job);

  return NextResponse.json({ jobs: results });
}
