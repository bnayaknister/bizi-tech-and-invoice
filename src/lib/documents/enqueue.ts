import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DOC_TYPE_TO_MORNING_CODE,
  DOC_TYPE_LABEL,
  VAT_TYPE_DEFAULT,
  type MorningDocumentRequest,
  type PendingDocType,
} from "@/lib/morning/types";
import { shortDate, todayInIsrael } from "@/lib/dates";
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
  // The guest, when the session had one — it reaches the printed line via
  // buildLineItemText below (owner spec 2026-08-20). Optional: a caller that
  // omits it produces exactly the guestless line, which is the common case
  // today, so no call site is obliged to supply it.
  guest?: string | null;
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
 * What the client actually reads on the line: the show, the guest when there
 * was one, and the recording date (owner spec 2026-08-20).
 *
 *     דעה לא פופולרית · חיים ילדין · 31.07.28      with a guest
 *     אסתטיטוקס 11.08.26                            without
 *
 * TWO SEPARATORS, ON PURPOSE. With a guest the parts are joined by " · ";
 * without one the show and the date stay space-separated, the shape they have
 * always had. The owner chose this — a lone "·" between two fields reads as a
 * list with something missing from it.
 *
 * WHY "·" (U+00B7) AND NOT AN EM DASH. `DESCRIPTION_SEPARATOR` in
 * @/lib/morning/types is " — " (U+2014, bytes 20 e2 80 94 20) and
 * relabelDocDescription keys off it to swap a document's printed label. "·" is
 * 20 c2 b7 20 — no byte overlap, and not dash-shaped, so it cannot be misread
 * by a person either. (It is safe twice over: that normalizer only ever runs on
 * tax variants, and only inspects the head of the string. But the line below is
 * the one a human reads, and unambiguous beats merely-unreachable.)
 *
 * filter(Boolean) is what makes an absent field impossible to see: a missing
 * part is never added, so no separator is ever emitted for it. There is no
 * input that yields " · · ", a trailing "·", or the word "undefined".
 */
export function buildLineItemText(p: {
  podcast_name?: string | null;
  guest?: string | null;
  record_date?: string | null;
}): string {
  const show = (p.podcast_name ?? "").replace(/\s+/g, " ").trim();
  const guest = (p.guest ?? "").replace(/\s+/g, " ").trim();
  const date = shortDate(p.record_date) ?? "";
  return guest
    ? [show, guest, date].filter(Boolean).join(" · ")
    : [show, date].filter(Boolean).join(" ");
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


// Same one-liner issue.ts:45, bundle.ts:25 and reconcile.ts:80 each keep their
// own copy of. Local again rather than imported: bundle.ts already imports from
// this file, and reaching back for a three-token predicate would buy a cycle
// risk with no gain.
const present = (v: unknown) => v != null && String(v).trim() !== "";

/** What already proves this production's work has been billed. */
export type BilledEvidence = {
  rule: "a" | "b" | "c";
  jobId: string;
  evidence: string;
};

/**
 * Has this production's work ALREADY been billed?
 *
 * ═══ THE HOLE THIS CLOSES ═══
 * The only duplicate protection a deal invoice ever had is the partial unique
 * index `(doc_type, production_id) where production_id is not null` (0025 →
 * 0047 → 0063). Every document raised FROM a work order sidesteps it, because
 * those are written with production_id NULL:
 *     createDealInvoiceFromWorkOrder  bundle.ts:468
 *     taxFromParent                   taxFromParent.ts:631
 * So the sequence the owner asked for — issue the deal invoice early, straight
 * off the work order, then let the episode reach client approval — inserted a
 * SECOND 300 with no collision, no refusal and no event. checkEligibility never
 * looked: it reads legacy/kind/billing_mode/show/contract and nothing about
 * money that already moved.
 *
 * ═══ WHY THESE THREE SIGNALS ═══
 * All three are LOCAL and IMMEDIATE. "The order is closed in Morning" would be
 * the natural test and is the wrong one: closure reaches us only on the daily
 * pull, and the window between issuing and pulling is exactly when someone
 * advances the episode.
 *
 *   a  the job carries a document number — invoice_biz OR invoice_tax. Both,
 *      because the 305-direct path writes only invoice_tax: production
 *      25198c70 (נדל״ן, 23.8) sits in the table right now with tax=50069 and
 *      biz=null, and a check on invoice_biz alone would have missed it.
 *   b  a LIVE queue row of a billing type already covers the job
 *   c  the same, in the registry
 *
 * b and c read job_id ∪ bundle_job_ids, not bundle_job_ids alone. Of the eight
 * live billing queue rows today, five carry bundle_job_ids and THREE carry
 * production_id + job_id with no bundle at all (40293, 40305, 40306). Those
 * three happen to be covered by the index — but leaning on the index inside the
 * guard that exists to cover the index's holes is the assumption that produced
 * this bug in the first place.
 *
 * b is the rule that matters most and matches nothing today: invoice_biz is
 * stamped at ISSUE time, so between "converted" and "issued" rule a is silent
 * and only the queue row knows. That window is precisely the owner's scenario.
 *
 * ═══ dismissed ═══
 * Not special-cased, and deliberately. A dismissed job with no document
 * produces no evidence and blocks nothing — which is right: dismissed means
 * "decided not to bill", and a new episode must still bill. A dismissed job
 * that DOES carry an invoice still blocks, because the money is real whatever
 * the job's visibility. The rules describe evidence of billing; hiding a row
 * does not unbill it.
 */
export async function findBilledEvidence(
  admin: SupabaseClient,
  productionId: string
): Promise<BilledEvidence | null> {
  const { data: links } = await admin
    .from("job_productions")
    .select("job_id")
    .eq("production_id", productionId);
  const jobIds = (links ?? []).map((l) => l.job_id as string).filter(Boolean);
  if (!jobIds.length) return null;

  // ---- a: the job already carries a document number ----------------------
  const { data: jobs } = await admin
    .from("jobs")
    .select("id,invoice_biz,invoice_tax,dismissed")
    .in("id", jobIds);
  for (const j of (jobs ?? []) as { id: string; invoice_biz: string | null; invoice_tax: string | null; dismissed: boolean }[]) {
    const num = present(j.invoice_biz) ? j.invoice_biz : present(j.invoice_tax) ? j.invoice_tax : null;
    if (num) {
      return {
        rule: "a",
        jobId: j.id,
        evidence: `${present(j.invoice_biz) ? "invoice_biz" : "invoice_tax"}=${num}${j.dismissed ? " (job מוסתר)" : ""}`,
      };
    }
  }

  // ---- b: a live queue row already covers the job ------------------------
  // Two narrow queries rather than one hand-built .or(): `in` and `overlaps`
  // compose badly as a filter string over a uuid array, and a quoting slip here
  // would read as "not billed" — the silent direction.
  const LIVE = ["pending", "approved", "issued", "accrued"];
  const BILLING: PendingDocType[] = ["deal_invoice", "tax_invoice", "tax_receipt"];
  const [byJob, byBundle] = await Promise.all([
    admin
      .from("pending_documents")
      .select("id,doc_type,morning_doc_number,job_id")
      .in("doc_type", BILLING)
      .in("status", LIVE)
      .in("job_id", jobIds),
    admin
      .from("pending_documents")
      .select("id,doc_type,morning_doc_number,bundle_job_ids")
      .in("doc_type", BILLING)
      .in("status", LIVE)
      .overlaps("bundle_job_ids", jobIds),
  ]);
  for (const r of [...(byJob.data ?? []), ...(byBundle.data ?? [])] as {
    id: string;
    doc_type: string;
    morning_doc_number: string | null;
    job_id?: string | null;
    bundle_job_ids?: string[] | null;
  }[]) {
    const hit = r.job_id && jobIds.includes(r.job_id)
      ? r.job_id
      : (r.bundle_job_ids ?? []).find((j) => jobIds.includes(j)) ?? jobIds[0];
    return {
      rule: "b",
      jobId: hit,
      evidence: `${r.doc_type} בתור (${r.morning_doc_number ?? r.id.slice(0, 8)})`,
    };
  }

  // ---- c: the registry already holds one ---------------------------------
  const BILLING_CODES = [300, 305, 320];
  const [docByJob, docByBundle] = await Promise.all([
    admin
      .from("documents")
      .select("id,type,morning_doc_number,job_id")
      .in("type", BILLING_CODES)
      .is("cancelled_at", null)
      .is("archived_at", null)
      .in("job_id", jobIds),
    admin
      .from("documents")
      .select("id,type,morning_doc_number,bundle_job_ids")
      .in("type", BILLING_CODES)
      .is("cancelled_at", null)
      .is("archived_at", null)
      .overlaps("bundle_job_ids", jobIds),
  ]);
  for (const d of [...(docByJob.data ?? []), ...(docByBundle.data ?? [])] as {
    id: string;
    type: number;
    morning_doc_number: string | null;
    job_id?: string | null;
    bundle_job_ids?: string[] | null;
  }[]) {
    const hit = d.job_id && jobIds.includes(d.job_id)
      ? d.job_id
      : (d.bundle_job_ids ?? []).find((j) => jobIds.includes(j)) ?? jobIds[0];
    return {
      rule: "c",
      jobId: hit,
      evidence: `מסמך ${d.type} במרשם (${d.morning_doc_number ?? d.id.slice(0, 8)})`,
    };
  }

  return null;
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

  // Already billed? Then this approval must not raise a second document.
  // deal_invoice ONLY: a work order is queued at creation, long before any
  // invoice exists, and the same test there would block an ordinary re-sync.
  // Verified against every call site — work_order comes from the calendar sync
  // and manual creation, deal_invoice only from the two approval paths.
  if (docType === "deal_invoice") {
    const billed = await findBilledEvidence(admin, production.id);
    if (billed) {
      // Loud, unlike the 23505 branch below. That one is silent because it means
      // "this exact row is already queued"; this one means money moved through a
      // different door, and "why was no 300 created?" has to be answerable from
      // the log rather than reconstructed (0024: silence must be documented).
      await admin.from("events").insert({
        entity_type: "production",
        entity_id: production.id,
        event_type: "deal_invoice_skipped_already_billed",
        payload: {
          rule: billed.rule,
          job_id: billed.jobId,
          evidence: billed.evidence,
          doc_type: docType,
        },
      });
      await setBlockReason(admin, production.id, null);
      return { status: "exists" };
    }
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

  // One string, two destinations: buildDocumentPayload writes it to the
  // document's own description AND to the income line. Kept unified on purpose
  // (owner 2026-08-20) — it is what the owner does by hand in Morning (see
  // work order 10306), and with a single line there is nothing for a separate
  // title to say that the line does not.
  //
  // The " — " is DESCRIPTION_SEPARATOR's shape and stays: it divides the
  // document's printed LABEL from everything else. It is dropped along with
  // the label's tail when there is nothing to put after it — a document with
  // no show and no date used to read "הזמנת עבודה —", trailing dash included.
  const lineText = buildLineItemText(production);
  const description = lineText ? `${DOC_TYPE_LABEL[docType]} — ${lineText}` : DOC_TYPE_LABEL[docType];
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
