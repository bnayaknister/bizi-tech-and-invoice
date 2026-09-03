import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueDocument } from "@/lib/documents/enqueue";

// Manual production creation (owner request 2026-07-21). The calendar sync
// covers the automated path; this is the "+ הפקה חדשה" button on the board,
// for a session the calendar never carried. It mirrors the sync's create
// branch exactly so a hand-made production is indistinguishable from a
// synced one downstream:
//   - kind derived from the show's billing_mode (contract / client / internal)
//   - client / studio / camera_count / default editor inherited from the show
//   - 6 stages seeded by the create_default_stages() trigger
//   - a work order queued for the bookkeeper if the production is eligible
//   - legacy=false so it lands on the live board
//
// calendar_uid stays null on purpose: this row was never on the calendar,
// so the sync's match-by-uid loop must never touch it (no phantom "removed
// from calendar" flag, no update). The insert runs through the caller's own
// session so RLS (can_edit_stages) is the real wall — same pattern as the
// split route; admin is used only for show config, the audit event, the
// default-editor assignment, and the work-order queue.

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase
    .from("profiles")
    .select("can_edit_stages")
    .eq("id", user.id)
    .single();
  if (!profile?.can_edit_stages)
    return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    show_id?: string;
    record_date?: string;
    record_time?: string | null;
    studio?: string | null;
    guest?: string | null;
    notes?: string | null;
    confirm?: boolean;
  };

  const showId = body.show_id?.trim();
  const recordDate = body.record_date?.trim();
  if (!showId) return NextResponse.json({ error: "יש לבחור תוכנית" }, { status: 400 });
  if (!recordDate || !/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) {
    return NextResponse.json({ error: "תאריך הקלטה לא תקין" }, { status: 400 });
  }

  const admin = createAdminClient();
  // show config drives every inherited field — read it with admin so the
  // classification is resolved even for a stages-only creator who can't see
  // money columns, exactly as the calendar sync does
  const { data: show } = await admin
    .from("shows")
    .select("id,name,client_id,billing_mode,default_studio,camera_count,default_editor_id,has_episode,reels_count")
    .eq("id", showId)
    .maybeSingle();
  if (!show) return NextResponse.json({ error: "התוכנית לא נמצאה" }, { status: 404 });

  // ---- the calendar already caught this day? ------------------------------
  // Narrow on purpose (owner spec 2026-08-30). It fires ONLY for a hand-made
  // production landing on a show+day the CALENDAR already produced one for.
  // Several calendar episodes on one day (עומר חן ×3 on 3.8, SFI ×2 on 17.8)
  // are ordinary and must never warn; manual-vs-manual is a different problem
  // and deliberately out of scope.
  //
  // Three real cases, all genuine duplicates, none caught: 28.7 (cancelled as
  // "הקמה כפולה"), 13.8 (unnoticed for two weeks, and it would have double-billed
  // the September redemption — migration 0066), 28.8 (migration 0065). Two of
  // the three cost a data-fix migration each.
  //
  // merged_into / cancelled_at are excluded because a duplicate that was already
  // resolved is not evidence of anything: 94d4a7ea was merged away and 4696ed68
  // was cancelled, and counting either would warn about work already done.
  //
  // calendar_uid IS NOT NULL is the whole test of "came from the calendar" —
  // 32 productions carry one and none has ever lost it.
  if (!body.confirm) {
    const { data: fromCalendar, error: dupErr } = await admin
      .from("productions")
      .select("id,record_time,guest,status,episode_no")
      .eq("show_id", showId)
      .eq("record_date", recordDate)
      .not("calendar_uid", "is", null)
      .is("merged_into", null)
      .is("cancelled_at", null);
    // a failed lookup must not read as "nothing there" — that is the silent
    // direction, and silence here is exactly what this guard exists to end
    if (dupErr) {
      return NextResponse.json(
        { error: `בדיקת כפילות מול היומן נכשלה: ${dupErr.message}` },
        { status: 500 }
      );
    }
    if (fromCalendar && fromCalendar.length > 0) {
      return NextResponse.json(
        {
          error: `כבר יש ${fromCalendar.length === 1 ? "הפקה אחת" : `${fromCalendar.length} הפקות`} של "${show.name}" ב-${recordDate} שנקלטו מהיומן`,
          needs_confirmation: true,
          calendar_productions: fromCalendar.map((p) => ({
            id: p.id as string,
            record_time: (p.record_time as string | null) ?? null,
            guest: (p.guest as string | null) ?? null,
            status: p.status as string,
            episode_no: (p.episode_no as number | null) ?? null,
          })),
        },
        { status: 409 }
      );
    }
  }

  // identical derivation to the sync create branch
  const kind =
    show.billing_mode === "contract"
      ? "contract"
      : show.billing_mode === "per_episode" && show.client_id
      ? "client"
      : "internal";

  // the show's active contract, if it has one (0056) — attribution, not a
  // charge; see the same note in the sync's create branch
  let contractId: string | null = null;
  if (show.billing_mode === "contract") {
    const { data: c, error: cErr } = await createAdminClient()
      .from("contracts")
      .select("id")
      .eq("show_id", show.id)
      .eq("status", "active")
      .maybeSingle();
    // a failed lookup must not read as "no contract" — that would create the
    // production with contract_id=null and blame the configuration for it
    if (cErr) {
      return NextResponse.json(
        { error: `קריאת החוזה של התוכנית נכשלה: ${cErr.message} (${cErr.code ?? "?"})` },
        { status: 500 }
      );
    }
    contractId = (c?.id as string) ?? null;
  }

  const { data: inserted, error } = await supabase
    .from("productions")
    .insert({
      podcast_name: show.name,
      show_id: show.id,
      client_id: show.client_id,
      kind,
      contract_id: contractId,
      record_date: recordDate,
      record_time: body.record_time?.trim() || null,
      guest: body.guest?.trim() || null,
      studio: body.studio?.trim() || show.default_studio || null,
      camera_count: show.camera_count,
      // deliverables composition, copied show -> production (0055) — the
      // sync's create branch does the identical copy, which is what keeps a
      // hand-made production indistinguishable from a synced one downstream
      has_episode: show.has_episode,
      reels_count: show.reels_count,
      notes: body.notes?.trim() || null,
      calendar_uid: null,
      legacy: false,
    })
    // `status` is read back rather than restated: it is the column's DEFAULT,
    // and the work-order enqueue below needs the value the DB actually wrote
    // (0067 — see the per_hour branch of checkEligibility).
    .select("id,status")
    .single();
  if (error) {
    // RLS / guard rejection surfaces here as a clean 403
    const isGuard = /הרשאת|רק בעל/.test(error.message);
    return NextResponse.json({ error: error.message }, { status: isGuard ? 403 : 400 });
  }

  // "עורך קבוע" — auto-assign the edit steps the 6-stage trigger just created
  if (show.default_editor_id) {
    await admin
      .from("stages")
      .update({ assignee_id: show.default_editor_id })
      .eq("production_id", inserted.id)
      .eq("step", "edit");
  }

  await admin.from("events").insert({
    entity_type: "production",
    entity_id: inserted.id,
    event_type: "production_created_manually",
    actor_id: user.id,
    payload: {
      show_id: show.id,
      show: show.name,
      record_date: recordDate,
      kind,
      // recorded so "is this warning too aggressive?" is answerable from the
      // log in two months rather than from memory
      ...(body.confirm ? { confirmed_over_calendar_duplicate: true } : {}),
    },
  });

  // same work-order queue as the sync create branch: queued if eligible,
  // otherwise a 🟡 with the reason (never issued here)
  const enq = await enqueueDocument(admin, "work_order", {
    id: inserted.id,
    kind,
    legacy: false,
    client_id: show.client_id,
    show_id: show.id,
    podcast_name: show.name,
    record_date: recordDate,
    // identical expression to the insert above, so a hand-made production's
    // line reads the same as a synced one's
    guest: body.guest?.trim() || null,
    // 0067: same as the sync's create branch — an hourly show with no hours
    // yet is silence, not a flag, and this status is what says so.
    status: inserted.status,
  });

  return NextResponse.json({ ok: true, id: inserted.id, work_order: enq.status });
}
