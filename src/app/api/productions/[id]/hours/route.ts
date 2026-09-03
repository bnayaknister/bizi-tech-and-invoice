import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionAndProfile } from "@/lib/profile";
import {
  effectivePrice,
  enqueueDocument,
  type ProductionForBilling,
  type ShowForBilling,
} from "@/lib/documents/enqueue";
import { approvedAddonTotal } from "@/lib/productions/price";
import { MAX_HOURS } from "@/lib/productions/hours";
import { balanceError } from "@/lib/documents/lineBalance";
import type { MorningDocumentRequest } from "@/lib/morning/types";

// "כמה שעות הוקלטו?" — the technician's answer, and everything that answer
// decides (F6 שלב 2א, owner spec 2026-09-02; schema in 0067).
//
// ═══ WHY THIS IS A ROUTE OF ITS OWN ═══
// studio_hours is a stage-tier column — the technician types it, exactly like
// storage_disk, and guard_production_stage_columns (0067 §6) walls it to
// can_edit_stages in the DB. But unlike every other stage column it is
// MULTIPLIED BY A RATE and comes out the other side as the amount on a
// document. So the write is three writes that must not drift apart:
//
//   1. productions.studio_hours   — the fact
//   2. jobs.amount                — what our books say the session is worth
//   3. the work order             — what the client will be shown
//
// The generic entity PATCH could do (1) and nothing else, and an hours field
// wired to it would have left the money at whatever it was when the job was
// born — which for an hourly show is null (0067 §7: the job is created on the
// transition into הוקלט, before anyone has typed a number). Silently unpriced
// forever. (2) is the side everyone forgets, and it is the reason this file
// exists rather than a `case "set_hours"` in the addons route.
//
// ═══ PERMISSION: STAGES, NOT MONEY ═══
// can_edit_stages, deliberately, even though the number decides an amount. The
// person who knows how long the session ran is the technician; requiring a
// money permission would mean the bookkeeper guessing, or the number never
// being entered at all. The RATE stays money-walled (0067 grants: hourly_rate
// is not readable by the authenticated role, and guard_show_money_columns
// refuses to let a stages user change it), so a technician can say "3.5 hours"
// and can neither see nor set what an hour costs. The wall is on the price, not
// on the fact.
//
// The DB is still the real wall: (1) goes through the USER's client so
// guard_production_stage_columns fires with a real auth.uid(). (2) and (3) go
// through the service role — deriving money from a fact the technician is
// allowed to state is the system's job, not the technician's, which is the same
// division ensure_job_for_production makes as a security-definer function.

// A live work order occupies the production's slot in
// pending_documents_one_live_per_production (0025 → 0047 → 0063), so these are
// exactly the rows that can already exist when the hours arrive.
//
//   pending / accrued / failed  — nothing has been sent to Morning. The row is
//     re-amounted in place: the bookkeeper keeps her queue position, her hand-
//     edited description and her row id, and only the money moves.
//   approved / issued           — a document exists, or is being created, in
//     Morning. Refused (409). An issued document cannot be edited there, only
//     cancelled/credited (documents/[id]/cancel, 0063).
//   consolidated                — the row's money was folded into a bundled
//     document. Re-amounting it alone would leave the bundle's Σ disagreeing
//     with its parts, which is the exact class of drift the balance gate exists
//     to refuse. Also 409.
//   rejected / cancelled        — dead, and outside the unique index. Treated
//     as "no row": enqueueDocument mints a fresh one, which is what those two
//     statuses mean.
const REAMOUNTABLE = new Set(["pending", "accrued", "failed"]);
const FROZEN = new Set(["approved", "issued", "consolidated"]);

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const { user, profile } = await getSessionAndProfile();
  if (!user || !profile?.approved) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  if (!profile.can_edit_stages) {
    return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { hours?: number | string | null };

  // ---- validation: everything, before anything is written ------------------
  if (body.hours === undefined || body.hours === null || body.hours === "") {
    return NextResponse.json({ error: "יש להזין את מספר שעות ההקלטה" }, { status: 400 });
  }
  const hours = Number(body.hours);
  if (!Number.isFinite(hours)) {
    return NextResponse.json({ error: "מספר השעות אינו מספר תקין" }, { status: 400 });
  }
  // > 0 and not >= 0: productions_studio_hours_positive (0067 §3) says the same
  // thing in the DB, and the reason is a rule, not an arithmetic edge — a
  // session that ran zero hours did not happen, and the path for that is
  // cancelling the production (0062), never a document for 0 ₪.
  if (hours <= 0) {
    return NextResponse.json(
      { error: "מספר השעות חייב להיות גדול מאפס — הקלטה שלא התקיימה מבטלים, לא מחייבים על 0 שעות" },
      { status: 400 }
    );
  }
  // MAX_HOURS is shared with the form (lib/productions/hours.ts) so the field's
  // max attribute and this refusal are the same number. The column carries no
  // upper bound on purpose — a constraint violation is not a message anyone can
  // act on (0067's header).
  if (hours > MAX_HOURS) {
    return NextResponse.json(
      { error: `מספר השעות חייב להיות עד ${MAX_HOURS} — מספר גדול יותר הוא כמעט תמיד טעות הקלדה` },
      { status: 400 }
    );
  }
  // studio_hours is numeric(5,2): a third decimal would be ROUNDED by the
  // column on the way in, and money that changes itself on the way into the
  // database is the one thing this system does not do (0067's header, on why
  // hourly_rate is bare numeric). Refuse instead, while the number is still on
  // the form and its author is still looking at it.
  if (Number(hours.toFixed(2)) !== hours) {
    return NextResponse.json(
      { error: "מספר השעות מוגבל לשתי ספרות אחרי הנקודה (רבע שעה = 0.25)" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // price_override, status and studio_hours are all read because all three
  // reach the price: the override wins outright, the status decides whether a
  // missing number is a 🟡, and the old hours are the `from` of the event.
  const { data: prodRow, error: prodErr } = await admin
    .from("productions")
    .select("id,kind,legacy,client_id,show_id,podcast_name,record_date,guest,price_override,status,studio_hours")
    .eq("id", params.id)
    .maybeSingle();
  if (prodErr) return NextResponse.json({ error: prodErr.message }, { status: 400 });
  if (!prodRow) return NextResponse.json({ error: "ההפקה לא נמצאה" }, { status: 404 });

  const { data: showRow, error: showErr } = prodRow.show_id
    ? await admin
        .from("shows")
        .select("id,client_id,billing_mode,default_rate,pricing_model,hourly_rate")
        .eq("id", prodRow.show_id)
        .maybeSingle()
    : { data: null, error: null };
  if (showErr) return NextResponse.json({ error: showErr.message }, { status: 400 });
  if (!showRow) {
    return NextResponse.json({ error: "להפקה אין תוכנית משויכת — אי אפשר לתמחר שעות" }, { status: 400 });
  }
  const show = showRow as ShowForBilling;

  // Refused rather than stored-and-ignored. On a per_episode show the hours
  // multiply nothing: the number would be written, no amount anywhere would
  // move, and the technician would have every reason to believe the session was
  // priced. A silent no-op on the money side is the failure mode this whole
  // file is written against.
  if (show.pricing_model !== "per_hour") {
    return NextResponse.json(
      { error: "התוכנית אינה מתומחרת לפי שעת אולפן — שעות הקלטה לא ישנו את סכום החיוב" },
      { status: 400 }
    );
  }

  // ---- what already exists in the queue, before anything is written --------
  const { data: existingRows, error: exErr } = await admin
    .from("pending_documents")
    .select("id,status,amount,payload,created_at")
    .eq("production_id", params.id)
    .eq("doc_type", "work_order")
    .order("created_at", { ascending: false });
  if (exErr) return NextResponse.json({ error: exErr.message }, { status: 400 });

  const rows = (existingRows ?? []) as {
    id: string;
    status: string;
    amount: number | null;
    payload: MorningDocumentRequest | null;
  }[];
  const frozen = rows.find((r) => FROZEN.has(r.status));
  if (frozen) {
    return NextResponse.json(
      {
        error:
          frozen.status === "consolidated"
            ? "הזמנת העבודה כבר אוגדה למסמך מרוכז — לתיקון שעות יש לטפל במסמך המאוגד"
            : "הזמנת העבודה כבר הונפקה — לתיקון שעות יש לבטל את המסמך ולהנפיק מתקן",
        status: frozen.status,
        pending_document_id: frozen.id,
      },
      { status: 409 }
    );
  }
  const reusable = rows.find((r) => REAMOUNTABLE.has(r.status)) ?? null;

  // ═══ 1. THE FACT ═══════════════════════════════════════════════════════════
  // Through the user's client on purpose: the service role has auth.uid() null,
  // which makes can_edit_stages() null, which makes guard_production_stage_
  // columns (0067 §6) pass silently (0010's own note documents this). Writing
  // this column with the admin client would mean the wall added by the
  // migration never fires on the one route that uses the column.
  const supabase = createClient();
  const previousHours = (prodRow.studio_hours as number | null) ?? null;
  const { data: updated, error: updErr } = await supabase
    .from("productions")
    .update({ studio_hours: hours })
    .eq("id", params.id)
    .select("id,studio_hours")
    .single();
  if (updErr) {
    // the guard's own sentence, turned into a clean 403 — same test as
    // api/productions/[id]/route.ts
    const isGuard = /הרשאת|רק בעל/.test(updErr.message);
    return NextResponse.json({ error: updErr.message }, { status: isGuard ? 403 : 400 });
  }
  if (!updated) {
    return NextResponse.json({ error: "ההפקה לא נמצאה או שאין הרשאה" }, { status: 404 });
  }

  await admin.from("events").insert({
    entity_type: "production",
    entity_id: params.id,
    event_type: "production_hours_set",
    actor_id: user.id,
    payload: { from: previousHours, to: hours },
  });

  // ═══ 2. WHAT THE SESSION IS WORTH ═════════════════════════════════════════
  const production: ProductionForBilling = {
    id: prodRow.id as string,
    kind: prodRow.kind as string | null,
    legacy: prodRow.legacy as boolean | null,
    client_id: prodRow.client_id as string | null,
    show_id: prodRow.show_id as string | null,
    podcast_name: prodRow.podcast_name as string | null,
    record_date: prodRow.record_date as string | null,
    guest: prodRow.guest as string | null,
    price_override: prodRow.price_override as number | null,
    status: prodRow.status as string,
    // the number just written, not the one that was read
    studio_hours: hours,
  };
  const base = effectivePrice(production, show);

  // base cannot be null here — pricing_model is per_hour (checked above),
  // studio_hours was just validated > 0, and the only remaining code is
  // no_hourly_rate. That one is real: a show can be per_hour with no rate yet.
  // It is NOT an error on this request — the hours are a true fact and they are
  // saved — so the money side is skipped and the reason is recorded, and
  // enqueueDocument below raises the 🟡 that names it.
  const jobResult: Record<string, unknown> = { job_id: null, job_amount: null };
  if (base.amount != null) {
    const { data: link } = await admin
      .from("job_productions")
      .select("job_id")
      .eq("production_id", params.id)
      .limit(1)
      .maybeSingle();
    const jobId = (link?.job_id as string | null) ?? null;
    if (jobId) {
      const { data: job } = await admin
        .from("jobs")
        .select("id,amount,invoice_biz,invoice_tax")
        .eq("id", jobId)
        .maybeSingle();
      // Money that has already left the building is not re-derived. A job
      // carrying a document number has been billed at whatever that document
      // says, and quietly moving the column underneath it would make our books
      // disagree with Morning's — see findBilledEvidence for the same rule on
      // the document side.
      const billed = !!(job?.invoice_biz || job?.invoice_tax);
      if (job && !billed) {
        // base + approved add-ons, which is ensure_job_for_production's own
        // sum (0067 §7) — through the shared helper rather than a fifth
        // hand-written copy of it.
        const { data: addons } = await admin
          .from("production_addons")
          .select("production_id,status,total")
          .eq("production_id", params.id);
        const jobAmount = base.amount + approvedAddonTotal(addons ?? []);
        const { error: jobErr } = await admin.from("jobs").update({ amount: jobAmount }).eq("id", jobId);
        if (jobErr) return NextResponse.json({ error: `עדכון סכום החיוב נכשל: ${jobErr.message}` }, { status: 400 });
        jobResult.job_id = jobId;
        jobResult.job_amount = jobAmount;
        await admin.from("events").insert({
          entity_type: "job",
          entity_id: jobId,
          event_type: "job_reamounted_from_hours",
          actor_id: user.id,
          payload: { from: (job.amount as number | null) ?? null, to: jobAmount, studio_hours: hours, production_id: params.id },
        });
      } else if (billed) {
        jobResult.job_id = jobId;
        jobResult.skipped = "already_billed";
      }
    }
  }

  // ═══ 3. WHAT THE CLIENT WILL BE SHOWN ═════════════════════════════════════
  if (!reusable) {
    // No row yet — the normal case for an hourly show, whose production is
    // created with no hours and therefore never queued a work order at all
    // (checkEligibility returns applicable:false there: documented silence, no
    // 🟡). Same function, same guards, same cadence brake as every other
    // enqueue — a monthly client's row is still born 'accrued'.
    const enq = await enqueueDocument(admin, "work_order", production);
    return NextResponse.json({
      ok: true,
      studio_hours: hours,
      work_order: enq.status,
      work_order_reason: enq.status === "blocked" ? enq.reason : null,
      ...jobResult,
    });
  }

  // A row exists and nothing has been sent. Re-amount it in place.
  const payload = { ...((reusable.payload ?? {}) as MorningDocumentRequest) };
  const income = Array.isArray(payload.income) ? payload.income : [];
  // A work order carries exactly one income line (buildDocumentPayload writes
  // one, and bundling is a deal-invoice concern). Writing income[0] on a row
  // with several lines is precisely the bug the edit route's amount gate was
  // written to close — so this refuses instead of guessing which line the hours
  // belong to.
  if (income.length !== 1) {
    return NextResponse.json(
      {
        error:
          `השעות נשמרו, אך הזמנת העבודה בתור נושאת ${income.length} שורות פירוט ולא אחת — ` +
          "יש לעדכן את סכומה ידנית במסך המסמכים",
        studio_hours: hours,
        pending_document_id: reusable.id,
        ...jobResult,
      },
      { status: 409 }
    );
  }
  if (base.amount == null) {
    // no hourly_rate: the hours are saved, but there is no number to put on the
    // row. Leaving it at its old amount is correct — it is the 🟡 on the show
    // that has to be fixed, not this document.
    return NextResponse.json({
      ok: true,
      studio_hours: hours,
      work_order: "unpriced",
      work_order_reason: "לא הוגדר תעריף שעתי לתוכנית",
      pending_document_id: reusable.id,
      ...jobResult,
    });
  }

  // Money only. The description is NOT rebuilt: the bookkeeper may have edited
  // it (documents/pending/edit), and re-deriving it here would silently discard
  // her wording on a route about hours.
  const amount = base.amount;
  payload.income = income.map((line, i) => (i === 0 ? { ...line, price: amount } : line));
  const gate = balanceError(payload.income, amount);
  if (gate) return NextResponse.json({ error: gate, studio_hours: hours }, { status: 400 });

  const { error: reErr } = await admin
    .from("pending_documents")
    .update({ amount, payload })
    .eq("id", reusable.id);
  if (reErr) return NextResponse.json({ error: `עדכון הזמנת העבודה נכשל: ${reErr.message}` }, { status: 400 });

  await admin.from("events").insert({
    entity_type: "production",
    entity_id: params.id,
    event_type: "work_order_reamounted",
    actor_id: user.id,
    payload: {
      pending_document_id: reusable.id,
      status: reusable.status,
      from: reusable.amount,
      to: base.amount,
      studio_hours: hours,
      hourly_rate: show.hourly_rate ?? null,
    },
  });

  return NextResponse.json({
    ok: true,
    studio_hours: hours,
    work_order: "reamounted",
    pending_document_id: reusable.id,
    amount,
    ...jobResult,
  });
}
