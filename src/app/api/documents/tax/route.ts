import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createTaxFromParents } from "@/lib/documents/taxFromParent";
import {
  mintOverrideTicket,
  verifyOverrideTicket,
  OVERRIDE_TICKET_TTL_MS,
} from "@/lib/documents/overrideTicket";

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
// The row is created as tax_invoice (305) — DEFAULT_TAX_VARIANT, and this route
// never overrides it. 305 because it is the one that is safe to be wrong about:
// a 320 declares to the tax authority that the money arrived, and cannot be
// taken back (the reasoning lives in full on DEFAULT_TAX_VARIANT). An earlier
// version of this comment claimed 320 and was simply wrong about its own route.
//
// The 305/320 choice belongs to the approval modal, which sees the money. The
// review route rewrites the type, the remark, AND the printed label at the head
// of `description` — all three name the document, and a page where they
// disagree cannot be corrected once it is in Morning.
//
// TWO source kinds since stage 3 (owner approved 2026-08-11), one per request:
//   sourceIds   — pending_documents.id, the original path, N allowed (bundles)
//   documentIds — documents.id of a PULLED parent, mapped from its raw by
//                 pullSource.ts. EXACTLY ONE: v1 is one document per source,
//                 and aggregating pulled parents is a business decision the
//                 owner deferred, not a technical gap. The builder underneath
//                 keeps its N-source capability — this route is the v1 valve,
//                 and widening it later means deleting one check here.
// Mixing the two kinds in one request is refused for the same reason. An
// app-issued document sent as a documentId is refused by the builder's source
// gate toward its queue row — deliberately a refusal, not a silent redirect:
// the server must never act on a row the operator did not pick.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    sourceIds?: string[];
    documentIds?: string[];
    // admin override of PULL_NET_CEILING — see the block below
    overCeiling?: boolean;
    overCeilingTicket?: string;
    overCeilingReason?: string;
  };
  const sourceIds = Array.isArray(body.sourceIds) ? body.sourceIds.filter(Boolean) : [];
  const documentIds = Array.isArray(body.documentIds) ? body.documentIds.filter(Boolean) : [];
  const overCeilingTicket = typeof body.overCeilingTicket === "string" ? body.overCeilingTicket : null;
  const overCeilingReason = typeof body.overCeilingReason === "string" ? body.overCeilingReason.trim() : "";
  if (!sourceIds.length && !documentIds.length) {
    return NextResponse.json({ error: "חסרים מסמכי מקור" }, { status: 400 });
  }
  if (sourceIds.length && documentIds.length) {
    return NextResponse.json(
      { error: "לא ניתן לשלב מקור מתור האישורים ומסמך מהרישום באותה בקשה" },
      { status: 400 }
    );
  }
  if (documentIds.length > 1) {
    return NextResponse.json(
      { error: "מסמך נמשך אחד לבקשה — איגוד מסמכים מהרישום אינו נתמך בשלב זה" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // ---- admin override of the net ceiling (owner spec 2026-08-22) ----------
  // Two calls, always. The first is refused and mints a ticket committing to
  // the numbers it just warned about; the second must echo that ticket. The
  // permission wall is can_manage_users — NOT can_edit_money — following the
  // precedent set by /api/finance/dismiss for a destructive-looking money
  // action. The reason is mandatory and free text: an override with no stated
  // cause is indistinguishable from an accident six months later.
  //
  // Nothing here relaxes any other gate. `allowOverCeiling` reaches exactly the
  // one line in mapPullDocToSource, and both duplicate guards in the builder
  // (idempotency on linkedDocumentIds, and jobs.invoice_tax) run afterwards,
  // unconditionally — an override cannot produce a second tax document for a
  // parent that already has one.
  const wantsOverride = body.overCeiling === true;
  let mayOverride = false;
  if (wantsOverride) {
    const { data: adminProfile } = await supabase
      .from("profiles")
      .select("can_manage_users")
      .eq("id", user.id)
      .single();
    if (!adminProfile?.can_manage_users) {
      return NextResponse.json(
        { error: "עקיפת תקרת הסכום פתוחה למנהל בלבד" },
        { status: 403 }
      );
    }
    if (!documentIds.length) {
      return NextResponse.json(
        { error: "התקרה חלה על מסמך מהרישום בלבד — אין מה לעקוף כאן" },
        { status: 400 }
      );
    }
    if (!overCeilingReason) {
      return NextResponse.json({ error: "חובה לציין סיבה לעקיפת התקרה" }, { status: 400 });
    }
    mayOverride = true;
  }

  // Probe first, ALWAYS, override or not: the run below is what proves the
  // amount, and the ticket must be verified against the proven net rather than
  // anything the caller sent. A refusal that is not the ceiling is returned as
  // is — an override is not a way past those.
  const probe = await createTaxFromParents(admin, sourceIds, user.id, undefined, {
    ...(documentIds.length ? { documentIds } : {}),
  });
  if (!probe.ok && !(probe.overCeiling && mayOverride)) {
    return NextResponse.json(
      { error: probe.error, ...(probe.overCeiling ? { over_ceiling: probe.overCeiling } : {}) },
      { status: probe.status }
    );
  }
  // the probe SUCCEEDED — under the ceiling, nothing to override, and the row
  // is already built. Fall through to the normal response.
  let res = probe;

  if (!probe.ok && probe.overCeiling && mayOverride) {
    const facts = { documentId: documentIds[0], net: probe.overCeiling.net, actorId: user.id };

    // step 1: no ticket yet -> refuse, and hand back one bound to these facts
    if (!overCeilingTicket) {
      const ticket = mintOverrideTicket(facts);
      if (!ticket) {
        return NextResponse.json(
          { error: "לא ניתן להנפיק אישור עקיפה בסביבה זו — פנה למפתח" },
          { status: 500 }
        );
      }
      return NextResponse.json(
        {
          error: probe.error,
          over_ceiling: {
            ...probe.overCeiling,
            document_id: documentIds[0],
            ticket,
            ttl_ms: OVERRIDE_TICKET_TTL_MS,
          },
          needs_confirmation: true,
        },
        { status: 409 }
      );
    }

    // step 2: the ticket must match the facts as they are NOW, not as it claims
    const verdict = verifyOverrideTicket(overCeilingTicket, facts);
    if (!verdict.ok) {
      const why =
        verdict.reason === "expired"
          ? "פג תוקף אישור העקיפה — התחילי מחדש"
          : verdict.reason === "mismatch"
            ? "אישור העקיפה אינו תואם את המסמך או את הסכום — ייתכן שהמסמך השתנה. התחילי מחדש"
            : verdict.reason === "no-key"
              ? "לא ניתן לאמת אישור עקיפה בסביבה זו — פנה למפתח"
              : "אישור העקיפה אינו תקין";
      return NextResponse.json({ error: why }, { status: 409 });
    }

    // Audited BEFORE the build, so an override that is attempted and then fails
    // downstream (a duplicate guard, say) is still on the record.
    await admin.from("events").insert({
      entity_type: "document",
      entity_id: documentIds[0],
      event_type: "tax_ceiling_overridden",
      actor_id: user.id,
      payload: {
        document_id: documentIds[0],
        net: probe.overCeiling.net,
        gross: probe.overCeiling.gross,
        ceiling: probe.overCeiling.ceiling,
        reason: overCeilingReason,
        confirmed: true,
      },
    });

    res = await createTaxFromParents(admin, sourceIds, user.id, undefined, {
      documentIds,
      allowOverCeiling: true,
    });
  }

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
