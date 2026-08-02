import type { SupabaseClient } from "@supabase/supabase-js";
import { DOC_TYPE_TO_MORNING_CODE, VAT_TYPE_DEFAULT, type MorningDocumentRequest } from "@/lib/morning/types";
import { todayInIsrael } from "@/lib/dates";

// Bundling: several per-episode documents folded into ONE Morning document with
// a line per episode. Two shapes share this file so redemption (owner spec
// 2026-07-28) reuses the exact same primitives as the manual finance bundle
// (0044) rather than growing a parallel one:
//   • deal invoice (300) — bundles JOBS; the shared invoice_biz set at issue
//     time is what lets a single later payment close them all (mark-paid
//     cascade). This is the function the /documents/bundle route also calls.
//   • work order (100) — bundles the ACCRUED work-order queue rows; touches no
//     job (a work order is not an invoice). The individual rows are marked
//     'consolidated' and point at the new bundle row.
//
// Neither talks to Morning: they enqueue a 'pending' row that flows through the
// existing approval → issue path (same brakes, same human gate).

const present = (v: unknown) => v != null && String(v).trim() !== "";
const LIVE_STATUSES = ["pending", "approved", "issued"];

export type BundleResult =
  | { ok: true; id: string; amount: number; lines: number }
  | { ok: false; status: number; error: string };

/**
 * Build ONE deal invoice for N jobs of the same Morning client. Every job must
 * be unbilled and free of a live pending deal invoice, and all must map to one
 * Morning client. Accepts 1+ jobs (a redemption of a single approved episode is
 * a one-line invoice); the UI route enforces its own ≥2 minimum on top.
 */
export async function createDealInvoiceBundle(
  admin: SupabaseClient,
  jobIds: string[],
  actorId: string | null
): Promise<BundleResult> {
  const ids = Array.from(new Set(jobIds.filter(Boolean)));
  if (ids.length < 1) return { ok: false, status: 400, error: "אין עבודות לאיגוד" };

  const { data: jobs } = await admin
    .from("jobs")
    .select("id,client_id,amount,campaign,date,invoice_biz")
    .in("id", ids);
  if (!jobs || jobs.length !== ids.length) {
    return { ok: false, status: 409, error: "חלק מהעבודות לא נמצאו — רענן ונסה שוב" };
  }

  const alreadyBilled = jobs.filter((j) => present(j.invoice_biz));
  if (alreadyBilled.length) {
    return { ok: false, status: 409, error: `${alreadyBilled.length} מהעבודות כבר חויבו — הסר אותן מהבחירה` };
  }

  const { data: livePending } = await admin
    .from("pending_documents")
    .select("job_id,bundle_job_ids")
    .eq("doc_type", "deal_invoice")
    .in("status", LIVE_STATUSES);
  const claimed = new Set<string>();
  for (const p of livePending ?? []) {
    if (p.job_id) claimed.add(p.job_id as string);
    for (const bid of (p.bundle_job_ids as string[] | null) ?? []) claimed.add(bid);
  }
  if (ids.some((id) => claimed.has(id))) {
    return { ok: false, status: 409, error: "לחלק מהעבודות כבר יש חשבון עסקה בתור — רענן ונסה שוב" };
  }

  const clientIds = Array.from(new Set(jobs.map((j) => j.client_id).filter(Boolean))) as string[];
  const { data: clients } = await admin.from("clients").select("id,name,morning_client_id").in("id", clientIds);
  const morningIds = new Set((clients ?? []).map((c) => c.morning_client_id).filter(Boolean));
  if (morningIds.size !== 1) {
    return {
      ok: false,
      status: 400,
      error: "כל העבודות חייבות להיות של אותו לקוח מורנינג — הבחירה כוללת יותר מלקוח אחד או לקוח לא ממופה",
    };
  }
  const morningClientId = Array.from(morningIds)[0] as string;
  const primaryClient = (clients ?? []).find((c) => c.morning_client_id === morningClientId)!;

  if (jobs.some((j) => j.amount == null)) {
    return { ok: false, status: 400, error: "לכל עבודה חייב להיות סכום — השלם אותם קודם" };
  }

  const ordered = ids.map((id) => jobs.find((j) => j.id === id)!);
  const lineDesc = (j: (typeof jobs)[number]) =>
    `${(j.campaign as string | null) ?? ""} ${(j.date as string | null) ?? ""}`.trim() || "פרק";
  const total = ordered.reduce((s, j) => s + Number(j.amount), 0);

  const payload: MorningDocumentRequest = {
    type: DOC_TYPE_TO_MORNING_CODE["deal_invoice"],
    lang: "he",
    currency: "ILS",
    vatType: VAT_TYPE_DEFAULT,
    date: todayInIsrael(), // issuance date, not the work dates (issue.ts re-stamps)
    description: `חשבון עסקה מאוגד — ${primaryClient.name ?? ""} (${ordered.length} עבודות)`.trim(),
    client: { id: morningClientId, name: (primaryClient.name as string | null) ?? undefined, add: false },
    income: ordered.map((j) => ({
      description: lineDesc(j),
      quantity: 1,
      price: Number(j.amount),
      currency: "ILS",
      vatType: VAT_TYPE_DEFAULT,
    })),
  };

  const { data: inserted, error } = await admin
    .from("pending_documents")
    .insert({
      doc_type: "deal_invoice",
      production_id: null,
      job_id: null,
      bundle_job_ids: ids,
      client_id: primaryClient.id,
      amount: total,
      payload,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) return { ok: false, status: 400, error: error.message };

  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: inserted.id,
    event_type: "document_queued",
    actor_id: actorId,
    payload: { doc_type: "deal_invoice", via: "bundle", job_ids: ids, client_id: primaryClient.id, amount: total, lines: ordered.length },
  });

  return { ok: true, id: inserted.id, amount: total, lines: ordered.length };
}

/**
 * Build ONE deal invoice FROM an already-issued work order, linked to it in
 * Morning (owner spec 2026-08-02). This is the second half of redemption: the
 * work order goes out first, and the invoice is created "based on" it, which is
 * also what closes the order on Morning's side (verified live 2026-08-02 —
 * linking flips the order to status=1; linkType is not required, and `remarks`
 * is generated by Morning from the link, so we must not write it ourselves).
 *
 * The income lines are INHERITED verbatim from the order's frozen payload, so
 * the invoice can never total something different from the order it closes.
 * `description` is the one field rebuilt — it is independent and stored as sent.
 *
 * Takes an explicit queue-row id, never a client lookup: a monthly client can
 * hold several issued order bundles at once (one per redemption) and nothing
 * distinguishes them, so guessing would bill the wrong month's episodes.
 */
export async function createDealInvoiceFromWorkOrder(
  admin: SupabaseClient,
  workOrderPendingId: string,
  actorId: string | null
): Promise<BundleResult> {
  const { data: wo } = await admin
    .from("pending_documents")
    .select("id,doc_type,status,client_id,amount,payload,morning_doc_id,morning_doc_number")
    .eq("id", workOrderPendingId)
    .maybeSingle();
  if (!wo) return { ok: false, status: 404, error: "הזמנת העבודה לא נמצאה" };
  if (wo.doc_type !== "work_order") {
    return { ok: false, status: 400, error: "אפשר ליצור חשבון עסקה על סמך הזמנת עבודה בלבד" };
  }

  // Only an ISSUED order has a Morning id to link to. The messages name the
  // fix, not the rule — the bookkeeper reads them mid-task.
  if (wo.status !== "issued") {
    const why =
      wo.status === "pending" || wo.status === "approved"
        ? "ההזמנה עדיין לא הונפקה — אשרי אותה קודם"
        : wo.status === "accrued"
          ? "ההזמנה מסוכמת וטרם נפדתה"
          : "ההזמנה לא קיימת במורנינג";
    return { ok: false, status: 409, error: why };
  }
  const linkedId = wo.morning_doc_id as string | null;
  if (!linkedId) return { ok: false, status: 409, error: "ההזמנה לא קיימת במורנינג" };
  // A dry-run issuance mints a synthetic `dry-…` id (morning/client.ts) that is
  // not a real Morning UUID. Sending it as a link would produce a confusing
  // rejection, so it is refused here rather than at the API boundary.
  if (linkedId.startsWith("dry-")) {
    return { ok: false, status: 409, error: "ההזמנה הונפקה במצב הרצה יבשה — אין מסמך אמיתי במורנינג לקשר אליו" };
  }

  // Idempotency: a live deal invoice already carrying this order's id in its
  // linkedDocumentIds means the conversion already happened. Morning also marks
  // the order closed, but that only reaches us on the next daily pull — this
  // check is local and immediate.
  const { data: already } = await admin
    .from("pending_documents")
    .select("id,status,morning_doc_number")
    .eq("doc_type", "deal_invoice")
    .in("status", LIVE_STATUSES)
    .contains("payload", { linkedDocumentIds: [linkedId] });
  if (already && already.length) {
    return { ok: false, status: 409, error: "כבר קיים חשבון עסקה על סמך ההזמנה הזו" };
  }

  const payloadIn = wo.payload as MorningDocumentRequest | null;
  const income = payloadIn?.income ?? [];
  const client = payloadIn?.client;
  if (!client?.id || income.length === 0) {
    return { ok: false, status: 400, error: "נתוני ההזמנה חסרים — לא ניתן לבנות חשבון עסקה" };
  }

  // The jobs this invoice bills: the order's folded source rows still carry
  // their production_id, and by now those episodes are client-approved so a job
  // exists. bundle_job_ids is what makes issue.ts stamp the SAME invoice_biz on
  // every one of them — the shared number the mark-paid cascade needs.
  const { data: sources } = await admin
    .from("pending_documents")
    .select("production_id")
    .eq("consolidated_into", workOrderPendingId);
  const productionIds = (sources ?? []).map((s) => s.production_id).filter(Boolean) as string[];
  let jobIds: string[] = [];
  if (productionIds.length) {
    const { data: jp } = await admin.from("job_productions").select("job_id").in("production_id", productionIds);
    jobIds = Array.from(new Set((jp ?? []).map((r) => r.job_id).filter(Boolean))) as string[];
  }

  const { data: clientRow } = wo.client_id
    ? await admin.from("clients").select("name").eq("id", wo.client_id as string).maybeSingle()
    : { data: null };
  const clientName = (clientRow?.name as string | null) ?? client.name ?? "";

  const payload: MorningDocumentRequest = {
    type: DOC_TYPE_TO_MORNING_CODE["deal_invoice"],
    lang: "he",
    currency: "ILS",
    vatType: VAT_TYPE_DEFAULT,
    date: todayInIsrael(), // issuance date, not the work dates (issue.ts re-stamps)
    description: `חשבון עסקה מאוגד — ${clientName} (${income.length} פרקים)`.trim(),
    client: { id: client.id, name: client.name, add: false },
    income, // inherited verbatim: the invoice must total exactly what the order did
    // the link itself. linkType is deliberately absent (not required), and
    // remarks is left to Morning, which writes "חשבון עסקה עבור הזמנה NNNNN".
    linkedDocumentIds: [linkedId],
  };

  const { data: inserted, error } = await admin
    .from("pending_documents")
    .insert({
      doc_type: "deal_invoice",
      production_id: null,
      job_id: null,
      bundle_job_ids: jobIds.length ? jobIds : null,
      client_id: wo.client_id,
      amount: wo.amount, // the order's total, never recomputed
      payload,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) return { ok: false, status: 400, error: error.message };

  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: inserted.id,
    event_type: "document_queued",
    actor_id: actorId,
    payload: {
      doc_type: "deal_invoice",
      via: "from_work_order",
      work_order_pending_id: workOrderPendingId,
      linked_morning_doc_id: linkedId,
      linked_morning_doc_number: wo.morning_doc_number ?? null,
      client_id: wo.client_id,
      amount: wo.amount,
      lines: income.length,
      job_ids: jobIds,
    },
  });

  return { ok: true, id: inserted.id, amount: Number(wo.amount ?? 0), lines: income.length };
}

// One accrued work-order queue row, as read for consolidation.
export type AccruedWorkOrder = {
  id: string;
  client_id: string | null;
  amount: number | null;
  production_id: string | null;
  payload: MorningDocumentRequest;
};

/**
 * Fold N accrued work-order rows into ONE consolidated work order (a line per
 * episode) and mark each source row 'consolidated', pointing at the new row.
 * All rows must share one client. Touches no job.
 */
export async function createWorkOrderBundle(
  admin: SupabaseClient,
  rows: AccruedWorkOrder[],
  actorId: string | null
): Promise<BundleResult> {
  if (rows.length < 1) return { ok: false, status: 400, error: "אין הזמנות עבודה מסוכמות לפדיון" };

  const clientIds = Array.from(new Set(rows.map((r) => r.client_id).filter(Boolean)));
  if (clientIds.length !== 1) return { ok: false, status: 400, error: "כל ההזמנות חייבות להיות של אותו לקוח" };

  // every accrued work order carries exactly one income line (the base session
  // — add-ons never touch a work order); concatenating gives one line/episode.
  const baseClient = rows[0].payload?.client;
  const income = rows.flatMap((r) => r.payload?.income ?? []);
  if (!baseClient?.id || income.length === 0) {
    return { ok: false, status: 400, error: "נתוני ההזמנות המסוכמות חסרים — לא ניתן לאחד" };
  }
  const total = rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);

  const payload: MorningDocumentRequest = {
    type: DOC_TYPE_TO_MORNING_CODE["work_order"],
    lang: "he",
    currency: "ILS",
    vatType: VAT_TYPE_DEFAULT,
    date: todayInIsrael(), // issuance date, not the work dates (issue.ts re-stamps)
    description: `הזמנת עבודה מאוגדת — ${baseClient.name ?? ""} (${rows.length} פרקים)`.trim(),
    client: { id: baseClient.id, name: baseClient.name, add: false },
    income,
  };

  const { data: inserted, error } = await admin
    .from("pending_documents")
    .insert({
      doc_type: "work_order",
      production_id: null,
      job_id: null,
      client_id: clientIds[0],
      amount: total,
      payload,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) return { ok: false, status: 400, error: error.message };

  // fold the source rows: 'consolidated' is a terminal, still-blocking state
  // (the recast unique index keeps 06:00 from re-queuing these productions).
  await admin
    .from("pending_documents")
    .update({ status: "consolidated", consolidated_into: inserted.id })
    .in("id", rows.map((r) => r.id));

  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: inserted.id,
    event_type: "document_queued",
    actor_id: actorId,
    payload: { doc_type: "work_order", via: "bundle", source_ids: rows.map((r) => r.id), client_id: clientIds[0], amount: total, lines: income.length },
  });

  return { ok: true, id: inserted.id, amount: total, lines: income.length };
}
