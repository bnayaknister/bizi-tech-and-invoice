import type { SupabaseClient } from "@supabase/supabase-js";
import { todayInIsrael } from "@/lib/dates";
import {
  DOC_TYPE_TO_MORNING_CODE,
  VAT_TYPE_DEFAULT,
  type MorningDocumentRequest,
} from "@/lib/morning/types";

/**
 * The billing chain for one "רדיו ושונות" job: the job row, the stamp that
 * claims it, and the work order that goes to the approval queue.
 *
 * ═══ WHY THIS IS A FUNCTION AND NOT A SECOND COPY ═══
 * It has TWO callers and they are the same three steps:
 *   · api/misc-productions            — the create route, steps 3-5
 *   · api/misc-productions/[id]/work-order — step 6's "צור הזמנת עבודה" button,
 *     which retries exactly those steps for a row whose first attempt 207'd
 *
 * The kanban next door was deliberately a measured copy rather than an
 * extraction, and the difference is not taste: that was layout, this is MONEY.
 * Two copies of a Morning payload and a rollback are two things that must be
 * kept in step forever, on the path that mints documents. The house already
 * made this call once, in the database: 0060 pulled the trigger body out into
 * ensure_job_for_production so "the backfill goes through exactly the same
 * path, not a manual INSERT of its own".
 *
 * The extraction is also what makes the rollback fix below land in ONE place
 * instead of being written twice and drifting once.
 *
 * ═══ ⚠️ THE ROLLBACK ORDER, AND THE ORPHAN IT USED TO LEAVE ═══
 * misc_productions.job_id references jobs(id) with ON DELETE **NO ACTION**
 * (verified against pg_constraint, 2026-09-14). The old rollback deleted the
 * job FIRST, while job_id was still stamped, and only then nulled the column —
 * so the delete was refused by the FK and the job SURVIVED, orphaned and
 * invisible on every misc screen. Neither result was checked, so nothing said
 * a word.
 *
 * Measured on the live schema, in a block that always rolls back:
 *   [delete job while stamped: REFUSED 23503]
 *   [null job_id: done]
 *   [job rows surviving: 1]          ← the orphan
 *   [delete after nulling: SUCCEEDED]
 *
 * So the order here is the reverse — UNSTAMP, THEN DELETE — and both results
 * are read. A rollback that cannot prove it undid the thing is not a rollback,
 * it is a hope; and this one had been wrong since the route was written.
 */

export type MiscBillingInput = {
  entityId: string;
  clientId: string;
  clientName: string | null;
  morningClientId: string;
  /** the job's campaign and the order's income line — what the operator typed */
  name: string;
  /** 0064: jobs.date is the WORK date, never today */
  workDate: string;
  amount: number;
  /** the order's own wording; falls back to a built title when empty */
  description: string | null;
  actorId: string;
};

export type MiscBillingResult =
  | { ok: true; jobId: string; pendingDocumentId: string }
  | {
      ok: false;
      /**
       * `already_billed` is NOT a failure of this call — it means another
       * caller won the race and the row IS billed. Its own outcome, because
       * the two need opposite answers: every other reason invites a retry,
       * this one forbids it.
       */
      reason: "job_failed" | "link_failed" | "already_billed" | "queue_failed";
      message: string;
      /** set when a rollback could not undo its own writes — a real leak */
      leakedJobId?: string;
    };

export async function billMiscProduction(
  admin: SupabaseClient,
  input: MiscBillingInput
): Promise<MiscBillingResult> {
  const { entityId, clientId, clientName, morningClientId, name, workDate, amount, actorId } = input;

  // ---- 1. the job this order bills ----------------------------------------
  // No job_productions row: there are no productions, and that absence is the
  // honest record — the same sentence bundle-from-show:103-104 writes, and 47
  // of the 94 jobs in this database already live that way.
  const { data: job, error: jobErr } = await admin
    .from("jobs")
    .insert({
      client_id: clientId,
      campaign: name,
      amount,
      date: workDate, // 0064: jobs.date is the WORK date, not today
      paid: "לא",
      legacy: false,
    })
    .select("id")
    .single();
  if (jobErr || !job) {
    return { ok: false, reason: "job_failed", message: jobErr?.message ?? "" };
  }
  const jobId = job.id as string;

  // ---- 2. stamp the job on the entity, AND the one-job guard --------------
  // Stamped before the queue insert, not after: job_id is what the retry path
  // reads to decide whether this work is already billed, and a job that exists
  // while the entity still says job_id null is exactly the state that lets a
  // second call mint a second job for the same work.
  //
  // THE GUARD IS THE `is("job_id", null)` PREDICATE, not a read-then-write.
  // A SELECT followed by an UPDATE has a window between them; this has none —
  // two concurrent calls cannot both match, so the loser updates zero rows.
  // It was unreachable when only the create route existed (the entity was
  // born five statements earlier and nothing else knew its id); with the step 6
  // button it is reachable for real, from two tabs, and it is now the only
  // thing standing between a double click and two work orders — the database
  // offers nothing here, see the note at the queue insert below.
  //
  // AND THE RESULT IS READ, NEVER ASSUMED. PostgREST reports a zero-row UPDATE
  // as success with no error, so without this the job would be created, left
  // unlinked, and reported as billed.
  const { data: linked, error: linkErr } = await admin
    .from("misc_productions")
    .update({ job_id: jobId, updated_at: new Date().toISOString(), updated_by: actorId })
    .eq("id", entityId)
    .is("job_id", null)
    .select("id");

  if (linkErr || !linked?.length) {
    // Nothing points at the job here — the stamp is exactly what failed — so a
    // plain delete is safe and needs no unstamping first.
    const { error: delErr } = await admin.from("jobs").delete().eq("id", jobId);
    const leak = delErr ? { leakedJobId: jobId } : {};
    return linkErr
      ? { ok: false, reason: "link_failed", message: linkErr.message, ...leak }
      : { ok: false, reason: "already_billed", message: "", ...leak };
  }

  // ---- 3. the work order, into the approval queue --------------------------
  // The description INHERITS: what the operator wrote is what the client will
  // read, and the 2026-09-07 rule (bundle.ts, "THE ORDER'S OWN WORDING") exists
  // because rebuilding it cost two manual repairs on 40318.
  const docTitle = (input.description ?? "").trim() || `הזמנת עבודה — ${clientName ?? ""} ${name}`.trim();

  const payload: MorningDocumentRequest = {
    type: DOC_TYPE_TO_MORNING_CODE["work_order"],
    lang: "he",
    currency: "ILS",
    vatType: VAT_TYPE_DEFAULT,
    // issuance date, not the work date — issue.ts re-stamps at the moment it
    // calls Morning, exactly as buildDocumentPayload documents
    date: todayInIsrael(),
    description: docTitle,
    client: {
      id: morningClientId,
      name: clientName ?? undefined,
      add: false, // never auto-create a client in Morning from a document
    },
    income: [
      {
        description: name,
        quantity: 1,
        price: amount,
        currency: "ILS",
        vatType: VAT_TYPE_DEFAULT,
      },
    ],
  };

  // ⚠️ production_id IS NULL HERE, AND THAT PUTS THIS ROW OUTSIDE THE ONLY
  // UNIQUE INDEX THE QUEUE HAS. pending_documents_one_live_per_production is
  // partial — `WHERE production_id IS NOT NULL` (0063) — so a misc work order
  // is not covered by it, and there is no unique index on job_id at all
  // (six indexes on the table, checked 2026-09-14). The database will happily
  // hold two live work orders for the same misc job. The `is("job_id", null)`
  // predicate above is therefore not a belt beside a database wall; it IS the
  // wall. Same hole 0077 documented for the registry's manual enqueue path —
  // a different door into the same missing wall. Backlog.
  const { data: inserted, error: queueErr } = await admin
    .from("pending_documents")
    .insert({
      doc_type: "work_order",
      production_id: null,
      job_id: jobId,
      client_id: clientId,
      amount,
      payload,
      status: "pending",
    })
    .select("id")
    .single();

  if (queueErr || !inserted) {
    // ⚠️ UNSTAMP FIRST, THEN DELETE — see the header. The reverse order is
    // refused by the FK (23503) and leaves the job alive. Both results are
    // checked, because a job nothing points at is money-shaped litter that no
    // screen will ever show.
    const { error: unstampErr } = await admin
      .from("misc_productions")
      .update({ job_id: null, updated_at: new Date().toISOString(), updated_by: actorId })
      .eq("id", entityId)
      .eq("job_id", jobId);

    let leakedJobId: string | undefined;
    if (unstampErr) {
      // The entity still points at the job, so the job cannot be deleted and
      // must not be. Reported rather than silently retried: the row now looks
      // billed with no work order behind it, and only a human can tell which
      // of the two is wrong.
      leakedJobId = jobId;
    } else {
      const { error: delErr } = await admin.from("jobs").delete().eq("id", jobId);
      if (delErr) leakedJobId = jobId;
    }

    return {
      ok: false,
      reason: "queue_failed",
      message: queueErr?.message ?? "",
      ...(leakedJobId ? { leakedJobId } : {}),
    };
  }

  // The queue row gets its own event under its own entity, so the document's
  // log reads the same way every other queued document's does. Best-effort:
  // the work order is already in the queue, and a journal write that fails
  // must not report a queued document as failed (rule 38).
  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: inserted.id,
    event_type: "document_queued",
    actor_id: actorId,
    payload: {
      doc_type: "work_order",
      via: "misc_production",
      misc_production_id: entityId,
      job_id: jobId,
      client_id: clientId,
      amount,
    },
  });

  return { ok: true, jobId, pendingDocumentId: inserted.id as string };
}
