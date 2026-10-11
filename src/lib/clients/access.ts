import type { Profile } from "@/lib/profile";
import { ACTIVE_CLIENT, MERGED_CLIENT, PENDING_CLIENT } from "@/lib/clients/status";

/**
 * Who may see the clients screen — owner 7.10: "owner או can_view_money בלבד.
 * מי שאינו עובר — לא רואה את הכרטיס ולא את המסך."
 *
 * ═══ WHY THIS IS ITS OWN FILE, AND NOT IN app/clients/data.ts ═══
 * Three callers need it and one of them must stay pure. `modules/clients.ts`
 * registers it as the hub card's `hasAccess`, and `modules/registry.ts` is
 * imported by AppHeader — so anything the registry can reach travels with
 * every authenticated screen's module graph. `data.ts` imports
 * `next/headers` (through the server supabase client), and a predicate that
 * drags that in cannot be unit-tested offline either, which is exactly what
 * F19 requires of this change's suite.
 *
 * So: one pure function, three importers, zero copies.
 *   · modules/clients.ts  — whether the hub draws the card
 *   · app/clients/data.ts — whether the screen answers at all
 *   · the suite           — asserted per role, by counting
 *
 * 🔴 AN OR, NOT AN AND, and `approved` is non-negotiable on top of it. An
 * owner gets in on their role; a bookkeeper gets in on can_view_money without
 * being an owner. Writing it as `role === "owner" && can_view_money` would
 * lock out exactly the audience the screen was asked for.
 *
 * ⚠️ VIEWING IS NOT EDITING. This gate decides whether the list and the card
 * are readable. Every write still runs through POST /api/entity/client/[id],
 * which checks `can_edit_money` itself — and the ח.פ, which goes to Morning,
 * is checked there too. A gate that let someone read must never be mistaken
 * for one that lets them write.
 */
export function canSeeClients(profile: Profile | null | undefined): boolean {
  return !!profile?.approved && (profile.role === "owner" || !!profile.can_view_money);
}

/**
 * Bnaya and Eli — `profiles.studio_admin` (0107). The flag is set only from the
 * SQL Editor; `guard_studio_admin_flag` refuses every session write to it, so
 * reading it from the viewer's own profile row is reading something the
 * viewer cannot have granted themselves.
 *
 * `approved` on top, like every gate in this file: an unapproved account is
 * nobody, whatever its flags say.
 */
export function isStudioAdmin(
  profile: Pick<Profile, "approved" | "studio_admin"> | null | undefined
): boolean {
  return !!profile?.approved && !!profile.studio_admin;
}

/**
 * "הרשאות הזמנת חדרים" — owner decision 11.10 (E17): Bnaya and Eli only, to
 * VIEW as well as to edit. Before E17-3 it was can_view_money / can_edit_money,
 * which also let Shiri (and any bookkeeper with money sight) in. One predicate
 * for the drawer, the /clients card and the route, so the tab cannot be drawn
 * for someone the route would refuse.
 */
export const BOOKING_CONTACTS_FORBIDDEN = "הרשאות הזמנת חדרים — לבניה ולאלי בלבד";

export function canManageBookingContacts(
  profile: Pick<Profile, "approved" | "studio_admin"> | null | undefined
): boolean {
  return isStudioAdmin(profile);
}

/**
 * Which client statuses the /clients list loads for this viewer (E17-3).
 * Everyone: `active` and `merged` — the merged rows feed the "מוזגו" tab and
 * nothing else (filterClients keeps them out of every other scope; B24). A
 * studio_admin also gets `pending`, shown in its own "ממתינים לאישור" tab.
 * `rejected` is in nobody's list — it is never read.
 */
export function clientStatusesVisibleTo(
  profile: Pick<Profile, "approved" | "studio_admin"> | null | undefined
): string[] {
  return isStudioAdmin(profile) ? [ACTIVE_CLIENT, PENDING_CLIENT, MERGED_CLIENT] : [ACTIVE_CLIENT, MERGED_CLIENT];
}

/** Does this viewer get the "ממתינים לאישור" tab? */
export function canSeePendingClients(
  profile: Pick<Profile, "approved" | "studio_admin"> | null | undefined
): boolean {
  return clientStatusesVisibleTo(profile).includes(PENDING_CLIENT);
}

/**
 * "קישור הרשמה חדש" (E17-4): a studio_admin, and only while registration is
 * open — the switch is passed in so this stays pure.
 */
export function canCreateRegistrationLink(
  profile: Pick<Profile, "approved" | "studio_admin"> | null | undefined,
  registrationEnabled: boolean
): boolean {
  return registrationEnabled && isStudioAdmin(profile);
}
