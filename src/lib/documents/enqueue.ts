import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DOC_TYPE_TO_MORNING_CODE,
  DOC_TYPE_LABEL,
  VAT_TYPE_DEFAULT,
  type MorningDocumentRequest,
  type PendingDocType,
} from "@/lib/morning/types";
import { roundAgorot } from "@/lib/documents/lineBalance";
import { shortDate, todayInIsrael } from "@/lib/dates";
import { SupabaseReadError } from "@/lib/supabase/unwrap";
import { hasBeenPerformed } from "@/lib/productions/status";
import { certainBillingMatchForJobs } from "@/lib/documents/reconcile";

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
//
// `amount` is a number, never null (0067). Until then an eligible production
// could still come back priceless, and the caller had to catch that separately
// — which is exactly how the priceless block ended up as the one refusal in
// this file that set billing_block_reason and wrote NO event. There is now one
// place that decides a block, and every block it decides is logged.
export type Eligibility =
  | { ok: true; clientId: string; morningClientId: string; amount: number }
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
  // ---- 0067, read ONLY by the per_hour branch below ----
  // Where the production stands. It decides one thing and one thing only:
  // whether "an hourly show with no hours yet" is correct silence or a 🟡.
  //
  // Optional, like its neighbours — but an OMITTED status is deliberately the
  // LOUD reading, not the quiet one (see HOURS_NOT_YET_EXPECTED). A caller that
  // forgets the column gets a flag it can see and fix; the opposite default
  // would hide a real missing-hours block behind a call site's omission, which
  // is the silence 0024 exists to prevent. Every live call site passes it.
  status?: string | null;
  // The recorded studio hours (numeric(5,2)). Multiplied by the show's
  // hourly_rate; null until the technician types it, which is normal and is
  // NOT by itself an error — see the branch below.
  studio_hours?: number | null;
};

export type ShowForBilling = {
  id: string;
  client_id: string | null;
  billing_mode: string | null;
  default_rate: number | null;
  // ---- 0067 ----
  // A SEPARATE AXIS from billing_mode, which stays 'per_episode' on an hourly
  // show: it genuinely does bill once per production, only the way the amount
  // is COMPUTED changes. Optional so that an omitted column reads as
  // 'per_episode' — today's behaviour, which is also what the column's NOT NULL
  // DEFAULT says every existing row is.
  pricing_model?: string | null;
  // ₪ per studio hour. shows_one_rate_per_model (0067) makes it impossible for
  // a show to carry this AND default_rate, so "which rate applies?" is not a
  // question that can be asked.
  hourly_rate?: number | null;
};

/**
 * Could the hours exist yet?
 *
 * `hasBeenPerformed` is the line 0060/0061 draw in the database and the accrued
 * screen already reads — scheduled and mid-recording are "not yet", and 'בוטל'
 * is excluded by name rather than by enum order (it sorts LAST, so any range
 * test would sweep cancelled episodes in as "recorded and then some").
 * Imported, not re-declared: since F6's UI computes the same flag in the
 * drawer, a second copy of this set would be a second definition of when a
 * technician is asked for hours.
 *
 * The null guard is this file's own, and it is the LOUD direction: a caller
 * that omits `status` gets a 🟡 it can see and fix, never silence. See the
 * field's own note on ProductionForBilling.
 */
const hoursNotYetExpected = (status: string | null | undefined) =>
  status != null && !hasBeenPerformed(status);

// roundAgorot now lives in lineBalance.ts (imported above). The same
// `round(studio_hours * hourly_rate, 2)` runs in SQL inside
// ensure_job_for_production (0067 §7), which is what writes jobs.amount — two
// independent derivations of ONE base that must come out equal to the agora, or
// the job and its document quietly disagree about the same money.

/**
 * What one production is worth, before add-ons — or the reason it is worth
 * nothing yet.
 *
 * ONE EXPRESSION, because the rule already has four copies (the migration
 * header of 0067 names them: enqueue.ts, productions/price.ts,
 * addons/route.ts, and ensure_job_for_production in SQL). checkEligibility
 * turns the `blocked` codes into the sentences a bookkeeper reads; the hours
 * route uses the number to write jobs.amount. Neither owns a second copy of
 * the arithmetic.
 *
 * The three codes are distinct because the person who fixes them is:
 *   no_hourly_rate  — whoever configures the show (money)
 *   no_hours        — the technician who ran the session (stages)
 *   no_default_rate — whoever configures the show (money)
 * Collapsing them into one null is what would send the wrong person looking.
 *
 * WHAT THIS DOES NOT DECIDE: whether the absence is a problem. `no_hours` on a
 * session that hasn't happened yet is simply the calendar. That judgement needs
 * the production's status and belongs to the caller — see checkEligibility.
 */
// `blocked: null` on the priced arm rather than an optional field: an optional
// property is not a discriminant, and the compiler could then not prove that
// exhausting the three codes leaves a number behind — which is the one thing
// this shape exists to make provable.
export type BaseAmount =
  | { amount: number; blocked: null }
  | { amount: null; blocked: "no_hourly_rate" | "no_hours" | "no_default_rate" };

export function effectivePrice(production: ProductionForBilling, show: ShowForBilling): BaseAmount {
  // The human said the number. It wins in BOTH models — an override on an
  // hourly show is the owner pricing one session by hand, and there is nothing
  // for hours × rate to add to that.
  if (production.price_override != null) return { amount: Number(production.price_override), blocked: null };

  if (show.pricing_model === "per_hour") {
    // Rate before hours, on purpose: with no rate there is nothing to multiply,
    // and reporting missing HOURS on a show that has no rate sends a technician
    // to fix something that was never the fault.
    if (show.hourly_rate == null) return { amount: null, blocked: "no_hourly_rate" };
    if (production.studio_hours == null) return { amount: null, blocked: "no_hours" };
    return { amount: roundAgorot(Number(production.studio_hours) * Number(show.hourly_rate)), blocked: null };
  }

  if (show.default_rate == null) return { amount: null, blocked: "no_default_rate" };
  return { amount: Number(show.default_rate), blocked: null };
}

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
 *
 * Then, and only for a production that passed all of them, the PRICE (0067):
 *
 *   price_override                        → price_override        (both models)
 *   per_hour + hours + rate               → round(hours × rate, 2)
 *   per_hour, no rate                     → blocked, applicable    (config)
 *   per_hour, no hours, not yet recorded  → blocked, NOT applicable (silence)
 *   per_hour, no hours, recorded or later → blocked, applicable    (🟡)
 *   per_episode + default_rate            → default_rate
 *   per_episode, no default_rate          → blocked, applicable
 *
 * Still a pure function of its arguments — the one piece of billing logic that
 * is testable without a database (scripts/test_hourly_pricing.ts), and that is
 * worth keeping.
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

  // ═══ the effective price, across both pricing models (0067) ═══
  // Everything above this line answers "is a document owed?". Everything below
  // answers "for how much?" — and a production that is owed a document but has
  // no number to put on it is BLOCKED, not eligible-with-null. That refusal
  // used to live in enqueueDocument, where it was the one block in the whole
  // path that set a 🟡 and wrote no event.
  const base = effectivePrice(production, show);
  if (base.amount !== null) {
    return {
      ok: true,
      clientId: client.id,
      morningClientId: client.morning_client_id,
      amount: base.amount,
    };
  }
  if (base.blocked === "no_hourly_rate") {
    // A different sentence from the missing-hours one, on purpose. Sending a
    // technician to look for hours when the real fault is a show with no rate
    // is how a 🟡 gets dismissed as noise. Loud regardless of status: the rate
    // is a property of the SHOW, knowable and fixable before anyone records
    // anything, and shows_one_rate_per_model means a show without it carries no
    // price in either column.
    return { ok: false, applicable: true, reason: "התוכנית מתומחרת לפי שעת אולפן אך לא הוגדר תעריף שעתי" };
  }
  if (base.blocked === "no_hours") {
    // Not a problem yet: the session hasn't happened, so nobody has hours to
    // type. Documented silence (applicable:false) — no row, no 🟡, and no stale
    // flag left behind. The work order is created later, by the hours route, at
    // the moment the number arrives.
    if (hoursNotYetExpected(production.status)) {
      return {
        ok: false,
        applicable: false,
        reason: "התוכנית מתומחרת לפי שעת אולפן — ההקלטה טרם התבצעה ואין עדיין שעות לחייב",
      };
    }
    // Recorded (or beyond) with no hours: the work was done and the number that
    // decides its price is missing. This is the 🟡 the whole model needs —
    // without it an hourly episode would simply never be billed, silently.
    return { ok: false, applicable: true, reason: "התוכנית מתומחרת לפי שעת אולפן — לא הוזנו שעות ההקלטה" };
  }
  // no_default_rate — the refusal that used to live in enqueueDocument, now a
  // block like every other: a reason, a 🟡, and an event.
  return { ok: false, applicable: true, reason: "לתוכנית אין מחיר ברירת מחדל — אי אפשר לבנות מסמך" };
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
  rule: "a" | "b" | "c" | "c2" | "d";
  jobId: string;
  /**
   * The human sentence. Every rule has always had one, every caller that shows
   * a message reads THIS, and its shape is unchanged — the structured `detail`
   * below sits beside it rather than replacing it, because the registry route
   * needs a Hebrew sentence and the event needs fields, and one key cannot be
   * both without a reader somewhere getting the shape it did not expect.
   */
  evidence: string;
  /** The same facts, addressable. Written to the event payload. */
  detail: {
    doc_number: string | null;
    doc_type: number | string | null;
    amount?: number | null;
    days_gap?: number | null;
    /** rule a only — which column carried the number */
    column?: "invoice_biz" | "invoice_tax";
    /** rule b only — the queue row's status */
    queue_status?: string | null;
    /** rule d only — the job and production this work was really billed under */
    kept_job_id?: string | null;
    kept_production_id?: string | null;
  };
  /**
   * c2 only. The block left a job with a matching document NOBODY linked, so
   * the queue went quiet and the gap stayed. Nothing consumes this yet (see the
   * report on the event's readers) — it is on the event so the gap is
   * addressable the day a screen asks for it, rather than reconstructed.
   */
  needsLink?: boolean;
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
  // productionId is handed on so rule (d) can run — it is the one rule that
  // asks about the PRODUCTION rather than about its jobs. See the note on
  // `productionId` in the signature below for why the registry path does not
  // pass one.
  return findBilledEvidenceForJobs(admin, jobIds, productionId);
}

/**
 * The same rules, asked about jobs directly.
 *
 * Split out 2026-09-16 so the registry's "+ חשבון עסקה חדש" can ask the
 * question too. That route starts from a JOB and may have no production at
 * all, and until now it carried its own narrower copy of rules a and b — two
 * statements of one rule, and the copy was missing c and c2 entirely.
 *
 * `productionId` is OPTIONAL and gates rule (d) alone. The registry passes
 * none, and that is the deliberate escape hatch rather than an oversight: (d)
 * blocks on a merge that a human recorded and may later decide was wrong, so
 * there has to be one door left. That door is the registry, it is money-tier,
 * and it opens only after someone un-dismisses the duplicate's job by hand —
 * a money decision with a name on it, which is exactly the bar (d) is
 * protecting.
 */
export async function findBilledEvidenceForJobs(
  admin: SupabaseClient,
  jobIds: string[],
  productionId?: string
): Promise<BilledEvidence | null> {
  if (!jobIds.length) return null;

  // ---- a: the job already carries a document number ----------------------
  const { data: jobs } = await admin
    .from("jobs")
    .select("id,invoice_biz,invoice_tax,dismissed")
    .in("id", jobIds);
  for (const j of (jobs ?? []) as { id: string; invoice_biz: string | null; invoice_tax: string | null; dismissed: boolean }[]) {
    const column = present(j.invoice_biz) ? "invoice_biz" : present(j.invoice_tax) ? "invoice_tax" : null;
    const num = column === "invoice_biz" ? j.invoice_biz : column === "invoice_tax" ? j.invoice_tax : null;
    if (column && num) {
      return {
        rule: "a",
        jobId: j.id,
        evidence: `${column}=${num}${j.dismissed ? " (job מוסתר)" : ""}`,
        detail: { doc_number: num, doc_type: null, column },
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
      .select("id,doc_type,status,morning_doc_number,job_id")
      .in("doc_type", BILLING)
      .in("status", LIVE)
      .in("job_id", jobIds),
    admin
      .from("pending_documents")
      .select("id,doc_type,status,morning_doc_number,bundle_job_ids")
      .in("doc_type", BILLING)
      .in("status", LIVE)
      .overlaps("bundle_job_ids", jobIds),
  ]);
  for (const r of [...(byJob.data ?? []), ...(byBundle.data ?? [])] as {
    id: string;
    doc_type: string;
    status: string;
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
      detail: { doc_number: r.morning_doc_number, doc_type: r.doc_type, queue_status: r.status },
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
      detail: { doc_number: d.morning_doc_number, doc_type: d.type },
    };
  }

  // ---- d: this production is a KNOWN duplicate of one already billed ------
  //
  // Rules a, b, c and c2 all ask about THIS job. (d) asks the one question
  // none of them can: was this work already billed under a DIFFERENT job,
  // because someone decided this production was a duplicate?
  //
  // Measured on ליעד הרמן / אוכלי סרטים 28.8 (2026-09-16). 0065 merged the
  // manual duplicate away and dismissed its ₪600 job; on 8.9 a technician undid
  // the merge and the production came back to the board in 'נשלח_ללקוח'. All
  // four earlier rules read clean on it — no invoice on the dismissed job (a),
  // its work order is a rejected work_order (b), no linked document (c), and
  // the client's two unlinked documents are ₪1,416 and ₪1,770 so no amount
  // matches ₪600 (c2). The client is per_episode at ₪600, so one client
  // approval would have queued a deal invoice for a recording already billed
  // ₪300 under 40311.
  //
  // BEFORE c2, and that ordering is the point: (d) rests on a decision a human
  // recorded PLUS hard billing evidence on the survivor, while c2 infers a
  // match from client and amount. When both could fire, the recorded decision
  // is the better sentence to leave in the log.
  //
  // TWO SOURCES, because the merge writes two events and either can be the one
  // that survives. Payload keys verified against every row in the table
  // (2026-09-16): production_merged_duplicate — 15 rows, all carry
  // `merged_into`; job_dismissed — 80 rows, `kept_job_id` on the merge-borne
  // ones. Neither key is assumed.
  //
  // The merge EVENT is the signal, never `productions.merged_into` — the whole
  // reason this rule exists is a production whose merged_into was cleared while
  // the billing it caused stayed put. A cleared column is precisely the state
  // (d) must still see through.
  if (productionId) {
    const [mergeEv, dismissEv] = await Promise.all([
      admin
        .from("events")
        .select("payload")
        .eq("entity_id", productionId)
        .eq("event_type", "production_merged_duplicate")
        .order("created_at", { ascending: false })
        .limit(1),
      admin
        .from("events")
        .select("payload")
        .in("entity_id", jobIds)
        .eq("event_type", "job_dismissed")
        .order("created_at", { ascending: false })
        .limit(5),
    ]);

    const keptProductionId =
      ((mergeEv.data ?? [])[0]?.payload as { merged_into?: string } | undefined)?.merged_into ?? null;
    const keptJobIdFromEvent =
      ((dismissEv.data ?? []) as { payload?: { kept_job_id?: string } }[])
        .map((e) => e.payload?.kept_job_id)
        .find((v) => present(v)) ?? null;

    if (keptProductionId || keptJobIdFromEvent) {
      // The surviving jobs: the one the dismissal named, plus whatever the
      // surviving production carries. Both, because the two events can name
      // different halves of the same survivor and either may be missing.
      const survivorJobIds = new Set<string>();
      if (keptJobIdFromEvent) survivorJobIds.add(keptJobIdFromEvent);
      if (keptProductionId) {
        const { data: survLinks } = await admin
          .from("job_productions")
          .select("job_id")
          .eq("production_id", keptProductionId);
        for (const l of survLinks ?? []) if (l.job_id) survivorJobIds.add(l.job_id as string);
      }
      // Never let the survivor set collapse back onto this production's own
      // jobs — that would make a row evidence against itself.
      for (const id of jobIds) survivorJobIds.delete(id);

      const survivors = Array.from(survivorJobIds);
      if (survivors.length) {
        // "Is the survivor actually billed?" — rules (a) and (c) only, asked
        // about the other job. NOT the whole function: c2's inference about a
        // DIFFERENT job is too long a chain to end in a block over here, and a
        // live queue row (b) is not yet money that moved.
        const [survJobs, survDocs] = await Promise.all([
          admin.from("jobs").select("id,invoice_biz,invoice_tax").in("id", survivors),
          admin
            .from("documents")
            .select("id,type,morning_doc_number,job_id")
            .in("type", [300, 305, 320])
            .is("cancelled_at", null)
            .is("archived_at", null)
            .in("job_id", survivors),
        ]);

        const billedJob = ((survJobs.data ?? []) as {
          id: string;
          invoice_biz: string | null;
          invoice_tax: string | null;
        }[]).find((j) => present(j.invoice_biz) || present(j.invoice_tax));
        const billedDoc = ((survDocs.data ?? []) as {
          id: string;
          type: number;
          morning_doc_number: string | null;
          job_id: string | null;
        }[])[0];

        if (billedJob || billedDoc) {
          const number = billedJob
            ? present(billedJob.invoice_biz)
              ? billedJob.invoice_biz
              : billedJob.invoice_tax
            : billedDoc.morning_doc_number ?? billedDoc.id.slice(0, 8);
          const keptJobId = billedJob?.id ?? billedDoc?.job_id ?? survivors[0];
          return {
            rule: "d",
            // The job named is THIS production's own — the row that would have
            // been billed twice. The survivor's ids live in `detail`.
            jobId: jobIds[0],
            evidence: `ההפקה סומנה ככפילות של הפקה שכבר חויבה (${number})`,
            detail: {
              doc_number: number ?? null,
              doc_type: billedDoc?.type ?? null,
              kept_job_id: keptJobId,
              kept_production_id: keptProductionId,
            },
            needsLink: false,
          };
        }
      }
    }
  }

  // ---- c2: a live billing document that MATCHES but was never linked ------
  // Rules a, b and c all read a link. This one is the case where no link was
  // ever made — a document pulled from Morning gets job_id only when a human
  // presses "שייך מסמך קיים", and on חברת החשמל nobody ever did, so a second
  // 300 was queued against money already billed. Twice.
  //
  // It runs LAST because it is the only rule that reasons rather than reads:
  // a, b and c state a fact someone recorded, c2 states that the matching
  // engine considers this document certainly this job's. Whenever a recorded
  // fact exists, it answers first and c2 is never reached.
  //
  // It BLOCKS and does not link. Writing job_id here would turn a guard into
  // an auto-matcher and put the engine's judgement on the money — the decision
  // 0087 kept with the bookkeeper. A block costs a rejected queue row that
  // never existed; a wrong link costs a document attached to the wrong work.
  const match = await certainBillingMatchForJobs(admin, jobIds);
  if (match) {
    const number = match.doc.morning_doc_number ?? match.doc.id.slice(0, 8);
    return {
      rule: "c2",
      jobId: match.jobId,
      evidence: `מסמך ${match.doc.type} במרשם (${number}) — התאמה ודאית שלא קושרה ל-job`,
      detail: {
        doc_number: match.doc.morning_doc_number,
        doc_type: match.doc.type,
        amount: match.doc.amount,
        days_gap: match.dateGapDays,
      },
      needsLink: true,
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
    // 0067: pricing_model and hourly_rate are read here, not merely typed — an
    // omitted column reads as per_episode and would bill an hourly show at a
    // default_rate the constraint guarantees is null.
    .select("id,client_id,billing_mode,default_rate,pricing_model,hourly_rate")
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
          // The same facts as fields, added 2026-09-16 alongside the sentence
          // rather than in place of it — `evidence` keeps the shape every
          // existing row of this event already has.
          evidence_detail: billed.detail,
          // c2 only: blocked, AND the registry document behind the block is
          // still unlinked. The gap outlives the block and someone has to
          // close it.
          ...(billed.needsLink ? { needs_link: true } : {}),
        },
      });
      await setBlockReason(admin, production.id, null);
      return { status: "exists" };
    }
  }

  // elig.amount is a number by construction (0067): "eligible but priceless"
  // is no longer a state this function has to handle, because checkEligibility
  // now refuses it as a block like every other — with a reason, a 🟡 AND an
  // event, which the refusal that used to stand here never wrote.
  //
  // amountOverride adjusts the amount of a production that is ALREADY eligible;
  // it does not manufacture eligibility. No call site passes it today (verified
  // across src/ and scripts/), so nothing changes — but the semantics are now
  // stated rather than emergent from statement order.
  const baseAmount = opts.amountOverride ?? elig.amount;

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
