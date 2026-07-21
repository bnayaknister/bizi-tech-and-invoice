import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DOC_TYPE_TO_MORNING_CODE,
  DOC_TYPE_LABEL,
  VAT_TYPE_DEFAULT,
  type MorningDocumentRequest,
  type PendingDocType,
} from "@/lib/morning/types";

// Enqueueing, not issuing. Nothing in this file talks to Morning — it
// decides whether a document is OWED, builds the exact payload that would
// be sent, and parks it for a human (owner spec 2026-07-19). The issuing
// half lives in the review route.
//
// The eligibility gate is deliberately strict and deliberately loud: when a
// production fails it, we do NOT create anything and we DO record why, on
// the production itself (billing_block_reason -> 🟡 on the radar). Silence
// was the old bug.

// `applicable` separates "this should bill but can't" (a fixable problem the
// radar must surface) from "no document is owed here at all" (internal,
// legacy, non-client — correct silence, never a flag). Only an applicable
// block writes billing_block_reason.
export type Eligibility =
  | { ok: true; clientId: string; morningClientId: string; amount: number | null }
  | { ok: false; applicable: boolean; reason: string };

export type ProductionForBilling = {
  id: string;
  kind: string | null;
  legacy: boolean | null;
  client_id: string | null;
  show_id: string | null;
  podcast_name: string | null;
  record_date: string | null;
  // a per-production price that wins over the show's default_rate when set
  // (owner spec 2026-07-21). Optional: callers minted before this column
  // existed (e.g. calendar sync at creation, when no override can exist yet)
  // simply omit it and fall through to the show rate.
  price_override?: number | null;
};

export type ShowForBilling = {
  id: string;
  client_id: string | null;
  billing_mode: string | null;
  default_rate: number | null;
};

export type ClientForBilling = {
  id: string;
  name: string | null;
  morning_client_id: string | null;
};

/**
 * The five cumulative conditions (owner spec 2026-07-19). All must hold:
 *   kind='client' AND show has client_id AND client has morning_client_id
 *   AND billing_mode <> 'none' AND legacy=false
 * Any miss returns a human-readable reason — that string is what the
 * bookkeeper reads on the radar, so it names the fix, not the rule.
 */
export function checkEligibility(
  production: ProductionForBilling,
  show: ShowForBilling | null,
  client: ClientForBilling | null
): Eligibility {
  // ---- not applicable: no document is owed, and that's correct ----
  if (production.legacy) return { ok: false, applicable: false, reason: "הפקה היסטורית (legacy)" };
  if (production.kind !== "client") {
    return { ok: false, applicable: false, reason: `הפקה מסוג '${production.kind ?? "לא ידוע"}' — לא מחויבת` };
  }
  if (show && show.billing_mode === "none") {
    return { ok: false, applicable: false, reason: "התוכנית מסומנת כפנימית (לא מחויבת)" };
  }
  // ---- applicable but blocked: a client production that SHOULD bill ----
  if (!show) return { ok: false, applicable: true, reason: "להפקה אין תוכנית משויכת" };
  if (!show.client_id) return { ok: false, applicable: true, reason: "לתוכנית אין לקוח משויך" };
  if (!client) return { ok: false, applicable: true, reason: "הלקוח של התוכנית לא נמצא" };
  if (!client.morning_client_id) {
    return { ok: false, applicable: true, reason: `הלקוח '${client.name ?? ""}' לא ממופה למורנינג` };
  }
  return {
    ok: true,
    clientId: client.id,
    morningClientId: client.morning_client_id,
    // effective price: the production's override wins over the show default
    amount: production.price_override ?? show.default_rate ?? null,
  };
}

/**
 * The exact body that will be POSTed to /documents. Built at enqueue time
 * and stored on the row, so the approver approves the real thing rather
 * than a summary of it.
 */
export type ExtraLine = { description: string; quantity: number; price: number };

export function buildDocumentPayload(args: {
  docType: PendingDocType;
  morningClientId: string;
  clientName: string | null;
  description: string;
  amount: number;
  date?: string | null;
  // approved add-ons become one income row each, after the base line
  // (owner spec 2026-07-21) — the deal invoice bills base + upsells
  extraLines?: ExtraLine[];
}): MorningDocumentRequest {
  return {
    type: DOC_TYPE_TO_MORNING_CODE[args.docType],
    lang: "he",
    currency: "ILS",
    vatType: VAT_TYPE_DEFAULT,
    date: args.date ?? undefined,
    description: args.description,
    client: {
      id: args.morningClientId,
      name: args.clientName ?? undefined,
      // never auto-create a client in Morning from a document
      add: false,
    },
    income: [
      {
        description: args.description,
        quantity: 1,
        price: args.amount,
        currency: "ILS",
        vatType: VAT_TYPE_DEFAULT,
      },
      ...(args.extraLines ?? []).map((l) => ({
        description: l.description,
        quantity: l.quantity,
        price: l.price,
        currency: "ILS",
        vatType: VAT_TYPE_DEFAULT,
      })),
    ],
  };
}

async function setBlockReason(admin: SupabaseClient, productionId: string, reason: string | null) {
  await admin.from("productions").update({ billing_block_reason: reason }).eq("id", productionId);
}

export type EnqueueResult =
  | { status: "queued"; id: string }
  | { status: "exists" }
  | { status: "blocked"; reason: string }
  | { status: "error"; error: string };

/**
 * Queue one document for one production.
 *
 * A split production is several productions sharing a calendar_uid, and
 * each is billed separately (owner rule 2026-07-19) — this function is
 * called per production, so splits get one document each for free.
 *
 * Re-running is safe: the partial unique index in 0025 allows only one
 * live (pending/approved/issued) row per (doc_type, production), so a
 * repeated 06:00 sync or a retried approval cannot double-queue.
 */
export async function enqueueDocument(
  admin: SupabaseClient,
  docType: PendingDocType,
  production: ProductionForBilling,
  opts: { jobId?: string | null; amountOverride?: number | null } = {}
): Promise<EnqueueResult> {
  const { data: show } = await admin
    .from("shows")
    .select("id,client_id,billing_mode,default_rate")
    .eq("id", production.show_id ?? "")
    .maybeSingle();

  const clientId = (show as ShowForBilling | null)?.client_id ?? production.client_id;
  const { data: client } = clientId
    ? await admin.from("clients").select("id,name,morning_client_id").eq("id", clientId).maybeSingle()
    : { data: null };

  const elig = checkEligibility(production, show as ShowForBilling | null, client as ClientForBilling | null);
  if (!elig.ok) {
    if (elig.applicable) {
      // a client production that should bill but can't — flag it (🟡 radar)
      await setBlockReason(admin, production.id, elig.reason);
      await admin.from("events").insert({
        entity_type: "production",
        entity_id: production.id,
        event_type: "document_enqueue_blocked",
        payload: { doc_type: docType, reason: elig.reason },
      });
    } else {
      // no document is owed here at all — make sure no stale flag lingers
      await setBlockReason(admin, production.id, null);
    }
    return { status: "blocked", reason: elig.reason };
  }

  const baseAmount = opts.amountOverride ?? elig.amount;
  if (baseAmount === null || baseAmount === undefined) {
    const reason = "לתוכנית אין מחיר ברירת מחדל — אי אפשר לבנות מסמך";
    await setBlockReason(admin, production.id, reason);
    return { status: "blocked", reason };
  }

  // A deal invoice bills base package + every approved, priced add-on
  // (owner spec 2026-07-21) — one income row per line. Add-ons never touch a
  // work order (that's the base session only), so this is deal_invoice-only.
  let extraLines: ExtraLine[] = [];
  if (docType === "deal_invoice") {
    const { data: addons } = await admin
      .from("production_addons")
      .select("title,quantity,unit_price,total")
      .eq("production_id", production.id)
      .eq("status", "approved");
    extraLines = (addons ?? [])
      .filter((a) => a.unit_price != null && a.total != null)
      .map((a) => ({ description: a.title as string, quantity: a.quantity as number, price: a.unit_price as number }));
  }
  const addonsTotal = extraLines.reduce((sum, l) => sum + l.price * l.quantity, 0);
  const amount = baseAmount + addonsTotal;

  const description = `${DOC_TYPE_LABEL[docType]} — ${production.podcast_name ?? ""} ${production.record_date ?? ""}`.trim();
  const payload = buildDocumentPayload({
    docType,
    morningClientId: elig.morningClientId,
    clientName: (client as ClientForBilling | null)?.name ?? null,
    description,
    amount: baseAmount, // the base line; add-ons are appended as their own rows
    date: production.record_date,
    extraLines,
  });

  const { data: inserted, error } = await admin
    .from("pending_documents")
    .insert({
      doc_type: docType,
      production_id: production.id,
      job_id: opts.jobId ?? null,
      client_id: elig.clientId,
      amount, // grand total: base + approved add-ons
      payload,
      status: "pending",
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = the one-live-row-per-production index. Not an error: it means
    // this document is already queued or already issued.
    if (error.code === "23505") return { status: "exists" };
    return { status: "error", error: error.message };
  }

  await setBlockReason(admin, production.id, null);
  await admin.from("events").insert({
    entity_type: "production",
    entity_id: production.id,
    event_type: "document_queued",
    payload: { doc_type: docType, pending_document_id: inserted.id, amount },
  });
  return { status: "queued", id: inserted.id };
}
