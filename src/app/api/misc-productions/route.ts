import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { billMiscProduction } from "@/lib/misc/workOrder";

// "רדיו ושונות" — one non-podcast job (radio production, sound edit for someone
// else's recording, a one-off session), its supplier lines, the job it bills,
// and the work order that goes to the approval queue. All in one call.
// Nothing here reaches Morning (issuePendingDocument does, from the review
// route). can_edit_money.
//
// ═══ WHY IT DOES NOT GO THROUGH enqueueDocument ═══
// The same reason bundle-from-show gives (that file's header, :16-23):
// enqueueDocument is anchored to a production in every direction — it reads the
// show through production.show_id, runs checkEligibility on the production,
// writes billing_block_reason onto it, and inserts production_id. There is no
// production here, and deliberately so: 0074's header records the four DB-layer
// mechanisms that made kind='misc' on `productions` unworkable, two of which
// (ensure_job_for_production and checkEligibility) refuse anything that is not
// kind='client' and would have left this row with no job at all.
//
// So this route builds its rows the way bundle-from-show already does — it is
// the third caller of that pattern, not a new one.
//
// ═══ THE INCOME LINE, AND THE BALANCE GATE ═══
// One line, quantity 1, price = amount. The balance gate (lineBalance.ts:58-70)
// compares Σ(price × quantity) to the amount column with a one-agora epsilon
// before approval, so this multiplies out exactly by construction. That is the
// deliberate difference from bundle-from-show, which bills N episodes on one
// line and has to divide: rule 47's lesson is that `quantity = 1` is an
// observation elsewhere in this codebase, but HERE it is an invariant — this
// route writes the line itself and there is exactly one unit of work.

type SupplierInput = {
  supplierName?: string;
  service?: string | null;
  price?: number | null;
  dueDate?: string | null;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    clientId?: string;
    name?: string;
    workDate?: string;
    clientOrderRef?: string | null;
    amount?: number;
    description?: string | null;
    suppliers?: SupplierInput[];
  };

  // ---- validation ---------------------------------------------------------
  // Every message names the field, because this route is called from a form
  // and "בקשה לא תקינה" sends the operator hunting through six inputs.
  const clientId = (body.clientId ?? "").trim();
  if (!clientId) return NextResponse.json({ error: "יש לבחור לקוח" }, { status: 400 });

  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "יש להזין שם לעבודה" }, { status: 400 });

  const workDate = (body.workDate ?? "").trim();
  // The column is NOT NULL (0074) and the job's date derives from it — 0064
  // made jobs.date the work date and every ageing number downstream reads it.
  // Checked for SHAPE here rather than left to the DB: a 22P02 reaches the
  // screen as "invalid input syntax for type date", which is not a sentence
  // anyone can act on.
  if (!ISO_DATE.test(workDate)) {
    return NextResponse.json({ error: "יש להזין תאריך עבודה תקין" }, { status: 400 });
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "יש להזין סכום גדול מאפס" }, { status: 400 });
  }
  // agorot, for the same reason bundle-from-show rounds (:91-95): the balance
  // gate's epsilon is one agora, and a float that arrived from a form can carry
  // more precision than a document can express.
  const total = Math.round(amount * 100) / 100;

  // Supplier lines are validated BEFORE anything is written. A bad price on
  // line 3 must not leave a half-created job behind — and the DB's own CHECK
  // would surface as a constraint name, not a sentence.
  const rawSuppliers = Array.isArray(body.suppliers) ? body.suppliers : [];
  const suppliers: { supplier_name: string; service: string | null; price: number | null; due_date: string | null }[] = [];
  for (let i = 0; i < rawSuppliers.length; i++) {
    const s = rawSuppliers[i] ?? {};
    const supplierName = (s.supplierName ?? "").trim();
    // a blank row is what an untouched "+ הוסף ספק" leaves behind — drop it
    // rather than refuse the whole form over a row the operator never filled
    if (!supplierName && s.price == null && !s.service && !s.dueDate) continue;
    if (!supplierName) {
      return NextResponse.json({ error: `ספק ${i + 1}: חסר שם` }, { status: 400 });
    }
    let price: number | null = null;
    if (s.price != null && String(s.price).trim() !== "") {
      const p = Number(s.price);
      if (!Number.isFinite(p) || p < 0) {
        return NextResponse.json({ error: `ספק ${i + 1} (${supplierName}): מחיר לא תקין` }, { status: 400 });
      }
      price = Math.round(p * 100) / 100;
    }
    const dueDate = (s.dueDate ?? "").trim();
    if (dueDate && !ISO_DATE.test(dueDate)) {
      return NextResponse.json({ error: `ספק ${i + 1} (${supplierName}): תאריך תשלום לא תקין` }, { status: 400 });
    }
    suppliers.push({
      supplier_name: supplierName,
      service: (s.service ?? "").trim() || null,
      price,
      due_date: dueDate || null,
    });
  }

  const admin = createAdminClient();

  // ---- the client, and the iron rule --------------------------------------
  const { data: client } = await admin
    .from("clients")
    .select("id,name,morning_client_id")
    .eq("id", clientId)
    .maybeSingle();
  if (!client) return NextResponse.json({ error: "הלקוח לא נמצא" }, { status: 404 });
  // iron rule: no issuance without a Morning-mapped client (bundle-from-show:77-80)
  if (!client.morning_client_id) {
    return NextResponse.json({ error: `הלקוח '${client.name ?? ""}' אינו ממופה למורנינג` }, { status: 400 });
  }

  // ---- 1. the entity ------------------------------------------------------
  // Written FIRST, and it is the row that survives everything below. See the
  // rollback note at the queue insert.
  const { data: entity, error: entityErr } = await admin
    .from("misc_productions")
    .insert({
      client_id: client.id,
      name,
      work_date: workDate,
      client_order_ref: (body.clientOrderRef ?? "").trim() || null,
      amount: total,
      description: (body.description ?? "").trim() || null,
      status: "נפתח",
      created_by: user.id,
      updated_by: user.id,
    })
    .select("id")
    .single();
  if (entityErr || !entity) {
    return NextResponse.json({ error: `יצירת העבודה נכשלה: ${entityErr?.message ?? ""}` }, { status: 500 });
  }

  // ---- 2. supplier lines --------------------------------------------------
  // A failure here rolls back the entity, and this is the ONE place that does:
  // the suppliers are part of what the operator typed, not a consequence of it,
  // so an entity saved without them is a silent data loss she cannot see.
  // Everything from the job onwards is a billing consequence and is handled the
  // other way round (below).
  if (suppliers.length) {
    const { error: supErr } = await admin
      .from("misc_production_suppliers")
      .insert(suppliers.map((s) => ({ ...s, misc_production_id: entity.id, created_by: user.id })));
    if (supErr) {
      await admin.from("misc_productions").delete().eq("id", entity.id);
      return NextResponse.json({ error: `שמירת הספקים נכשלה: ${supErr.message}` }, { status: 500 });
    }
  }

  // ---- 3-5. the billing chain: job -> stamp -> work order in the queue -----
  //
  // ⚠️ FROM HERE DOWN, A FAILURE DOES NOT DELETE THE ENTITY (owner decision
  // 2026-09-08). The entity is a record of work that was agreed; the job and
  // the work order are an attempt to bill it. Losing the second must not erase
  // the first — the operator would have to retype everything, including the
  // supplier lines, to recover from a transient queue error. What she gets
  // instead is a row at 'נפתח' with job_id null, which step 6's "צור הזמנת
  // עבודה" button acts on. The response says so explicitly so the screen can
  // tell "created and queued" from "created, billing failed".
  //
  // The three steps live in lib/misc/workOrder.ts because the button runs the
  // SAME three, on a row that reached this state rather than one born into it.
  // Two copies of a Morning payload and a rollback would be two things to keep
  // in step forever on the path that mints documents — and the rollback bug
  // that extraction just fixed (an orphaned job, see that file's header) is
  // what a second copy would have inherited.
  const billing = await billMiscProduction(admin, {
    entityId: entity.id as string,
    clientId: client.id as string,
    clientName: (client.name as string | null) ?? null,
    morningClientId: client.morning_client_id as string,
    name,
    workDate,
    amount: total,
    description: (body.description ?? "").trim() || null,
    actorId: user.id,
  });

  if (!billing.ok) {
    // All four reasons land on the same 207: the entity exists, the billing
    // does not, and the row is at 'נפתח' with job_id null. `already_billed` is
    // unreachable on THIS path — the entity was created five statements ago
    // and nothing else knows its id — and it is the button, not this route,
    // that can actually meet it.
    //
    // The sentence names which step failed, because which one it was decides
    // whether a retry will work, and the modal surfaces it verbatim as
    // `detail` rather than paraphrasing it away (NewMiscModal.tsx:126-133).
    const WHY: Record<typeof billing.reason, string> = {
      job_failed: "יצירת ה-job נכשלה",
      link_failed: "קישור ה-job נכשל",
      already_billed: "כבר קיימת לה הזמנת עבודה",
      queue_failed: "הוספת ההזמנה לתור נכשלה",
    };
    const detail = billing.message ? `: ${billing.message}` : "";
    // A job the rollback could not remove is reported, not swallowed. It is
    // invisible on every misc screen, so this line is the only place it is
    // ever mentioned.
    const leak = billing.leakedJobId ? ` ⚠️ נותר job יתום ${billing.leakedJobId} — יש למחוק ידנית.` : "";
    return NextResponse.json(
      {
        ok: true,
        id: entity.id,
        job_id: null,
        billed: false,
        error: `העבודה נשמרה, אך ${WHY[billing.reason]}${detail}. ניתן ליצור הזמנת עבודה מהמסך${leak}`,
      },
      { status: 207 }
    );
  }

  await admin.from("events").insert({
    entity_type: "misc_production",
    entity_id: entity.id,
    event_type: "misc_production_created",
    actor_id: user.id,
    payload: {
      via: "misc_productions_route",
      client_id: client.id,
      name,
      work_date: workDate,
      client_order_ref: (body.clientOrderRef ?? "").trim() || null,
      amount: total,
      suppliers: suppliers.length,
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
    amount: total,
    suppliers: suppliers.length,
    status: "queued",
  });
}
