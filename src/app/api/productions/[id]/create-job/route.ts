import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionAndProfile } from "@/lib/profile";
import { todayInIsrael } from "@/lib/dates";
import { suggestJobAmount, type ProductionForBilling, type ShowForBilling } from "@/lib/documents/enqueue";
import { createJobGate, jobAmountError } from "@/lib/productions/createJob";

// "יצירת עבודה לחיוב" — one job for one production that has none, priced by a
// human who is looking at the number (owner decision 2026-10-04).
//
// GET  returns whether this production needs one, and what to OFFER.
// POST creates the job and the link. It issues NOTHING.
//
// ═══ WHY THIS ROUTE AND NOT ensure_job_for_production ═══
// The RPC exists and does the same two writes, and it was still the wrong
// door. It DERIVES the amount from effectivePrice (0090:175-204), which is
// exactly what both live cases cannot do: מכון דוידסון's show is per_hour with
// no hours on a historical episode, so the RPC would mint a job carrying
// `amount = null` and the note "יש להשלים סכום". The owner's decision was a
// number they see and confirm, and a route that accepts one is the only shape
// that honours it. It also refuses on status (0061), which both of these rows
// would survive but neither should have to argue with.
//
// ═══ WHY THIS CANNOT ISSUE ANYTHING — THREE STRUCTURAL REASONS ═══
//   1. This file does not import enqueueDocument, issuePendingDocument, or the
//      Morning client. The only writes below are `jobs`, `job_productions` and
//      `events`. (`suggestJobAmount` is pure arithmetic over two rows.)
//   2. `jobs` carries no INSERT trigger that queues anything. The only one on
//      insert is trg_compute_due_date (0002:278-281), which sets new.due_date
//      and returns — which is also why due_date is NOT computed here.
//   3. `job_productions` carries no triggers at all (measured: zero CREATE
//      TRIGGER statements naming it across supabase/migrations).
//
// ═══ WHY THE DUPLICATE IT COULD CAUSE CANNOT HAPPEN ═══
// A production that gets a job here and LATER moves status — SFI's two rows
// are in 'ממתין_לתגובת_לקוח' and the client is expected to approve them — fires
// trg_on_production_approved → ensure_job_for_production, whose duplicate
// guard is `if exists (select 1 from job_productions where production_id =
// p_id)` (0090:160-166). It writes a `client_approved_already_billed` event and
// returns null. No second job. That guard is the whole reason this route is
// allowed to write the link at all.
//
// ═══ WHAT THIS DOES NOT DO, ON PURPOSE ═══
// It does not stamp `pending_documents.job_id` on the production's open work
// order the way ensure_job_for_production does (0077). Nothing needs it:
// resolveParentWorkOrderLink finds the order by `production_id`
// (parentRef.ts:168-172), never by job_id, so the consolidated deal invoice
// resolves 10311/10312 the moment the link below exists. 0077's note 3 already
// records that column as a known-null for orders that arrive after their job,
// and says the fix belongs at the three enqueue sites — not here.

const PROD_SELECT =
  "id,kind,legacy,client_id,contract_id,show_id,podcast_name,record_date,guest,price_override,status,studio_hours,cancelled_at,merged_into";

type ProdRow = {
  id: string;
  kind: string | null;
  legacy: boolean | null;
  client_id: string | null;
  contract_id: string | null;
  show_id: string | null;
  podcast_name: string | null;
  record_date: string | null;
  guest: string | null;
  price_override: number | null;
  status: string | null;
  studio_hours: number | null;
  cancelled_at: string | null;
  merged_into: string | null;
};

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Everything both verbs need, read once.
 *
 * The admin client, and that is the permission note: `shows.hourly_rate` and
 * `shows.default_rate` are NOT granted to `authenticated` (0022, 0067:189), so
 * a user-scoped read would silently return null for the rate and the
 * suggestion would come back empty on exactly the hourly show this feature was
 * built for. The gate is the explicit `can_edit_money` check in each verb —
 * the same shape record-billed/route.ts:61-62 uses, and for the same reason.
 */
async function load(admin: Admin, id: string) {
  const { data: prod } = await admin.from("productions").select(PROD_SELECT).eq("id", id).maybeSingle();
  if (!prod) return { error: "ההפקה לא נמצאה", status: 404 as const };
  const p = prod as unknown as ProdRow;

  const [{ data: links }, showRes] = await Promise.all([
    admin.from("job_productions").select("job_id").eq("production_id", id),
    p.show_id
      ? admin
          .from("shows")
          .select("id,client_id,billing_mode,default_rate,pricing_model,hourly_rate")
          .eq("id", p.show_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const show = (showRes.data ?? null) as ShowForBilling | null;

  // The production's own client wins; the show's is the fallback, which is the
  // same precedence every other creation path applies (calendar sync writes
  // prod.client_id FROM the show, and ensure_job_for_production then copies the
  // production's). A production whose client was cleared but whose show still
  // has one is still billable to that client.
  const clientId = p.client_id ?? show?.client_id ?? null;

  return { prod: p, show, clientId, jobIds: (links ?? []).map((l) => l.job_id as string).filter(Boolean) };
}

function forBilling(p: ProdRow): ProductionForBilling {
  return {
    id: p.id,
    kind: p.kind,
    legacy: p.legacy,
    client_id: p.client_id,
    show_id: p.show_id,
    podcast_name: p.podcast_name,
    record_date: p.record_date,
    guest: p.guest,
    price_override: p.price_override,
    status: p.status,
    studio_hours: p.studio_hours,
  };
}

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const { user, profile } = await getSessionAndProfile();
  if (!user || !profile?.approved) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  if (!profile.can_edit_money) {
    return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });
  }

  const admin = createAdminClient();
  const ctx = await load(admin, params.id);
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { prod, show, clientId, jobIds } = ctx;

  const gate = createJobGate({
    hasJob: jobIds.length > 0,
    cancelled: !!prod.cancelled_at,
    clientId,
  });

  return NextResponse.json({
    can_create: gate.ok,
    blocked: gate.ok ? null : gate.error,
    show_name: prod.podcast_name,
    record_date: prod.record_date,
    guest: prod.guest,
    // null = no offer. The screen leaves the field empty and says so.
    suggested_amount: suggestJobAmount(forBilling(prod), show),
  });
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const { user, profile } = await getSessionAndProfile();
  if (!user || !profile?.approved) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  if (!profile.can_edit_money) {
    return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    amount?: number | string | null;
    suggested_amount?: number | string | null;
  };

  // ---- validation: everything, before anything is written -----------------
  // ONE spelling of "which numbers are money", shared with the form.
  const amountErr = jobAmountError(body.amount);
  if (amountErr) return NextResponse.json({ error: amountErr }, { status: 400 });
  const amount = Number(body.amount);

  const admin = createAdminClient();
  const ctx = await load(admin, params.id);
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { prod, clientId, jobIds } = ctx;

  // Re-asked here and not trusted from the GET: the three facts are about money
  // landing on a job that already exists, and the drawer's copy may be minutes
  // old. `hasJob` in particular can become true between the two calls — another
  // tab, or a status transition that fired the trigger.
  const gate = createJobGate({
    hasJob: jobIds.length > 0,
    cancelled: !!prod.cancelled_at,
    clientId,
  });
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  // ---- 1. the job -------------------------------------------------------
  const { data: job, error: jobErr } = await admin
    .from("jobs")
    .insert({
      client_id: clientId,
      // Carried, not invented: ensure_job_for_production writes
      // prod.contract_id onto the job it creates (0090:201-202), and a job that
      // dropped it would detach a contract production from its contract.
      contract_id: prod.contract_id,
      // 0064: jobs.date is the WORK date. due_date and every ageing number
      // downstream derive from it, through trg_compute_due_date.
      //
      // The fallback mirrors ensure_job_for_production's `coalesce(
      // prod.record_date, current_date)` (0090:205-207) rather than inventing a
      // refusal the owner did not ask for — and through todayInIsrael(), not
      // `new Date()`: a `date` column written from a UTC instant lands on the
      // previous day for three hours every evening (dates.ts:120-128). Both
      // live cases carry a record_date, so this never fires today.
      date: prod.record_date ?? todayInIsrael(),
      // The SAME format the database writes for a production's job —
      // `prod.podcast_name`, bare (0090:198-204). There is no shared helper to
      // import: the only other writer of this column for a production IS that
      // SQL function. Matching its value is what keeps a hand-made job
      // indistinguishable from a trigger-made one on every money screen.
      campaign: prod.podcast_name,
      amount,
      paid: "לא",
      // 0081 writes `paid` explicitly for the same reason this does: a column
      // default is not a statement, and 0082 had to backfill the rows that
      // relied on one.
      legacy: !!prod.legacy,
    })
    .select("id")
    .single();
  if (jobErr || !job) {
    return NextResponse.json({ error: jobErr?.message ?? "יצירת העבודה נכשלה" }, { status: 400 });
  }
  const jobId = job.id as string;

  // ---- 2. the link ------------------------------------------------------
  // Not in a transaction with the insert above: PostgREST gives us no
  // transaction across two calls, and there is no RPC that takes an explicit
  // amount (see the header on why ensure_job_for_production is not it).
  //
  // So: compensate. The delete is safe for the same reason record-billed's is
  // (that route's :293-300) — job_productions is the only thing that was about
  // to point at this job, the insert that would have pointed at it just failed,
  // and the FK carries no ON DELETE. A job nothing references is removable; a
  // job left behind with no link is invisible on every money screen, which is
  // the orphan workOrder.ts:30-44 was written about.
  const { error: linkErr } = await admin
    .from("job_productions")
    .insert({ job_id: jobId, production_id: prod.id });
  if (linkErr) {
    const { error: undoErr } = await admin.from("jobs").delete().eq("id", jobId);
    return NextResponse.json(
      {
        error: undoErr
          ? `קישור העבודה להפקה נכשל (${linkErr.message}), והעבודה שנוצרה לא נמחקה (${undoErr.message}) — פנו למפתח`
          : `קישור העבודה להפקה נכשל (${linkErr.message}) — העבודה לא נוצרה. נסו שוב.`,
      },
      { status: 400 }
    );
  }

  // ---- 3. the audit -----------------------------------------------------
  // The tax-ceiling shape (documents/tax/route.ts:184-199): entity, type,
  // actor, and a payload carrying every number the decision rested on.
  // `suggested_amount` rides along only when it differs from what was
  // submitted, so "the owner overrode the computed price" is a question the log
  // answers rather than one that needs reconstructing.
  const suggested = body.suggested_amount == null ? null : Number(body.suggested_amount);
  const overrode = suggested != null && Number.isFinite(suggested) && suggested !== amount;
  await admin.from("events").insert({
    entity_type: "job",
    entity_id: jobId,
    event_type: "job_created_manually",
    actor_id: user.id,
    payload: {
      job_id: jobId,
      production_id: prod.id,
      client_id: clientId,
      amount,
      date: prod.record_date,
      campaign: prod.podcast_name,
      legacy: !!prod.legacy,
      production_status: prod.status,
      ...(overrode ? { suggested_amount: suggested } : {}),
    },
  });

  return NextResponse.json({ ok: true, job_id: jobId, amount });
}
