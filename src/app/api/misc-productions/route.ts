import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayInIsrael } from "@/lib/dates";
import {
  DOC_TYPE_TO_MORNING_CODE,
  VAT_TYPE_DEFAULT,
  type MorningDocumentRequest,
} from "@/lib/morning/types";

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

  // ---- 3. the job this order bills ----------------------------------------
  // No job_productions row: there are no productions, and that absence is the
  // honest record — the same sentence bundle-from-show:103-104 writes, and 47
  // of the 94 jobs in this database already live that way.
  //
  // ⚠️ FROM HERE DOWN, A FAILURE DOES NOT DELETE THE ENTITY (owner decision
  // 2026-09-08). The entity is a record of work that was agreed; the job and
  // the work order are an attempt to bill it. Losing the second must not erase
  // the first — the operator would have to retype everything, including the
  // supplier lines, to recover from a transient queue error. What she gets
  // instead is a row at 'נפתח' with job_id null, which step 6's "צור הזמנת
  // עבודה" button acts on. The response says so explicitly so the screen can
  // tell "created and queued" from "created, billing failed".
  const { data: job, error: jobErr } = await admin
    .from("jobs")
    .insert({
      client_id: client.id,
      campaign: name,
      amount: total,
      date: workDate, // 0064: jobs.date is the WORK date, not today
      paid: "לא",
      legacy: false,
    })
    .select("id")
    .single();
  if (jobErr || !job) {
    return NextResponse.json(
      {
        ok: true,
        id: entity.id,
        job_id: null,
        billed: false,
        error: `העבודה נשמרה, אך יצירת ה-job נכשלה: ${jobErr?.message ?? ""}. ניתן ליצור הזמנת עבודה מהמסך`,
      },
      { status: 207 }
    );
  }

  // ---- 4. stamp the job on the entity, AND the one-job guard --------------
  // Stamped before the queue insert, not after: job_id is what the retry path
  // (step 6) reads to decide whether this work is already billed, and a job
  // that exists while the entity still says job_id null is exactly the state
  // that lets a second call mint a second job for the same work.
  //
  // THE GUARD IS THE `is("job_id", null)` PREDICATE, not a read-then-write.
  // A SELECT followed by an UPDATE has a window between them; this has none —
  // two concurrent calls cannot both match, so the loser updates zero rows.
  // Unreachable on this path (the entity was created five statements ago and
  // nothing else knows its id), and load-bearing the moment step 6 calls the
  // same code for an existing row. Written now rather than then, because a
  // guard added later is a guard that has to be remembered.
  //
  // AND THE RESULT IS READ, NEVER ASSUMED. `.select()` is what makes "did it
  // actually match" answerable: PostgREST reports a zero-row UPDATE as success
  // with no error, so without this the job would be created, left unlinked,
  // and reported as billed — the precise shape of the bug review/route.ts:217
  // was written to close ("the bookkeeper saw 'rejected', the row stayed
  // pending"). Zero rows here means somebody else won the race, so the job we
  // just made is the duplicate and it is the one that goes.
  const { data: linked, error: linkErr } = await admin
    .from("misc_productions")
    .update({ job_id: job.id, updated_at: new Date().toISOString(), updated_by: user.id })
    .eq("id", entity.id)
    .is("job_id", null)
    .select("id");
  if (linkErr || !linked?.length) {
    await admin.from("jobs").delete().eq("id", job.id as string);
    return NextResponse.json(
      {
        ok: true,
        id: entity.id,
        job_id: null,
        billed: false,
        error: linkErr
          ? `העבודה נשמרה, אך קישור ה-job נכשל: ${linkErr.message}. ניתן ליצור הזמנת עבודה מהמסך`
          : "העבודה נשמרה, אך כבר קיימת לה הזמנת עבודה — לא נוצרה הזמנה נוספת",
      },
      { status: 207 }
    );
  }

  // ---- 5. the work order, into the approval queue --------------------------
  // The description INHERITS: what the operator wrote is what the client will
  // read, and the 2026-09-07 rule (bundle.ts, "THE ORDER'S OWN WORDING") exists
  // because rebuilding it cost two manual repairs on 40318.
  const docTitle =
    (body.description ?? "").trim() || `הזמנת עבודה — ${client.name ?? ""} ${name}`.trim();

  const payload: MorningDocumentRequest = {
    type: DOC_TYPE_TO_MORNING_CODE["work_order"],
    lang: "he",
    currency: "ILS",
    vatType: VAT_TYPE_DEFAULT,
    // issuance date, not the work date — issue.ts re-stamps at the moment it
    // calls Morning, exactly as buildDocumentPayload documents
    date: todayInIsrael(),
    description: docTitle,
    client: {
      id: client.morning_client_id as string,
      name: (client.name as string | null) ?? undefined,
      add: false, // never auto-create a client in Morning from a document
    },
    income: [
      {
        description: name,
        quantity: 1,
        price: total,
        currency: "ILS",
        vatType: VAT_TYPE_DEFAULT,
      },
    ],
  };

  const { data: inserted, error: queueErr } = await admin
    .from("pending_documents")
    .insert({
      doc_type: "work_order",
      production_id: null,
      job_id: job.id,
      client_id: client.id,
      amount: total,
      payload,
      status: "pending",
    })
    .select("id")
    .single();
  if (queueErr || !inserted) {
    // roll the job back rather than leave one nothing points at — the same
    // repair bundle-from-show:158-161 and milestones/[mid]/enqueue:162 make.
    // The entity and its suppliers stay; job_id goes back to null so the retry
    // path sees the same state a never-billed row has.
    await admin.from("jobs").delete().eq("id", job.id as string);
    await admin
      .from("misc_productions")
      .update({ job_id: null, updated_at: new Date().toISOString(), updated_by: user.id })
      .eq("id", entity.id);
    return NextResponse.json(
      {
        ok: true,
        id: entity.id,
        job_id: null,
        billed: false,
        error: `העבודה נשמרה, אך הוספת ההזמנה לתור נכשלה: ${queueErr?.message ?? ""}. ניתן ליצור הזמנת עבודה מהמסך`,
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
      job_id: job.id,
      pending_document_id: inserted.id,
    },
  });

  // the queue row gets its own event under its own entity, so the document's
  // log reads the same way every other queued document's does
  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: inserted.id,
    event_type: "document_queued",
    actor_id: user.id,
    payload: {
      doc_type: "work_order",
      via: "misc_production",
      misc_production_id: entity.id,
      job_id: job.id,
      client_id: client.id,
      amount: total,
    },
  });

  return NextResponse.json({
    ok: true,
    id: entity.id,
    job_id: job.id,
    pending_document_id: inserted.id,
    billed: true,
    amount: total,
    suppliers: suppliers.length,
    status: "queued",
  });
}
