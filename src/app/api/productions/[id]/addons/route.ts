import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionAndProfile } from "@/lib/profile";

// Session add-ons / upsells (owner spec 2026-07-21). Server-only: the
// price columns are revoked from the shared authenticated role (0031), so
// every read/write runs through the service role AFTER an explicit
// permission check here — the same model as the review-link routes.
//
// Who may do what:
//   add    — can_edit_stages  (a technician logs the upsell, no price)
//   price  — can_edit_money    (only money editors set the amount)
//   delete — can_edit_stages   (only while still 'proposed')
//   approve/reject (manual) — can_edit_money
// The client's own approve/reject happens on the review link, not here.

type AddonRow = {
  id: string;
  production_id: string;
  title: string;
  quantity: number;
  unit_price: number | null;
  total: number | null;
  status: string;
  approved_via: string | null;
  created_by: string | null;
  created_at: string;
};

// strip the price columns for a viewer without can_view_money
function shape(a: AddonRow, canViewMoney: boolean) {
  return {
    id: a.id,
    title: a.title,
    quantity: a.quantity,
    status: a.status,
    approved_via: a.approved_via,
    created_at: a.created_at,
    unit_price: canViewMoney ? a.unit_price : null,
    total: canViewMoney ? a.total : null,
  };
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { user, profile } = await getSessionAndProfile();
  if (!user || !profile?.approved) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  if (!profile.can_view_stages) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("production_addons")
    .select("id,production_id,title,quantity,unit_price,total,status,approved_via,created_by,created_at")
    .eq("production_id", params.id)
    .order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const addons = (data as AddonRow[]).map((a) => shape(a, profile.can_view_money));

  // the base package price (show default_rate) so the section can show the
  // production total = base + approved add-ons — money viewers only
  let baseAmount: number | null = null;
  if (profile.can_view_money) {
    const { data: prod } = await admin
      .from("productions")
      .select("show_id")
      .eq("id", params.id)
      .maybeSingle();
    if (prod?.show_id) {
      const { data: show } = await admin
        .from("shows")
        .select("default_rate")
        .eq("id", prod.show_id)
        .maybeSingle();
      baseAmount = (show?.default_rate as number | null) ?? null;
    }
  }

  return NextResponse.json({
    addons,
    base_amount: baseAmount,
    can_edit_stages: profile.can_edit_stages,
    can_edit_money: profile.can_edit_money,
    can_view_money: profile.can_view_money,
  });
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const { user, profile } = await getSessionAndProfile();
  if (!user || !profile?.approved) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    title?: string;
    quantity?: number;
    addon_id?: string;
    unit_price?: number | null;
  };
  const admin = createAdminClient();

  async function logEvent(eventType: string, payload: Record<string, unknown>) {
    await admin.from("events").insert({
      entity_type: "production",
      entity_id: params.id,
      event_type: eventType,
      actor_id: user!.id,
      payload,
    });
  }

  switch (body.action) {
    case "add": {
      if (!profile.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });
      const title = (body.title ?? "").trim();
      const quantity = Number(body.quantity ?? 1);
      if (!title) return NextResponse.json({ error: "יש להזין תיאור לתוספת" }, { status: 400 });
      if (!Number.isInteger(quantity) || quantity < 1) return NextResponse.json({ error: "כמות לא תקינה" }, { status: 400 });
      // a money editor may seed the price in the same action; a stages-only
      // editor never sends one (and couldn't, the field isn't shown to them)
      const unitPrice = profile.can_edit_money && body.unit_price != null ? Number(body.unit_price) : null;
      if (unitPrice != null && (!Number.isFinite(unitPrice) || unitPrice < 0)) {
        return NextResponse.json({ error: "מחיר לא תקין" }, { status: 400 });
      }
      const { data, error } = await admin
        .from("production_addons")
        .insert({ production_id: params.id, title, quantity, unit_price: unitPrice, created_by: user.id })
        .select("id")
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      await logEvent("addon_added", { addon_id: data.id, title, quantity, priced: unitPrice != null });
      return NextResponse.json({ ok: true, id: data.id });
    }

    case "price": {
      if (!profile.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });
      if (!body.addon_id) return NextResponse.json({ error: "חסר מזהה תוספת" }, { status: 400 });
      const unitPrice = body.unit_price == null ? null : Number(body.unit_price);
      if (unitPrice != null && (!Number.isFinite(unitPrice) || unitPrice < 0)) {
        return NextResponse.json({ error: "מחיר לא תקין" }, { status: 400 });
      }
      const { data, error } = await admin
        .from("production_addons")
        .update({ unit_price: unitPrice })
        .eq("id", body.addon_id)
        .eq("production_id", params.id)
        .select("id")
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      if (!data) return NextResponse.json({ error: "התוספת לא נמצאה" }, { status: 404 });
      await logEvent("addon_priced", { addon_id: body.addon_id, unit_price: unitPrice });
      return NextResponse.json({ ok: true });
    }

    case "delete": {
      if (!profile.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });
      if (!body.addon_id) return NextResponse.json({ error: "חסר מזהה תוספת" }, { status: 400 });
      // only a not-yet-decided line can be removed; an approved/rejected line
      // is part of the client's answer and stays for the record
      const { data, error } = await admin
        .from("production_addons")
        .delete()
        .eq("id", body.addon_id)
        .eq("production_id", params.id)
        .eq("status", "proposed")
        .select("id")
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      if (!data) return NextResponse.json({ error: "לא ניתן למחוק — התוספת כבר טופלה" }, { status: 400 });
      await logEvent("addon_deleted", { addon_id: body.addon_id });
      return NextResponse.json({ ok: true });
    }

    case "approve":
    case "reject": {
      if (!profile.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });
      if (!body.addon_id) return NextResponse.json({ error: "חסר מזהה תוספת" }, { status: 400 });
      const status = body.action === "approve" ? "approved" : "rejected";
      // approving requires a price — an unpriced line can't reach an invoice
      if (status === "approved") {
        const { data: row } = await admin
          .from("production_addons")
          .select("unit_price")
          .eq("id", body.addon_id)
          .eq("production_id", params.id)
          .maybeSingle();
        if (!row) return NextResponse.json({ error: "התוספת לא נמצאה" }, { status: 404 });
        if (row.unit_price == null) return NextResponse.json({ error: "אי אפשר לאשר תוספת בלי מחיר" }, { status: 400 });
      }
      const { data, error } = await admin
        .from("production_addons")
        .update({ status, approved_via: "manual" })
        .eq("id", body.addon_id)
        .eq("production_id", params.id)
        .select("id")
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      if (!data) return NextResponse.json({ error: "התוספת לא נמצאה" }, { status: 404 });
      await logEvent(status === "approved" ? "addon_approved" : "addon_rejected", { addon_id: body.addon_id, via: "manual" });
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: "פעולה לא מוכרת" }, { status: 400 });
  }
}
