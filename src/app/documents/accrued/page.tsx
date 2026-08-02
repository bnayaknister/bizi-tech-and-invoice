import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayInIsrael } from "@/lib/dates";
import AppHeader from "@/components/AppHeader";
import AccruedClient, { type AccruedGroup, type AccruedMonth, type IssuedOrder } from "./AccruedClient";

export const dynamic = "force-dynamic";

// Which month an accrued episode belongs to. record_date is the business truth
// — the same anchor the rate rule uses — and created_at only stands in when the
// production carries no date yet. Both are read in Israel time: a row created
// at 01:00 on the 1st is UTC-still-last-month, and for a monthly client that
// one hour decides whether its month is "closed".
const ISRAEL_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const monthKeyOf = (recordDate: string | null, createdAt: string) =>
  recordDate ? recordDate.slice(0, 7) : ISRAEL_DAY.format(new Date(createdAt)).slice(0, 7);

const MONTH_LABEL = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", month: "long", year: "numeric" });
const monthLabel = (key: string) => MONTH_LABEL.format(new Date(`${key}-01T00:00:00Z`));

// The accrued queue (owner spec 2026-07-28): work orders frozen by a client's
// billing_cadence (monthly / every_n), grouped by client. Each group is one
// "פדה" — a consolidated work order + consolidated deal invoice. Each row can
// be individually released ("הוצא עכשיו") — the bookkeeper always overrides.
export default async function AccruedPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_money) redirect("/");

  const admin = createAdminClient();
  const { data } = await admin
    .from("pending_documents")
    .select(
      "id,amount,created_at,client_id,production_id," +
        "clients(name,billing_cadence,billing_every_n)," +
        "productions(podcast_name,record_date,guest)"
    )
    .eq("doc_type", "work_order")
    .eq("status", "accrued")
    .order("created_at", { ascending: true });

  const now = Date.now();
  // The current month and how much of it is left, in Israel time — the only
  // "target" a monthly client has. every_n counts to a number; monthly counts
  // down to a date.
  const today = todayInIsrael();
  const currentMonth = today.slice(0, 7);
  const [ty, tm, td] = today.split("-").map(Number);
  const daysToMonthEnd = new Date(Date.UTC(ty, tm, 0)).getUTCDate() - td;

  const byClient = new Map<string, AccruedGroup>();
  // per client: month key -> what accrued in it. Built alongside the rows so
  // the episodes are walked once.
  const monthsByClient = new Map<string, Map<string, { count: number; total: number }>>();
  for (const r of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const clientId = (r.client_id as string) ?? "—";
    const client = r.clients as { name?: string; billing_cadence?: string; billing_every_n?: number } | null;
    const prod = r.productions as { podcast_name?: string; record_date?: string; guest?: string } | null;
    const created = new Date(r.created_at as string).getTime();
    const ageDays = Math.floor((now - created) / 86_400_000);
    let g = byClient.get(clientId);
    if (!g) {
      g = {
        client_id: clientId,
        client_name: client?.name ?? "—",
        cadence: (client?.billing_cadence as AccruedGroup["cadence"]) ?? "per_episode",
        every_n: (client?.billing_every_n as number | null) ?? null,
        total: 0,
        oldest_age_days: 0,
        rows: [],
      };
      byClient.set(clientId, g);
    }
    g.total += Number(r.amount ?? 0);
    g.oldest_age_days = Math.max(g.oldest_age_days, ageDays);

    const mk = monthKeyOf(prod?.record_date ?? null, r.created_at as string);
    let months = monthsByClient.get(clientId);
    if (!months) {
      months = new Map();
      monthsByClient.set(clientId, months);
    }
    const bucket = months.get(mk) ?? { count: 0, total: 0 };
    bucket.count += 1;
    bucket.total += Number(r.amount ?? 0);
    months.set(mk, bucket);

    g.rows.push({
      id: r.id as string,
      amount: (r.amount as number | null) ?? null,
      show_name: prod?.podcast_name ?? "—",
      record_date: prod?.record_date ?? null,
      guest: prod?.guest ?? null,
      age_days: ageDays,
    });
  }

  // Ready-to-redeem, per cadence — the two rhythms answer different questions
  // and one shared threshold got both wrong (owner 2026-08-02):
  //   every_n  — the bundle is FULL (its actual target), or it has stalled 30+
  //              days and will plainly never fill (a show that ended at 2/6).
  //   monthly  — a month CLOSED without being redeemed. Not "30 days since the
  //              row", which for an episode recorded on the 30th only fires
  //              almost a month after that month ended.
  const groups = Array.from(byClient.values()).map((g) => {
    const months: AccruedMonth[] = Array.from(monthsByClient.get(g.client_id) ?? [])
      .map(([key, b]) => ({ key, label: monthLabel(key), count: b.count, total: b.total, closed: key < currentMonth }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const hasClosedMonth = months.some((m) => m.closed);
    return {
      ...g,
      months,
      has_closed_month: hasClosedMonth,
      days_to_month_end: daysToMonthEnd,
      ready:
        g.cadence === "every_n"
          ? (g.every_n != null && g.rows.length >= g.every_n) || g.oldest_age_days >= 30
          : g.cadence === "monthly"
            ? hasClosedMonth
            : g.oldest_age_days >= 30,
    };
  });
  groups.sort((a, b) => Number(b.ready) - Number(a.ready) || b.oldest_age_days - a.oldest_age_days);

  // Redeemed order bundles that already went out to Morning and are still
  // waiting for their deal invoice (owner spec 2026-08-02). A bundle is a
  // consolidated row: production_id is null and its episodes hang off it via
  // consolidated_into. "Waiting" = no live deal invoice links back to its
  // Morning id — the same check the builder enforces server-side.
  const { data: issuedRows } = await admin
    .from("pending_documents")
    .select("id,amount,issued_at,morning_doc_number,morning_doc_id,client_id,payload,clients(name)")
    .eq("doc_type", "work_order")
    .eq("status", "issued")
    .is("production_id", null)
    .not("morning_doc_id", "is", null)
    .order("issued_at", { ascending: true });

  const { data: liveInvoices } = await admin
    .from("pending_documents")
    .select("payload")
    .eq("doc_type", "deal_invoice")
    .in("status", ["pending", "approved", "issued"]);
  const linkedIds = new Set<string>();
  for (const r of liveInvoices ?? []) {
    for (const id of ((r.payload as { linkedDocumentIds?: string[] } | null)?.linkedDocumentIds ?? [])) {
      linkedIds.add(id);
    }
  }

  const issuedOrders: IssuedOrder[] = (issuedRows ?? [])
    .filter((r) => !linkedIds.has(r.morning_doc_id as string))
    .map((r) => {
      const income = (r.payload as { income?: unknown[] } | null)?.income ?? [];
      const client = r.clients as { name?: string } | null;
      return {
        id: r.id as string,
        client_name: client?.name ?? "—",
        doc_number: (r.morning_doc_number as string | null) ?? null,
        amount: (r.amount as number | null) ?? null,
        lines: income.length,
        issued_at: (r.issued_at as string | null) ?? null,
        dry_run: String(r.morning_doc_id ?? "").startsWith("dry-"),
      };
    });

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <AccruedClient groups={groups} issuedOrders={issuedOrders} canRedeem={!!profile.can_edit_money} />
    </div>
  );
}
