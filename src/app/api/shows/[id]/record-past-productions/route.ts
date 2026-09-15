import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { amountBasis, linkPreflight, linkDocumentToJob, VAT } from "@/lib/documents/reconcile";
import { chainIds } from "@/lib/documents/chains";
import { MORNING_DOC_NAME } from "@/lib/morning/types";

// Record episodes that were ALREADY produced and ALREADY billed, outside this
// app, against an existing show. It creates the productions, attaches them to a
// job, and marks their stages done. It issues nothing, queues nothing, and
// never calls Morning.
//
// ═══ WHY A ROUTE AND NOT "JUST USE THE BOARD" ═══
// Because the ordinary path fires three separate mechanisms, each of which
// produces a real document or a real duplicate for work that was finished and
// invoiced months ago:
//
//   1. POST /api/productions:208 queues a WORK ORDER. checkEligibility has no
//      billed-evidence test for work_order (enqueue.ts:671 scopes it to
//      deal_invoice, and says why), so a perfectly eligible show — mapped
//      client, per_episode, a default_rate — gets an order for work already
//      done. It would have to be rejected by hand, every time.
//   2. Moving to 'הוקלט' fires ensure_job_for_production, which creates a
//      SECOND job beside the one the invoice is already on.
//   3. Moving to 'אושר_ע"י_לקוח' enqueues a DEAL INVOICE
//      ([id]/route.ts:125) — immediately, for a per_episode cadence client.
//
// This route walks none of that. It writes the end state directly.
//
// ═══ THE STATUS IS WRITTEN AT INSERT, NOT WALKED TO ═══
// Productions are INSERTed at 'הופץ'. Three facts make that both safe and
// strictly safer than the alternative:
//
//   · trg_on_production_approved is AFTER UPDATE **OF status** — it does not
//     fire on INSERT at all. Mechanisms 2 and 3 above are therefore not
//     avoided by a guard, they are never reached.
//   · derive_production_status (trigger on stages) refuses to move a cursor
//     that is outside its auto band: `not (cur = any(auto_states))` where
//     auto_states is עתיד_להתחיל/בהקלטה/הוקלט/בעריכה/נערך. 'הופץ' is outside
//     it, so marking the stages done below cannot drag the status backwards.
//   · no UPDATE of productions.status happens anywhere here, so
//     guard_client_approval_transition and guard_production_cancellation are
//     never evaluated.
//
// The owner's ordering requirement is still honoured, and it is the one that
// carries weight: job_productions is written BEFORE any stage is touched. That
// is what would block ensure_job_for_production if anything ever did reach it
// (its duplicate guard is `exists (select 1 from job_productions where
// production_id = p_id)`), and it is what keeps the 🔵 "הופק ולא חויב" alert —
// which fires on all-stages-done with no link, and does NOT look at legacy —
// from ever seeing a window in which it should fire.
//
// ═══ legacy = true ═══
// The silence lever, and the only one that is clean: checkEligibility's first
// line is `if (production.legacy) return { applicable: false }`, and
// applicable:false means no queue row, NO 🟡 on the radar, and any stale block
// flag cleared (enqueue.ts:659-662). Nothing here calls enqueueDocument anyway;
// legacy is what keeps the row quiet for every OTHER path that might later look
// at it.
//
// ═══ STAGES ARE MARKED IN DEPENDENCY ORDER ═══
// enforce_stage_order (0038) refuses to open a step whose predecessor is not
// done — deliver needs edit, and episode/edit needs record. One UPDATE covering
// all rows would fire the trigger per row in an unspecified order and could
// raise. So they move in three passes, by step.

const ALLOWED_TYPES = [300, 305, 320, 400];
const LINK_ORDER = (t: number) => (t === 300 ? 0 : t === 305 || t === 320 ? 1 : 2);
const ALREADY_LINKED = "המסמך כבר משויך ל-job";
// record → edit → deliver. reels/edit has no predecessor and reels/record only
// exists on a reels-only production, so ordering by STEP satisfies every shape
// create_default_stages can produce.
const STEP_ORDER: string[] = ["record", "edit", "deliver"];

type CandidateDoc = {
  id: string;
  morning_doc_id: string | null;
  morning_doc_number: string | null;
  type: number;
  amount: number | null;
  document_date: string | null;
  parent_doc_numbers: string[] | null;
  job_id: string | null;
  bundle_job_ids: string[] | null;
  cancelled_at: string | null;
  archived_at: string | null;
  client_id: string | null;
};

const DOC_SELECT =
  "id,morning_doc_id,morning_doc_number,type,amount,document_date,parent_doc_numbers,job_id,bundle_job_ids,cancelled_at,archived_at,client_id";

type Admin = ReturnType<typeof createAdminClient>;

async function loadShow(admin: Admin, id: string) {
  const { data: show } = await admin
    .from("shows")
    .select("id,name,client_id,billing_mode,default_rate,default_studio,camera_count,has_episode,reels_count")
    .eq("id", id)
    .maybeSingle();
  if (!show) return { error: "התוכנית לא נמצאה", status: 404 as const };
  // A show that bills nobody has no billing to record. Refused rather than
  // silently producing kind='internal' rows the money screens ignore.
  if (show.billing_mode === "none") {
    return { error: "התוכנית מסומנת כפנימית (לא מחויבת) — אין מה לרשום", status: 400 as const };
  }
  if (!show.client_id) return { error: "לתוכנית אין לקוח משויך", status: 400 as const };
  return { show };
}

// Same gates the write path applies, linkPreflight included — so a document
// offered here is one that can actually be linked. The empty job makes gate 2
// trivially pass, which is correct: the job these attach to is brand new.
async function loadCandidateDocs(admin: Admin, clientId: string): Promise<CandidateDoc[]> {
  const { data } = await admin
    .from("documents")
    .select(DOC_SELECT)
    .eq("client_id", clientId)
    .is("job_id", null)
    .is("cancelled_at", null)
    .is("archived_at", null)
    .in("type", ALLOWED_TYPES)
    .order("document_date", { ascending: true });

  const rows = ((data ?? []) as unknown as CandidateDoc[]).filter((d) => !(d.bundle_job_ids ?? []).length);
  const verdicts = await Promise.all(
    rows.map((d) =>
      linkPreflight(
        admin,
        { morning_doc_id: d.morning_doc_id, morning_doc_number: d.morning_doc_number, type: d.type },
        { invoice_biz: null, invoice_tax: null }
      )
    )
  );
  return rows.filter((_, i) => verdicts[i].ok);
}

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase
    .from("profiles")
    .select("can_edit_stages,can_edit_money")
    .eq("id", user.id)
    .single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });
  if (!profile?.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  const admin = createAdminClient();
  const ctx = await loadShow(admin, params.id);
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { show } = ctx;

  const clientId = show.client_id as string;
  const [{ data: jobRows }, { data: linkRows }, docs] = await Promise.all([
    admin
      .from("jobs")
      .select("id,campaign,amount,date,paid,invoice_biz,invoice_tax,dismissed")
      .eq("client_id", clientId)
      .eq("dismissed", false)
      .order("date", { ascending: false }),
    admin.from("job_productions").select("job_id,production_id"),
    loadCandidateDocs(admin, clientId),
  ]);

  const linkCount = new Map<string, number>();
  for (const l of (linkRows ?? []) as { job_id: string }[]) {
    linkCount.set(l.job_id, (linkCount.get(l.job_id) ?? 0) + 1);
  }
  const chains = chainIds(docs);

  return NextResponse.json({
    show: {
      id: show.id,
      name: show.name,
      default_rate: show.default_rate == null ? null : Number(show.default_rate),
      billing_mode: show.billing_mode,
    },
    jobs: (jobRows ?? []).map((j) => ({
      id: j.id as string,
      campaign: (j.campaign as string | null) ?? null,
      amount: j.amount == null ? null : Number(j.amount),
      date: (j.date as string | null) ?? null,
      paid: (j.paid as string | null) ?? null,
      doc_number: (j.invoice_tax as string | null) ?? (j.invoice_biz as string | null) ?? null,
      // how many productions already hang off this job — a warning, never a block
      linked_productions: linkCount.get(j.id as string) ?? 0,
    })),
    documents: docs.map((d) => ({
      id: d.id,
      number: d.morning_doc_number,
      type: d.type,
      type_label: MORNING_DOC_NAME[d.type] ?? `סוג ${d.type}`,
      amount: d.amount == null ? null : Number(d.amount),
      net: d.amount == null ? null : Number(d.amount) / VAT,
      date: d.document_date,
      chain_id: chains.get(d.id) ?? d.id,
    })),
  });
}

type Episode = { record_date: string; title: string };
type Billing =
  | { mode: "job"; job_id?: string }
  | { mode: "documents"; document_ids?: string[]; amount_confirmed?: boolean }
  | { mode: "none" };

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase
    .from("profiles")
    .select("can_edit_stages,can_edit_money")
    .eq("id", user.id)
    .single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });
  if (!profile?.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { episodes?: Episode[]; billing?: Billing };
  const episodes = (body.episodes ?? []).filter((e) => e && typeof e.record_date === "string");
  if (!episodes.length) return NextResponse.json({ error: "לא נוספו פרקים" }, { status: 400 });
  for (const e of episodes) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.record_date)) {
      return NextResponse.json({ error: `תאריך הקלטה לא תקין: ${e.record_date}` }, { status: 400 });
    }
  }
  const billing: Billing = body.billing ?? { mode: "none" };
  if (!["job", "documents", "none"].includes(billing.mode)) {
    return NextResponse.json({ error: "מצב חיוב לא מוכר" }, { status: 400 });
  }

  const admin = createAdminClient();
  const ctx = await loadShow(admin, params.id);
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { show } = ctx;
  const clientId = show.client_id as string;

  // ---- validate the billing choice BEFORE anything is created -------------
  let existingJobId: string | null = null;
  let jobLinkWarning: string | null = null;
  let docs: CandidateDoc[] = [];

  if (billing.mode === "job") {
    const jobId = billing.job_id?.trim();
    if (!jobId) return NextResponse.json({ error: "לא נבחר חיוב" }, { status: 400 });
    const { data: job } = await admin
      .from("jobs")
      .select("id,client_id,dismissed,campaign")
      .eq("id", jobId)
      .maybeSingle();
    if (!job) return NextResponse.json({ error: "החיוב לא נמצא" }, { status: 404 });
    if (job.client_id !== clientId) {
      return NextResponse.json({ error: "החיוב שייך ללקוח אחר" }, { status: 400 });
    }
    if (job.dismissed) return NextResponse.json({ error: "החיוב מוסתר (dismissed)" }, { status: 400 });
    existingJobId = jobId;

    const { data: already } = await admin.from("job_productions").select("production_id").eq("job_id", jobId);
    const n = (already ?? []).length;
    // a warning, never a block: one job legitimately covers several episodes —
    // that is exactly what "פרק כפול" is
    if (n > 0) jobLinkWarning = `החיוב הזה כבר מקושר ל-${n} הפקות. ההפקות החדשות יתווספו אליו.`;
  }

  if (billing.mode === "documents") {
    const ids = Array.from(new Set((billing.document_ids ?? []).filter((v) => typeof v === "string" && v)));
    if (!ids.length) return NextResponse.json({ error: "לא נבחרו מסמכים" }, { status: 400 });

    const { data: rows } = await admin.from("documents").select(DOC_SELECT).in("id", ids);
    docs = (rows ?? []) as unknown as CandidateDoc[];
    const byId = new Map(docs.map((d) => [d.id, d]));
    for (const id of ids) {
      const d = byId.get(id);
      if (!d) return NextResponse.json({ error: "אחד המסמכים לא נמצא" }, { status: 400 });
      const num = d.morning_doc_number ?? id.slice(0, 8);
      if (d.client_id !== clientId) {
        return NextResponse.json({ error: `המסמך ${num} שייך ללקוח אחר` }, { status: 400 });
      }
      if (d.job_id) {
        return NextResponse.json(
          { error: `המסמך ${num} שויך בינתיים לעבודה אחרת ולכן לא שויך כאן.` },
          { status: 400 }
        );
      }
      if ((d.bundle_job_ids ?? []).length) {
        return NextResponse.json({ error: `המסמך ${num} מאוגד לעבודות אחרות` }, { status: 400 });
      }
      if (d.cancelled_at || d.archived_at) {
        return NextResponse.json({ error: `המסמך ${num} מבוטל או מאורכב` }, { status: 400 });
      }
      if (!ALLOWED_TYPES.includes(d.type)) {
        return NextResponse.json(
          { error: `המסמך ${num} מסוג ${MORNING_DOC_NAME[d.type] ?? d.type} אינו ניתן לשיוך לעבודה` },
          { status: 400 }
        );
      }
    }

    // ---- the amount check: MAX against episodes × rate, NEVER a sum --------
    // A 300 and the 305 raised on it are one bill at one gross; adding them
    // would warn on the most ordinary chain there is.
    if (show.default_rate == null) {
      return NextResponse.json(
        { error: "לתוכנית אין מחיר לפרק — אי אפשר לגזור את סכום החיוב" },
        { status: 400 }
      );
    }
    const expectedNet = episodes.length * Number(show.default_rate);
    const amounts = docs.map((d) => Number(d.amount ?? 0)).filter((n) => Number.isFinite(n));
    const grossMax = amounts.length ? Math.max(...amounts) : 0;
    if (!amountBasis(expectedNet, grossMax) && billing.amount_confirmed !== true) {
      return NextResponse.json(
        {
          error: "סכום המסמכים אינו תואם את מספר הפרקים",
          // `expected_amount` and not the milestone route's `milestone_amount`:
          // the number being compared here is episodes × rate, and reusing that
          // name would put "אבן הדרך" in a sentence on a screen that has none.
          mismatch: { gross_max: grossMax, net: grossMax / VAT, expected_amount: expectedNet },
        },
        { status: 409 }
      );
    }
  }

  // ═══ from here on, things are created. Everything that fails rolls back
  //     what THIS call made — and only that. ═══
  const createdProductions: string[] = [];
  let createdJobId: string | null = null;

  const rollback = async () => {
    // productions first: stages and job_productions both cascade off them
    // (0001 stages.production_id, 0009 job_productions both sides), so this
    // one delete removes everything hanging off the row.
    if (createdProductions.length) await admin.from("productions").delete().in("id", createdProductions);
    // only a job this call made, and only after nothing points at it any more
    if (createdJobId) await admin.from("jobs").delete().eq("id", createdJobId);
  };
  const fail = async (message: string, status = 400) => {
    await rollback();
    return NextResponse.json({ error: message }, { status });
  };

  // ---- 1. the productions, born at their FINAL status ---------------------
  const kind = show.billing_mode === "contract" ? "contract" : "client";
  const sortedEpisodes = [...episodes].sort((a, b) => a.record_date.localeCompare(b.record_date));
  for (const ep of sortedEpisodes) {
    const { data: prod, error } = await admin
      .from("productions")
      .insert({
        podcast_name: show.name,
        show_id: show.id,
        client_id: clientId,
        kind,
        contract_id: null,
        record_date: ep.record_date,
        guest: ep.title?.trim() || null,
        studio: show.default_studio ?? null,
        camera_count: show.camera_count,
        // composition copied show → production, exactly as the other two
        // creation paths do (0055)
        has_episode: show.has_episode,
        reels_count: show.reels_count,
        calendar_uid: null,
        // the two that make this row what it is
        legacy: true,
        status: "הופץ",
      })
      .select("id")
      .single();
    if (error || !prod) return fail(error?.message ?? "יצירת ההפקה נכשלה");
    createdProductions.push(prod.id as string);
  }

  // ---- 2. the job, and the link — BEFORE any stage is touched ------------
  let jobId: string | null = existingJobId;
  if (billing.mode === "documents") {
    const dates = docs.map((d) => d.document_date).filter((v): v is string => !!v).sort();
    const jobDate = sortedEpisodes[0].record_date || dates[0] || new Date().toISOString().slice(0, 10);
    const title = sortedEpisodes.map((e) => e.title?.trim()).filter(Boolean).join(" + ");
    const { data: job, error: jobErr } = await admin
      .from("jobs")
      .insert({
        client_id: clientId,
        contract_id: null,
        campaign: `${show.name} — ${title || sortedEpisodes[0].record_date}`,
        // episodes × the show's rate, NET — the same basis every existing job
        // on this client carries, and what amountBasis grosses up by VAT
        amount: episodes.length * Number(show.default_rate),
        date: jobDate,
        paid: "לא",
        // deliberately no invoice_biz / invoice_tax: linkDocumentToJob stamps
        // them from the documents, and linkPreflight's gate 2 refuses a column
        // already spoken for. A 320 or 400 flips `paid` on its own.
        legacy: false,
      })
      .select("id")
      .single();
    if (jobErr || !job) return fail(jobErr?.message ?? "יצירת החיוב נכשלה");
    jobId = job.id as string;
    createdJobId = jobId;
  }

  if (jobId) {
    const { error: linkErr } = await admin
      .from("job_productions")
      .insert(createdProductions.map((production_id) => ({ job_id: jobId, production_id })));
    if (linkErr) return fail(linkErr.message);
  }

  // ---- 3. the stages, in dependency order --------------------------------
  // enforce_stage_order refuses a step whose predecessor is not done, so these
  // are three passes and not one statement. derive_production_status runs on
  // each of them and does nothing: 'הופץ' is outside its auto band.
  for (const step of STEP_ORDER) {
    const { error: stErr } = await admin
      .from("stages")
      .update({ status: "done" })
      .in("production_id", createdProductions)
      .eq("step", step)
      .neq("status", "done");
    if (stErr) return fail(`סימון השלבים נכשל (${step}): ${stErr.message}`);
  }

  // ---- 4. the documents, in the order they were raised -------------------
  // Last, and deliberately so: by now the productions exist, the job exists and
  // is linked, and the stages are done. A document that fails here leaves a
  // COMPLETE and correct production record that is simply missing one document
  // link — repairable from the registry, and never a reason to delete work that
  // succeeded. That is why this is a 207 and not a rollback.
  const linked: string[] = [];
  const failed: { number: string; error: string }[] = [];
  if (billing.mode === "documents" && jobId) {
    const ordered = [...docs].sort(
      (a, b) =>
        LINK_ORDER(a.type) - LINK_ORDER(b.type) ||
        (a.document_date ?? "").localeCompare(b.document_date ?? "")
    );
    for (const d of ordered) {
      const num = d.morning_doc_number ?? d.id.slice(0, 8);
      const res = await linkDocumentToJob(admin, { docId: d.id, jobId, actorId: user.id, auto: false });
      if (res.ok) linked.push(num);
      else {
        failed.push({
          number: num,
          error:
            res.error === ALREADY_LINKED
              ? `המסמך ${num} שויך בינתיים לעבודה אחרת ולכן לא שויך כאן.`
              : res.error,
        });
      }
    }
  }

  await admin.from("events").insert({
    entity_type: "show",
    entity_id: show.id,
    event_type: "past_productions_recorded",
    actor_id: user.id,
    payload: {
      show_id: show.id,
      production_ids: createdProductions,
      job_id: jobId,
      job_created: !!createdJobId,
      document_ids: docs.map((d) => d.id),
      linked,
      failed,
      episodes: sortedEpisodes.length,
      billing_mode: billing.mode,
    },
  });

  return NextResponse.json(
    {
      production_ids: createdProductions,
      job_id: jobId,
      job_created: !!createdJobId,
      linked,
      failed,
      warning: jobLinkWarning,
    },
    { status: failed.length ? 207 : 200 }
  );
}
