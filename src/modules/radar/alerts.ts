import type { SupabaseClient } from "@supabase/supabase-js";

export type AlertCounts = {
  paidNoTax: number;
  amountMissing: number;
  invoiceDateUnknown: number;
  criticalTotal: number; // 🔴 only
};

// Lightweight version for the hub card (step 3). Kept separate from the full
// radar so the dashboard doesn't pay for the whole engine on every load.
export async function getAlertCounts(supabase: SupabaseClient): Promise<AlertCounts> {
  const [paidNoTax, amountMissing, invoiceDateUnknown] = await Promise.all([
    supabase.from("jobs").select("id", { count: "exact", head: true }).eq("paid", "כן").is("invoice_tax", null),
    supabase.from("jobs").select("id", { count: "exact", head: true }).is("amount", null),
    supabase.from("invoices").select("id", { count: "exact", head: true }).eq("date_is_estimated", true),
  ]);
  const paidNoTaxCount = paidNoTax.count ?? 0;
  const amountMissingCount = amountMissing.count ?? 0;
  const invoiceDateUnknownCount = invoiceDateUnknown.count ?? 0;
  return {
    paidNoTax: paidNoTaxCount,
    amountMissing: amountMissingCount,
    invoiceDateUnknown: invoiceDateUnknownCount,
    criticalTotal: paidNoTaxCount + amountMissingCount,
  };
}

// ============================= full radar =============================

export type Severity = "red" | "blue" | "yellow";

export type VUChannel = {
  key: "green" | "y1" | "y2" | "red";
  label: string;
  tone: string; // css var
  count: number;
  amount: number;
  href: string;
};

export type RadarAlert = {
  key: string;
  severity: Severity;
  title: string;
  count: number;
  amount: number | null;
  href: string;
};

// a client that looks active (has a real, billing show) but has had NO
// business communication of any kind in 90+ days — owner spec 2026-07-22,
// widening the original "hasn't recorded" definition. "Business
// communication" = any of: a production, a document issued, a payment
// received, or any event logged directly against the client.
export type DormantActivityKind = "production" | "document" | "payment" | "event";
export type DormantActivity = { kind: DormantActivityKind; label: string; date: string };

export type DormantClient = {
  id: string;
  name: string;
  shows: string[]; // the active, billing shows that make this client "active"
  activities: DormantActivity[]; // most recent date per kind that ever occurred, oldest signal first — so the caller sees what this is about before picking up the phone
  daysSinceLastActivity: number | null; // days since the MOST RECENT of all four signals; null = no activity of any kind, ever
  historicalRevenue: number; // sum of all jobs.amount ever billed to this client
};

export type RadarData = {
  debtToCollect: number; // charged, not paid
  openCommitment: number; // not yet charged
  vu: VUChannel[];
  alerts: RadarAlert[];
  dormantClients: DormantClient[]; // sorted by daysSinceLastActivity desc (longest-silent first; null = no data = top)
};

const DAY = 86_400_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll<T>(supabase: SupabaseClient, table: string, columns: string, filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  const page = 1000;
  for (;;) {
    let q = supabase.from(table).select(columns);
    if (filter) q = filter(q);
    const { data, error } = await q.range(from, from + page - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < page) return out;
    from += page;
  }
}

// The whole radar in one pass. `supabase` should be a service-role client —
// the /radar page is already can_view_money-gated, and aggregate math must
// not be silently truncated by row-level policies.
export async function computeRadar(supabase: SupabaseClient): Promise<RadarData> {
  const today = new Date();
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

  const [jobs, milestones, invoices, productions, stageRollup, jobProds, shows, clients, pendingDocs, clientEvents, paymentEvents] = await Promise.all([
    fetchAll<{ id: string; amount: number | null; paid: string; invoice_tax: string | null; due_date: string | null; client_id: string | null }>(
      supabase, "jobs", "id,amount,paid,invoice_tax,due_date,client_id"
    ),
    fetchAll<{ id: string; amount: number; status: string; expected_date: string | null; is_estimated: boolean }>(
      supabase, "contract_milestones", "id,amount,status,expected_date,is_estimated"
    ),
    fetchAll<{ id: string; date_is_estimated: boolean }>(supabase, "invoices", "id,date_is_estimated"),
    fetchAll<{
      id: string;
      kind: string;
      show_id: string | null;
      client_id: string | null;
      record_date: string | null;
      on_hold: boolean;
      on_hold_since: string | null;
      merged_into: string | null;
      billing_block_reason: string | null;
      calendar_removed: boolean;
      status: string;
    }>(supabase, "productions", "id,kind,show_id,client_id,record_date,on_hold,on_hold_since,merged_into,billing_block_reason,calendar_removed,status"),
    // per-production stage counts from the rollup view (migration 0035) — one
    // round-trip of ~1 row per production instead of paging every ~4.3k raw
    // stage rows. total/done drive the "produced but never billed" check;
    // in_progress feeds the stuck-stage count below.
    fetchAll<{ production_id: string; total: number; done: number; in_progress: number }>(
      supabase, "production_stage_rollup", "production_id,total,done,in_progress"
    ),
    fetchAll<{ production_id: string }>(supabase, "job_productions", "production_id"),
    fetchAll<{ id: string; client_id: string | null; billing_mode: string; active: boolean; name: string }>(
      supabase, "shows", "id,client_id,billing_mode,active,name"
    ),
    fetchAll<{ id: string; normalized_name: string | null; name: string }>(supabase, "clients", "id,normalized_name,name"),
    fetchAll<{ id: string; status: string; created_at: string; doc_type: string; production_id: string | null; client_id: string | null; issued_at: string | null }>(
      supabase, "pending_documents", "id,status,created_at,doc_type,production_id,client_id,issued_at"
    ),
    // "any event related to the client" (owner spec 2026-07-22, widening the
    // dormant-client definition) — events logged directly against a client
    // entity (client edits, Morning propagation failures, etc.), not events
    // on productions/jobs that merely belong to one (those are covered by
    // the production/document/payment signals). Scoped by entity_type so
    // this stays a bounded query, not a full-table scan of `events`.
    // event_type is pulled so the administrative/system events below can be
    // dropped — they are NOT signs of a live relationship (see ADMIN_EVENTS).
    fetchAll<{ entity_id: string; created_at: string; event_type: string }>(supabase, "events", "entity_id,created_at,event_type", (q) =>
      q.eq("entity_type", "client")
    ),
    // payment-received signal: jobs.paid flips with no timestamp column of
    // its own (0001) — the only record of WHEN is the job_marked_paid event
    // (entity_type='job', entity_id=job id), joined to jobs.client_id below.
    fetchAll<{ entity_id: string; created_at: string }>(supabase, "events", "entity_id,created_at", (q) =>
      q.eq("event_type", "job_marked_paid")
    ),
  ]);

  const num = (v: number | null | undefined) => (v == null ? 0 : Number(v));
  const overdueDays = (due: string) => Math.floor((todayMid - new Date(due).getTime()) / DAY);

  // ---- two numbers (never summed) ----
  const debtJobs = jobs.filter((j) => j.paid === "לא" && j.amount != null);
  const debtToCollect = debtJobs.reduce((s, j) => s + num(j.amount), 0);
  const openCommitment = milestones
    .filter((m) => m.status === "pending")
    .reduce((s, m) => s + num(m.amount), 0);

  // ---- 4 VU channels, counted from due_date (screens-spec §4) ----
  const vuBuckets = { green: [] as number[], y1: [] as number[], y2: [] as number[], red: [] as number[] };
  for (const j of debtJobs) {
    if (!j.due_date) continue;
    const od = overdueDays(j.due_date);
    const amt = num(j.amount);
    if (od < 0) vuBuckets.green.push(amt);
    else if (od <= 30) vuBuckets.y1.push(amt);
    else if (od <= 60) vuBuckets.y2.push(amt);
    else vuBuckets.red.push(amt);
  }
  const ch = (key: VUChannel["key"], label: string, tone: string, arr: number[]): VUChannel => ({
    key,
    label,
    tone,
    count: arr.length,
    amount: arr.reduce((s, a) => s + a, 0),
    href: `/finance?vu=${key}`,
  });
  const vu: VUChannel[] = [
    ch("green", "בזמן", "var(--green)", vuBuckets.green),
    ch("y1", "1–30 באיחור", "var(--amber)", vuBuckets.y1),
    ch("y2", "31–60 באיחור", "var(--amber)", vuBuckets.y2),
    ch("red", "60+ באיחור", "var(--red)", vuBuckets.red),
  ];

  // ---- 🔵 produced but never billed — the silencing rule is load-bearing ----
  // kind='client' (never internal/contract) AND all 6 stages done AND no
  // job_productions link AND the show doesn't bill_mode='none'. active is
  // irrelevant — a closed show still owes (the Cinematheque precedent).
  const billingModeByShow = new Map(shows.map((s) => [s.id, s.billing_mode]));
  const linkedProductions = new Set(jobProds.map((jp) => jp.production_id));
  const rollupByProd = new Map(stageRollup.map((r) => [r.production_id, r]));
  const producedNotBilled = productions.filter((p) => {
    // merged-away (calendar duplicate merged, or split undone) is soft-
    // hidden from the whole app, including the board this alert links to —
    // it must never surface a billing alert for a row nobody can see
    if (p.merged_into) return false;
    if (p.kind !== "client") return false;
    // "all 6 stages done" — total>=6 AND every stage done (done===total). The
    // rollup gives these counts directly; a production with no stage rows at
    // all has no rollup entry and is correctly not "produced".
    const rl = rollupByProd.get(p.id);
    if (!rl || rl.total < 6 || rl.done !== rl.total) return false;
    if (linkedProductions.has(p.id)) return false;
    if (p.show_id && billingModeByShow.get(p.show_id) === "none") return false;
    return true;
  });

  // ---- other alerts ----
  const paidNoTax = jobs.filter((j) => j.paid === "כן" && !j.invoice_tax);
  const amountMissing = jobs.filter((j) => j.amount == null);
  const unknownPayment = jobs.filter((j) => j.paid === "לא ידוע");
  const estimatedInvoiceDate = invoices.filter((i) => i.date_is_estimated);
  const milestoneOverdue = milestones.filter(
    (m) => m.status === "pending" && m.expected_date && new Date(m.expected_date).getTime() < todayMid && !m.is_estimated
  );
  const approachingDue = debtJobs.filter((j) => {
    if (!j.due_date) return false;
    const od = overdueDays(j.due_date);
    return od < 0 && od >= -7; // due within the next 7 days
  });
  const openMilestones = milestones.filter((m) => m.status === "pending");
  // a milestone whose expected date is within the next 14 days — a heads-up
  // to invoice before it slips into the overdue (red) bucket
  const milestoneApproaching = milestones.filter((m) => {
    if (m.status !== "pending" || !m.expected_date) return false;
    const days = Math.floor((new Date(m.expected_date).getTime() - todayMid) / DAY);
    return days >= 0 && days <= 14;
  });
  const stuckStageCount = stageRollup.reduce((s, r) => s + r.in_progress, 0); // no per-stage timestamp yet → every in_progress stage counts
  const onHoldLong = productions.filter(
    (p) => p.on_hold && p.on_hold_since && todayMid - new Date(p.on_hold_since).getTime() > 14 * DAY
  );
  const nameGroups = new Map<string, number>();
  for (const c of clients) {
    const key = (c.normalized_name || c.name || "").trim();
    if (key) nameGroups.set(key, (nameGroups.get(key) ?? 0) + 1);
  }
  const duplicateClientNames = Array.from(nameGroups.values()).filter((n) => n > 1).length;

  // ---- 🔵 dormant clients — "no business communication in 90+ days"
  // (owner spec 2026-07-22, widening the original recording-only definition
  // from 2026-07-21). "Active" for this purpose still means at least one
  // show that is BOTH active=true AND actually bills (billing_mode !=
  // 'none') — an internal show or one that already ended shouldn't make a
  // client look active just because its row hasn't been archived. A client
  // with no qualifying show is silently skipped, exactly like billing
  // eligibility elsewhere in this file: no document owed = no alert, not a
  // lesser alert. (There's no separate "archived client" state in this
  // schema today — a deleted client is gone from `clients` entirely, so
  // that exception is satisfied by construction; nothing to filter here.)
  //
  // "Business communication" = the most recent of FOUR independent signals.
  // The client is dormant only if ALL FOUR are 90+ days stale (or never
  // happened at all) — any one of them being recent keeps the client off
  // the list:
  //   1. production  — productions.record_date (the original signal)
  //   2. document    — pending_documents.issued_at where status='issued'
  //   3. payment     — the job_marked_paid event on one of the client's jobs
  //                    (jobs.paid has no timestamp column of its own — 0001 —
  //                    so the event log is the only record of WHEN it flipped)
  //   4. event       — any events row logged directly against the client
  //                    entity (entity_type='client'); NOT events on
  //                    productions/jobs that merely belong to the client —
  //                    those are already covered by signals 1–3
  const DORMANT_DAYS = 90;
  const activeBillingShowsByClient = new Map<string, string[]>();
  for (const s of shows) {
    if (!s.client_id || !s.active || s.billing_mode === "none") continue;
    const arr = activeBillingShowsByClient.get(s.client_id) ?? [];
    arr.push(s.name);
    activeBillingShowsByClient.set(s.client_id, arr);
  }

  const keepLatest = (map: Map<string, string>, key: string, dateIso: string) => {
    const cur = map.get(key);
    if (!cur || dateIso > cur) map.set(key, dateIso);
  };

  // signal 1: production (excluding merged-away rows — soft-hidden
  // system-wide; the survivor row carries the same date already).
  //
  // The client link is resolved production -> show -> client, NOT off
  // productions.client_id alone: 216 of the 710 historical (legacy) rows
  // carry no client_id and are attached only through show_id (the import
  // set client_id on the show, not on every back-filled production). Reading
  // client_id directly made those clients look like they had never recorded —
  // the exact false "dormant / never recorded" signal the owner flagged
  // (2026-07-22). The history is precisely what this alert is about, so
  // every production counts, legacy or not, and the show is a valid bridge
  // to its client when the row itself doesn't name one.
  const showClientId = new Map(shows.filter((s) => s.client_id).map((s) => [s.id, s.client_id as string]));
  const lastProductionByClient = new Map<string, string>();
  for (const p of productions) {
    if (p.merged_into || !p.record_date) continue;
    const clientId = p.client_id ?? (p.show_id ? showClientId.get(p.show_id) : undefined);
    if (!clientId) continue;
    keepLatest(lastProductionByClient, clientId, p.record_date);
  }

  // signal 2: document issued
  const lastDocumentByClient = new Map<string, string>();
  for (const d of pendingDocs) {
    if (d.status !== "issued" || !d.client_id || !d.issued_at) continue;
    keepLatest(lastDocumentByClient, d.client_id, d.issued_at);
  }

  // signal 3: payment received — job_marked_paid events, joined via job id
  const clientByJobId = new Map(jobs.filter((j) => j.client_id).map((j) => [j.id, j.client_id as string]));
  const lastPaymentByClient = new Map<string, string>();
  for (const e of paymentEvents) {
    const clientId = clientByJobId.get(e.entity_id);
    if (!clientId) continue;
    keepLatest(lastPaymentByClient, clientId, e.created_at);
  }

  // signal 4: any event logged directly against the client — but ONLY events
  // that actually represent a live relationship. Administrative/system
  // bookkeeping is excluded: 'morning_client_mapped' is the owner wiring a
  // client to its Green-Invoice id, 'client_created' is the row first being
  // entered — neither is business communication. Without this filter a single
  // bulk mapping pass (39 clients mapped in one sitting, 2026-07-20) makes
  // every mapped client look freshly active and the alert silently reports
  // ZERO dormant clients — the opposite false signal to the legacy-link bug,
  // and exactly the "cry wolf" the owner warned against. Keep this list to
  // system-generated types only; real contact events must still count.
  //
  // ⚠️ MAINTENANCE (owner 2026-07-22): every NEW client event_type added
  // anywhere in the app must be triaged against THIS set before it can move
  // the dormancy clock. Ask: is it real business communication, or system
  // noise? The safe default is NOISE — if you are not certain it represents
  // genuine contact with the client, add it here so it does NOT count as
  // activity. A false "active" silences the alert (the morning_client_mapped
  // bug); a false "dormant" at worst prompts a phone call. Err toward calling.
  const ADMIN_EVENTS = new Set(["morning_client_mapped", "client_created"]);
  const lastEventByClient = new Map<string, string>();
  for (const e of clientEvents) {
    if (ADMIN_EVENTS.has(e.event_type)) continue;
    keepLatest(lastEventByClient, e.entity_id, e.created_at);
  }

  // total historical business volume, not just what's been collected — size
  // of the relationship is what makes a client worth a phone call, paid or not
  const revenueByClient = new Map<string, number>();
  for (const j of jobs) {
    if (!j.client_id) continue;
    revenueByClient.set(j.client_id, (revenueByClient.get(j.client_id) ?? 0) + num(j.amount));
  }

  const ACTIVITY_LABEL: Record<DormantActivityKind, string> = {
    production: "הקלטה אחרונה",
    document: "מסמך אחרון",
    payment: "תשלום אחרון",
    event: "פעילות אחרונה",
  };

  const dormantClients: DormantClient[] = [];
  for (const c of clients) {
    const activeShows = activeBillingShowsByClient.get(c.id);
    if (!activeShows || activeShows.length === 0) continue;

    const byKind: [DormantActivityKind, string | undefined][] = [
      ["production", lastProductionByClient.get(c.id)],
      ["document", lastDocumentByClient.get(c.id)],
      ["payment", lastPaymentByClient.get(c.id)],
      ["event", lastEventByClient.get(c.id)],
    ];
    const activities: DormantActivity[] = byKind
      .filter((x): x is [DormantActivityKind, string] => !!x[1])
      .map(([kind, date]) => ({ kind, label: ACTIVITY_LABEL[kind], date }));

    // the client is dormant only if the MOST RECENT of all four signals is
    // 90+ days old — one recent signal is enough to keep them off the list
    const mostRecent = activities.reduce<string | null>(
      (max, a) => (max === null || a.date > max ? a.date : max),
      null
    );
    const daysSince = mostRecent ? Math.floor((todayMid - new Date(mostRecent).getTime()) / DAY) : null;
    if (daysSince !== null && daysSince < DORMANT_DAYS) continue;

    dormantClients.push({
      id: c.id,
      name: c.name,
      shows: activeShows,
      activities,
      daysSinceLastActivity: daysSince,
      historicalRevenue: revenueByClient.get(c.id) ?? 0,
    });
  }
  // sorted by how long they've been dormant, longest first (owner 2026-07-22):
  // this list answers "who do I call" and the answer is whoever has gone
  // silent the longest, NOT whoever billed the most. historicalRevenue stays
  // in the payload as context on the row, never as the sort key. null
  // (no activity data of any kind) is the most extreme silence — it sorts to
  // the very top, ahead of any finite day count.
  dormantClients.sort((a, b) => {
    const av = a.daysSinceLastActivity ?? Infinity;
    const bv = b.daysSinceLastActivity ?? Infinity;
    return bv - av;
  });

  // ---- 🟡 a client production that should bill but can't (owner 2026-07-19):
  // billing_block_reason is set ONLY for applicable blocks (missing client /
  // unmapped client / no rate), never for internal or legacy — so this
  // counts real problems, not correct silence. Merged-away rows stay hidden.
  const billingBlocked = productions.filter((p) => !p.merged_into && p.billing_block_reason);

  // ---- document approval queue aging (owner 2026-07-19): 24h -> the
  // bookkeeper is nudged, 72h -> the owner too, here on the radar. A queue
  // nobody empties is the exact leak this system was built to prevent.
  const pendingNow = pendingDocs.filter((d) => d.status === "pending");
  const agedHours = (d: { created_at: string }) => (Date.now() - new Date(d.created_at).getTime()) / (DAY / 24);
  const pending72 = pendingNow.filter((d) => agedHours(d) >= 72);
  const pending24 = pendingNow.filter((d) => agedHours(d) >= 24 && agedHours(d) < 72);

  // ---- 🟡 a production is gone (cancelled, or its calendar event removed)
  // AFTER a document was already issued in Morning (owner 2026-07-19/21). We
  // never delete anything in Morning — the owner closes it by hand — so this
  // is a standing reminder. Signal: the production is calendar_removed or
  // status='בוטל', and an issued work order OR deal invoice exists for it.
  const issuedDocProds = new Set(
    pendingDocs
      .filter((d) => d.status === "issued" && (d.doc_type === "work_order" || d.doc_type === "deal_invoice") && d.production_id)
      .map((d) => d.production_id as string)
  );
  const cancelledWithWorkOrder = productions.filter(
    (p) => (p.calendar_removed || p.status === "בוטל") && !p.merged_into && issuedDocProds.has(p.id)
  );

  const sum = (arr: { amount: number | null }[]) => arr.reduce((s, x) => s + num(x.amount), 0);

  const allAlerts: RadarAlert[] = [
    { key: "pending_docs_72h", severity: "red", title: "מסמכים ממתינים לאישור מעל 72 שעות", count: pending72.length, amount: null, href: "/documents" },
    { key: "paid_no_tax", severity: "red", title: "שולם — ואין חשבונית מס", count: paidNoTax.length, amount: sum(paidNoTax), href: "/finance?filter=paid_no_tax" },
    { key: "amount_missing", severity: "red", title: "חיוב ללא סכום", count: amountMissing.length, amount: null, href: "/finance?filter=amount_missing" },
    { key: "overdue_60", severity: "red", title: "60+ יום מעבר לפירעון", count: vuBuckets.red.length, amount: vuBuckets.red.reduce((s, a) => s + a, 0), href: "/finance?vu=red" },
    { key: "milestone_overdue", severity: "red", title: "אבן דרך שעבר מועדה ואין חשבונית", count: milestoneOverdue.length, amount: milestoneOverdue.reduce((s, m) => s + num(m.amount), 0), href: "/contracts" },
    { key: "produced_not_billed", severity: "blue", title: "הופק ולא חויב", count: producedNotBilled.length, amount: null, href: "/productions" },
    { key: "open_commitment", severity: "blue", title: "התחייבות פתוחה", count: openMilestones.length, amount: openCommitment, href: "/contracts" },
    { key: "billing_blocked", severity: "yellow", title: "הפקת לקוח חסומה לחיוב", count: billingBlocked.length, amount: null, href: "/productions" },
    { key: "cancelled_with_work_order", severity: "yellow", title: "הפקה בוטלה אחרי שהונפקה הזמנת עבודה — לסגור במורנינג", count: cancelledWithWorkOrder.length, amount: null, href: "/productions" },
    { key: "pending_docs_24h", severity: "yellow", title: "מסמכים ממתינים לאישור מעל 24 שעות", count: pending24.length, amount: null, href: "/documents" },
    { key: "unknown_payment", severity: "yellow", title: "סטטוס תשלום חסר", count: unknownPayment.length, amount: sum(unknownPayment), href: "/finance?filter=unknown_payment" },
    { key: "estimated_invoice_date", severity: "yellow", title: "תאריך חשבונית משוער", count: estimatedInvoiceDate.length, amount: null, href: "/finance?filter=estimated" },
    { key: "milestone_approaching", severity: "yellow", title: "אבן דרך בעוד 14 יום", count: milestoneApproaching.length, amount: milestoneApproaching.reduce((s, m) => s + num(m.amount), 0), href: "/contracts" },
    { key: "approaching_due", severity: "yellow", title: "מתקרב לפירעון (7 ימים) ואין חשבונית", count: approachingDue.length, amount: approachingDue.reduce((s, j) => s + num(j.amount), 0), href: "/finance?vu=green" },
    { key: "duplicate_clients", severity: "yellow", title: "אותו לקוח בשמות שונים", count: duplicateClientNames, amount: null, href: "/finance" },
    { key: "stuck_stage", severity: "yellow", title: "שלב תקוע מעל 14 יום", count: stuckStageCount, amount: null, href: "/productions" },
    { key: "on_hold_long", severity: "yellow", title: "מוקפא מעל 14 יום", count: onHoldLong.length, amount: null, href: "/productions" },
  ];
  const alerts = allAlerts.filter((a) => a.count > 0);

  return { debtToCollect, openCommitment, vu, alerts, dormantClients };
}
