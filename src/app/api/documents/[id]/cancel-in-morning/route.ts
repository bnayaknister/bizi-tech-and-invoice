import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { closeDocument } from "@/lib/morning/client";
import { MorningError } from "@/lib/morning/client";
import {
  MSG_DRY_RUN,
  MSG_SUCCESS,
  MSG_TIMEOUT,
  alreadyClosedIsSuccess,
  cancelDocumentLocally,
  hasLiveTaxChild,
  jobBlocksCancel,
  MORNING_CANCELLABLE_TYPES,
  TAX_CHILD_REFUSAL,
  msgFailed,
  type TaxChildRow,
} from "@/lib/documents/cancelLocal";

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/documents/[id]/cancel-in-morning — close the document AT MORNING,
// then mark it cancelled here.
// ═══════════════════════════════════════════════════════════════════════════
//
// E11, unblocked 2026-10-06. Until today the app only MIRRORED a cancellation
// Shiri performed by hand in Morning (`../cancel/route.ts` still does exactly
// that, and still should). The blocker was that Morning's API has no cancel
// endpoint — and the owner resolved it by measuring what Morning's own UI does:
//
//   🔵 deal invoice 40339 (EY), cancelled THROUGH MORNING'S INTERFACE, came back
//      at status 2 — "נסגר ידנית" — with no credit note.
//
// So for a non-tax document, Morning's cancel button IS a manual close, and
// `POST /documents/{id}/close` is the same operation rather than an
// approximation of it. That is the whole basis of this route, and it is why it
// is bounded to types 100 and 300.
//
// ⚠️ NOT THROUGH THE APPROVAL QUEUE, by owner decision and for a structural
// reason the 5.10 investigation found: a `pending_documents` row models a
// document that WILL BE CREATED and carries `payload`/`amount` that a
// cancellation has none of, and `pending_documents_one_live_per_job` (0079)
// would collide with the row of the very document being cancelled. The queue is
// the wrong shape; this is a direct action.
//
// ═══ THE ORDER, AND WHY EVERY STEP IS WHERE IT IS ═══
//   1. gates        — source, type, not-already-cancelled, no live tax child.
//                     All before any event, so a refused attempt leaves no trace
//                     that reads like an attempt that failed at Morning.
//   2. requested    — evented BEFORE the call. If the process dies mid-call this
//                     is the only record that we tried, and it is what tells the
//                     owner where to look in Morning.
//   3. closeDocument
//   4a. success     — the local effect, through the SHARED function, then
//                     `succeeded`.
//   4b. failure     — ZERO local change, then `failed`.
//   4c. timeout     — ZERO local change, then `unknown`. A 504 is not a failure;
//                     we cannot tell whether Morning closed it.
//
// 🔴 THE LOCAL WRITE NEVER RUNS BEFORE THE REMOTE ONE. Reversed, a Morning
// failure would leave a document cancelled here and live there — the exact
// contradiction between the two systems that E11 said is "worse than today's
// honest manual step".

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// ⚠️ THE MESSAGES LIVE IN lib/documents/cancelLocal.ts AND NOT HERE. A Next.js
// route module may only export the handler and a short list of config fields —
// `next build` refuses anything else with "MSG_SUCCESS is not a valid Route
// export field", and `tsc` does NOT catch it. They belong beside the rest of the
// approved copy anyway, where the test reads them without importing a route.

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) {
    return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason) return NextResponse.json({ error: "חובה לציין סיבה לביטול" }, { status: 400 });

  const admin = createAdminClient();
  const { data: doc } = await admin
    .from("documents")
    .select("id,morning_doc_id,morning_doc_number,type,amount,job_id,cancelled_at,source,status")
    .eq("id", params.id)
    .maybeSingle();
  if (!doc) return NextResponse.json({ error: "המסמך לא נמצא" }, { status: 404, headers: NO_STORE });

  // ── gate: ours to close ──────────────────────────────────────────────────
  //
  // 🔴 `source='app'` AND NOTHING ELSE. 560 of the 300/305/320 rows in the
  // account are `source='pull'` (0087:8) — issued by somebody else, in an
  // account we did not act in, and quite possibly already closed there. Closing
  // one of those is reaching into a document we never created.
  if (doc.source !== "app") {
    return NextResponse.json(
      { error: "אפשר לבטל במורנינג רק מסמכים שהונפקו מהמערכת." },
      { status: 400, headers: NO_STORE }
    );
  }
  if (!MORNING_CANCELLABLE_TYPES.includes(doc.type as (typeof MORNING_CANCELLABLE_TYPES)[number])) {
    // tax documents are cancelled by a credit note (330) and nothing else
    return NextResponse.json(
      { error: "אפשר לבטל במורנינג רק הזמנת עבודה או חשבון עסקה." },
      { status: 400, headers: NO_STORE }
    );
  }
  if (doc.cancelled_at) {
    return NextResponse.json({ error: "המסמך כבר מבוטל" }, { status: 409, headers: NO_STORE });
  }
  if (!doc.morning_doc_id) {
    // nothing to close: the row has no Morning identity to act on
    return NextResponse.json(
      { error: "למסמך אין מזהה במורנינג, ולכן אי אפשר לסגור אותו שם." },
      { status: 400, headers: NO_STORE }
    );
  }

  // ── gate: no LIVE tax document standing on it (G3) ──────────────────────
  //
  // Two independent sources, and either one refuses — see `hasLiveTaxChild` and
  // `jobBlocksCancel` for why both are asked.
  //
  // ⚠️ NO INDEX EXISTS FOR THIS QUESTION, and that is a declared cost rather
  // than an oversight: 0075 added `parent_doc_numbers` with no index on purpose
  // ("the only consumer planned reads it off a row it already has") and named
  // the reverse question — "which documents were raised against me" — as the
  // day a GIN index becomes a one-line migration. This route asks exactly that
  // reverse question. This stage has NO MIGRATION, so it runs as a filtered scan
  // over `documents`, which holds ~1,100 rows. Correct, and cheap at this size;
  // the index is the follow-up ticket the moment the table grows.
  const docNumber = (doc.morning_doc_number as string | null) ?? null;
  if (doc.type === 300) {
    const { data: children } = await admin
      .from("documents")
      .select("type,cancelled_at,parent_doc_numbers,parent_relation")
      .in("type", [305, 320]);
    if (hasLiveTaxChild(docNumber, (children ?? []) as unknown as TaxChildRow[])) {
      return NextResponse.json({ error: TAX_CHILD_REFUSAL }, { status: 409, headers: NO_STORE });
    }
    if (doc.job_id) {
      const { data: job } = await admin
        .from("jobs")
        .select("id,invoice_tax")
        .eq("id", doc.job_id as string)
        .maybeSingle();
      if (jobBlocksCancel(job)) {
        return NextResponse.json({ error: TAX_CHILD_REFUSAL }, { status: 409, headers: NO_STORE });
      }
    }
  }

  const morningDocId = doc.morning_doc_id as string;
  const eventBase = {
    entity_type: "document" as const,
    entity_id: params.id,
    actor_id: user.id,
  };

  // ── 2. the attempt is recorded BEFORE the call ──────────────────────────
  await admin.from("events").insert({
    ...eventBase,
    event_type: "morning_cancel_requested",
    payload: {
      morning_doc_id: morningDocId,
      morning_doc_number: docNumber,
      doc_type: doc.type,
      amount: doc.amount,
      reason,
    },
  });

  // ── 3. the call ─────────────────────────────────────────────────────────
  let dryRun = false;
  try {
    const res = await closeDocument(morningDocId);
    dryRun = res.dryRun;
  } catch (e) {
    const status = e instanceof MorningError ? e.status : 0;
    const message = e instanceof Error ? e.message : "שגיאה לא ידועה";

    // ── 4c. timeout — UNKNOWN, not failure ───────────────────────────────
    // 504 is what fetchWithTimeout maps a 15s deadline to. We cannot tell
    // whether Morning closed the document and lost the reply, so nothing local
    // moves and the owner is told to go and look before retrying.
    if (status === 504) {
      await admin.from("events").insert({
        ...eventBase,
        event_type: "morning_cancel_unknown",
        payload: { morning_doc_id: morningDocId, morning_doc_number: docNumber, reason, error: message },
      });
      return NextResponse.json({ error: MSG_TIMEOUT, unknown: true }, { status: 504, headers: NO_STORE });
    }

    // ── "already closed at Morning" ──────────────────────────────────────
    // Morning documents no behaviour for closing a closed document, so this is
    // decided on OUR state and only in the conservative direction: it counts as
    // success exactly when our own row already says 1/2. See
    // `alreadyClosedIsSuccess`. A status of 0 — or null, which a document
    // issued since the last pull carries — falls through to `failed`, because a
    // guess either way is worse than reporting it.
    if (!alreadyClosedIsSuccess(doc.status as number | null)) {
      await admin.from("events").insert({
        ...eventBase,
        event_type: "morning_cancel_failed",
        payload: {
          morning_doc_id: morningDocId,
          morning_doc_number: docNumber,
          reason,
          error: message,
          status,
          our_status: doc.status ?? null,
        },
      });
      return NextResponse.json({ error: msgFailed(message) }, { status: 502, headers: NO_STORE });
    }
    // our row already says closed → treat as agreement and fall through to the
    // local effect, recording WHY it was accepted
    await admin.from("events").insert({
      ...eventBase,
      event_type: "morning_cancel_already_closed",
      payload: {
        morning_doc_id: morningDocId,
        morning_doc_number: docNumber,
        reason,
        error: message,
        status,
        our_status: doc.status ?? null,
      },
    });
  }

  // ── 4a. the local effect, through the SHARED function ───────────────────
  const now = new Date().toISOString();
  const reverted = await cancelDocumentLocally(
    admin,
    {
      id: doc.id as string,
      morning_doc_id: morningDocId,
      morning_doc_number: docNumber,
      type: doc.type as number,
      job_id: (doc.job_id as string | null) ?? null,
    },
    { userId: user.id, reason, cancelledAt: now }
  );

  await admin.from("events").insert({
    ...eventBase,
    event_type: "morning_cancel_succeeded",
    payload: {
      morning_doc_id: morningDocId,
      morning_doc_number: docNumber,
      doc_type: doc.type,
      amount: doc.amount,
      reason,
      dry_run: dryRun,
      reverted: {
        invoice_biz_cleared: reverted.invoiceBizCleared,
        invoice_row_deleted: reverted.invoiceRowDeleted,
        queue_row_released: reverted.queueRowReleased,
      },
    },
  });

  // the same `document_cancelled` events the mirror route writes, so every
  // consumer of the document's and the job's history sees one vocabulary
  // regardless of which route did the cancelling
  await admin.from("events").insert({
    ...eventBase,
    event_type: "document_cancelled",
    payload: {
      morning_doc_number: docNumber,
      doc_type: doc.type,
      amount: doc.amount,
      reason,
      job_id: doc.job_id ?? null,
      via: "morning",
      reverted: {
        invoice_biz_cleared: reverted.invoiceBizCleared,
        invoice_row_deleted: reverted.invoiceRowDeleted,
        queue_row_released: reverted.queueRowReleased,
      },
    },
  });
  if (doc.job_id && (reverted.invoiceBizCleared || reverted.invoiceRowDeleted)) {
    await admin.from("events").insert({
      entity_type: "job",
      entity_id: doc.job_id as string,
      event_type: "document_cancelled",
      actor_id: user.id,
      payload: {
        morning_doc_number: docNumber,
        doc_type: doc.type,
        reason,
        reverted_to: "not_billed",
        via: "morning",
      },
    });
  }

  return NextResponse.json(
    { ok: true, dryRun, message: dryRun ? MSG_DRY_RUN : MSG_SUCCESS, reverted },
    { headers: NO_STORE }
  );
}
