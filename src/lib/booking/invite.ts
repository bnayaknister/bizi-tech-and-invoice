import type { SupabaseClient } from "@supabase/supabase-js";
import { inviteAttendeesToSystemEvent, isCalendarDryRun } from "@/lib/calendar/write";
import { getClientEmails } from "@/lib/morning/client";
import { ACTIVE_CLIENT } from "@/lib/clients/status";
import { EMAIL_SHAPE } from "./bookers";

// ═══════════════════════════════════════════════════════════════════════════
// B26 — the client gets a Google Calendar invitation for a booked recording.
// ═══════════════════════════════════════════════════════════════════════════
//
// ═══ 🔴 A SEPARATE STEP, AFTER THE EVENT EXISTS, NEVER IN ITS WAY ═══
// The event itself is written exactly as before (writeCalendarEvent.ts) — the
// approval's critical path does not know invitations exist. Only after a REAL
// creation does `scheduleBookingInvite` hand a background task to the
// platform: read the client's emails, then PATCH them onto the event. A slow
// Morning, a client with no email, a 403 from Google — each is an `events`
// row and a log line. The event always stays; the bot and the API have
// already answered.
//
// ═══ WHO IS INVITED (owner decisions 12.10, B26 + E22) ═══
// Every email on the client's card IN MORNING — read live, no local copy — if
// the show has a client; a client who registered through /join and has none
// in Morning yet falls back to the emails of their approved registration.
// PLUS the email of every "מורשה לקבוע הקלטות" on the show (booking_contacts,
// 0111). A show without a client (an internal production) never reaches
// Morning. Cleaned: trimmed, lowercased, de-duplicated, a basic shape check.
//
// ═══ THE SWITCH ═══
// CALENDAR_INVITE_CLIENTS, default OFF — off means Morning is not called and
// nothing is scheduled. A calendar DRY RUN skips it too: there is no real
// event to invite anyone to, and a preview must not read Morning for nothing.
//
// There is no invitation-status column on booking_requests (no migration,
// owner decision) — the `events` rows are the record:
//   booking_calendar_invite_sent / _skipped (no-email) / _failed.

export function isInviteClientsOn(): boolean {
  return process.env.CALENDAR_INVITE_CLIENTS === "true";
}


/** Trim, lowercase, drop malformed, de-duplicate — order kept. PURE. */
export function cleanInviteEmails(list: unknown): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== "string") continue;
    const e = raw.trim().toLowerCase();
    if (!EMAIL_SHAPE.test(e) || out.includes(e)) continue;
    out.push(e);
  }
  return out;
}

export type InviteDeps = {
  getClientEmails: (morningClientId: string) => Promise<{ emails: string[]; ok: boolean }>;
  invite: typeof inviteAttendeesToSystemEvent;
};
const DEFAULT_DEPS: InviteDeps = { getClientEmails, invite: inviteAttendeesToSystemEvent };

export type ClientEmailSource = "morning" | "registration" | "none" | "no-client" | "morning-unreachable";

export type InviteOutcome =
  | {
      outcome: "sent";
      emails: number;
      fromClient: number;
      fromBookers: number;
      clientSource: ClientEmailSource;
      dryRun: boolean;
    }
  | { outcome: "skipped"; reason: "switch-off" | "no-email" | "not-created" }
  | { outcome: "failed"; reason: "morning-unreachable" | "google" | "refused" | "read"; error: string | null };

/**
 * The client card's emails for a show — Morning first, then the approved
 * /join registration. A show WITHOUT a client (an internal production, E22)
 * never reaches Morning: decision 5 of 12.10.
 */
async function clientEmailsForShow(
  admin: SupabaseClient,
  clientId: string | null,
  deps: InviteDeps
): Promise<{ emails: string[]; source: ClientEmailSource }> {
  if (!clientId) return { emails: [], source: "no-client" };
  const { data: client } = await admin
    // clients-status: by id — the status is read and checked right below
    .from("clients")
    .select("id,status,morning_client_id")
    .eq("id", clientId)
    .maybeSingle();
  // a client that is not active (pending, merged, rejected) is not read from Morning
  if (!client || client.status !== ACTIVE_CLIENT) return { emails: [], source: "no-client" };

  if (client.morning_client_id) {
    const m = await deps.getClientEmails(client.morning_client_id as string);
    if (!m.ok) return { emails: [], source: "morning-unreachable" };
    const fromMorning = cleanInviteEmails(m.emails);
    if (fromMorning.length) return { emails: fromMorning, source: "morning" };
  }
  // /join: approved, but Morning has no email for them yet
  const { data: regs } = await admin
    .from("client_registrations")
    .select("emails,decided_at")
    .eq("client_id", client.id as string)
    .eq("status", "approved")
    .order("decided_at", { ascending: false })
    .limit(1);
  const fromReg = cleanInviteEmails((regs?.[0] as { emails?: unknown } | undefined)?.emails);
  return { emails: fromReg, source: fromReg.length ? "registration" : "none" };
}

/** E22: the emails of the show's "מורשים לקבוע הקלטות" (0111's column). */
async function bookerEmailsForShow(admin: SupabaseClient, showId: string): Promise<string[]> {
  const { data } = await admin.from("booking_contacts").select("email").eq("show_id", showId);
  return cleanInviteEmails(((data ?? []) as { email: string | null }[]).map((r) => r.email));
}

/**
 * Invite the client and the show's bookers to ONE booking's event. Never
 * throws. Reads the row itself, so a caller hands over nothing but the id.
 *
 * Who (owner decision 12.10, E22-5): the client card's emails in Morning, if
 * the show has a client, PLUS every booker's email; duplicates removed. A
 * Morning that does not answer does not cost the bookers their invitation —
 * they are invited, and the event row says Morning was unreachable; only
 * when there is nobody else to invite is it a failure.
 */
export async function inviteClientsToBookingEvent(
  // untyped on purpose: writeCalendarEvent.ts passes either client factory,
  // and `booking_contacts.email` reaches database.types.ts only after 0111's
  // gen types
  admin: SupabaseClient,
  bookingId: string,
  deps: InviteDeps = DEFAULT_DEPS
): Promise<InviteOutcome> {
  if (!isInviteClientsOn()) return { outcome: "skipped", reason: "switch-off" };

  let result: InviteOutcome;
  try {
    const { data: row, error } = await admin
      .from("booking_requests")
      .select("id,status,show_id,calendar_event_id,calendar_write_status")
      .eq("id", bookingId)
      .maybeSingle();
    if (error || !row) {
      result = { outcome: "failed", reason: "read", error: error?.message ?? "הבקשה לא נמצאה" };
    } else if (row.status !== "approved" || row.calendar_write_status !== "created") {
      // a pending/declined/cancelled request invites nobody
      result = { outcome: "skipped", reason: "not-created" };
    } else {
      const { data: show } = await admin.from("shows").select("client_id").eq("id", row.show_id).maybeSingle();
      const client = await clientEmailsForShow(admin, (show?.client_id as string | null) ?? null, deps);
      const bookers = await bookerEmailsForShow(admin, row.show_id as string);
      const emails = cleanInviteEmails([...client.emails, ...bookers]);
      const fromBookers = emails.filter((e) => !client.emails.includes(e)).length;

      if (emails.length === 0) {
        result =
          client.source === "morning-unreachable"
            ? { outcome: "failed", reason: "morning-unreachable", error: "מורנינג לא ענה" }
            : { outcome: "skipped", reason: "no-email" };
      } else {
        const r = await deps.invite({
          bookingId: row.id as string,
          calendarEventId: row.calendar_event_id as string | null,
          calendarWriteStatus: row.calendar_write_status as string | null,
          emails,
        });
        if (r.ok) {
          result = {
            outcome: "sent",
            emails: emails.length,
            fromClient: client.emails.length,
            fromBookers,
            clientSource: client.source,
            dryRun: r.dryRun,
          };
        } else if (r.refused) result = { outcome: "failed", reason: "refused", error: r.reason };
        else result = { outcome: "failed", reason: "google", error: r.error };
      }
    }
  } catch (e) {
    result = { outcome: "failed", reason: "read", error: e instanceof Error ? e.message : "שגיאה לא ידועה" };
  }

  if (result.outcome !== "sent") console.error("booking/invite:", bookingId, JSON.stringify(result));
  try {
    await admin.from("events").insert({
      entity_type: "booking_request",
      entity_id: bookingId,
      event_type:
        result.outcome === "sent"
          ? "booking_calendar_invite_sent"
          : result.outcome === "skipped"
            ? "booking_calendar_invite_skipped"
            : "booking_calendar_invite_failed",
      actor_id: null,
      // COUNTS, never the addresses — an audit row is not a second copy of
      // anybody's contact details
      payload: result,
    });
  } catch (e) {
    console.error("booking/invite: רישום האירוע נכשל", e);
  }
  return result;
}

// ─── running it after the response ─────────────────────────────────────────

type Runner = (task: () => Promise<unknown>) => void;

/**
 * Next 14.2 has no `after()`. On Vercel, the request context exposes
 * `waitUntil` under this well-known symbol — exactly what @vercel/functions
 * reads — so the function stays alive until the task settles without the
 * response waiting for it. Anywhere else the promise simply runs on.
 */
const defaultRunner: Runner = (task) => {
  const p = Promise.resolve()
    .then(task)
    .catch((e) => console.error("booking/invite: המשימה ברקע זרקה", e));
  try {
    const ctx = (globalThis as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } } | undefined>)[
      Symbol.for("@vercel/request-context")
    ]?.get?.();
    ctx?.waitUntil?.(p);
  } catch {
    /* not on Vercel: the promise runs on regardless */
  }
};

let runner: Runner = defaultRunner;

/** Tests capture the task instead of letting it float. */
export function setInviteRunnerForTests(r: Runner | null): void {
  runner = r ?? defaultRunner;
}

/**
 * Called after a REAL event creation. Off / dry run: nothing is scheduled and
 * Morning is not called.
 */
export function scheduleBookingInvite(admin: SupabaseClient, bookingId: string): boolean {
  if (!isInviteClientsOn() || isCalendarDryRun()) return false;
  runner(() => inviteClientsToBookingEvent(admin, bookingId));
  return true;
}
