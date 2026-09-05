import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayInIsrael } from "@/lib/dates";
import {
  DOC_TYPE_TO_MORNING_CODE,
  VAT_TYPE_DEFAULT,
  type MorningDocumentRequest,
} from "@/lib/morning/types";

// One work order for N episodes of a show that were edited but never entered
// as productions. It creates the job it bills and queues the document in the
// SAME call, then flows through the ordinary approval → issue path. Nothing
// here reaches Morning (issuePendingDocument does, from the review route).
//
// ═══ WHY IT DOES NOT GO THROUGH enqueueDocument ═══
// That function is anchored to a production in every direction: it reads the
// show through production.show_id, runs checkEligibility on the production,
// writes billing_block_reason onto it, and inserts production_id (enqueue.ts
// :620, :654, :663, :772). There is no production here — that is the whole
// point — so this route builds its row the way /api/documents/enqueue already
// does for a job-anchored order: buildDocumentPayload's shape, inserted
// directly. It is the second caller of that pattern, not a new one.
//
// ═══ WHY THE PAYLOAD IS BUILT HERE AND NOT BY buildDocumentPayload ═══
// buildDocumentPayload hardcodes quantity: 1 (enqueue.ts:406) because every
// document it serves bills one session. This one bills N episodes and the
// count has to be visible on the printed page — "7 × 500" rather than a bare
// 3,500 nobody can check. Changing that helper would touch every production
// document in the system for the sake of this one route, so the shape is
// reproduced here instead: same type/lang/currency/vatType/date/client keys,
// one income line, quantity carrying the count.
//
// The balance gate (lineBalance.ts:58-70) compares Σ(price × quantity) to the
// amount column before approval, so the single line must multiply out to
// exactly `total` — which is why an explicit `amount` override and a computed
// price × quantity cannot both be trusted blindly (see the note at `total`).
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    showId?: string;
    quantity?: number;
    unitPrice?: number;
    amount?: number;
    description?: string;
  };

  if (!body.showId) return NextResponse.json({ error: "לא נבחרה תוכנית" }, { status: 400 });
  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    return NextResponse.json({ error: "כמות לא תקינה" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: show } = await admin
    .from("shows")
    .select("id,name,client_id,default_rate,pricing_model")
    .eq("id", body.showId)
    .maybeSingle();
  if (!show) return NextResponse.json({ error: "התוכנית לא נמצאה" }, { status: 404 });
  if (!show.client_id) return NextResponse.json({ error: "לתוכנית לא משויך לקוח" }, { status: 400 });

  const { data: client } = await admin
    .from("clients")
    .select("id,name,morning_client_id")
    .eq("id", show.client_id as string)
    .maybeSingle();
  if (!client) return NextResponse.json({ error: "הלקוח לא נמצא" }, { status: 404 });
  // iron rule: no issuance without a Morning-mapped client
  if (!client.morning_client_id) {
    return NextResponse.json({ error: "הלקוח אינו ממופה למורנינג" }, { status: 400 });
  }

  const price = body.unitPrice ?? (show.default_rate as number | null);
  if (price == null || !Number.isFinite(Number(price))) {
    return NextResponse.json({ error: "לא הוגדר מחיר לפרק בתוכנית" }, { status: 400 });
  }
  const unitPrice = Number(price);

  // An explicit `amount` wins, but it must still be what the single income
  // line multiplies out to — otherwise the row is queued and then refused at
  // approval by the balance gate, which is a failure the bookkeeper meets
  // hours later with no way to fix it from her screen. Rounded to agorot for
  // the same reason ensure_job_for_production rounds an hourly base (0067):
  // the gate's epsilon is one agora.
  const total = Math.round((body.amount ?? unitPrice * quantity) * 100) / 100;
  const linePrice = Math.round((total / quantity) * 100) / 100;

  const docTitle =
    (body.description ?? "").trim() ||
    `הזמנת עבודה — ${client.name ?? ""} ${show.name ?? ""}`.trim();
  const lineText = `עריכת פרק — ${show.name ?? ""}`.trim();

  // ---- the job this order bills -------------------------------------------
  // No job_productions row: there are no productions, and that absence is the
  // honest record. 45 such jobs already exist in this database.
  const { data: job, error: jobErr } = await admin
    .from("jobs")
    .insert({
      client_id: show.client_id,
      campaign: show.name,
      amount: total,
      date: todayInIsrael(),
      paid: "לא",
      legacy: false,
    })
    .select("id")
    .single();
  if (jobErr || !job) return NextResponse.json({ error: "יצירת העבודה נכשלה" }, { status: 500 });

  const payload: MorningDocumentRequest = {
    type: DOC_TYPE_TO_MORNING_CODE["work_order"],
    lang: "he",
    currency: "ILS",
    vatType: VAT_TYPE_DEFAULT,
    // issuance date, not the work dates — issue.ts re-stamps at the moment it
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
        description: lineText,
        quantity,
        price: linePrice,
        currency: "ILS",
        vatType: VAT_TYPE_DEFAULT,
      },
    ],
  };

  const { data: inserted, error } = await admin
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
  if (error || !inserted) {
    // roll the job back rather than leave one nothing points at — the same
    // repair milestones/[mid]/enqueue:162 makes for the same reason
    await admin.from("jobs").delete().eq("id", job.id as string);
    return NextResponse.json({ error: "הוספת המסמך לתור נכשלה" }, { status: 500 });
  }

  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: inserted.id,
    event_type: "document_queued",
    actor_id: user.id,
    payload: {
      doc_type: "work_order",
      via: "bundle_from_show",
      show_id: show.id,
      show_name: show.name,
      job_id: job.id,
      client_id: client.id,
      quantity,
      unit_price: linePrice,
      amount: total,
    },
  });

  return NextResponse.json({
    ok: true,
    id: inserted.id,
    job_id: job.id,
    amount: total,
    quantity,
    price: linePrice,
    status: "queued",
  });
}
