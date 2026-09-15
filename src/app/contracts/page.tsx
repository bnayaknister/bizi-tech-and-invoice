import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import { deriveMilestoneState } from "@/lib/finance/milestone";
import { MORNING_DOC_CODE } from "@/lib/morning/types";
import ContractsClient, { type ContractCard } from "./ContractsClient";

export const dynamic = "force-dynamic";

export default async function ContractsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_money) redirect("/"); // money-only screen

  const admin = createAdminClient();
  const [{ data: contracts }, { data: milestones }, { data: clients }, { data: jobs }, { data: queued }] =
    await Promise.all([
      admin.from("contracts").select("id,name,client_id,total_amount,status").order("created_at"),
      admin
        .from("contract_milestones")
        .select("id,contract_id,name,amount,expected_date,is_estimated,status,job_id")
        .order("expected_date", { nullsFirst: true }),
      // morning_client_id rides along so the screen can say WHY a milestone
      // cannot be issued instead of hiding the button — an unmapped client is
      // the one refusal the bookkeeper can fix herself.
      admin.from("clients").select("id,name,morning_client_id"),
      admin.from("jobs").select("id,invoice_biz,invoice_tax,date,paid"),
      // Every queue row that can bear on a milestone's buttons. It cannot be
      // read off `jobs`: that table models the deal invoice (invoice_biz) and
      // the tax document (invoice_tax) and has no column for a 100 at all.
      //
      // NO `job_id is not null` filter, and that is the whole trick. A tax row
      // built by taxFromParent carries `job_id: null` and puts its jobs in
      // `bundle_job_ids` instead — verified on the one real 305 in the data
      // (#50068, job_id null). Filtering on job_id would drop every tax row and
      // the screen would offer a tax button for a document already queued.
      //
      // 'pending' is in the status list on purpose: it is what makes a button
      // disappear the moment it is clicked, not only once Shiri approves.
      admin
        .from("pending_documents")
        .select("id,doc_type,status,job_id,bundle_job_ids,morning_doc_id,amount")
        .in("doc_type", ["work_order", "deal_invoice", "tax_invoice", "tax_receipt"])
        .in("status", ["pending", "approved", "issued"]),
    ]);

  const clientName = new Map((clients ?? []).map((c) => [c.id, c.name]));
  const clientMapped = new Map((clients ?? []).map((c) => [c.id, !!c.morning_client_id]));
  const jobById = new Map((jobs ?? []).map((j) => [j.id, j]));

  // null and "" both mean "no document number" — a blank string is not one.
  const present = (v: unknown) => v != null && String(v).trim() !== "";

  // ---- wave 2: the registry rows behind the numbers stamped on the jobs ----
  //
  // WHY THIS READ EXISTS AT ALL — `jobs.invoice_tax` cannot tell 305 from 320.
  //
  // issue.ts:101-103 writes that one column for BOTH tax types, so a milestone
  // that got a חשבונית מס and one that got a חשבונית מס / קבלה are
  // indistinguishable from the job alone. They need opposite treatment: a 320
  // already contains the payment and closes the milestone, while a 305 is a
  // debt still waiting for money and must be able to father a receipt.
  //
  // The queue rows in `queued` can classify a tax document — they carry the
  // doc_type — but only for documents this app issued. Measured 2026-09-15:
  // ONE of the three milestones holding an invoice_tax (מכירת ביפו "חלק א",
  // #60166) has zero tax queue rows, because it was raised by hand in Morning
  // and reached us on the pull. Classifying from the queue alone would leave
  // that row unexplained — which is the blank row this whole change is fixing.
  // `documents.type` answers all three, so it leads and the queue row is the
  // fallback.
  //
  // `raw` rides along because the receipt builder's openness gate reads it
  // (receiptFromTaxInvoice.ts readOpenness) and this screen has to predict that
  // verdict to decide whether the button is live, disabled, or absent. Bounded
  // by two numbers per milestone — ten rows today — so it is fetched whole
  // rather than through a view that would have to be kept in step with the
  // builder.
  const milestoneJobs = (milestones ?? [])
    .map((m) => (m.job_id ? jobById.get(m.job_id) : null))
    .filter((j): j is NonNullable<typeof j> => !!j);
  const docNumbers = Array.from(
    new Set(
      milestoneJobs
        .flatMap((j) => [j.invoice_biz, j.invoice_tax])
        .filter((n): n is string => present(n))
        .map((n) => String(n).trim())
    )
  );

  const [{ data: taxDocs }, { data: liveReceipts }] = await Promise.all([
    docNumbers.length
      ? admin
          .from("documents")
          .select("id,morning_doc_id,morning_doc_number,type,document_date,cancelled_at,raw")
          .in("morning_doc_number", docNumbers)
      : Promise.resolve({ data: [] as unknown[] }),
    // Every receipt still alive in the queue. NOT filtered by job, and that is
    // not laziness: createReceiptFromTaxInvoices inserts a 400 with job_id NULL
    // and no bundle_job_ids (it says so in as many words — "there is nothing for
    // bundle_job_ids to carry"), so a receipt is unreachable from the milestone's
    // job by any join. The only thing tying it to its parent is
    // payload.linkedDocumentIds, which is exactly what the builder's own
    // idempotency gate matches on. Two rows exist in the whole account today;
    // reading them all and matching in memory is cheaper than a contains() query
    // per milestone and uses the same key the server does.
    admin
      .from("pending_documents")
      .select("id,status,payload")
      .eq("doc_type", "receipt")
      .in("status", ["pending", "approved", "issued"]),
  ]);

  type RegistryDoc = {
    id: string;
    morning_doc_id: string | null;
    morning_doc_number: string | null;
    type: number | null;
    document_date: string | null;
    cancelled_at: string | null;
    raw: unknown;
  };
  const docByNumber = new Map<string, RegistryDoc>();
  for (const d of ((taxDocs ?? []) as unknown as RegistryDoc[])) {
    if (d.morning_doc_number) docByNumber.set(String(d.morning_doc_number).trim(), d);
  }

  // the Morning ids already spoken for by a live receipt
  const receiptedMorningIds = new Set<string>();
  for (const r of ((liveReceipts ?? []) as { payload: unknown }[])) {
    const ids = (r.payload as { linkedDocumentIds?: unknown } | null)?.linkedDocumentIds;
    if (Array.isArray(ids)) for (const v of ids) if (typeof v === "string") receiptedMorningIds.add(v);
  }

  /**
   * The receipt verdict, predicted here so the button can be honest before it
   * is pressed rather than after.
   *
   * This MIRRORS the server and does not replace it — createReceiptFromTaxInvoices
   * re-runs every one of these gates and owns the outcome. What it buys is the
   * difference between a button that fails and a button that explains: the three
   * refusal sentences are imported from RECEIPT_NOTICE, so the tooltip and the
   * error are the same words.
   *
   * `awaiting_pull` is the one that will be hit in practice. A document the app
   * just issued carries the Morning POST response in `raw`, which has no `ref`
   * and no `amount`, so the receipt cannot be priced until the nightly pull
   * replaces it. That is a wait measured in hours, and it is stated on the
   * button instead of being discovered by clicking it.
   */
  const receiptVerdict = (raw: unknown): "ready" | "awaiting_pull" | "closed" | "not_allowed" => {
    if (!raw || typeof raw !== "object") return "awaiting_pull";
    const rec = raw as Record<string, unknown>;
    if (!("ref" in rec) || !Array.isArray(rec.ref)) return "awaiting_pull";
    // the gross is read from the same raw, so a raw without one cannot price a
    // receipt even when `ref` looks inviting
    if (rec.amount === null || rec.amount === undefined || !Number.isFinite(Number(rec.amount))) {
      return "awaiting_pull";
    }
    const codes = (rec.ref as unknown[]).map((v) => Number(v)).filter((n) => Number.isFinite(n));
    if (!codes.length) return "closed";
    return codes.includes(MORNING_DOC_CODE.receipt) ? "ready" : "not_allowed";
  };

  type QueueRow = {
    id: string;
    doc_type: string;
    status: string;
    job_id: string | null;
    bundle_job_ids: string[] | null;
    morning_doc_id: string | null;
    amount: number | null;
  };
  // A row bears on a job through EITHER column — job-anchored documents use
  // job_id, tax documents use bundle_job_ids.
  const rowsForJob = new Map<string, QueueRow[]>();
  for (const q of (queued ?? []) as QueueRow[]) {
    const targets = Array.from(
      new Set<string>([...(q.job_id ? [q.job_id] : []), ...(q.bundle_job_ids ?? [])])
    );
    for (const j of targets) rowsForJob.set(j, [...(rowsForJob.get(j) ?? []), q]);
  }

  // "Issued for real": the three conditions taxFromParent enforces server-side
  // before it will link to a parent. A dry-run issuance mints a synthetic
  // "dry-" id that is not a Morning document, so a row carrying one can never
  // father anything — offering a button for it would promise a 409.
  const reallyIssued = (q: QueueRow) =>
    q.status === "issued" && present(q.morning_doc_id) && !String(q.morning_doc_id).startsWith("dry-");

  const cards: ContractCard[] = (contracts ?? []).map((c) => {
    const ms = (milestones ?? []).filter((m) => m.contract_id === c.id);
    const milestoneCards = ms.map((m) => {
      const job = m.job_id ? jobById.get(m.job_id) : null;
      const rows = m.job_id ? rowsForJob.get(m.job_id) ?? [] : [];
      // The amount on the most authoritative issued parent: the deal invoice if
      // one went out, otherwise the work order.
      const issuedParent =
        rows.find((q) => q.doc_type === "deal_invoice" && reallyIssued(q)) ??
        rows.find((q) => q.doc_type === "work_order" && reallyIssued(q)) ??
        null;
      const issuedAmount = issuedParent?.amount ?? null;
      const state = deriveMilestoneState({
        status: m.status,
        expected_date: m.expected_date,
        is_estimated: m.is_estimated,
        jobPaid: job?.paid ?? null,
      });
      const invoiceNumber =
        state === "paid" ? job?.invoice_tax ?? job?.invoice_biz ?? null : job?.invoice_biz ?? null;

      // ---- which tax document, and what may still be raised on it ----------
      const taxNumber = present(job?.invoice_tax) ? String(job!.invoice_tax).trim() : null;
      const taxDoc = taxNumber ? docByNumber.get(taxNumber) ?? null : null;
      const taxQueueRow =
        rows.find((q) => (q.doc_type === "tax_invoice" || q.doc_type === "tax_receipt") && reallyIssued(q)) ?? null;

      // documents.type leads (it answers for pulled documents too); the queue
      // row is the fallback; null means nobody can say, and a row that cannot
      // say says nothing rather than guessing.
      const taxKind: "tax_invoice" | "tax_receipt" | null =
        taxDoc?.type === MORNING_DOC_CODE.tax_receipt
          ? "tax_receipt"
          : taxDoc?.type === MORNING_DOC_CODE.tax_invoice
            ? "tax_invoice"
            : taxQueueRow
              ? (taxQueueRow.doc_type as "tax_invoice" | "tax_receipt")
              : null;

      // The chain, for a milestone whose buttons are gone: what actually went
      // out, in the order it went out. Read off rows already in hand.
      const bizNumber = present(job?.invoice_biz) ? String(job!.invoice_biz).trim() : null;
      const bizDoc = bizNumber ? docByNumber.get(bizNumber) ?? null : null;

      // A receipt is offered on a 305 and never on anything else. Both doors
      // the route accepts are supported: `source_id` when the app issued the
      // 305 and it has a queue row, `document_id` when it was raised by hand in
      // Morning and only the pull knows about it. One or the other, never both
      // — the route refuses a request carrying a mix.
      const isTaxInvoice = taxKind === "tax_invoice";
      const taxMorningId = taxQueueRow?.morning_doc_id ?? taxDoc?.morning_doc_id ?? null;
      const alreadyReceipted = !!taxMorningId && receiptedMorningIds.has(taxMorningId);
      const receiptSourceId =
        isTaxInvoice && taxQueueRow && taxQueueRow.doc_type === "tax_invoice" ? taxQueueRow.id : null;
      const receiptDocumentId = isTaxInvoice && !receiptSourceId && taxDoc ? taxDoc.id : null;

      const receiptFacts = {
        tax_kind: taxKind,
        tax_doc_number: taxNumber,
        tax_doc_date: taxDoc?.document_date ?? null,
        deal_doc_number: bizNumber,
        deal_doc_date: bizDoc?.document_date ?? null,
        // null = no receipt button at all (not a 305, or one already exists)
        receipt_state:
          !isTaxInvoice || alreadyReceipted || (!receiptSourceId && !receiptDocumentId)
            ? null
            : receiptVerdict(taxDoc?.raw ?? null),
        receipt_source_id: receiptSourceId,
        receipt_document_id: receiptDocumentId,
        // a receipt already in the queue, so the screen can say so instead of
        // offering a button that would answer "כבר קיימת קבלה על סמכו"
        has_receipt: alreadyReceipted,
      };

      return {
        id: m.id,
        name: m.name,
        amount: m.amount as number,
        expected_date: m.expected_date,
        is_estimated: m.is_estimated,
        status: m.status,
        state,
        job_id: m.job_id,
        // the linked job's number, shown whatever the state — an 'open'
        // milestone with a job attached was invisible before (owner 2026-08-22)
        job_number: job ? job.invoice_tax ?? job.invoice_biz ?? null : null,
        invoice_number: invoiceNumber,
        invoice_date: state === "paid" || state === "invoiced" ? job?.date ?? null : null,
        // The facts the issue buttons need, kept SEPARATE. The fields above
        // collapse both columns into one string (`invoice_tax ?? invoice_biz`),
        // which is right for display and useless for a decision: it cannot tell
        // a job that has been billed from one that has not.
        has_work_order: rows.some((q) => q.doc_type === "work_order"),
        has_deal_invoice: present(job?.invoice_biz),
        has_tax_document: present(job?.invoice_tax),
        // The parent ids stage 2 issues against. Only a really-issued row can
        // be one; a queued or dry-run parent is not a Morning document.
        work_order_source_id: rows.find((q) => q.doc_type === "work_order" && reallyIssued(q))?.id ?? null,
        deal_invoice_source_id: rows.find((q) => q.doc_type === "deal_invoice" && reallyIssued(q))?.id ?? null,
        // In flight, not yet issued. A queued deal invoice hides the tax button
        // (owner decision): building the tax document on the work order while a
        // 300 is a click away would close the order and strand the 300 open —
        // the `order_not_closed` alert, self-inflicted.
        has_queued_deal_invoice: rows.some((q) => q.doc_type === "deal_invoice" && !reallyIssued(q)),
        has_queued_tax: rows.some((q) => (q.doc_type === "tax_invoice" || q.doc_type === "tax_receipt")),
        // The amount that actually went out, when a parent has been issued —
        // the milestone's own amount can be edited afterwards and then the two
        // disagree. Display only; nothing is blocked on it.
        issued_amount: issuedAmount,
        ...receiptFacts,
      };
    });
    const paidSum = milestoneCards.filter((m) => m.state === "paid").reduce((t, m) => t + m.amount, 0);
    return {
      id: c.id,
      name: c.name,
      client_id: c.client_id,
      client_name: c.client_id ? clientName.get(c.client_id) ?? null : null,
      client_mapped: c.client_id ? clientMapped.get(c.client_id) ?? false : false,
      total_amount: c.total_amount as number,
      paid_sum: paidSum,
      status: c.status,
      // derived from the DISPLAY state, never the raw status column: a
      // milestone whose linked job is paid reads 'paid' here while its status
      // column still says 'invoiced' (milestone.ts). A badge only — nothing
      // closes the contract on its own.
      all_paid: milestoneCards.length > 0 && milestoneCards.every((m) => m.state === "paid"),
      milestones: milestoneCards,
    };
  });

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main>
        <ContractsClient
          contracts={cards}
          clients={(clients ?? []) as { id: string; name: string }[]}
          canEditMoney={profile.can_edit_money}
        />
      </main>
    </div>
  );
}
