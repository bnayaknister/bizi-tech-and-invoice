import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DOC_TYPE_TO_MORNING_CODE,
  sourceRemark,
  type MorningDocumentRequest,
  type PendingDocType,
} from "@/lib/morning/types";

/**
 * "On the basis of" — the ONE place that decides what a child document says
 * about its parents, and which parents it is allowed to close.
 *
 * ═══ WHY THIS FILE EXISTS ═══
 * Five paths issue a document derived from another, and by 2026-09-17 they had
 * drifted into three different behaviours:
 *
 *   createDealInvoiceFromWorkOrder  link + remark   ← the owner's reference
 *   createTaxFromParents            link + remark
 *   createReceiptFromTaxInvoices    link + remark
 *   issue.ts (approval / kanban)    link, NO remark ← 40321 went out silent
 *   createDealInvoiceBundle         neither         ← closed nothing
 *
 * The drift was not carelessness: each site wrote the same two lines from
 * scratch, and the third of them was written under a comment claiming Morning
 * generates the remark by itself. It does not — see types.ts:100-110, which
 * records the live verification, and 40321, which proves it again.
 *
 * ═══ THE TWO HALVES DO DIFFERENT JOBS ═══
 *   linkedDocumentIds  CLOSES the parent in Morning. Irreversible: there is no
 *                      PUT on documents.
 *   remarks            PRINTS "חשבון עסקה עבור הזמנה 10321" below the totals.
 *                      It is also the ONLY source of `parent_doc_numbers` on
 *                      our side — parseParentLink reads it back off the daily
 *                      pull (registry.ts:247). Nothing in the app writes that
 *                      column directly, and this file deliberately does not
 *                      start (owner decision 2026-09-17, option א): one
 *                      derivation, already proven, one day late.
 *
 * ═══ THE PRINCIPLE, INHERITED FROM THE RESOLVER BELOW ═══
 * Doubt = do not link. An order left open is an inconvenience a human closes by
 * hand in a minute; an order closed wrongly is money nobody can un-close.
 */

/** A parent as the builders already hold it: a row that reached Morning. */
export type ParentDoc = {
  morning_doc_id: string;
  morning_doc_number: string | number | null;
};

export type ParentRef = {
  /** Morning ids, in the order given. Closes each parent. */
  linkedDocumentIds: string[];
  /** The printed provenance line, or undefined when no parent carries a number. */
  remarks: string | undefined;
  /** The parents' numbers as strings, same order — for events and callers. */
  parentNumbers: string[];
};

/**
 * Build both halves from parents the caller has ALREADY validated.
 *
 * Pure, and order-preserving by construction: `linkedDocumentIds` and the
 * numbers inside `remarks` follow the order of `parents` exactly, because the
 * three call sites that adopted this function each had their own array order
 * and a reordering here would silently change a document's printed text.
 *
 * `sourceRemark` still owns the wording and the de-duplication; this only
 * chooses what to hand it. That keeps one spelling of the sentence, which is
 * the whole point of the file.
 */
export function buildParentRef(opts: {
  childType: PendingDocType;
  parentCode: number;
  parents: readonly ParentDoc[];
}): ParentRef {
  const { childType, parentCode, parents } = opts;
  const linkedDocumentIds = parents.map((p) => p.morning_doc_id);
  const parentNumbers = parents.map((p) => String(p.morning_doc_number));
  return {
    linkedDocumentIds,
    remarks: sourceRemark(childType, parentCode, parentNumbers),
    parentNumbers,
  };
}

/**
 * The same, spread into a payload. `remarks` is omitted rather than set to
 * undefined when there is no source — a parentless document must not carry the
 * key at all, which is the contract sourceRemark's own doc states.
 */
export function parentRefFields(ref: ParentRef): Pick<MorningDocumentRequest, "linkedDocumentIds" | "remarks"> {
  return {
    linkedDocumentIds: ref.linkedDocumentIds,
    ...(ref.remarks ? { remarks: ref.remarks } : {}),
  };
}

// ---------------------------------------------------------------------------
// the resolver — which work order a deal invoice may close
// ---------------------------------------------------------------------------

/**
 * Moved here from issue.ts on 2026-09-17, unchanged. It lived there because
 * issue.ts was its only caller; three more callers arrived the same day, and a
 * gate list that decides what money closes must not be reachable only through
 * the one file that happened to need it first.
 *
 * issue.ts re-exports it so scripts/test_parent_work_order_link.ts keeps
 * importing from where it always did.
 */
export type ParentLink =
  | { linked: true; work_order_id: string; work_order_number: string | null; morning_doc_id: string }
  | {
      linked: false;
      skip_reason: string;
      detail?: string;
      work_order_id?: string;
      morning_doc_id?: string | null;
    };

type WorkOrderRow = {
  id: string;
  status: string;
  morning_doc_id: string | null;
  morning_doc_number: string | null;
};

/**
 * The parent work order a deal invoice should be issued "on the basis of", so
 * Morning CLOSES it.
 *
 * ═══ WHY AT ISSUE TIME AND NOT AT ENQUEUE ═══
 * A deal invoice raised by client approval can be created BEFORE its work order
 * has been issued. Live case 40293/10293 (2026-07-29) — the invoice row was
 * created at 11:42:40 and the order was issued at 11:43:47, sixty-seven seconds
 * later. At enqueue time there was no morning_doc_id to link to, and a lookup
 * there would have found nothing and written nothing, silently, forever.
 *
 * ═══ WHY GATE 4 (consolidation) IS THE ONE THAT MATTERS ═══
 * A REDEEMED work order is one document covering four or five episodes (10317
 * folds 5, 10323 folds 4 — nine live productions between them today). Its own
 * row carries production_id NULL, and each folded source row keeps
 * consolidated_into pointing at it (bundle.ts:562). A per-episode deal invoice
 * linked to such an order would close a debt for every episode it covers while
 * exactly one was billed — and Morning has no PUT on documents, so that cannot
 * be taken back. Both directions are refused: a source row that was folded
 * (status 'consolidated'), and an order that is itself a fold parent.
 *
 * The owner's 2026-09-17 rule — "a consolidated order closes only if the
 * document covers ALL of its jobs" — is satisfied by this refusal today rather
 * than by a coverage test, and deliberately: no caller can yet assemble a
 * document that covers a whole fold, because the redemption path bills the fold
 * as one order and never per job. When one can, the test belongs here, beside
 * gate 4b, and `consolidated_into` is how the fold's job set is read (measured
 * 2026-09-17: 10317 → 5 children, 10323 → 4, every child carrying job_id).
 *
 * Note on gate 5: issue.ts does NOT send `status` to upsertDocument, so an
 * order the app issued carries documents.status NULL until the next daily pull
 * overwrites it with Morning's own value. That is reported as its own skip
 * (`work_order_status_unknown`) rather than folded into "closed", because the
 * two mean different things to whoever reads the log — and because it is the
 * one skip that resolves itself.
 */
export async function resolveParentWorkOrderLink(
  admin: SupabaseClient,
  productionId: string
): Promise<ParentLink> {
  const { data: orders, error: ordersErr } = await admin
    .from("pending_documents")
    .select("id,status,morning_doc_id,morning_doc_number")
    .eq("doc_type", "work_order")
    .eq("production_id", productionId);
  if (ordersErr) return { linked: false, skip_reason: "lookup_failed", detail: ordersErr.message };

  const rows = (orders ?? []) as WorkOrderRow[];

  // ---- gate 1: no order at all -------------------------------------------
  if (!rows.length) return { linked: false, skip_reason: "no_work_order" };

  // ---- gate 4a: this episode's order was folded into a consolidated one ----
  // Checked BEFORE the 'issued' filter on purpose: a folded row's status is
  // 'consolidated', so the filter below would drop it and report the vaguer
  // "not issued". This is the diagnosis that has to survive to the log.
  const folded = rows.find((o) => o.status === "consolidated");
  if (folded) {
    return {
      linked: false,
      skip_reason: "work_order_consolidated",
      work_order_id: folded.id,
      morning_doc_id: folded.morning_doc_id,
    };
  }

  // ---- gate 2: only an ISSUED order exists in Morning ---------------------
  const issued = rows.filter((o) => o.status === "issued");
  if (!issued.length) {
    return {
      linked: false,
      skip_reason: "work_order_not_issued",
      detail: rows.map((o) => o.status).sort().join(","),
      work_order_id: rows[0].id,
    };
  }
  // 0025's partial unique index should make this impossible — one live row per
  // (doc_type, production). Not trusted: picking the wrong order closes the
  // wrong debt, and there is no undo. Refuse and let a human decide.
  if (issued.length > 1) {
    return {
      linked: false,
      skip_reason: "multiple_issued_work_orders",
      detail: issued.map((o) => o.morning_doc_number ?? o.id).join(","),
    };
  }
  const wo = issued[0];

  // ---- gate 3: a real Morning document, not a dry run ---------------------
  if (!wo.morning_doc_id) {
    return { linked: false, skip_reason: "work_order_without_morning_id", work_order_id: wo.id };
  }
  if (wo.morning_doc_id.startsWith("dry-")) {
    return {
      linked: false,
      skip_reason: "work_order_dry_run",
      work_order_id: wo.id,
      morning_doc_id: wo.morning_doc_id,
    };
  }

  // ---- gate 4b: the order is itself a consolidation parent -----------------
  // A fold parent carries production_id NULL and so cannot be reached by the
  // query above. Checked anyway: the cost is one indexed lookup, and the thing
  // it guards against is the irreversible one.
  const { data: children, error: childErr } = await admin
    .from("pending_documents")
    .select("id")
    .eq("consolidated_into", wo.id)
    .limit(1);
  if (childErr) {
    return {
      linked: false,
      skip_reason: "consolidation_lookup_failed",
      detail: childErr.message,
      work_order_id: wo.id,
      morning_doc_id: wo.morning_doc_id,
    };
  }
  if (children && children.length) {
    return {
      linked: false,
      skip_reason: "work_order_is_consolidation_parent",
      work_order_id: wo.id,
      morning_doc_id: wo.morning_doc_id,
    };
  }

  // ---- gate 5: still open in Morning --------------------------------------
  // 0 = פתוח, 1 = נסגר אוטומטית, 2 = נסגר ידנית (RegistryClient.tsx:208).
  // Only 0 may be linked; anything else, including an unrecognised code, is
  // treated as closed — the same fail-safe reading that screen already applies.
  const { data: reg, error: regErr } = await admin
    .from("documents")
    .select("status")
    .eq("morning_doc_id", wo.morning_doc_id)
    .maybeSingle();
  if (regErr) {
    return {
      linked: false,
      skip_reason: "registry_lookup_failed",
      detail: regErr.message,
      work_order_id: wo.id,
      morning_doc_id: wo.morning_doc_id,
    };
  }
  if (!reg) {
    return {
      linked: false,
      skip_reason: "work_order_not_in_registry",
      work_order_id: wo.id,
      morning_doc_id: wo.morning_doc_id,
    };
  }
  const morningStatus = (reg as { status: number | null }).status;
  if (morningStatus === null || morningStatus === undefined) {
    return {
      linked: false,
      skip_reason: "work_order_status_unknown",
      work_order_id: wo.id,
      morning_doc_id: wo.morning_doc_id,
    };
  }
  if (morningStatus !== 0) {
    return {
      linked: false,
      skip_reason: "work_order_closed_in_morning",
      detail: String(morningStatus),
      work_order_id: wo.id,
      morning_doc_id: wo.morning_doc_id,
    };
  }

  return {
    linked: true,
    work_order_id: wo.id,
    work_order_number: wo.morning_doc_number,
    morning_doc_id: wo.morning_doc_id,
  };
}

// ---------------------------------------------------------------------------
// jobs -> the work orders a deal invoice must be built from
// ---------------------------------------------------------------------------

/** Why one job could not contribute an order, in the bookkeeper's words. */
export type JobOrderFailure = {
  job_id: string;
  /** "המניפה · 10.09.26" — what she sees on the finance screen. */
  label: string;
  skip_reason: string;
  detail?: string;
  work_order_number?: string | null;
};

export type JobOrdersResult =
  | { ok: true; workOrderIds: string[] }
  | { ok: false; failures: JobOrderFailure[] };

/**
 * The refusal sentence, per skip reason. Owner-approved wording 2026-09-17:
 * every failing job is named, and each carries its OWN reason — she should not
 * have to open the registry to find out which of thirteen things happened.
 *
 * A reason with no sentence here is a bug in this map, not in the caller, so it
 * falls back to the raw code rather than to silence: an unfamiliar string on
 * screen is reportable, a missing line is not.
 */
const FAILURE_TEXT: Record<string, string> = {
  no_work_order: "לא הונפקה הזמנת עבודה",
  work_order_not_issued: "הזמנת העבודה עדיין בתור ולא הונפקה",
  work_order_consolidated: "הזמנת העבודה אוחדה להזמנה מרוכזת",
  work_order_is_consolidation_parent:
    "ההזמנה מרוכזת, וחשבון עסקה על חלק מהפרקים שלה אינו נסגר",
  multiple_issued_work_orders: "יש יותר מהזמנת עבודה מונפקת אחת",
  work_order_without_morning_id: "ההזמנה לא הגיעה למורנינג",
  work_order_dry_run: "ההזמנה הונפקה בהרצה יבשה בלבד",
  work_order_not_in_registry: "ההזמנה טרם נמשכה ממורנינג",
  work_order_status_unknown: "מצב ההזמנה במורנינג טרם ידוע — יימשך במשיכה הבאה",
  work_order_closed_in_morning: "הזמנת העבודה כבר סגורה במורנינג",
  lookup_failed: "קריאת הזמנות העבודה נכשלה",
  consolidation_lookup_failed: "בדיקת האיגוד נכשלה",
  registry_lookup_failed: "קריאת המרשם נכשלה",
};

export function failureSentence(f: JobOrderFailure): string {
  const why = FAILURE_TEXT[f.skip_reason] ?? f.skip_reason;
  const num = f.work_order_number ? ` (${f.work_order_number})` : "";
  return `• ${f.label} — ${why}${num}`;
}

/**
 * The whole refusal, as the bookkeeper reads it. Zero documents are created
 * when this is returned — stated first, because "did something go out?" is the
 * question she has while reading it.
 */
export function refusalMessage(failures: JobOrderFailure[], total: number): string {
  const head =
    total > 1
      ? `הבנדל לא הונפק — אפס מסמכים נוצרו.\n\nחשבון עסקה מונפק רק על סמך הזמנת עבודה מונפקת. ${failures.length} מתוך ${total} העבודות אינן עומדות בכך:`
      : "חשבון עסקה לא נוצר.\n\nחשבון עסקה מונפק רק על סמך הזמנת עבודה מונפקת:";
  const tail =
    failures.length > 1
      ? "יש להנפיק להן הזמנת עבודה מהרג'יסטרי, ואז להמיר את כולן יחד."
      : "יש להנפיק לה הזמנת עבודה מהרג'יסטרי, ואז להמיר אותה לחשבון עסקה.";
  return [head, "", ...failures.map(failureSentence), "", tail].join("\n");
}

/**
 * Resolve every job to exactly one issued work order, or refuse the whole set.
 *
 * ALL-OR-NOTHING, and that is the owner's rule rather than an implementation
 * convenience (2026-09-17): a bundle that silently drops the jobs it could not
 * resolve bills less than the bookkeeper selected, and she finds out from the
 * total. Refusing costs her one more click and tells her exactly what to fix.
 *
 * Read-only. Nothing here writes, so a refusal leaves the database untouched.
 */
export async function resolveWorkOrdersForJobs(
  admin: SupabaseClient,
  jobIds: readonly string[]
): Promise<JobOrdersResult> {
  const { data: jobRows } = await admin
    .from("jobs")
    .select("id,campaign,date")
    .in("id", jobIds as string[]);
  const labelOf = (jobId: string) => {
    const j = (jobRows ?? []).find((r) => r.id === jobId) as
      | { campaign: string | null; date: string | null }
      | undefined;
    const name = (j?.campaign ?? "").trim() || "עבודה";
    // dd.MM.yy — the same short form shortDate() prints on a document line, so
    // the job she reads about here is spelled the way she sees it everywhere
    // else. Built locally rather than imported: shortDate is FROZEN document
    // text (dates.ts:209) and this is screen text.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(j?.date ?? "").slice(0, 10));
    const d = m ? `${m[3]}.${m[2]}.${m[1].slice(2)}` : "";
    return d ? `${name} · ${d}` : name;
  };

  const { data: links } = await admin
    .from("job_productions")
    .select("job_id,production_id")
    .in("job_id", jobIds as string[]);

  const failures: JobOrderFailure[] = [];
  const workOrderIds: string[] = [];
  const seen = new Set<string>();

  // Sequential on purpose: the resolver runs three SELECTs per job, and a
  // bundle is a handful of jobs chosen by hand. Parallelism here would buy
  // milliseconds and cost the deterministic failure order the message relies on.
  for (const jobId of jobIds) {
    const prodIds = (links ?? []).filter((l) => l.job_id === jobId).map((l) => l.production_id as string);
    if (prodIds.length !== 1) {
      failures.push({
        job_id: jobId,
        label: labelOf(jobId),
        skip_reason: prodIds.length === 0 ? "no_work_order" : "multiple_issued_work_orders",
        detail: `productions=${prodIds.length}`,
      });
      continue;
    }
    const link = await resolveParentWorkOrderLink(admin, prodIds[0]);
    if (!link.linked) {
      failures.push({
        job_id: jobId,
        label: labelOf(jobId),
        skip_reason: link.skip_reason,
        detail: link.detail,
      });
      continue;
    }
    // Two jobs of one consolidated order would resolve to the same row. Gate 4b
    // already refuses that case, so this is belt-and-braces — but a duplicate id
    // in linkedDocumentIds is exactly the shape that closes something twice.
    if (seen.has(link.work_order_id)) continue;
    seen.add(link.work_order_id);
    workOrderIds.push(link.work_order_id);
  }

  if (failures.length) return { ok: false, failures };
  return { ok: true, workOrderIds };
}

/** Shared by both refusing callers, so the log reads the same from either. */
export async function recordParentRefusal(
  admin: SupabaseClient,
  opts: {
    actorId: string | null;
    via: string;
    jobIds: readonly string[];
    failures: JobOrderFailure[];
  }
): Promise<void> {
  try {
    await admin.from("events").insert(
      opts.failures.map((f) => ({
        entity_type: "job",
        entity_id: f.job_id,
        event_type: "deal_invoice_parent_missing",
        actor_id: opts.actorId,
        payload: {
          via: opts.via,
          skip_reason: f.skip_reason,
          detail: f.detail ?? null,
          selected_job_ids: opts.jobIds,
        },
      }))
    );
  } catch {
    // The refusal matters more than its log line — same rule issue.ts applies
    // to deal_invoice_parent_link.
  }
}

export { DOC_TYPE_TO_MORNING_CODE };
