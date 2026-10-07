import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getSessionAndProfile } from "@/lib/profile";
import { selectColumns } from "@/lib/entities";
import { deriveState, isUnpaidDebt } from "@/lib/finance/state";
import { todayInIsrael } from "@/lib/dates";
import {
  buildClientList,
  overdueDays,
  type ClientListRow,
  type ClientRow,
  type JobRow,
  type ShowRow,
} from "@/lib/clients/overview";
import type { FieldMeta } from "@/components/EntityFieldRows";
import type { Profile } from "@/lib/profile";
import { canSeeClients } from "@/lib/clients/access";
import { clientFieldMeta } from "@/lib/clients/fields";

/**
 * The /clients server reads. Shared by the list page and /clients/[id] so the
 * two can never show a different list for the same user.
 *
 * ═══ WHY THE CARD'S DATA IS FETCHED PER CLIENT ═══
 * The LIST needs three tables (clients, shows, jobs). The CARD needs three
 * more (contracts, documents, productions) — and `documents` alone passed 1,000
 * rows long ago. PostgREST caps an unbounded select at 1,000 and says nothing
 * about it, so "load everything and group in memory" is a screen that silently
 * stops showing a client's older documents. Scoping those three to
 * `client_id = <the open card>` keeps every result small and the whole question
 * disappears. The list's own three are paginated instead, because a list cannot
 * be scoped.
 *
 * ═══ SERVICE ROLE, SAME AS /finance AND /radar ═══
 * Both pages gate on `owner || can_view_money` before anything is read, and an
 * aggregate must not be silently truncated by row-level policies — a debt
 * total that is missing rows is worse than no debt total. The field metadata
 * below is still computed from the VIEWER's profile, so what the card offers to
 * edit is their permission and not the service role's.
 */

/**
 * Every row of a table, 1,000 at a time. The same shape radar/alerts.ts uses
 * and for the same reason: a plain `.select()` stops at 1,000 rows with no
 * error, so an unpaginated money aggregate is wrong as soon as the business
 * grows past that — quietly, and in the direction of under-reporting.
 */
async function fetchAll<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  table: string,
  columns: string
): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

/** a job row with the three columns only the card reads */
type CardJobRow = JobRow & {
  campaign: string | null;
  invoice_biz: string | null;
  invoice_tax: string | null;
};

export type ClientCardJob = {
  id: string;
  date: string | null;
  campaign: string | null;
  amount: number | null;
  paid: string | null;
  due_date: string | null;
  state: ReturnType<typeof deriveState>;
  overdueDays: number | null;
};

export type ClientCard = {
  id: string;
  name: string;
  /** the six billing columns, exactly as the drawer's GET returns them */
  entity: Record<string, unknown>;
  fields: FieldMeta[];
  shows: { id: string; name: string; active: boolean | null }[];
  contracts: {
    id: string;
    name: string | null;
    status: string | null;
    total_amount: number | null;
    start_date: string | null;
    end_date: string | null;
  }[];
  debt: number;
  debtJobs: ClientCardJob[];
  documents: {
    id: string;
    type: string | null;
    morning_doc_number: string | null;
    document_date: string | null;
    amount: number | null;
    pdf_url: string | null;
    cancelled_at: string | null;
  }[];
  productions: {
    id: string;
    podcast_name: string | null;
    record_date: string | null;
    status: string | null;
  }[];
};

export type ClientsScreenData = {
  rows: ClientListRow[];
  card: ClientCard | null;
  canEditMoney: boolean;
  today: string;
};

export async function loadClientsScreen(selectedId: string | null): Promise<
  { ok: false } | { ok: true; profile: Profile; data: ClientsScreenData }
> {
  const { user, profile } = await getSessionAndProfile();
  if (!user || !canSeeClients(profile)) return { ok: false };
  const p = profile as Profile;

  const admin = createAdminClient();
  const today = todayInIsrael();

  const [clients, shows, jobs]: [ClientRow[], ShowRow[], CardJobRow[]] = await Promise.all([
    fetchAll<ClientRow>(admin, "clients", "id,name,normalized_name,morning_client_id,merged_into"),
    fetchAll<ShowRow>(admin, "shows", "id,name,client_id,active"),
    // campaign/invoice_biz/invoice_tax are for the CARD's debt table and its
    // deriveState colour. Three more columns on a read the list already makes,
    // rather than a second query on the same table.
    fetchAll<CardJobRow>(admin, "jobs", "id,client_id,amount,paid,due_date,date,dismissed,campaign,invoice_biz,invoice_tax"),
  ]);

  const rows = buildClientList(clients, shows, jobs, today);

  let card: ClientCard | null = null;
  if (selectedId) {
    const base = clients.find((c) => c.id === selectedId) ?? null;
    if (base) card = await loadCard(base, shows, jobs, today, p);
  }

  return { ok: true, profile: p, data: { rows, card, canEditMoney: !!p.can_edit_money, today } };
}

async function loadCard(
  base: ClientRow,
  shows: ShowRow[],
  jobs: CardJobRow[],
  today: string,
  profile: Profile
): Promise<ClientCard> {
  const admin = createAdminClient();

  // The six billing columns through the VIEWER's own client, not the service
  // role: `selectColumns` builds the list from what this profile may SEE, and
  // reading it under RLS is what keeps the card's editable fields and the row
  // it edits on the same permission footing as the drawer.
  const viewer = createClient();
  const { data: entity } = await viewer
    .from("clients")
    .select(selectColumns("client", profile))
    .eq("id", base.id)
    .maybeSingle();

  // scoped by client_id — small by construction, so no pagination and no cap
  const [contracts, documents, productions] = await Promise.all([
    admin
      .from("contracts")
      .select("id,name,status,total_amount,start_date,end_date")
      .eq("client_id", base.id)
      .order("start_date", { ascending: false }),
    admin
      .from("documents")
      .select("id,type,morning_doc_number,document_date,amount,pdf_url,cancelled_at")
      .eq("client_id", base.id)
      .is("archived_at", null)
      .order("document_date", { ascending: false })
      .limit(20),
    admin
      .from("productions")
      .select("id,podcast_name,record_date,status,cancelled_at,merged_into")
      .eq("client_id", base.id)
      .is("cancelled_at", null)
      .is("merged_into", null)
      .order("record_date", { ascending: false })
      .limit(20),
  ]);

  // the client's own jobs, re-read from the rows already in memory. `deriveState`
  // is the /finance pipeline colour — the same function, so "פיגור" and the
  // colour on this card mean what they mean on the money screen.
  const mine = jobs.filter((j) => j.client_id === base.id && !j.dismissed);
  const listRow = buildClientList([base], shows, jobs, today)[0];
  const debtJobs: ClientCardJob[] = mine
    .filter(isUnpaidDebt)
    .map((j) => ({
      id: j.id,
      date: j.date,
      campaign: j.campaign,
      amount: j.amount,
      paid: j.paid,
      due_date: j.due_date,
      state: deriveState({ paid: j.paid, invoice_biz: j.invoice_biz, invoice_tax: j.invoice_tax }),
      // positive = days past due; null = not overdue, or no due date at all.
      // The same arithmetic the list column uses, from the same function.
      overdueDays: overdueOf(j.due_date, today),
    }))
    .sort((a, b) => (b.overdueDays ?? -1) - (a.overdueDays ?? -1));

  return {
    id: base.id,
    name: base.name,
    entity: (entity as Record<string, unknown> | null) ?? { id: base.id, name: base.name },
    fields: clientFieldMeta(profile),
    shows: shows
      .filter((s) => s.client_id === base.id)
      .map((s) => ({ id: s.id, name: s.name, active: s.active })),
    contracts: (contracts.data ?? []) as ClientCard["contracts"],
    debt: listRow?.debt ?? 0,
    debtJobs,
    documents: (documents.data ?? []) as ClientCard["documents"],
    productions: (productions.data ?? []) as ClientCard["productions"],
  };
}

/** overdueDays from the pure module, narrowed to "only if actually late" */
function overdueOf(due: string | null, today: string): number | null {
  if (!due) return null;
  const d = overdueDays(due, today);
  return d != null && d > 0 ? d : null;
}
