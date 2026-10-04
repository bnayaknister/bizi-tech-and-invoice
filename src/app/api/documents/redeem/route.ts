import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createWorkOrderBundle, type AccruedWorkOrder } from "@/lib/documents/bundle";
import { hasBeenPerformed } from "@/lib/productions/status";
import { rowsInAccruedMonth } from "@/lib/documents/accruedMonth";

// "פדה [לקוח]" (owner spec 2026-07-28): the bookkeeper releases a monthly /
// every_n client's accrued episodes. It produces ONE consolidated work order
// (a line per episode), queued 'pending' for her normal approval → issue.
// Nothing reaches Morning here. can_edit_money.
//
// SCOPE (owner 2026-10-04): a monthly client is redeemed ONE RECORDING MONTH
// at a time and the request must name that month — `{ clientId, monthKey }`.
// every_n and per_episode are unchanged: `{ clientId }`, the whole queue. The
// month is honoured through rowsInAccruedMonth, the same partition
// /documents/accrued keys its cards on, because this route re-selects from the
// database and never sees what that screen rendered.
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

  const body = (await request.json().catch(() => ({}))) as { clientId?: string; monthKey?: string };
  const clientId = body.clientId;
  if (!clientId) return NextResponse.json({ error: "חסר לקוח" }, { status: 400 });
  const monthKey = body.monthKey?.trim() || null;
  if (monthKey && !/^\d{4}-\d{2}$/.test(monthKey)) {
    return NextResponse.json({ error: "מפתח חודש שגוי" }, { status: 400 });
  }

  const admin = createAdminClient();

  // ---- the scope of this redemption ---------------------------------------
  // A monthly client is redeemed ONE RECORDING MONTH AT A TIME (owner
  // 2026-10-04), so the cadence and the month must agree before anything is
  // folded. Both mismatches are refusals and neither may be papered over:
  //
  //   • a monthKey for a client who is not monthly — the caller believes this
  //     client's queue is split by month and it is not; folding "everything"
  //     instead would bill a bundle the screen never showed.
  //   • a monthly client with NO monthKey — this is the OLD request shape, and
  //     it is exactly the bug being fixed: it means "fold every month at
  //     once", which is how מצנע's 1 Oct episode went into the September work
  //     order. A stale browser tab holding the previous chunk sends precisely
  //     this, and it must fail loudly rather than quietly do the old thing to
  //     real money.
  const { data: clientRow } = await admin
    .from("clients")
    .select("billing_cadence")
    .eq("id", clientId)
    .maybeSingle();
  if (!clientRow) return NextResponse.json({ error: "הלקוח לא נמצא" }, { status: 404 });
  const cadence = clientRow.billing_cadence ?? "per_episode";
  if (monthKey && cadence !== "monthly") {
    return NextResponse.json(
      { error: "פדיון לפי חודש קיים רק ללקוח בחיוב חודשי" },
      { status: 400 }
    );
  }
  if (!monthKey && cadence === "monthly") {
    return NextResponse.json(
      { error: "לקוח בחיוב חודשי נפדה חודש-חודש — רענני את המסך ופדי כרטיס של חודש" },
      { status: 400 }
    );
  }

  // the accrued work orders for this client.
  // created_at and productions.record_date are selected for the month
  // partition and for nothing else — they are the two fields israelMonthKey
  // reads, and without them rowsInAccruedMonth would quietly bucket every row
  // by the created_at fallback.
  const { data: accrued } = await admin
    .from("pending_documents")
    .select("id,client_id,amount,production_id,payload,created_at,productions(status,cancelled_at,record_date)")
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
  const everything = (accrued ?? []) as unknown as Array<
    AccruedWorkOrder & {
      created_at: string;
      productions: { status?: string; cancelled_at?: string | null; record_date?: string | null } | null;
    }
  >;
  // The month partition FIRST, then the performed filter. The two predicates
  // are independent so the final set is the same either way — but `skipped`
  // is a message to the bookkeeper, and scoped to the month she pressed it
  // says "3 episodes of this month are not recorded yet" instead of counting
  // unrecorded episodes of months she did not ask about.
  //
  // rowsInAccruedMonth, not a .filter() here: the screen draws the cards from
  // that same function's rule and this route never sees what it drew. See its
  // header for why a second spelling of the partition is the failure mode.
  const all = monthKey ? rowsInAccruedMonth(everything, monthKey) : everything;
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
      // which recording month this redemption covered. A monthly client now
      // has several redemptions and the log has to tell them apart.
      ...(monthKey ? { month_key: monthKey } : {}),
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
