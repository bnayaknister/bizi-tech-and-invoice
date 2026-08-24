import type { SupabaseClient } from "@supabase/supabase-js";
import { createDocument, MorningError, isDryRun, morningEnv } from "@/lib/morning/client";
import { DOC_TYPE_TO_MORNING_CODE, type MorningDocumentRequest, type PendingDocType } from "@/lib/morning/types";
import { upsertDocument } from "@/lib/documents/registry";
import { todayInIsrael } from "@/lib/dates";

// Turning an APPROVED queue row into a real document. This is the only
// place in the app that causes a document to exist in Morning.
//
// Iron rules (owner, 2026-07-19), each mapped to code below:
//  1. morning_doc_id UNIQUE — checked BEFORE the call (don't issue twice)
//     and AFTER it (don't record twice). A duplicate document against the
//     tax authority is a real-world problem, not a data blemish.
//  2. All or nothing — a failed call writes NO local document row. The
//     queue row goes to 'failed' with the error and stays re-runnable.
//  4. Every call is evented: what was sent, what came back, who approved.

export type IssueOutcome =
  | { ok: true; morningDocId: string; docNumber: string; pdfUrl: string | null; dryRun: boolean }
  | { ok: false; error: string; alreadyIssued?: boolean };

export type PendingRow = {
  id: string;
  doc_type: PendingDocType;
  production_id: string | null;
  job_id: string | null;
  client_id: string | null;
  amount: number | null;
  payload: MorningDocumentRequest;
  status: string;
  morning_doc_id: string | null;
  attempts: number | null;
};

// invoices.type is the two-value enum ('עסקה','מס'). A work order is not an
// invoice and gets no registry row — it lives in pending_documents only.
// (The full 5-tab document screen is where that widens; until then this
// keeps the finance registry meaning exactly what it means today.)
function registryType(docType: PendingDocType): "עסקה" | "מס" | null {
  if (docType === "deal_invoice") return "עסקה";
  if (docType === "tax_invoice" || docType === "tax_receipt") return "מס";
  return null;
}

const present = (v: unknown): boolean => v != null && String(v).trim() !== "";

/** The job columns a document moves. Enough of a job to decide; nothing more. */
export type JobFinanceFacts = {
  invoice_biz: unknown;
  invoice_tax: unknown;
  paid: unknown;
};

/**
 * What ONE issued document does to ONE linked job — the whole decision, pure.
 *
 * Extracted (owner spec 2026-08-22) rather than left inline because it is now
 * the only testable surface for it: a dry run no longer reaches the jobs write
 * at all (see the block that calls this), and there is no Morning sandbox, so
 * an end-to-end check of these rules is impossible by construction. The rules
 * are the risk; the UPDATE around them is not.
 *
 * The rules:
 *
 *   deal_invoice (300)   → invoice_biz, if the job has none
 *   tax_invoice  (305)   → invoice_tax, if the job has none
 *   tax_receipt  (320)   → invoice_tax, AND paid — a 320 is an invoice AND a
 *                          receipt, and the review route's payment gate refuses
 *                          to issue one without a payment block summing to the
 *                          parent's gross. So by the time we are here, "the
 *                          money came in" is already declared to the tax
 *                          authority. Recording it locally is not a guess.
 *   receipt      (400)   → paid, and ONLY paid. A receipt carries no tax-invoice
 *                          number, so writing one into invoice_tax would be a
 *                          lie; the number belongs to the 305 above it. Its
 *                          jobs are not on the row (job_id null, no
 *                          bundle_job_ids — receiptFromTaxInvoice) and are
 *                          resolved through the parents instead; see the
 *                          receipt branch in issuePendingDocument.
 *
 * paid flips ONLY from the exact string 'לא'. Not `!present()`: 'ללא חיוב' is a
 * deliberate decision that no money is coming, and 'לא ידוע' is an admission
 * that nobody knows — overwriting either with 'כן' would be inventing a fact.
 * Same test as linkDocumentToJob (reconcile.ts), so the two paths can never
 * disagree about what counts as an unpaid job.
 *
 * Returns an EMPTY object when there is nothing to do — an already-paid job, a
 * job that already carries the number, a work order. The caller writes nothing
 * in that case, so a re-issue is silent.
 */
export function jobPatchForDocument(opts: {
  docType: PendingDocType;
  docNumber: string;
  job: JobFinanceFacts;
}): { invoice_biz?: string; invoice_tax?: string; paid?: string } {
  const { docType, docNumber, job } = opts;
  const patch: { invoice_biz?: string; invoice_tax?: string; paid?: string } = {};

  if (docType === "deal_invoice" && !present(job.invoice_biz)) patch.invoice_biz = docNumber;
  if ((docType === "tax_invoice" || docType === "tax_receipt") && !present(job.invoice_tax)) {
    patch.invoice_tax = docNumber;
  }
  // 320 only. A 305 declares a debt and says nothing about money arriving.
  if (docType === "tax_receipt" && job.paid === "לא") patch.paid = "כן";
  // 400: money and nothing else — deliberately no invoice_tax.
  if (docType === "receipt" && job.paid === "לא") patch.paid = "כן";

  return patch;
}

/**
 * The jobs a RECEIPT (400) settles — reached through the tax invoices it was
 * raised on, because the receipt row itself points at none.
 *
 * `payload.linkedDocumentIds` holds the parents' Morning ids, and a parent can
 * sit in either table: `pending_documents` when the app issued it,
 * `documents` when the pull brought it in — and in BOTH when the app issued it,
 * since issue.ts writes through to the registry under the same morning_doc_id.
 * So both are read and the results unioned.
 *
 * Deduped by job id before the caller writes: one receipt can be raised on
 * several invoices ("קבלה מאוגדת"), and the same job can legitimately appear
 * under two of them. Writing twice would be harmless; eventing twice would not
 * — the radar counts job_marked_paid rows as its payment-timing signal.
 *
 * An empty result is an ordinary outcome, not a failure: a 305 pulled from
 * Morning and never matched to a job has no job to offer.
 */
export async function jobsBehindReceipt(
  admin: SupabaseClient,
  linkedDocumentIds: string[]
): Promise<string[]> {
  if (!linkedDocumentIds.length) return [];

  const out = new Set<string>();
  const collect = (rows: { job_id?: unknown; bundle_job_ids?: unknown }[] | null) => {
    for (const r of rows ?? []) {
      if (typeof r.job_id === "string" && r.job_id) out.add(r.job_id);
      if (Array.isArray(r.bundle_job_ids)) {
        for (const id of r.bundle_job_ids) if (typeof id === "string" && id) out.add(id);
      }
    }
  };

  const { data: pending } = await admin
    .from("pending_documents")
    .select("job_id,bundle_job_ids")
    .in("morning_doc_id", linkedDocumentIds);
  collect(pending);

  const { data: registry } = await admin
    .from("documents")
    .select("job_id,bundle_job_ids")
    .in("morning_doc_id", linkedDocumentIds);
  collect(registry);

  return Array.from(out);
}

export async function issuePendingDocument(
  admin: SupabaseClient,
  row: PendingRow,
  actorId: string,
  // The recipients to email this document to (owner spec 2026-07-29). Injected
  // into client.emails — the only way Morning emails a document, and only at
  // creation. An empty array = issue but send to NOBODY (a work order default);
  // undefined = caller opted out of the feature entirely (client.emails and
  // sent_to are left untouched). Recorded in sent_to since Morning has no
  // send-log. The caller (the review route) has already capped/sanitized it.
  recipients?: string[]
): Promise<IssueOutcome> {
  // ---- iron rule 1, before ------------------------------------------------
  if (row.morning_doc_id) {
    return { ok: false, error: "המסמך כבר הונפק", alreadyIssued: true };
  }
  if (row.status === "issued") {
    return { ok: false, error: "המסמך כבר הונפק", alreadyIssued: true };
  }

  // A document's date is its ISSUANCE date — today, in Israel time — never the
  // recording/job date baked into the payload at enqueue time (which can be a
  // month old and makes Morning reject it: "התאריך… מוקדם מדי"). Stamp it here,
  // authoritatively, so a document approved weeks after it was queued still
  // dates to the real day it goes out. Covers every doc type and every enqueue
  // path, because this is the ONLY place that calls Morning. The work date
  // stays in the line description (built at enqueue). Owner bug 2026-07-29.
  const docDate = todayInIsrael();
  const sent: MorningDocumentRequest = {
    ...row.payload,
    date: docDate,
    // recipients override client.emails so Morning emails exactly who the
    // bookkeeper chose; undefined leaves the payload's emails as-is.
    ...(recipients !== undefined
      ? { client: { ...row.payload.client, emails: recipients } }
      : {}),
  };
  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: row.id,
    event_type: "morning_call_started",
    actor_id: actorId,
    payload: { doc_type: row.doc_type, env: morningEnv(), dry_run: isDryRun(), sent },
  });

  let result;
  let dryRun = false;
  try {
    const res = await createDocument(sent);
    result = res.result;
    dryRun = res.dryRun;
  } catch (e) {
    const err = e instanceof MorningError ? e : null;
    const message = e instanceof Error ? e.message : "שגיאה לא ידועה מול מורנינג";
    // iron rule 2: nothing local is written. The row records the failure and
    // remains eligible for another attempt.
    await admin
      .from("pending_documents")
      .update({
        status: "failed",
        last_error: message,
        attempts: (row.attempts ?? 0) + 1,
      })
      .eq("id", row.id);
    await admin.from("events").insert({
      entity_type: "pending_document",
      entity_id: row.id,
      event_type: "morning_call_failed",
      actor_id: actorId,
      payload: { doc_type: row.doc_type, error: message, status: err?.status ?? null, body: err?.body ?? null, sent },
    });
    return { ok: false, error: message };
  }

  const morningDocId = result.id;
  const docNumber = String(result.number ?? "");
  const pdfUrl = result.url?.origin || result.url?.he || null;

  // ---- iron rule 1, after -------------------------------------------------
  // The id Morning just returned must not already exist locally. If it does,
  // this document was recorded by another path (a retry that actually
  // succeeded, the daily pull) — stop rather than write a second row.
  const { data: clash } = await admin
    .from("pending_documents")
    .select("id")
    .eq("morning_doc_id", morningDocId)
    .neq("id", row.id)
    .maybeSingle();
  const { data: invClash } = await admin
    .from("invoices")
    .select("id")
    .eq("morning_doc_id", morningDocId)
    .maybeSingle();

  if (clash || invClash) {
    await admin.from("events").insert({
      entity_type: "pending_document",
      entity_id: row.id,
      event_type: "morning_duplicate_detected",
      actor_id: actorId,
      payload: { morning_doc_id: morningDocId, clash_pending: clash?.id ?? null, clash_invoice: invClash?.id ?? null },
    });
    return { ok: false, error: `מסמך ${morningDocId} כבר רשום במערכת — לא נרשם פעמיים`, alreadyIssued: true };
  }

  const issuedAt = new Date().toISOString();

  // The queue row is the source of truth for the issuance itself.
  const { error: updErr } = await admin
    .from("pending_documents")
    .update({
      status: "issued",
      morning_doc_id: morningDocId,
      morning_doc_number: docNumber,
      pdf_url: pdfUrl,
      issued_at: issuedAt,
      last_error: null,
      // our send record (Morning has no send-log). [] = sent to nobody.
      ...(recipients !== undefined ? { sent_to: recipients } : {}),
    })
    .eq("id", row.id);
  if (updErr) {
    return { ok: false, error: `המסמך הונפק (${morningDocId}) אך רישומו נכשל: ${updErr.message}` };
  }

  // A bundle document covers several jobs (owner spec — one deal invoice for N
  // episodes). Read its membership tolerantly: bundle_job_ids ships in 0044, so
  // an unapplied migration just falls back to the single job_id (existing
  // behavior). The shared invoice_biz set below is the authoritative link.
  let bundleJobIds: string[] = [];
  {
    const { data: pd, error: pdErr } = await admin
      .from("pending_documents")
      .select("bundle_job_ids")
      .eq("id", row.id)
      .maybeSingle();
    if (!pdErr && Array.isArray(pd?.bundle_job_ids)) bundleJobIds = pd!.bundle_job_ids as string[];
  }
  const isBundle = bundleJobIds.length > 0;
  const bundleJobs = isBundle ? bundleJobIds : row.job_id ? [row.job_id] : [];
  // the single doc row can only point at one job — a bundle points at none
  // (its jobs are reached via the shared invoice_biz / bundle_job_ids)
  const primaryJobId = bundleJobs.length === 1 ? bundleJobs[0] : null;

  // Write-through to the documents registry (all types, incl. work orders
  // and receipts) so an app-issued document shows on the 5-tab screen at
  // once, not only after the next daily pull. Same morning_doc_id the pull
  // upserts on, so the two never duplicate.
  //
  // Its failure is now LOUD (owner decision 2026-08-12). It used to be
  // discarded, which was tolerable only while nothing read the registry; the
  // tax_variant flip now resolves a parent's type and number here and nowhere
  // else, so a missing row is a document that cannot be converted later.
  //
  // Loud does NOT mean aborting: the document already exists in Morning and the
  // queue row already says so. Stopping here would leave the invoices row
  // unwritten and the jobs unstamped — a second failure, larger than the first.
  // So the rest of the local bookkeeping runs to completion and the outcome is
  // reported at the end, exactly as a failed queue-row update already is above.
  const registryWrite = await upsertDocument(admin, {
    morning_doc_id: morningDocId,
    morning_doc_number: docNumber || null,
    type: DOC_TYPE_TO_MORNING_CODE[row.doc_type],
    client_id: row.client_id,
    amount: row.amount,
    document_date: docDate,
    pdf_url: pdfUrl,
    source: "app",
    production_id: row.production_id,
    job_id: primaryJobId,
    // only send the column when there is a bundle, so the non-bundle path
    // stays writable before 0044 is applied
    ...(isBundle ? { bundle_job_ids: bundleJobIds } : {}),
    ...(recipients !== undefined ? { sent_to: recipients } : {}),
    raw: result,
  });
  if (!registryWrite.ok) {
    await admin.from("events").insert({
      entity_type: "pending_document",
      entity_id: row.id,
      event_type: "registry_write_failed",
      actor_id: actorId,
      payload: {
        doc_type: row.doc_type,
        morning_doc_id: morningDocId,
        doc_number: docNumber,
        error: registryWrite.error,
      },
    });
  }

  // Invoices (not work orders) also land in the finance registry, so the
  // existing finance screen keeps showing every document that exists. One
  // invoices row per Morning document (morning_doc_id is unique) — a bundle
  // is one document, so one row with no single job_id.
  const regType = registryType(row.doc_type);
  if (regType && row.client_id) {
    await admin.from("invoices").insert({
      client_id: row.client_id,
      job_id: primaryJobId,
      type: regType,
      doc_number: docNumber,
      morning_doc_id: morningDocId,
      amount: row.amount ?? 0,
      issued_at: issuedAt,
      source: "morning_api",
      issued_by: actorId,
      pdf_url: pdfUrl,
    });
  }

  // Move EVERY linked job's finance state to match the document just issued: a
  // deal invoice bills it (invoice_biz → "ממתין לתשלום"), a tax invoice closes
  // the tax gap (invoice_tax). Every job in a bundle gets the SAME number —
  // that shared invoice_biz is what lets one later payment close them all.
  // Mirrors linkDocumentToJob; set only when not already present, so a re-issue
  // or a later reconcile never clobbers a real number. (A work order touches
  // nothing here.)
  //
  // ---- NOT IN DRY RUN (owner decision 2026-08-22) --------------------------
  // A dry run must not leave a mark on a job. The `dry-` prefix that makes a
  // synthetic issuance recognisable rides on morning_doc_id ONLY — the number
  // is `Math.floor(Date.now()/1000) % 1_000_000` (morning/client.ts), a bare
  // six-digit figure indistinguishable from a real Morning one, and jobs do not
  // store morning_doc_id. So `jobs.invoice_tax = '847213'` on a real job was a
  // fake number with nothing to identify it as fake.
  //
  // This is the same mistake that was already removed from the neighbouring
  // contract-milestone route on 2026-07-30 ("minted a fake DRY-nnnnnn number,
  // wrote it into a job's invoice_biz ... all without calling Morning") — it
  // simply survived here.
  //
  // documents and invoices are DELIBERATELY still written in a dry run: both
  // are keyed by the `dry-` morning_doc_id, so they are self-identifying and
  // four call sites already filter on that prefix — and the 305→320 variant
  // flip resolves its parent's type and number out of `documents` and nowhere
  // else (review/route.ts), so blocking that write would make the flip
  // impossible in any dry-run environment. The leak is the jobs stamp; these
  // are a tagged shadow ledger.
  if (dryRun && regType && bundleJobs.length) {
    await admin.from("events").insert({
      entity_type: "pending_document",
      entity_id: row.id,
      event_type: "dry_run_jobs_stamp_skipped",
      actor_id: actorId,
      payload: { doc_type: row.doc_type, doc_number: docNumber, job_ids: bundleJobs },
    });
  }
  if (!dryRun && regType && bundleJobs.length) {
    const { data: jobsData } = await admin
      .from("jobs")
      .select("id,campaign,amount,invoice_biz,invoice_tax,paid")
      .in("id", bundleJobs);

    // ---- the job's amount follows the document that bills it --------------
    // A deal invoice DEFINES the debt: it is the number the client owes and
    // the number a payment will be matched against. jobs.amount was set long
    // before, at הוקלט, from the show's default rate — and /finance and the
    // radar sum THAT column, never the document's. So when Shiri closes an
    // 800 work order and issues a corrected 400 (the discount case this whole
    // chain exists for), the job kept saying 800: 400 of debt that nobody
    // owes, and an incoming 400 payment that reconcile.ts could not match,
    // because amountBasis tolerates max(2, 1%) and the gap is 400.
    //
    // Only a deal invoice, and only while the job carries NO invoice_biz yet.
    // A 305/320 inherits its total from the 300 that came before it and must
    // not re-open a settled number; a job that already names an invoice has a
    // committed debt, and silently moving it would rewrite history.
    //
    // A BUNDLE IS DELIBERATELY LEFT ALONE. With N jobs behind one document
    // there is no trustworthy way to say which line discounted which episode:
    // the income lines are positional (bundle.ts flatMaps the folded rows in
    // order) while bundle_job_ids is a Set with no guaranteed order, and a
    // line edit can move a single price. Guessing would hand the discount to
    // the wrong job in silence. It is recorded and skipped instead — census
    // 2026-08-25: 8 issued documents map to exactly one job, 0 to several, so
    // this costs nothing today and refuses to invent a mapping tomorrow.
    if (row.doc_type === "deal_invoice" && typeof row.amount === "number") {
      const targets = (jobsData ?? []) as { id: string; campaign: string | null; amount: number | null; invoice_biz: string | null }[];
      if (targets.length === 1) {
        const job = targets[0];
        const before = job.amount === null ? null : Number(job.amount);
        const after = Number(row.amount);
        const alreadyBilled = present(job.invoice_biz);
        // a hair's difference is rounding, not a discount
        const differs = before === null || Math.abs(before - after) > 0.01;
        if (!alreadyBilled && differs) {
          const { error: alignErr } = await admin.from("jobs").update({ amount: after }).eq("id", job.id);
          await admin.from("events").insert({
            entity_type: "job",
            entity_id: job.id,
            event_type: alignErr ? "job_amount_alignment_failed" : "job_amount_aligned",
            actor_id: actorId,
            payload: {
              from: before,
              to: after,
              campaign: job.campaign,
              morning_doc_number: docNumber,
              pending_document_id: row.id,
              ...(alignErr ? { error: alignErr.message } : {}),
            },
          });
        }
      } else if (targets.length > 1) {
        await admin.from("events").insert({
          entity_type: "pending_document",
          entity_id: row.id,
          event_type: "job_amount_alignment_skipped",
          actor_id: actorId,
          payload: {
            reason: "bundled document — no reliable line-to-job mapping, amounts left untouched",
            morning_doc_number: docNumber,
            document_amount: row.amount,
            job_ids: targets.map((j) => j.id),
            job_amounts: targets.map((j) => j.amount),
          },
        });
      }
    }

    for (const job of jobsData ?? []) {
      const jobPatch = jobPatchForDocument({ docType: row.doc_type, docNumber, job });
      if (!Object.keys(jobPatch).length) continue;
      await admin.from("jobs").update(jobPatch).eq("id", job.id as string);

      // A 320 flipping paid is a money-state change, and jobs.paid has NO
      // timestamp column of its own (0001) — the job_marked_paid event is the
      // only record of WHEN the money came in. The radar's dormant-client
      // detection reads exactly this event as its payment signal (alerts.ts),
      // so skipping it here would make an actively-paying client look silent.
      // `via` says the marking was automatic, next to the existing
      // 'reconcile' / 'bundle_cascade' values.
      if (jobPatch.paid) {
        await admin.from("events").insert({
          entity_type: "job",
          entity_id: job.id,
          event_type: "job_marked_paid",
          actor_id: actorId,
          payload: {
            via: "auto_tax_receipt",
            doc_type: row.doc_type,
            morning_doc_number: docNumber,
            morning_doc_id: morningDocId,
            pending_document_id: row.id,
          },
        });
      }
    }
  }

  // ---- a RECEIPT (400) settles the jobs of the invoices it was raised on ----
  // Its own branch, not an extension of the block above: registryType returns
  // null for a receipt (it is not an invoice and gets no invoices row), so
  // `regType` gates that block shut, and bundleJobs is empty anyway — the queue
  // row is built with job_id null and no bundle_job_ids. The jobs are reached
  // through payload.linkedDocumentIds instead (jobsBehindReceipt).
  //
  // Same dry-run boundary and the same exact-'לא' rule as everything above.
  if (row.doc_type === "receipt") {
    const linkedIds = Array.isArray(row.payload?.linkedDocumentIds)
      ? (row.payload.linkedDocumentIds as string[])
      : [];
    const receiptJobs = dryRun ? [] : await jobsBehindReceipt(admin, linkedIds);

    if (dryRun) {
      await admin.from("events").insert({
        entity_type: "pending_document",
        entity_id: row.id,
        event_type: "dry_run_jobs_stamp_skipped",
        actor_id: actorId,
        payload: { doc_type: row.doc_type, doc_number: docNumber, linked_document_ids: linkedIds },
      });
    } else if (!receiptJobs.length) {
      // An ordinary outcome, not a failure — a 305 pulled from Morning and
      // never matched to a job has no job to offer. Evented all the same: the
      // silence is exactly what would otherwise have to be guessed at when
      // somebody asks why a receipt did not mark anything paid.
      await admin.from("events").insert({
        entity_type: "pending_document",
        entity_id: row.id,
        event_type: "auto_receipt_no_jobs",
        actor_id: actorId,
        payload: { doc_number: docNumber, linked_document_ids: linkedIds },
      });
    } else {
      const { data: jobsData } = await admin
        .from("jobs")
        .select("id,invoice_biz,invoice_tax,paid")
        .in("id", receiptJobs);
      for (const job of jobsData ?? []) {
        const jobPatch = jobPatchForDocument({ docType: row.doc_type, docNumber, job });
        if (!jobPatch.paid) continue;
        await admin.from("jobs").update({ paid: jobPatch.paid }).eq("id", job.id as string);

        await admin.from("events").insert({
          entity_type: "job",
          entity_id: job.id,
          event_type: "job_marked_paid",
          actor_id: actorId,
          payload: {
            via: "auto_receipt",
            doc_type: row.doc_type,
            morning_doc_number: docNumber,
            morning_doc_id: morningDocId,
            pending_document_id: row.id,
            linked_document_ids: linkedIds,
          },
        });

        // Money in, no tax invoice = a RED job, and that is the correct state:
        // it is a real exposure and the radar's red alert exists to show it.
        // Normally unreachable — the parent 305 stamps invoice_tax on the same
        // jobs, and the receipt builder refuses a `dry-` parent — so if it does
        // happen (a number cleared by hand after issuance) it is an anomaly and
        // is recorded as one rather than left to look like ordinary noise.
        if (!present(job.invoice_tax)) {
          await admin.from("events").insert({
            entity_type: "job",
            entity_id: job.id,
            event_type: "auto_receipt_paid_without_tax",
            actor_id: actorId,
            payload: {
              doc_number: docNumber,
              pending_document_id: row.id,
              linked_document_ids: linkedIds,
            },
          });
        }
      }
    }
  }

  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: row.id,
    event_type: dryRun ? "morning_document_issued_dryrun" : "morning_document_issued",
    actor_id: actorId,
    payload: {
      doc_type: row.doc_type,
      env: morningEnv(),
      dry_run: dryRun,
      morning_doc_id: morningDocId,
      doc_number: docNumber,
      pdf_url: pdfUrl,
      // owner rule 2026-07-19: a tax-authority failure must be visible
      tax_authority_last_error: result.taxAuthorityConfirmationLastError ?? null,
      tax_authority_initiated: result.taxAuthorityConfirmationInitiated ?? null,
      returned: result,
    },
  });

  // Send log (owner spec 2026-07-29): a distinct event when the document was
  // actually emailed to someone, so "what was sent, to whom, when" is auditable
  // even though Morning offers no send-log. Nobody selected → no send event.
  if (recipients && recipients.length > 0) {
    await admin.from("events").insert({
      entity_type: "pending_document",
      entity_id: row.id,
      event_type: "document_sent",
      actor_id: actorId,
      payload: { doc_type: row.doc_type, morning_doc_number: docNumber, recipients },
    });
  }

  // The document is real and every other local write succeeded — but the
  // registry row is missing, so the screens will not show it and it cannot
  // father a tax document until the next daily pull heals it. The operator has
  // to know that now, not discover it at the next conversion.
  if (!registryWrite.ok) {
    return {
      ok: false,
      error: `המסמך הונפק במורנינג (${docNumber || morningDocId}) אך רישומו במרשם המסמכים נכשל: ${registryWrite.error}. אין צורך להנפיק שוב — המשיכה היומית תשלים את הרישום`,
    };
  }

  return { ok: true, morningDocId, docNumber, pdfUrl, dryRun };
}
