import type { ModuleDef } from "@/modules/types";
import { pendingFutureCount, type QueueRow } from "@/lib/booking/queue";

// Stage 3ג of client-booked recordings: the queue the owner decides in.
//
// Owner-only, through the same predicate availabilityModule, archiveModule and
// settingsModule use — `profile.approved && profile.role === "owner"`. The hub
// filters on hasAccess, so a tech or bookkeeper never receives the card; the
// page and both routes repeat the check, because a hidden card is not an
// authorisation.
export const bookingsModule: ModuleDef = {
  key: "bookings",
  title: "בקשות הקלטה",
  // the same glyph availabilityModule borrows — these are two screens about
  // one subject, and the hub reads better when they look related
  icon: "productions",
  href: "/bookings",
  hasAccess: (profile) => profile.approved && profile.role === "owner",
  /**
   * A REAL count, unlike availabilityModule's static card — and it is cheap in
   * a way that one is not: a number from one indexed query on a small table,
   * against parsing the whole ICS feed on every hub load.
   *
   * ⚠️ The filtering is done by `pendingFutureCount`, in memory, rather than by
   * a `.gte("start_at", …)` in the query. Two reasons, and the second is the
   * real one: a filter inside a query string cannot be unit-tested without a
   * database and F19 is open, and the badge must mean exactly what the screen's
   * "ממתינות" section shows — both now read the same function, so they cannot
   * drift. The same doubled shape as toPickerShows and clickableDays.
   *
   * `status` is narrowed in SQL because that part is not a judgement.
   */
  getMetric: async (supabase) => {
    const { data } = await supabase
      .from("booking_requests")
      .select("id,start_at,status")
      .eq("status", "pending");
    const n = pendingFutureCount((data ?? []) as unknown as QueueRow[], new Date());
    return {
      label: "בקשות ממתינות",
      value: String(n),
      tone: n > 0 ? "warn" : "default",
    };
  },
};
