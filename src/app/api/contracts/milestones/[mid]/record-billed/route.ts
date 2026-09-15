import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { amountBasis, linkPreflight, linkDocumentToJob, VAT } from "@/lib/documents/reconcile";
import { MORNING_DOC_NAME } from "@/lib/morning/types";
import { chainIds } from "@/lib/documents/chains";

// Record documents that were ALREADY raised in Morning, outside this app,
// against a contract milestone. It creates the milestone's job and links the
// documents to it. It issues nothing, queues nothing, and never calls Morning.
//
// ═══ WHY THIS IS A THIRD ROUTE AND NOT A MODE ═══
// Its two siblings on this milestone each answer one verb and refuse the other.
// `enqueue` MAKES a work order happen (a real queue row, a human gate, DRY_RUN).
// `issue` RECORDS a deal invoice raised by hand, and mints the job that carries
// it. This one records documents that ALREADY EXIST IN OUR REGISTRY — the pull
// brought them in, they carry Morning ids and numbers, and the only thing
// missing is which job they belong to.
//
// a5dbdf8 (2026-07-30) removed the second mode from `issue` precisely because
// one route answering both "record what happened" and "make it happen" is how a
// fake "DRY-nnnnnn" document got minted and logged as real. Adding a third mode
// there would contradict the 400 that route still returns. So: a third route.
//
// ═══ WHY EVERY CALL USES THE ADMIN CLIENT ═══
// `documents` has RLS on and exactly ONE policy — `documents_select`
// (can_view_money). There is no INSERT policy and no UPDATE policy. A
// user-scoped client's UPDATE on documents.job_id therefore matches zero rows
// and returns NO ERROR, and linkDocumentToJob would sail on to patch the job,
// write the invoices row and return ok — a link that reports success and linked
// nothing. The permission gate is the explicit can_edit_money check below, the
// same shape as enqueue/route.ts:61-62.
//
// ═══ ATOMICITY: FORWARD RECOVERY, NOT ROLLBACK (owner decision) ═══
// linkDocumentToJob's four writes are not in a transaction — reconcile.ts:418
// says so, and that is why all of its refusals live in linkPreflight, ahead of
// the first write. Unwinding a link that SUCCEEDED would mean deleting an
// invoices row and un-eventing a money change, which is the exact shape that
// broke 60167 and needed migration 0085 to repair.
//
// So nothing that succeeded is ever rolled back. Instead:
//   · the job is linked to the milestone IMMEDIATELY, under an `is null`
//     predicate, and only a job that nothing points at yet is ever deleted
//     (the same window enqueue/route.ts:160-164 rolls back in);
//   · a milestone that already has a job REUSES it;
//   · a document already linked is refused by reconcile.ts:544, not duplicated.
// Together those make the route re-clickable: a partial result is repaired by
// pressing the button again, which skips what already landed. The response says
// which documents failed and why, so "press it again" is informed rather than
// hopeful. 207 carries that case.
//
// ═══ THE AMOUNT CHECK NEVER SUMS ═══
// A 300 and the 305 raised on it are the SAME bill at the SAME gross. Live case
// this was written for: בר ביצוע 40326 (300) and 50070 (305), both ₪49,560,
// against a ₪42,000 net milestone. Summing gives ₪99,120 and would fire a
// mismatch warning on the most ordinary chain there is. MAX is the comparison,
// through amountBasis so the screen and the matching engine cannot disagree
// about what "matches" means.

const ALLOWED_TYPES = [300, 305, 320, 400];

// 300 first, then the tax document, then the receipt — the order the documents
// were raised in. It matters for `paid`: a 400 or 320 flips the job to paid
// (reconcile.ts:581), and a job should not read "paid" for the instant before
// the invoice that justifies it has been recorded.
const LINK_ORDER = (t: number) => (t === 300 ? 0 : t === 305 || t === 320 ? 1 : 2);

// reconcile.ts:544's exact words, so the nicer sentence below replaces the one
// refusal the operator can actually act on. Compared as a string rather than a
// code because linkDocumentToJob returns no codes; if that line is ever
// reworded this falls back to showing the server's own text, which is correct
// but less specific — a degradation, not a break.
const ALREADY_LINKED = "המסמך כבר משויך ל-job";

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

async function loadMilestoneContext(admin: ReturnType<typeof createAdminClient>, mid: string) {
  const { data: ms } = await admin
    .from("contract_milestones")
    .select("id,contract_id,name,amount,job_id,status")
    .eq("id", mid)
    .maybeSingle();
  if (!ms) return { error: "אבן הדרך לא נמצאה", status: 404 as const };

  const { data: contract } = await admin
    .from("contracts")
    .select("id,name,client_id,status")
    .eq("id", ms.contract_id as string)
    .maybeSingle();
  if (!contract) return { error: "החוזה לא נמצא", status: 404 as const };
  if (!contract.client_id) return { error: "לחוזה אין לקוח", status: 400 as const };
  if (contract.status !== "active") {
    return { error: "החוזה סגור — פתחי אותו מחדש לפני רישום מסמכים", status: 400 as const };
  }
  return { ms, contract };
}

// The candidates, with every gate the write path will apply. `linkPreflight` is
// called per candidate rather than reimplemented: it is the function the POST
// below will run, so a document offered here is a document that can actually be
// linked. The empty job it is handed makes its gate 2 (the column already
// spoken for) trivially pass — correct, because the job this will link to is
// brand new and carries no number. Gate 1 (an invoices row already exists, seed
// shapes included) is the one that really filters, and it runs here exactly as
// it will there.
async function loadCandidates(
  admin: ReturnType<typeof createAdminClient>,
  clientId: string
): Promise<CandidateDoc[]> {
  const { data } = await admin
    .from("documents")
    .select(DOC_SELECT)
    .eq("client_id", clientId)
    .is("job_id", null)
    .is("cancelled_at", null)
    .is("archived_at", null)
    .in("type", ALLOWED_TYPES)
    .order("document_date", { ascending: true });

  const rows = ((data ?? []) as unknown as CandidateDoc[]).filter(
    (d) => !(d.bundle_job_ids ?? []).length
  );

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

export async function GET(_request: Request, { params }: { params: { mid: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const admin = createAdminClient();
  const ctx = await loadMilestoneContext(admin, params.mid);
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { ms, contract } = ctx;

  const docs = await loadCandidates(admin, contract.client_id as string);
  const chains = chainIds(docs);

  const { data: client } = await admin
    .from("clients")
    .select("name")
    .eq("id", contract.client_id as string)
    .maybeSingle();

  return NextResponse.json({
    milestone: { id: ms.id, name: ms.name, amount: Number(ms.amount), has_job: !!ms.job_id },
    client_name: (client?.name as string | null) ?? null,
    candidates: docs.map((d) => ({
      id: d.id,
      number: d.morning_doc_number,
      type: d.type,
      // MORNING_DOC_NAME is keyed by code and covers all four; the fallback is
      // the rule about every meta map indexed by a server value.
      type_label: MORNING_DOC_NAME[d.type] ?? `סוג ${d.type}`,
      amount: d.amount == null ? null : Number(d.amount),
      net: d.amount == null ? null : Number(d.amount) / VAT,
      date: d.document_date,
      chain_id: chains.get(d.id) ?? d.id,
      parents: d.parent_doc_numbers ?? [],
    })),
  });
}

export async function POST(request: Request, { params }: { params: { mid: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    document_ids?: string[];
    amount_confirmed?: boolean;
  };
  const ids = Array.from(new Set((body.document_ids ?? []).filter((v) => typeof v === "string" && v)));
  if (!ids.length) return NextResponse.json({ error: "לא נבחרו מסמכים" }, { status: 400 });

  const admin = createAdminClient();
  const ctx = await loadMilestoneContext(admin, params.mid);
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { ms, contract } = ctx;

  // ---- validate every document BEFORE anything is created -----------------
  // Re-read from the table rather than trusting the ids the screen sent: the
  // GET that populated it may be minutes old, and every one of these gates is
  // about money landing on the wrong job.
  const { data: docRows } = await admin.from("documents").select(DOC_SELECT).in("id", ids);
  const docs = (docRows ?? []) as unknown as CandidateDoc[];
  const byId = new Map(docs.map((d) => [d.id, d]));

  for (const id of ids) {
    const d = byId.get(id);
    if (!d) return NextResponse.json({ error: "אחד המסמכים לא נמצא" }, { status: 400 });
    const num = d.morning_doc_number ?? id.slice(0, 8);
    if (d.client_id !== contract.client_id) {
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

  // ---- the amount check: MAX, never a sum --------------------------------
  const amounts = docs.map((d) => Number(d.amount ?? 0)).filter((n) => Number.isFinite(n));
  const grossMax = amounts.length ? Math.max(...amounts) : 0;
  const msAmount = Number(ms.amount);
  if (!amountBasis(msAmount, grossMax) && body.amount_confirmed !== true) {
    return NextResponse.json(
      {
        error: "סכום המסמכים אינו תואם את אבן הדרך",
        mismatch: { gross_max: grossMax, net: grossMax / VAT, milestone_amount: msAmount },
      },
      { status: 409 }
    );
  }

  // ---- the job: reuse, or create a clean one and claim it -----------------
  let jobId = (ms.job_id as string | null) ?? null;
  let createdJob = false;
  if (!jobId) {
    // The earliest document is when this work was actually billed. It also
    // decides due_date: trg_compute_due_date fires on INSERT and derives it
    // from this date plus the client's payment_terms.
    const dates = docs.map((d) => d.document_date).filter((v): v is string => !!v).sort();
    const jobDate = dates[0] ?? new Date().toISOString().slice(0, 10);

    const { data: job, error: jobErr } = await admin
      .from("jobs")
      .insert({
        client_id: contract.client_id,
        contract_id: contract.id,
        campaign: `${contract.name} — ${ms.name}`,
        // the milestone's NET figure, which is what all five existing milestone
        // jobs carry, and what amountBasis expects to gross up by VAT
        amount: msAmount,
        date: jobDate,
        paid: "לא",
        // deliberately NO invoice_biz / invoice_tax: linkDocumentToJob stamps
        // them from the documents, and linkPreflight's gate 2 refuses a column
        // that is already spoken for. Pre-filling either would refuse the very
        // document this route exists to record.
        legacy: false,
      })
      .select("id")
      .single();
    if (jobErr) return NextResponse.json({ error: jobErr.message }, { status: 400 });
    jobId = job.id as string;
    createdJob = true;

    // `is("job_id", null)` is the PREDICATE, not a prior read — two concurrent
    // callers cannot both match, and the loser deletes the job it made. 0086's
    // unique index is the other half: it refuses a second milestone claiming
    // the same job. The FK on job_id carries no ON DELETE, so this delete can
    // only ever remove a job nothing points at.
    const { data: claimed, error: linkErr } = await admin
      .from("contract_milestones")
      .update({ job_id: jobId })
      .eq("id", ms.id as string)
      .is("job_id", null)
      .select("id");
    if (linkErr || !claimed?.length) {
      await admin.from("jobs").delete().eq("id", jobId);
      return NextResponse.json(
        { error: "לאבן הדרך כבר יש עבודה מקושרת. רענני את המסך ונסי שוב." },
        { status: 409 }
      );
    }
  }

  // ---- the links, in the order the documents were raised ------------------
  const ordered = [...docs].sort(
    (a, b) => LINK_ORDER(a.type) - LINK_ORDER(b.type) || (a.document_date ?? "").localeCompare(b.document_date ?? "")
  );
  const linked: string[] = [];
  const failed: { number: string; error: string }[] = [];
  for (const d of ordered) {
    const num = d.morning_doc_number ?? d.id.slice(0, 8);
    const res = await linkDocumentToJob(admin, {
      docId: d.id,
      jobId,
      actorId: user.id,
      auto: false,
    });
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

  await admin.from("events").insert({
    entity_type: "contract",
    entity_id: contract.id,
    event_type: "milestone_recorded_billed",
    actor_id: user.id,
    payload: {
      milestone_id: ms.id,
      contract_id: contract.id,
      job_id: jobId,
      job_created: createdJob,
      document_ids: ids,
      linked,
      failed,
    },
  });

  // 207 whenever anything failed — the job exists either way, so this is never
  // a clean error the client can treat as "nothing happened". It is also a 2xx,
  // which is why the client tests for 207 BEFORE res.ok.
  return NextResponse.json(
    { job_id: jobId, job_created: createdJob, linked, failed },
    { status: failed.length ? 207 : 200 }
  );
}
