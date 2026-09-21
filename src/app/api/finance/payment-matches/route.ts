import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computePaymentMatches, paymentMatchFingerprint } from "@/lib/documents/reconcile";
import { amountBasisLabel } from "@/lib/documents/confidence";

// The payment matches the engine WOULD link, shown and never written
// (F14 stage B, owner decision 2026-09-21).
//
// ═══ WHY THIS ROUTE EXISTS AT ALL ═══
// Until today `certainPaymentMatches` had no reader in any screen: the only
// two callers were scripts, and both went straight to the endpoint that linked
// the whole list in a loop. So the list that decides which jobs get marked
// paid was never once LOOKED at before it was acted on. This is that look, and
// it is the same query rule 55 requires before any change to the payment
// engine — it just stopped being something somebody has to remember to run.
//
// can_view_money to read, mirroring GET /api/documents/reconcile: seeing
// money-linked suggestions is a view permission; the linking itself (POST
// /api/finance/reconcile-payments) still requires can_edit_money.
//
// ⚠️ ZERO WRITES. Nothing below inserts, updates or events. The whole point of
// splitting the endpoint in two is that this half cannot move money.

const DOC_TYPE_LABEL: Record<number, string> = { 320: "מס / קבלה", 400: "קבלה" };
const docTypeLabel = (t: number) => DOC_TYPE_LABEL[t] ?? `סוג ${t}`;

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_view_money").eq("id", user.id).single();
  if (!profile?.can_view_money) return NextResponse.json({ error: "אין הרשאת צפייה בכספים" }, { status: 403 });

  const admin = createAdminClient();
  const matches = await computePaymentMatches(admin);
  if (!matches.length) return NextResponse.json({ matches: [] });

  // ---- enrichment, scoped to the matched rows ----------------------------
  // Deliberately `.in(...)` on the handful of ids rather than the table-wide
  // reads jobs-search does: this list is 0 today and is meant to stay small,
  // and a label is not worth five full-table scans. The join is the same one
  // jobs-search walks — job → job_productions → productions → shows.
  const jobIds = Array.from(new Set(matches.map((m) => m.job.id)));
  const clientIds = Array.from(
    new Set(matches.flatMap((m) => [m.job.client_id, m.doc.client_id]).filter((v): v is string => !!v))
  );

  const [{ data: clients }, { data: links }] = await Promise.all([
    clientIds.length ? admin.from("clients").select("id,name").in("id", clientIds) : Promise.resolve({ data: [] }),
    admin.from("job_productions").select("job_id,production_id").in("job_id", jobIds),
  ]);

  const prodIds = Array.from(new Set((links ?? []).map((l) => l.production_id as string).filter(Boolean)));
  const { data: prods } = prodIds.length
    ? await admin.from("productions").select("id,show_id,podcast_name,guest").in("id", prodIds)
    : { data: [] };
  const showIds = Array.from(new Set((prods ?? []).map((p) => p.show_id as string).filter(Boolean)));
  const { data: shows } = showIds.length
    ? await admin.from("shows").select("id,name").in("id", showIds)
    : { data: [] };

  const clientName = new Map((clients ?? []).map((c) => [c.id as string, c.name as string]));
  const showName = new Map((shows ?? []).map((s) => [s.id as string, s.name as string]));
  const prodById = new Map((prods ?? []).map((p) => [p.id as string, p]));
  const prodByJob = new Map<string, string>();
  for (const l of links ?? []) {
    const jid = l.job_id as string;
    if (!prodByJob.has(jid)) prodByJob.set(jid, l.production_id as string);
  }

  return NextResponse.json({
    matches: matches.map((m) => {
      const prod = prodByJob.get(m.job.id) ? prodById.get(prodByJob.get(m.job.id)!) : null;
      const show = prod ? showName.get((prod.show_id as string) ?? "") ?? (prod.podcast_name as string | null) ?? null : null;
      // The same phrasing the gaps screen and AssignDocModal already use for a
      // job, plus the show/guest when the job hangs off a production — a
      // payment is judged against "which recording is this", and client alone
      // does not answer that.
      const jobLabel = [
        m.job.client_id ? clientName.get(m.job.client_id) ?? "—" : "—",
        show,
        prod?.guest ? `אורח: ${prod.guest}` : null,
        m.job.campaign,
      ]
        .filter(Boolean)
        .join(" · ");

      return {
        docId: m.doc.id,
        jobId: m.job.id,
        // the document
        docNumber: m.doc.morning_doc_number,
        docType: m.doc.type,
        docTypeLabel: docTypeLabel(m.doc.type),
        docAmount: m.doc.amount,
        docDate: m.doc.document_date,
        clientName: m.doc.client_id
          ? clientName.get(m.doc.client_id) ?? m.doc.morning_client_name ?? "—"
          : m.doc.morning_client_name ?? "—",
        // the job
        jobLabel,
        jobAmount: m.job.amount,
        jobDate: m.job.date,
        // how they were matched. The basis wording comes from confidence.ts so
        // a second phrasing for the same idea can never be born here — the gaps
        // screen and this one say it in the same words.
        dateGapDays: m.dateGapDays,
        amountBasis: m.amountBasis,
        amountBasisLabel: amountBasisLabel(m.amountBasis),
        // what the confirm call must send back unchanged
        fingerprint: paymentMatchFingerprint(m),
      };
    }),
  });
}
