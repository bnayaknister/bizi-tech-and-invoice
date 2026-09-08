import type { ModuleDef } from "@/modules/types";
import { createTypedAdminClient } from "@/lib/supabase/admin";

/**
 * "רדיו ושונות" on the hub.
 *
 * Reuses the productions waveform glyph, the way projects.ts does and for the
 * same reason: DESIGN.md §12 admits no emoji, so a new icon is a real drawing
 * decision rather than a one-liner, and this IS audio work — a radio production
 * or a sound edit — just not a podcast episode. The hue is what separates the
 * three: violet on /productions, cyan on /projects, violet-light here
 * (ModuleCard's MODULE_THEME).
 *
 * hasAccess is can_view_money, matching the screen's own gate (owner decision
 * 2026-09-08 — the screen is closed to technicians outright). It deliberately
 * does NOT match 0074's RLS policy, which is can_view_stages and stays that
 * way; see misc/page.tsx for why the app gate is the narrower of the two and
 * the one that enforces.
 */
export const miscModule: ModuleDef = {
  key: "misc",
  title: "רדיו ושונות",
  icon: "productions",
  href: "/misc",
  hasAccess: (profile) => profile.approved && profile.can_view_money,

  /**
   * ⚠️ THE PASSED-IN CLIENT IS NOT USED HERE, AND THAT IS THE WHOLE POINT.
   *
   * The hub hands every module the USER'S session client (app/page.tsx:14), so
   * every metric is read under RLS. For every other money module that is
   * correct — jobs, documents and contracts are all can_view_money policies, so
   * the card's own gate and the policy agree.
   *
   * misc_productions is the one place they disagree: its policy is
   * can_view_stages (0074) while this card is can_view_money, and the two
   * permissions are INDEPENDENT booleans, both defaulting false (0002:14-16).
   * A bookkeeper with can_view_money and no can_view_stages — the exact person
   * the owner just narrowed this screen to — would be shown the card, read zero
   * rows through her own session, and get a confident "0 עבודות פתוחות" beside
   * a /misc screen listing them. Not an error, not an empty state: a plausible
   * number that is simply false, which is the failure mode this codebase has
   * paid for twice (unwrap.ts, and the 546 cards showing 0/0 in 0035).
   *
   * So the count is read through the service role, authorised by hasAccess
   * above rather than by RLS — the same trade the screen itself makes and the
   * same one radar/page.tsx:26 makes. The alternative is widening 0074's policy
   * to `can_view_stages() or can_view_money()`, which is a migration and is not
   * this task.
   *
   * This runs ONLY for a user who already passed hasAccess: the hub filters
   * before it calls getMetric (app/page.tsx:15-16), so there is no path where
   * this client is constructed for someone without can_view_money.
   */
  getMetric: async () => {
    const admin = createTypedAdminClient();
    // The two states named ONE BY ONE, never as a range. This is the trap 0074's
    // header spells out and 0060/0061/0062 each warn about in turn: 'בוטל' is
    // LAST in the enum, after every working state, so anything shaped like
    // `status >= 'הושלם'` — or `status < 'בוטל'` reaching for "not cancelled" —
    // sweeps cancelled rows in. The enum order exists for display, not logic.
    //
    // head:true — the count is all this needs, so no row bodies cross the wire.
    const { count } = await admin
      .from("misc_productions")
      .select("id", { count: "exact", head: true })
      .in("status", ["נפתח", "בעבודה"]);
    const n = count ?? 0;
    return {
      label: "עבודות פתוחות",
      value: String(n),
      tone: n > 0 ? "signal" : "default",
    };
  },
};
