import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureBookingLink } from "./links";
import { getAppBaseUrl } from "@/lib/appUrl";

// ═══════════════════════════════════════════════════════════════════════════
// Who may book which podcast — the lookup the bot does on every message.
// E9-3, owner decision 8.10 (rule ד).
// ═══════════════════════════════════════════════════════════════════════════
//
// `booking_contacts` (0103) is a many-to-many between a phone number and a
// show: several people may book one podcast, and one number may be authorised
// for several podcasts. The second half is what produces the list message.
//
// ⚠️ UNTYPED CLIENT THROUGHOUT. 0103 is applied by hand and
// `database.types.ts` is regenerated only afterwards (README step 3), so a
// types entry for `booking_contacts` would fail the drift check on the
// dangerous "-" side. Same choice, and the same sentence, as the webhook route
// before 0101 was applied.

export type ContactShow = {
  showId: string;
  showName: string;
  /** the contact's own name on that show's row — several people may share a number */
  contactName: string;
};

/**
 * Which podcasts this number may book, by name.
 *
 * ⚠️ THE NUMBER IS USED AS GIVEN. `wa_id` is stored canonical (0103's CHECK is
 * digits-only) and Meta sends it canonical, so there is nothing to normalise
 * here — and normalising both sides of the comparison would stop it using the
 * index `booking_contacts_wa_id_idx`, on the critical path of a webhook that
 * owes Meta a fast 200.
 *
 * Sorted by show name so the list message is stable between two messages from
 * the same person; an unordered list that reshuffles reads as a different list.
 */
export async function showsForNumber(admin: SupabaseClient, waId: string): Promise<ContactShow[]> {
  const { data, error } = await admin
    .from("booking_contacts")
    .select("show_id,name,shows(id,name)")
    .eq("wa_id", waId);

  if (error) {
    // Logged and treated as "unknown", never as "authorised for everything".
    // The safe direction for a failed permission read is zero permissions.
    console.error("booking/contacts: קריאת ההרשאות נכשלה", error);
    return [];
  }

  const out: ContactShow[] = [];
  for (const row of data ?? []) {
    // `as unknown as` and not a direct cast: on the UNTYPED client PostgREST's
    // embed is inferred as an ARRAY even for a to-one relation, so the two
    // shapes do not overlap and TypeScript is right to refuse the short form.
    // Same idiom as every other embed read in this codebase
    // (e.g. approve/route.ts's `row.shows as unknown as {...} | null`).
    const r = row as unknown as {
      show_id: string;
      name: string;
      shows?: { id: string; name: string } | null;
    };
    const show = r.shows ?? null;
    if (!show) continue;
    out.push({ showId: r.show_id, showName: show.name, contactName: r.name });
  }
  return out.sort((a, b) => a.showName.localeCompare(b.showName, "he"));
}

export type BookingUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: "no-clean-alias" | "show-not-found" | "failed" };

/**
 * The booking URL for one show — reusing its live link, or minting the first.
 *
 * ═══ 🔴 WHY THE BOT IS ALLOWED TO MINT A LINK ═══
 * `ensureBookingLink` (links.ts:105) takes an ADMIN CLIENT and no session: it
 * was always callable without a cookie, and `/api/booking/links` is merely the
 * owner's button on top of it. It is idempotent in the way that matters — a
 * show with a live link gets that link back unchanged, however many times it
 * is called — and 0096's partial unique index
 * (`booking_links_one_active_per_show`) is the real guarantee, not the select
 * inside it.
 *
 * So the alternative — refuse, and tell the owner to go and press a button —
 * would mean a client who writes to the bot waits for a human before they can
 * see a calendar, which is the one thing this whole stage exists to remove.
 * `created_by` is NULL for a bot-minted link, exactly as `decided_by` is null
 * for an automatic approval: the absence IS the record of who did it.
 *
 * ⚠️ THE ALIAS GATE STILL REFUSES, AND MUST. A show whose every name contains
 * a room name cannot produce a calendar title the sync reads back correctly
 * (see ./alias for the measurement), so giving it a link would manufacture
 * wrong-room productions on approval. The bot reports `no-clean-alias` up and
 * the caller tells the owner — it does not work around it.
 *
 * ⚠️ AND THE BASE URL IS `getAppBaseUrl`, NOT THE REQUEST ORIGIN. The owner's
 * route builds its URL from `new URL(request.url).origin` (booking/links/
 * route.ts:64-67), which is right for a clipboard and WRONG here: the origin
 * of a webhook request is whatever host Meta happened to hit, and a Vercel
 * preview alias sits behind Deployment Protection — a client tapping that link
 * lands on an SSO screen (appUrl.ts:1-13 documents exactly this failure).
 */
export async function bookingUrlForShow(
  admin: SupabaseClient,
  request: Request,
  showId: string
): Promise<BookingUrlResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await ensureBookingLink(admin as any, showId, null);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, url: `${getAppBaseUrl(request)}/b/${result.token}` };
}
