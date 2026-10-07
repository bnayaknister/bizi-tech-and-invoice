import type { Profile } from "@/lib/profile";

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
