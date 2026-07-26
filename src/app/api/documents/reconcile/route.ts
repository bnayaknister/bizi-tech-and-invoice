import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { linkDocumentToJob, suggestDocsForJob, suggestJobsForDoc } from "@/lib/documents/reconcile";

const DOC_TYPE_LABEL: Record<number, string> = { 300: "חשבון עסקה", 305: "חשבונית מס", 320: "מס / קבלה" };
const docTypeLabel = (t: number) => DOC_TYPE_LABEL[t] ?? `סוג ${t}`;

// GET — ranked match suggestions for the in-context "שייך מסמך קיים" pickers
// (step 3). ?jobId=  → candidate documents for that job (finance red tab);
// ?docId= → candidate jobs for that document (registry). can_view_money to
// read (seeing money-linked suggestions); the assignment itself (POST) still
// requires can_edit_money.
export async function GET(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_view_money").eq("id", user.id).single();
  if (!profile?.can_view_money) return NextResponse.json({ error: "אין הרשאת צפייה בכספים" }, { status: 403 });

  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");
  const docId = url.searchParams.get("docId");
  const admin = createAdminClient();
  const { data: clients } = await admin.from("clients").select("id,name");
  const clientName = new Map((clients ?? []).map((c) => [c.id as string, c.name as string]));

  if (jobId) {
    const cands = await suggestDocsForJob(admin, jobId);
    return NextResponse.json({
      candidates: cands.map((c) => ({
        docId: c.doc.id,
        number: c.doc.morning_doc_number,
        typeLabel: docTypeLabel(c.doc.type),
        amount: c.doc.amount,
        date: c.doc.document_date,
        clientName: c.doc.client_id ? clientName.get(c.doc.client_id) ?? c.doc.morning_client_name ?? "—" : c.doc.morning_client_name ?? "—",
        confidence: c.confidence,
        amountBasis: c.amountBasis,
        dateGapDays: c.dateGapDays,
      })),
    });
  }
  if (docId) {
    const cands = await suggestJobsForDoc(admin, docId);
    return NextResponse.json({
      candidates: cands.map((c) => ({
        jobId: c.job.id,
        jobLabel: [c.job.client_id ? clientName.get(c.job.client_id) ?? "—" : "—", c.job.campaign ?? ""].filter(Boolean).join(" · "),
        jobAmount: c.job.amount,
        jobDate: c.job.date,
        confidence: c.confidence,
        amountBasis: c.amountBasis,
        dateGapDays: c.dateGapDays,
      })),
    });
  }
  return NextResponse.json({ error: "צריך jobId או docId" }, { status: 400 });
}

// The gaps screen's one-click assignment (owner spec 2026-07-26, step B).
// The bookkeeper confirms a match the system proposed — "כל שיוך = לחיצה אחת".
// can_edit_money only (Shiri). Every assignment is evented inside
// linkDocumentToJob. The match itself is computed server-side; the client
// only sends which document goes to which job.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { docId?: string; jobId?: string };
  if (!body.docId || !body.jobId) return NextResponse.json({ error: "חסרים פרטי שיוך" }, { status: 400 });

  const admin = createAdminClient();
  const res = await linkDocumentToJob(admin, {
    docId: body.docId,
    jobId: body.jobId,
    actorId: user.id,
    auto: false,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, state: res.state });
}
