import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayInIsrael } from "@/lib/dates";
import { buildAccruedCards, type AccruedQueueRow } from "@/lib/documents/accruedCards";
import AppHeader from "@/components/AppHeader";
import AccruedClient, { type IssuedOrder } from "./AccruedClient";

export const dynamic = "force-dynamic";

// The accrued queue (owner spec 2026-07-28): work orders frozen by a client's
// billing_cadence (monthly / every_n). Each card is one "פדה" — a consolidated
// work order, which the approval path then turns into a deal invoice. Each row
// can be individually released ("הוצא עכשיו") — the bookkeeper always
// overrides.
//
// Grouped by client, EXCEPT a monthly client: one card per recording month
// (owner 2026-10-04). That rule, the month key and the ordering all live in
// buildAccruedCards so they can be tested without a database, and so the
// redemption route can filter by the same partition it draws.
export default async function AccruedPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_money) redirect("/");

  const admin = createAdminClient();
  const { data } = await admin
    .from("pending_documents")
    .select(
      // `payload` is read for the guest flag (owner spec 2026-08-25) and for
      // nothing else. Until now this screen showed productions.guest beside
      // every row while holding no copy of the document at all — so a row whose
      // frozen line does NOT name that guest looked identical to one that does,
      // and the screen actively reassured about the exact rows it should have
      // warned on. These are the rows a redemption folds VERBATIM, which makes
      // this the last screen where the text can still be fixed cheaply.
      "id,amount,created_at,client_id,production_id,payload," +
        "clients(name,billing_cadence,billing_every_n)," +
        "productions(podcast_name,record_date,guest,status,cancelled_at)"
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

  // The cards, built by a PURE function (src/lib/documents/accruedCards.ts).
  // It used to be ~90 lines of grouping inline here, which is why the split it
  // now performs had no way to be tested: this component needs a session and
  // the database to run at all. Everything above stays here — auth, the query,
  // the Israel-time clock — and the decision of which row lands in which card
  // is the part that moved, because that is the part that handles money.
  //
  // The cast is the one this file always carried: PostgREST cannot type a
  // two-level join through a string select, so `data` arrives as
  // GenericStringError[]. AccruedQueueRow is the shape the select above
  // actually returns, and it is asserted here rather than inside the builder so
  // the builder stays honestly typed for its tests.
  const groups = buildAccruedCards((data ?? []) as unknown as AccruedQueueRow[], {
    currentMonth,
    daysToMonthEnd,
    now,
  });

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
