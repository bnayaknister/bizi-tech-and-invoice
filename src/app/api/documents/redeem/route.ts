import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createWorkOrderBundle, type AccruedWorkOrder } from "@/lib/documents/bundle";
import { hasBeenPerformed } from "@/lib/productions/status";

// "פדה [לקוח]" (owner spec 2026-07-28): the bookkeeper releases a monthly /
// every_n client's accrued episodes. It produces ONE consolidated work order
// (a line per episode), queued 'pending' for her normal approval → issue.
// Nothing reaches Morning here. can_edit_money.
//
// Redemption deliberately stops at the work order (2026-08-02). It used to
// also build a consolidated deal invoice over whichever episodes happened to
// have a job, which had two failure modes that returned 200 with a buried
// note, and priced the two halves differently (the work order folds frozen
// payloads, the deal invoice read jobs.amount live). The deal invoice now
// comes from the work order itself, via Morning's "create based on"
// (linkedDocumentIds) — which is also what closes the order there.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { clientId?: string };
  const clientId = body.clientId;
  if (!clientId) return NextResponse.json({ error: "חסר לקוח" }, { status: 400 });

  const admin = createAdminClient();

  // the accrued work orders for this client
  const { data: accrued } = await admin
    .from("pending_documents")
    .select("id,client_id,amount,production_id,payload,productions(status,cancelled_at)")
    .eq("doc_type", "work_order")
    .eq("status", "accrued")
    .eq("client_id", clientId);

  // Only episodes that were actually performed (owner 2026-08-24). A work
  // order is accrued the moment the calendar creates the production —
  // enqueueDocument decides on billing_cadence alone — so a merely scheduled
  // episode is in this set long before anyone recorded it, and folding one
  // bills the client for work that has not happened.
  //
  // This is the SAME predicate the accrued screen applies, from the same
  // constant, and that is the point: this route selects straight from the DB
  // and never sees what the screen rendered, so a filter in only one of them
  // would let the bookkeeper approve four episodes and issue five.
  const all = (accrued ?? []) as unknown as Array<
    AccruedWorkOrder & { productions: { status?: string; cancelled_at?: string | null } | null }
  >;
  const rows = all.filter((r) =>
    hasBeenPerformed(r.productions?.status ?? null, r.productions?.cancelled_at ?? null)
  ) as AccruedWorkOrder[];
  const skipped = all.length - rows.length;

  if (rows.length === 0) {
    return NextResponse.json(
      {
        error: skipped
          ? `אין פרקים מוקלטים לפדיון עבור לקוח זה — ${skipped} פרקים מסוכמים טרם הוקלטו`
          : "אין פרקים מסוכמים לפדיון עבור לקוח זה",
      },
      { status: 400 }
    );
  }

  // the consolidated work order (folds + marks the accrued rows)
  const wo = await createWorkOrderBundle(admin, rows, user.id);
  if (!wo.ok) return NextResponse.json({ error: wo.error }, { status: wo.status });

  await admin.from("events").insert({
    entity_type: "client",
    entity_id: clientId,
    event_type: "billing_redeemed",
    actor_id: user.id,
    payload: {
      work_order_id: wo.id,
      work_order_lines: wo.lines,
      work_order_amount: wo.amount,
      // what was left behind and why — so a redemption that covered fewer
      // episodes than the client expected explains itself in the log
      ...(skipped ? { skipped_not_recorded: skipped } : {}),
    },
  });

  return NextResponse.json({
    ok: true,
    work_order: { id: wo.id, lines: wo.lines, amount: wo.amount },
    ...(skipped ? { skipped_not_recorded: skipped } : {}),
  });
}
