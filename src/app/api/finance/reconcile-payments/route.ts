import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { linkPaymentPairs, type PaymentPairInput } from "@/lib/documents/reconcile";

// Link the payment matches a HUMAN approved, one explicitly named pair at a
// time (F14 stage B, owner decision 2026-09-21).
//
// ═══ WHAT THIS ROUTE USED TO BE, AND WHY THE BODY IS NOW MANDATORY ═══
// Until today this endpoint took NO body at all: an empty POST ran
// `reconcileCertainPayments`, which computed the match list itself and linked
// every row of it in a loop — marking jobs paid with no preview, no per-row
// decision and no undo. Two scripts reached it, and on 2026-09-19 a typed
// confirmation gate was added to both. That gate protected TWO FILES, not the
// path: any new caller born tomorrow would have been born ungated.
//
// So the gate moved here, into the shape of the request. A POST without pairs
// is now a 400. A caller that does not know which pairs it wants cannot link
// anything, and that is true for callers that do not exist yet.
//
// can_edit_money — both the owner and Shiri approve, so the permission is
// unchanged. Every link and every mark-paid is evented inside
// linkDocumentToJob, as before.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { pairs?: unknown };
  const raw = Array.isArray(body.pairs) ? body.pairs : null;

  // The refusal says what changed, because the two scripts and any half-updated
  // caller will hit it and "חסרים פרטים" would send somebody to read the code.
  const NO_PAIRS =
    "האנדפוינט הזה אינו מקשר עוד את כל ההתאמות. " +
    "יש לשלוח רשימת זוגות מפורשת — {pairs: [{docId, jobId, fingerprint}]} — " +
    "שכל אחד מהם אושר על ידי אדם. את ההצעות לאישור מקבלים מ-GET /api/finance/payment-matches.";
  if (!raw || raw.length === 0) return NextResponse.json({ error: NO_PAIRS }, { status: 400 });

  const pairs: PaymentPairInput[] = [];
  for (const p of raw) {
    const o = (p ?? {}) as Record<string, unknown>;
    // The fingerprint is as mandatory as the two ids. A pair sent without one
    // is a caller that never looked at the list, and letting it through with an
    // empty string would make the staleness check pass by accident on a row
    // nobody read.
    if (typeof o.docId !== "string" || typeof o.jobId !== "string" || typeof o.fingerprint !== "string" || !o.fingerprint) {
      return NextResponse.json(
        { error: "כל זוג חייב לכלול docId, jobId וטביעת אצבע מהרשימה שהוצגה — לא בוצע שום קישור" },
        { status: 400 }
      );
    }
    pairs.push({ docId: o.docId, jobId: o.jobId, fingerprint: o.fingerprint });
  }

  const admin = createAdminClient();
  const results = await linkPaymentPairs(admin, user.id, pairs);

  // ⚠️ ALWAYS 200 WITH PER-PAIR RESULTS, NEVER A BLANKET FAILURE.
  // linkDocumentToJob's writes are not transactional, so pair 3 refusing says
  // nothing about pairs 1 and 2 — they are linked, and their jobs are marked
  // paid. A 4xx over the whole batch would tell the bookkeeper the opposite of
  // what the books now say. The caller reads `results` row by row.
  return NextResponse.json({
    ok: true,
    linked: results.filter((r) => r.ok).length,
    refused: results.filter((r) => !r.ok).length,
    results,
  });
}
