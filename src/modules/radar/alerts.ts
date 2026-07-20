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

export type RadarData = {
  debtToCollect: number; // charged, not paid
  openCommitment: number; // not yet charged
  vu: VUChannel[];
  alerts: RadarAlert[];
};

const DAY = 86_400_000;

async function fetchAll<T>(supabase: SupabaseClient, table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + page - 1);
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

  const [jobs, milestones, invoices, productions, stages, jobProds, shows, clients, pendingDocs] = await Promise.all([
    fetchAll<{ amount: number | null; paid: string; invoice_tax: string | null; due_date: string | null }>(
      supabase, "jobs", "amount,paid,invoice_tax,due_date"
    ),
    fetchAll<{ id: string; amount: number; status: string; expected_date: string | null; is_estimated: boolean }>(
      supabase, "contract_milestones", "id,amount,status,expected_date,is_estimated"
    ),
    fetchAll<{ id: string; date_is_estimated: boolean }>(supabase, "invoices", "id,date_is_estimated"),
    fetchAll<{
      id: string;
      kind: string;
      show_id: string | null;
      on_hold: boolean;
      on_hold_since: string | null;
      merged_into: string | null;
      billing_block_reason: string | null;
      calendar_removed: boolean;
    }>(supabase, "productions", "id,kind,show_id,on_hold,on_hold_since,merged_into,billing_block_reason,calendar_removed"),
    fetchAll<{ production_id: string; status: string }>(supabase, "stages", "production_id,status"),
    fetchAll<{ production_id: string }>(supabase, "job_productions", "production_id"),
    fetchAll<{ id: string; billing_mode: string }>(supabase, "shows", "id,billing_mode"),
    fetchAll<{ id: string; normalized_name: string | null; name: string }>(supabase, "clients", "id,normalized_name,name"),
    fetchAll<{ id: string; status: string; created_at: string; doc_type: string; production_id: string | null }>(
      supabase, "pending_documents", "id,status,created_at,doc_type,production_id"
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
  const stagesByProd = new Map<string, string[]>();
  for (const st of stages) {
    const arr = stagesByProd.get(st.production_id) ?? [];
    arr.push(st.status);
    stagesByProd.set(st.production_id, arr);
  }
  const producedNotBilled = productions.filter((p) => {
    // merged-away (calendar duplicate merged, or split undone) is soft-
    // hidden from the whole app, including the board this alert links to —
    // it must never surface a billing alert for a row nobody can see
    if (p.merged_into) return false;
    if (p.kind !== "client") return false;
    const ss = stagesByProd.get(p.id) ?? [];
    if (ss.length < 6 || !ss.every((s) => s === "done")) return false;
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
  const stuckStage = stages.filter((s) => s.status === "in_progress"); // no timestamp yet → all in_progress
  const onHoldLong = productions.filter(
    (p) => p.on_hold && p.on_hold_since && todayMid - new Date(p.on_hold_since).getTime() > 14 * DAY
  );
  const nameGroups = new Map<string, number>();
  for (const c of clients) {
    const key = (c.normalized_name || c.name || "").trim();
    if (key) nameGroups.set(key, (nameGroups.get(key) ?? 0) + 1);
  }
  const duplicateClientNames = Array.from(nameGroups.values()).filter((n) => n > 1).length;

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

  // ---- 🟡 a production was cancelled AFTER its work order was issued in
  // Morning (owner 2026-07-19). We never delete anything in Morning — the
  // owner closes it by hand — so this is a standing reminder, not urgent.
  // Signal: the production is calendar_removed (kept, not deleted) AND an
  // issued work_order exists for it.
  const issuedWorkOrderProds = new Set(
    pendingDocs.filter((d) => d.doc_type === "work_order" && d.status === "issued" && d.production_id).map((d) => d.production_id as string)
  );
  const cancelledWithWorkOrder = productions.filter(
    (p) => p.calendar_removed && !p.merged_into && issuedWorkOrderProds.has(p.id)
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
    { key: "stuck_stage", severity: "yellow", title: "שלב תקוע מעל 14 יום", count: stuckStage.length, amount: null, href: "/productions" },
    { key: "on_hold_long", severity: "yellow", title: "מוקפא מעל 14 יום", count: onHoldLong.length, amount: null, href: "/productions" },
  ];
  const alerts = allAlerts.filter((a) => a.count > 0);

  return { debtToCollect, openCommitment, vu, alerts };
}
