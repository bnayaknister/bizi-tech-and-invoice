import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createTaxFromParents } from "@/lib/documents/taxFromParent";
import { DOC_TYPE_LABEL } from "@/lib/morning/types";

// Queue a TAX DOCUMENT for a contract milestone, built on a parent the app
// itself issued (stage 2).
//
// A tax document is not job-anchored the way a work order or a deal invoice is:
// it inherits its income lines from a PARENT and it names that parent on the
// printed page. So it cannot go through milestones/[mid]/enqueue, which builds
// from the milestone's own amount. What it needs is the parent's queue row id,
// and picking that id is the whole job of this route.
//
// ═══ WHY THE DEAL INVOICE WINS WHEN BOTH EXIST ═══
// `linkedDocumentIds` is not decoration — it is what CLOSES the parent in
// Morning (taxFromParent.ts). A milestone that has been through 100 -> 300 has
// two legal parents: ALLOWED_CHILDREN permits work_order -> tax directly, and
// the idempotency gate is scoped to tax doc_types, so a 300 born of the 100
// does NOT stop us asking for a tax document from that same 100. The server
// would accept either. Build on the 100 and the 100 closes while the 300 stays
// open forever — which is exactly the `order_not_closed` alert on the radar,
// raised against a document we issued on purpose.
//
// So the rule is ours to enforce, not Morning's: the newest billing parent
// wins. Verified against the one real chain in the data — Venus (job
// b3359a21) ran 100 #10306 -> 300 #40303 -> 305 #50068, and the 305's payload
// carries linkedDocumentIds = [the 300's morning id], remarks "חשבונית מס עבור
// חשבון עסקה 40303". Not the order.
//
// ═══ SCOPE: sourceIds ONLY ═══
// A milestone whose parent was raised by hand in Morning and reached us on the
// nightly pull has NO queue row — "מכירת ביפו — חלק ב" (40258) is the live
// example. That parent is reachable only as `documentIds`, which is the pull
// path, which is where PULL_NET_CEILING and the admin-override ticket live.
// Deliberately out of scope: this route refuses it with a message pointing at
// /documents/registry, where that flow already exists and works. Nothing here
// touches over_ceiling, and it cannot — a queue-row parent never carries one
// (registry/page.tsx gives a 'pending' row over_ceiling: null unconditionally).

// Only a parent that really exists in Morning may father a document. The server
// re-checks all of this in taxFromParent; mirrored here so the refusal names
// the milestone rather than an opaque queue row.
const ISSUED = "issued";

export async function POST(request: Request, { params }: { params: { mid: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const admin = createAdminClient();

  const { data: ms } = await admin
    .from("contract_milestones")
    .select("id,contract_id,name,amount,job_id,status")
    .eq("id", params.mid)
    .maybeSingle();
  if (!ms) return NextResponse.json({ error: "אבן הדרך לא נמצאה" }, { status: 404 });
  if (!ms.job_id) {
    return NextResponse.json(
      { error: `לאבן הדרך '${ms.name}' אין job — הנפיקי קודם הזמנת עבודה` },
      { status: 400 }
    );
  }

  // Both candidate parents in one read. Only 'issued' rows are considered: a
  // pending or approved parent has no Morning document to link to, and saying
  // so here is clearer than letting taxFromParent refuse it generically.
  const { data: parents } = await admin
    .from("pending_documents")
    .select("id,doc_type,status,morning_doc_id,morning_doc_number")
    .eq("job_id", ms.job_id as string)
    .in("doc_type", ["work_order", "deal_invoice"])
    .eq("status", ISSUED);

  // A dry-run issuance mints a synthetic "dry-" id. It is not a real Morning
  // document, so it cannot be a parent — taxFromParent refuses it too, and
  // filtering here keeps the choice below honest rather than picking a parent
  // that is about to be rejected.
  const real = (parents ?? []).filter((p) => {
    const mid2 = (p.morning_doc_id as string | null) ?? "";
    return mid2.trim() !== "" && !mid2.startsWith("dry-");
  });

  const dealInvoice = real.find((p) => p.doc_type === "deal_invoice") ?? null;
  const workOrder = real.find((p) => p.doc_type === "work_order") ?? null;
  const parent = dealInvoice ?? workOrder; // see the header: the 300 wins

  if (!parent) {
    // Name the reason rather than the absence. A milestone can land here three
    // ways and the remedy differs for each.
    const queued = (parents ?? []).length > 0;
    const dryOnly = (parents ?? []).length > 0 && real.length === 0;
    const why = dryOnly
      ? "מסמכי המקור הונפקו בהרצה יבשה — אין מסמך אמיתי במורנינג לקשר אליו"
      : queued
        ? "אין למסמכי המקור מזהה מורנינג"
        : "אין מסמך מקור מונפק לאבן הדרך. אם המסמך הונפק ידנית במורנינג — ההנפקה עוברת דרך מרשם המסמכים (/documents/registry) ולא מכאן";
    return NextResponse.json({ error: `לאבן הדרך '${ms.name}': ${why}` }, { status: 400 });
  }

  // Everything below is taxFromParent's: the parent-type policy, both duplicate
  // guards, the openness check, the one-client gate, and the job resolution
  // that stamps invoice_tax later. No over_ceiling is passed and none applies —
  // that gate lives in the pull mapper, which this path never reaches.
  const built = await createTaxFromParents(admin, [parent.id as string], user.id);
  if (!built.ok) {
    return NextResponse.json({ error: built.error }, { status: built.status });
  }

  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: built.id,
    event_type: "document_queued",
    actor_id: user.id,
    payload: {
      doc_type: built.docType,
      via: "contract_milestone_tax",
      milestone_id: ms.id,
      contract_id: ms.contract_id,
      job_id: ms.job_id,
      parent_pending_id: parent.id,
      parent_doc_type: parent.doc_type,
      parent_doc_number: parent.morning_doc_number,
      // records that the 300 was preferred over an available 100, so the choice
      // is auditable rather than inferred from the payload months later
      parent_choice: dealInvoice && workOrder ? "deal_invoice_over_work_order" : "only_candidate",
      amount: built.amount,
    },
  });

  return NextResponse.json({
    ok: true,
    id: built.id,
    doc_type: built.docType,
    label: DOC_TYPE_LABEL[built.docType],
    amount: built.amount,
    parent_doc_number: parent.morning_doc_number,
    parent_openness_unknown: built.parentOpennessUnknown,
    status: "queued",
  });
}
