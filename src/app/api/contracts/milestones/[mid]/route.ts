import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Edit a milestone's expected date / estimated flag / name / amount, and
// (2026-08-22) its status and its linked job. can_edit_money gated.
//
// status: the column only ever moved forward by the issue route ('invoiced'),
// so a milestone could never reach 'paid' from the app. The manual menu on
// /contracts writes it here. Note it does NOT override a paid job — the
// display state is `status === 'paid' OR job.paid === 'כן'` (milestone.ts) and
// that or-gate is deliberate: the job is the source of truth for payment.
//
// job_id: linking a milestone to an existing deal invoice's job by hand. Three
// checks below, all in code — there is NO unique index on job_id in the DB and
// this route does not add one, so the "already taken" check is a read, with
// the race that implies. Acceptable on a single-bookkeeper screen; a second
// concurrent link would silently double-point and show the same invoice twice.
const ALLOWED = new Set(["expected_date", "is_estimated", "name", "amount", "status", "job_id"]);
const MILESTONE_STATUSES = new Set(["pending", "invoiced", "paid"]);

export async function POST(request: Request, { params }: { params: { mid: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { patch?: Record<string, unknown> };
  const patch = body.patch ?? {};
  const bad = Object.keys(patch).filter((k) => !ALLOWED.has(k));
  if (bad.length) return NextResponse.json({ error: `שדה לא מותר: ${bad.join(", ")}` }, { status: 400 });
  if (!Object.keys(patch).length) return NextResponse.json({ error: "אין שינויים" }, { status: 400 });

  if ("status" in patch && !MILESTONE_STATUSES.has(String(patch.status))) {
    // the CHECK constraint would catch it too, but with a raw postgres error
    return NextResponse.json({ error: "סטטוס לא חוקי לאבן דרך" }, { status: 400 });
  }

  // job_id needs the milestone's contract (for the client) before we can judge
  // the incoming job, so this route reads before it writes now.
  if ("job_id" in patch && patch.job_id !== null) {
    const jobId = String(patch.job_id ?? "");

    const { data: ms } = await supabase
      .from("contract_milestones")
      .select("id,contract_id")
      .eq("id", params.mid)
      .maybeSingle();
    if (!ms) return NextResponse.json({ error: "אבן הדרך לא נמצאה" }, { status: 404 });

    const { data: contract } = await supabase
      .from("contracts")
      .select("id,client_id")
      .eq("id", ms.contract_id)
      .maybeSingle();

    const { data: job } = await supabase.from("jobs").select("id,client_id").eq("id", jobId).maybeSingle();
    if (!job) return NextResponse.json({ error: "ה-job לא נמצא" }, { status: 404 });

    if (job.client_id !== contract?.client_id) {
      return NextResponse.json({ error: "ה-job שייך ללקוח אחר — אפשר לקשר רק job של לקוח החוזה" }, { status: 400 });
    }

    const { data: taken } = await supabase
      .from("contract_milestones")
      .select("id,name")
      .eq("job_id", jobId)
      .neq("id", params.mid)
      .maybeSingle();
    if (taken) {
      return NextResponse.json({ error: `ה-job כבר מקושר לאבן דרך אחרת (${taken.name})` }, { status: 409 });
    }
  }

  const { data, error } = await supabase
    .from("contract_milestones")
    .update(patch)
    .eq("id", params.mid)
    .select("id,contract_id,expected_date,is_estimated,name,amount,status,job_id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data) return NextResponse.json({ error: "אבן הדרך לא נמצאה" }, { status: 404 });

  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: "contract",
    entity_id: data.contract_id,
    event_type: "milestone_updated",
    actor_id: user.id,
    payload: { milestone_id: params.mid, patch },
  });
  return NextResponse.json({ ok: true, milestone: data });
}
