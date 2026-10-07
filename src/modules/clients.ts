import type { ModuleDef } from "@/modules/types";
import { canSeeClients } from "@/lib/clients/access";

// The clients screen on the hub (owner 7.10). Reachable from every screen as
// well, through the header menu — which reads this very registry, so the card
// and the menu item are one decision.
//
// hasAccess is `canSeeClients` BY REFERENCE, not a copy of its condition: the
// page and /clients/[id] both refuse on the same function, so a card that is
// drawn is a screen that opens, and a card that is hidden cannot be reached by
// typing the URL. The owner's gate is `owner || can_view_money` — an OR, so a
// bookkeeper with money sight gets in without being an owner.
export const clientsModule: ModuleDef = {
  key: "clients",
  // the approved wording, identical to the screen's own heading
  title: "לקוחות",
  // `users` is the person glyph. Shared with the משתמשים card on purpose:
  // the two are the same KIND of object (a directory of people/companies) read
  // for different reasons, and ModuleCard gives them different hues.
  icon: "users",
  href: "/clients",
  hasAccess: canSeeClients,
  /**
   * How many clients are billable — live rows (not merged) that are mapped to
   * Morning. Deliberately not "how many clients exist": an unmapped client
   * cannot be billed at all, so the number the owner wants on the hub is the
   * one that can take an invoice.
   *
   * `head: true` with an exact count — no rows cross the wire, so this is a
   * COUNT(*) and not a page of clients. One query, like every other card.
   */
  getMetric: async (supabase) => {
    const { count } = await supabase
      .from("clients")
      .select("id", { count: "exact", head: true })
      .is("merged_into", null)
      .not("morning_client_id", "is", null);
    const n = count ?? 0;
    return { label: "לקוחות פעילים לחיוב", value: String(n), tone: "default" };
  },
};
