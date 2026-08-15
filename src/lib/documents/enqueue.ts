import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DOC_TYPE_TO_MORNING_CODE,
  DOC_TYPE_LABEL,
  VAT_TYPE_DEFAULT,
  type MorningDocumentRequest,
  type PendingDocType,
} from "@/lib/morning/types";
import { todayInIsrael } from "@/lib/dates";
import { SupabaseReadError } from "@/lib/supabase/unwrap";

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

// The active contract of a contract-billed show (0056). Fetched by
// enqueueDocument and passed in, so checkEligibility stays a pure function of
// its arguments — it is the one piece of billing logic that is testable
// without a database, and that is worth keeping.
export type ContractForBilling = {
  id: string;
  name: string | null;
  milestoneCount: number;
};

// A client's billing_cadence is the DEFAULT rhythm (owner spec 2026-07-28):
// per_episode issues normally; monthly / every_n freeze the chain — the work
// order is queued 'accrued' (owed, not issued) and the deal invoice is not
// enqueued at all until the bookkeeper redeems the client. It is only a
// default — the bookkeeper always overrides per row in the queue.
export type BillingCadence = "per_episode" | "monthly" | "every_n";

// Read a client's cadence. The app-layer deal-invoice brake (the two approval
// call sites) uses this to decide whether to enqueue now or wait for redemption
// — the DB trigger on_production_approved stays untouched (it only makes the
// internal job). A missing client / missing column reads as per_episode, so an
// unapplied 0046 keeps today's behavior.
export async function getClientCadence(
  admin: SupabaseClient,
  clientId: string | null
): Promise<BillingCadence> {
  if (!clientId) return "per_episode";
  const { data, error } = await admin.from("clients").select("billing_cadence").eq("id", clientId).maybeSingle();
  // Throw, not per_episode: a failed read that defaults to per_episode issues
  // immediately to a monthly client instead of accruing.
  if (error) throw new SupabaseReadError("קריאת מקצב החיוב של הלקוח", error.message, error.code ?? null);
  const c = (data as { billing_cadence?: string } | null)?.billing_cadence;
  return c === "monthly" || c === "every_n" ? c : "per_episode";
}

/**
 * The cumulative conditions (owner spec 2026-07-19). All must hold:
 *   kind='client' AND show has client_id AND client has morning_client_id
 *   AND billing_mode='per_episode' AND legacy=false
 * Any miss returns a human-readable reason — that string is what the
 * bookkeeper reads on the radar, so it names the fix, not the rule.
 */
export function checkEligibility(
  production: ProductionForBilling,
  show: ShowForBilling | null,
  client: ClientForBilling | null,
  contract: ContractForBilling | null = null
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
  // A contract show bills from its milestones, never per episode. Until 0056
  // every such production returned applicable:true — a 🟡 on the radar — which
  // made 'contract' unusable in practice and is why the Ofer Golan show was
  // silenced with billing_mode='none' + kind='internal' instead: three manual
  // workarounds standing in for one declaration.
  //
  // The split below keeps the 0024 rule intact — silence must be documented,
  // never merely quiet. A contract show is correct silence ONLY when there is
  // a contract that can actually pay: linked, and carrying at least one
  // milestone. The issue route builds its job from a milestone, so a contract
  // with none cannot produce a single shekel — that is exactly the Ofer Golan
  // failure, and it stays loud instead of turning into a second silent hole.
  if (show.billing_mode === "contract") {
    if (!contract) {
      return {
        ok: false,
        applicable: true,
        reason: "התוכנית מסומנת כמחויבת בחוזה, אך לא מקושר אליה חוזה פעיל",
      };
    }
    if (contract.milestoneCount === 0) {
      return {
        ok: false,
        applicable: true,
        reason: `לחוזה '${contract.name ?? ""}' אין אבני דרך — אי אפשר להנפיק ממנו`,
      };
    }
    return { ok: false, applicable: false, reason: "התוכנית מחויבת לפי חוזה — החיוב מגיע מאבן דרך" };
  }
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
  // approved add-ons become one income row each, after the base line
  // (owner spec 2026-07-21) — the deal invoice bills base + upsells
  extraLines?: ExtraLine[];
}): MorningDocumentRequest {
  return {
    type: DOC_TYPE_TO_MORNING_CODE[args.docType],
    lang: "he",
    currency: "ILS",
    vatType: VAT_TYPE_DEFAULT,
    // the ISSUANCE date, not the recording/job date — the work date is in the
    // description. issue.ts re-stamps today at the moment it calls Morning, so
    // a delayed approval is still correct; this keeps the queue preview honest
    // for the common same-day case. Owner bug 2026-07-29 (see @/lib/dates).
    date: todayInIsrael(),
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
  | { status: "accrued"; id: string }
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
  opts: { jobId?: string | null; amountOverride?: number | null; forcePending?: boolean } = {}
): Promise<EnqueueResult> {
  const { data: show, error: showErr } = await admin
    .from("shows")
    .select("id,client_id,billing_mode,default_rate")
    .eq("id", production.show_id ?? "")
    .maybeSingle();
  if (showErr) return { status: "error", error: `קריאת התוכנית נכשלה: ${showErr.message}` };

  const clientId = (show as ShowForBilling | null)?.client_id ?? production.client_id;
  const { data: client, error: clientErr } = clientId
    ? await admin
        .from("clients")
        .select("id,name,morning_client_id,billing_cadence")
        .eq("id", clientId)
        .maybeSingle()
    : { data: null, error: null };
  if (clientErr) return { status: "error", error: `קריאת הלקוח נכשלה: ${clientErr.message}` };

  // The contract is only ever needed for a contract-billed show, so this costs
  // one extra round trip on exactly the shows that need it and none otherwise.
  // The embedded count is one query, not two (verified against PostgREST).
  let contract: ContractForBilling | null = null;
  if ((show as ShowForBilling | null)?.billing_mode === "contract" && production.show_id) {
    const { data: c, error: cErr } = await admin
      .from("contracts")
      .select("id,name,contract_milestones(count)")
      .eq("show_id", production.show_id)
      .eq("status", "active")
      .maybeSingle();
    // Do not swallow. A failed lookup here would silently read as "no contract
    // linked" and fire a 🟡 that blames the configuration for a query fault.
    if (cErr) return { status: "error", error: `קריאת החוזה של התוכנית נכשלה: ${cErr.message}` };
    if (c) {
      const embedded = (c as { contract_milestones?: { count: number }[] }).contract_milestones;
      contract = { id: c.id as string, name: (c.name as string) ?? null, milestoneCount: embedded?.[0]?.count ?? 0 };
    }
  }

  const elig = checkEligibility(
    production,
    show as ShowForBilling | null,
    client as ClientForBilling | null,
    contract
  );
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
    const { data: addons, error: addonsErr } = await admin
      .from("production_addons")
      .select("title,quantity,unit_price,total")
      .eq("production_id", production.id)
      .eq("status", "approved");
    // Do not swallow: a failed read here would build the invoice without the
    // add-on lines — undercharging, silently.
    if (addonsErr) return { status: "error", error: `קריאת התוספות נכשלה: ${addonsErr.message}` };
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
    extraLines,
  });

  // Cadence brake (owner spec 2026-07-28): a work order for a monthly / every_n
  // client is queued 'accrued' — owed but frozen — until the bookkeeper
  // redeems the client. per_episode issues normally. A caller can force the
  // normal path (forcePending) for a manual "issue now". Add-on-only deal
  // invoices are never accrued here; their brake lives at the two approval
  // call sites (the DB trigger is never touched). An accrued row is ELIGIBLE
  // (it passed the gate) — so we clear any stale block reason, never set one.
  const cadence = ((client as { billing_cadence?: string } | null)?.billing_cadence ?? "per_episode") as BillingCadence;
  const accrue = docType === "work_order" && cadence !== "per_episode" && !opts.forcePending;
  const status = accrue ? "accrued" : "pending";

  const { data: inserted, error } = await admin
    .from("pending_documents")
    .insert({
      doc_type: docType,
      production_id: production.id,
      job_id: opts.jobId ?? null,
      client_id: elig.clientId,
      amount, // grand total: base + approved add-ons
      payload,
      status,
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
    event_type: accrue ? "document_accrued" : "document_queued",
    payload: { doc_type: docType, pending_document_id: inserted.id, amount, cadence },
  });
  return accrue ? { status: "accrued", id: inserted.id } : { status: "queued", id: inserted.id };
}
