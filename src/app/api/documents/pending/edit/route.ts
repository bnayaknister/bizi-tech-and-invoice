import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { MorningDocumentRequest } from "@/lib/morning/types";

// "ערוך פרטים לפני אישור" (owner spec) — the bookkeeper corrects a queued
// document before it's issued. Amount and description are the two fields
// that actually need fixing; the client is fixed by the mapping and the
// type by the flow, so neither is editable here.
//
// Editable only while the row is still pending or failed (a failed row is
// often edited before a retry). An approved/issued row is frozen — its
// document already exists or is being created.
//
// The payload stored on the row is what will be POSTed to Morning, so the
// edit rewrites it in lockstep with the amount column: income[0].price and
// both description fields, nothing else, so a hand-edit can't reshape the
// request into something unexpected.

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    amount?: number;
    description?: string;
  };
  if (!body.id) return NextResponse.json({ error: "חסר מזהה מסמך" }, { status: 400 });

  const hasAmount = typeof body.amount === "number";
  const newDescription = typeof body.description === "string" ? body.description.trim() : undefined;
  if (!hasAmount && newDescription === undefined) {
    return NextResponse.json({ error: "אין שינוי" }, { status: 400 });
  }
  if (hasAmount && (!(body.amount! > 0) || !Number.isFinite(body.amount))) {
    return NextResponse.json({ error: "סכום חייב להיות מספר חיובי" }, { status: 400 });
  }
  if (newDescription !== undefined && newDescription.length === 0) {
    return NextResponse.json({ error: "תיאור לא יכול להיות ריק" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("pending_documents")
    .select("id,status,amount,payload")
    .eq("id", body.id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "המסמך לא נמצא" }, { status: 404 });
  if (row.status === "issued") {
    // an issued Morning document is immutable — there is no update endpoint
    // (owner rule 2026-07-21). The real-world fix is manual, in Morning.
    return NextResponse.json(
      { error: "מסמך שהונפק אינו ניתן לעריכה במורנינג — יש לבטל/לזכות ולהנפיק מחדש שם ישירות" },
      { status: 409 }
    );
  }
  if (row.status !== "pending" && row.status !== "failed") {
    return NextResponse.json({ error: `לא ניתן לערוך מסמך בסטטוס ${row.status}` }, { status: 409 });
  }

  const before = { amount: row.amount, description: (row.payload as MorningDocumentRequest)?.description };

  const payload = { ...(row.payload as MorningDocumentRequest) };
  if (hasAmount) {
    payload.income = (payload.income ?? []).map((r, i) => (i === 0 ? { ...r, price: body.amount! } : r));
  }
  if (newDescription !== undefined) {
    payload.description = newDescription;
    payload.income = (payload.income ?? []).map((r, i) => (i === 0 ? { ...r, description: newDescription } : r));
  }

  const patch: Record<string, unknown> = { payload };
  if (hasAmount) patch.amount = body.amount;

  const { error } = await admin.from("pending_documents").update(patch).eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: body.id,
    event_type: "document_edited",
    actor_id: user.id,
    payload: {
      before,
      after: { amount: hasAmount ? body.amount : row.amount, description: payload.description },
    },
  });

  return NextResponse.json({ ok: true });
}
