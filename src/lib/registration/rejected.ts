import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * A number whose registration was REJECTED does not get the registration
 * buttons again for 30 days (owner decision 11.10). It gets the neutral
 * sentence, and the owner still gets `bizi_unknown_contact` once a day.
 *
 * 🔴 ONLY A VERIFIED NUMBER IS BLOCKED — `booking_wa_id_1_verified`, i.e. the
 * registration came through a link the bot minted for THAT wa_id. A number
 * typed into a manual link is somebody's claim, not proof: blocking on it
 * would let anyone silence someone else's number by registering it and being
 * rejected. (`booking_wa_id_2_verified` is never true — submit.ts writes it
 * false — so only the first number is read.)
 *
 * After 30 days (and after the purge in any case) the number is an ordinary
 * unknown number again. A manual link from an admin works at any time.
 */
export const REJECTED_BLOCK_DAYS = 30;

/** The earliest `rejected_at` that still blocks, as an ISO string. PURE. */
export function rejectedBlockCutoff(now: Date): string {
  return new Date(now.getTime() - REJECTED_BLOCK_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Was a registration from this VERIFIED number rejected in the last 30 days?
 * A read failure answers `true`: the number gets the neutral sentence and the
 * owner is still paged — nobody is lost, and a rejected number is not offered
 * the form again because the database blinked.
 */
export async function isRecentlyRejectedNumber(
  admin: SupabaseClient<Database>,
  waId: string,
  now: Date
): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from("client_registrations")
      .select("id")
      .eq("status", "rejected")
      .eq("booking_wa_id_1", waId)
      .eq("booking_wa_id_1_verified", true)
      .gte("rejected_at", rejectedBlockCutoff(now))
      .limit(1);
    if (error) {
      console.error("registration/rejected: קריאת ההרשמות שנדחו נכשלה", error);
      return true;
    }
    return (data ?? []).length > 0;
  } catch (e) {
    console.error("registration/rejected: קריאת ההרשמות שנדחו זרקה", e);
    return true;
  }
}
