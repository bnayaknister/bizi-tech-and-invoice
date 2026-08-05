import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createTaxFromParents } from "@/lib/documents/taxFromParent";

// "צור חשבונית מס על סמך המסמך" (owner spec 2026-08-06) — the third rung of the
// chain: 100 -> 300 -> 305/320. The parent must already be issued in Morning;
// the child inherits its income lines verbatim and links back to it, which is
// also what closes it there.
//
// Nothing reaches Morning here: the document enters the normal approval queue as
// 'pending' and goes out through review -> issue, with the same human gate, the
// same double confirmation for tax documents, and the same DRY_RUN brake.
//
// A separate route on purpose. /api/documents/enqueue keeps its ALLOWED list of
// work_order|deal_invoice — that is a deliberate owner decision ("tax documents
// keep their own guarded path"), not a limitation to route around.
//
// The row is created as tax_receipt (320). The 305/320 choice belongs to the
// approval modal, which sees the money; the review route rewrites both the type
// AND the remark when it is flipped.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { sourceIds?: string[] };
  const sourceIds = Array.isArray(body.sourceIds) ? body.sourceIds.filter(Boolean) : [];
  if (!sourceIds.length) return NextResponse.json({ error: "חסרים מסמכי מקור" }, { status: 400 });

  const admin = createAdminClient();
  const res = await createTaxFromParents(admin, sourceIds, user.id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });

  // hand the built payload back so the screen can show the real thing — the
  // links, the printed remark, every income line — rather than a summary of it
  const { data: row } = await admin.from("pending_documents").select("payload").eq("id", res.id).maybeSingle();

  return NextResponse.json({
    ok: true,
    tax_document: {
      id: res.id,
      doc_type: res.docType,
      amount: res.amount,
      lines: res.lines,
      source_numbers: res.sourceNumbers,
      parent_openness_unknown: res.parentOpennessUnknown,
      payload: row?.payload ?? null,
    },
  });
}
