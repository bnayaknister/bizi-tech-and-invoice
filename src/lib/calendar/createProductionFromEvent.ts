import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueDocument, type EnqueueResult } from "@/lib/documents/enqueue";

// ═══════════════════════════════════════════════════════════════════════════
// "Create a production from one calendar session" — extracted from
// calendar/sync/route.ts's `toCreate` loop (feat/calendar-write, 7.10, gate
// G1) so a SECOND caller — the booking-approval route, which mints a
// production the MOMENT a recording request is approved rather than waiting
// for the next sync — creates it exactly the same way. Same columns, same
// `kind` derivation, same default-editor auto-assign, same `calendar_created`
// event, same work-order enqueue.
//
// 🔴 WHY THIS MATTERS MORE THAN "DON'T REPEAT YOURSELF": a production that
// skips the kind derivation, or the work-order enqueue, or lands with a
// `calendar_uid` the next sync does not recognise, is exactly the class of
// silent gap this whole feature exists to close (ensure_job_for_production
// only ever fires for kind='client'; a production minted with the wrong kind
// would simply never bill). One function, two callers, is what makes "created
// exactly like the sync would create it" a property of the CODE rather than
// a promise kept by two authors staying in sync by hand.
//
// NOT SHARED, and deliberately so: title/text parsing (`extractStudioAndGuest`,
// `matchTitleToShow`) and the `today only` date-window logic are sync-specific
// — the booking-approval caller already KNOWS its show, studio, guest and
// date structurally, from `booking_requests`, with no text to parse. Every
// field below is RESOLVED before this function is called; it does no
// resolution of its own.
//
// ⚠️ UNTYPED `SupabaseClient`, matching `enqueueDocument`'s own signature and
// the sync route's own choice (calendar/sync/route.ts uses `createAdminClient`,
// not the typed factory) — this is an EXISTING convention for this code
// family, not a new exception carved out for 0099 specifically.
export type ShowForProductionCreate = {
  id: string;
  name: string;
  client_id: string | null;
  billing_mode: string;
  default_studio: string | null;
  camera_count: number | null;
  default_editor_id: string | null;
  has_episode: boolean;
  reels_count: number;
};

export type ProductionCreateInput = {
  show: ShowForProductionCreate;
  /** `contractByShow.get(show.id) ?? null` — resolved by the caller (0056) */
  contractId: string | null;
  /** `israelDate(start)` — already resolved; this function does no date math */
  recordDate: string;
  /** `israelTimeHHMM(start)`, or null when there is no instant to read one from */
  recordTime: string | null;
  /**
   * Already resolved to its FINAL value by the caller for every reason except
   * one: the show-default fallback. That one fallback stays HERE (see
   * `buildProductionInsert`) because it is not about where the studio name
   * came from — title-parsing for sync, a stored column for an approval — it
   * is about what a production's studio becomes when nothing more specific is
   * known, which is one rule regardless of caller.
   */
  studio: string | null;
  guest: string | null;
  /**
   * The calendar event's unique id. For sync, `action.event.uid` — the
   * iCalUID the ICS feed carried. For an approval, the `iCalUID` Google
   * returned from `events.insert`, captured at write time (see
   * lib/calendar/write.ts) rather than round-tripped through a future sync.
   * Either way this is what `productions.calendar_uid` becomes, and what lets
   * `buildSyncPlan` recognise the row on the very next run (sync.ts:67,
   * 0019's partial unique index) instead of creating a duplicate.
   */
  calendarUid: string;
  /** for the `calendar_created` event's payload only — never parsed back */
  eventTitle: string;
  /** which caller this is, carried into the event payload for the audit trail */
  source: "sync" | "booking_approval";
  /** explicit, never `new Date()` inside pure logic — same discipline booking/queue.ts states at its own top */
  now: Date;
};

/**
 * The exact INSERT payload `calendar/sync/route.ts` builds today, as a PURE
 * function — so the kind derivation and the studio fallback are testable
 * without a database, and so a future change to either is forced through one
 * place both callers read.
 *
 * `kind` is returned alongside the insert payload (not only inside it)
 * because `createProductionFromEvent` needs it a second time, for the
 * work-order enqueue below — reading it back off the built object would be a
 * third spelling of the same derivation disguised as a read.
 */
export function buildProductionInsert(input: ProductionCreateInput): {
  kind: string;
  insert: Record<string, unknown>;
} {
  const { show } = input;
  const kind =
    show.billing_mode === "contract"
      ? "contract"
      : show.billing_mode === "per_episode" && show.client_id
        ? "client"
        : "internal";

  return {
    kind,
    insert: {
      podcast_name: show.name,
      show_id: show.id,
      client_id: show.client_id,
      kind,
      // which contract this session belongs to (0056) — an ATTRIBUTION, not a
      // charge; see calendar/sync/route.ts's own note on why this never bills
      // anything by itself.
      contract_id: input.contractId,
      record_date: input.recordDate,
      record_time: input.recordTime,
      guest: input.guest,
      studio: input.studio ?? show.default_studio ?? null,
      camera_count: show.camera_count,
      // deliverables composition, copied show -> production (0055): editing
      // the show affects NEW productions only, never retroactively.
      has_episode: show.has_episode,
      reels_count: show.reels_count,
      calendar_uid: input.calendarUid,
      calendar_synced_at: input.now.toISOString(),
      legacy: false,
    },
  };
}

export type CreateProductionFromEventResult = {
  productionId: string;
  /** the column's DEFAULT, read back — the per_hour branch of checkEligibility needs it */
  status: string;
  enqueue: EnqueueResult;
};

/**
 * `deps.enqueueDocument` is injectable, default the real one — the one seam a
 * caller needs to test this without a database (see
 * scripts/test_create_production_from_event.ts): everything else here is a
 * plain `admin.from(...)` call against a fake client the test supplies.
 */
export async function createProductionFromEvent(
  admin: SupabaseClient,
  input: ProductionCreateInput,
  deps: { enqueueDocument: typeof enqueueDocument } = { enqueueDocument }
): Promise<CreateProductionFromEventResult> {
  const { show } = input;
  const { kind, insert } = buildProductionInsert(input);

  const { data: inserted, error } = await admin
    .from("productions")
    .insert(insert)
    // `status` is read back rather than restated: it is the column's DEFAULT
    // ('עתיד_להתחיל'), and the work-order enqueue below needs the value the
    // DB actually wrote — see the per_hour branch of checkEligibility.
    .select("id,status")
    .single();
  if (error) throw new Error(error.message);

  // "עורך קבוע" — auto-assign to the edit steps the 6-stage trigger just created
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
    event_type: "calendar_created",
    payload: {
      calendar_uid: input.calendarUid,
      title: input.eventTitle,
      show: show.name,
      source: input.source,
    },
  });

  // A new production owes a work order — but nothing is issued here. It is
  // QUEUED for the bookkeeper (owner spec 2026-07-19); an ineligible
  // production is not queued and gets a 🟡 with the reason instead.
  const enq = await deps.enqueueDocument(admin, "work_order", {
    id: inserted.id,
    kind,
    legacy: false,
    client_id: show.client_id,
    show_id: show.id,
    podcast_name: show.name,
    record_date: input.recordDate,
    guest: input.guest,
    // 0067: an hourly show's production is created with no hours (the session
    // hasn't happened), and this status is what tells checkEligibility that
    // their absence is the calendar, not a fault.
    status: inserted.status,
  });

  return { productionId: inserted.id, status: inserted.status, enqueue: enq };
}
