import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionAndProfile } from "@/lib/profile";
import { billMiscProduction } from "@/lib/misc/workOrder";

/**
 * "צור הזמנת עבודה" — step 6. The retry the create route promised.
 *
 * ═══ WHAT IT ACTS ON: A STATE, NOT A HISTORY ═══
 * The create route has three 207 exits — the job insert failed, the stamp
 * failed, the queue insert failed — and ALL THREE CONVERGE ON ONE STATE: the
 * entity and its supplier lines exist, job_id is null, and no job survives
 * (each path rolls its own back). So this route does not ask which one
 * happened and has nothing to branch on. It runs the whole chain, always.
 *
 * That is also why it is safe on a row that never 207'd at all — a row created
 * some other way, or one whose billing was undone by hand. The precondition is
 * `job_id is null`, and that is the entire contract.
 *
 * ═══ THE DOUBLE-CLICK GUARD IS THE PREDICATE, AND IT IS THE ONLY WALL ═══
 * `is("job_id", null)` inside billMiscProduction is what makes two tabs safe:
 * two callers cannot both match, the loser updates zero rows, deletes the job
 * it made, and comes back `already_billed`.
 *
 * It carries that weight alone, because the database offers nothing here:
 * pending_documents_one_live_per_production is partial on
 * `production_id IS NOT NULL` (0063) and a misc work order is written with
 * production_id null, so the index does not see it; and there is no unique
 * index on job_id. Verified 2026-09-14. The same missing wall 0077 recorded for
 * the registry's manual enqueue path.
 *
 * The pre-flight check below is therefore NOT that wall — it is the readable
 * message. Without it the second clicker gets a confusing "retry failed" for
 * something that in fact succeeded, which is the shape
 * documents/enqueue/route.ts:111-124 already refuses to ship.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const { user, profile } = await getSessionAndProfile();
  if (!user || !profile?.approved) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  // The same flag the create route checks and the same one the button is gated
  // on. /misc is READ at can_view_money; billing is a write.
  if (!profile.can_edit_money) {
    return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });
  }

  const admin = createAdminClient();

  // Read through the SERVICE ROLE, like everything else on this screen: 0074
  // grants `authenticated` no table-level SELECT on misc_productions and never
  // names `amount` in its column grants, so a user-bound client cannot read the
  // number this order is for (misc/page.tsx says the same at length).
  const { data: entity, error: readErr } = await admin
    .from("misc_productions")
    .select("id,client_id,name,work_date,amount,description,status,job_id")
    .eq("id", params.id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 400 });
  if (!entity) return NextResponse.json({ error: "העבודה לא נמצאה" }, { status: 404 });

  // ---- pre-flight: readable refusals, before anything is created ----------

  // Already billed. A 409 and never a 207: 207 means "saved, billing failed,
  // you may retry", and a retry here can never succeed — the row HAS its order.
  // Telling the second clicker to try again would be the API lying about its
  // own state.
  if (entity.job_id) {
    return NextResponse.json(
      { error: "לעבודה הזאת כבר נוצרה הזמנת עבודה", status: "exists" },
      { status: 409 }
    );
  }

  // Cancelled work is not billed. The board cannot produce this row — 'בוטל' is
  // off it in both directions — but the table still lists cancelled rows, and
  // the button is hidden rather than absent, so the server says it too.
  if (entity.status === "בוטל") {
    return NextResponse.json(
      { error: "העבודה בוטלה — לא ניתן ליצור לה הזמנת עבודה" },
      { status: 409 }
    );
  }

  // The one refusal the operator cannot fix by retyping a field, and the iron
  // rule the create route states at :136-140: no issuance without a
  // Morning-mapped client. Checked BEFORE the job is made, so a client that
  // cannot be billed never mints one.
  const { data: client } = await admin
    .from("clients")
    .select("id,name,morning_client_id")
    .eq("id", entity.client_id as string)
    .maybeSingle();
  if (!client) return NextResponse.json({ error: "הלקוח לא נמצא" }, { status: 404 });
  if (!client.morning_client_id) {
    return NextResponse.json(
      { error: `הלקוח '${client.name ?? ""}' אינו ממופה למורנינג — לא ניתן להנפיק לו מסמכים` },
      { status: 400 }
    );
  }

  // amount is NOT NULL in 0074 and its CHECK forbids zero, so this cannot fire
  // on a row the create route made. It is here for a row written any other way,
  // because the balance gate compares Σ(price × quantity) to the amount column
  // and a null would fail it at approval time instead of here.
  const amount = entity.amount as number | null;
  if (amount == null || !(amount > 0)) {
    return NextResponse.json({ error: "לעבודה אין סכום — לא ניתן ליצור הזמנת עבודה" }, { status: 400 });
  }

  // ---- the chain, identical to the create route's ------------------------
  const billing = await billMiscProduction(admin, {
    entityId: entity.id as string,
    clientId: client.id as string,
    clientName: (client.name as string | null) ?? null,
    morningClientId: client.morning_client_id as string,
    name: entity.name as string,
    workDate: entity.work_date as string,
    amount,
    description: (entity.description as string | null) ?? null,
    actorId: user.id,
  });

  if (!billing.ok) {
    // The race the pre-flight cannot close: the row was unbilled when it was
    // read and billed by the time the stamp ran. Same answer as the pre-flight
    // — 409, never 207 — so the two paths cannot disagree about what happened.
    if (billing.reason === "already_billed") {
      return NextResponse.json(
        { error: "לעבודה הזאת כבר נוצרה הזמנת עבודה", status: "exists" },
        { status: 409 }
      );
    }

    // `already_billed` is absent because the early return above already
    // narrowed it out of `billing.reason` — the compiler is what proves the
    // 409 branch is exhaustive, so a new reason cannot slip through unlabelled.
    const WHY: Record<typeof billing.reason, string> = {
      job_failed: "יצירת ה-job נכשלה",
      link_failed: "קישור ה-job נכשל",
      queue_failed: "הוספת ההזמנה לתור נכשלה",
    };
    const detail = billing.message ? `: ${billing.message}` : "";
    // A job the rollback could not remove is named here and nowhere else — no
    // misc screen renders it, so an unreported orphan is an invisible one.
    const leak = billing.leakedJobId ? ` ⚠️ נותר job יתום ${billing.leakedJobId} — יש למחוק ידנית.` : "";
    return NextResponse.json(
      {
        error: `${WHY[billing.reason]}${detail}. העבודה נשמרה כפי שהייתה וניתן לנסות שוב${leak}`,
        // The row is untouched, so the screen can say "nothing changed" rather
        // than making the operator guess whether a half-order exists.
        billed: false,
      },
      { status: 500 }
    );
  }

  // The entity's own journal line. Distinct from misc_production_created on
  // purpose: this is billing that happened LATER than the work was recorded,
  // and folding the two would erase the gap — which is the one fact worth
  // keeping, since that gap is what the 207 left behind.
  await admin.from("events").insert({
    entity_type: "misc_production",
    entity_id: entity.id,
    event_type: "misc_work_order_created",
    actor_id: user.id,
    payload: {
      via: "misc_work_order_button",
      client_id: client.id,
      name: entity.name,
      amount,
      job_id: billing.jobId,
      pending_document_id: billing.pendingDocumentId,
    },
  });

  return NextResponse.json({
    ok: true,
    id: entity.id,
    job_id: billing.jobId,
    pending_document_id: billing.pendingDocumentId,
    billed: true,
  });
}
