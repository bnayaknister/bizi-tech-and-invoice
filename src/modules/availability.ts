import type { ModuleDef } from "@/modules/types";

// Stage 2 of client-booked recordings: the internal check the owner reads
// BEFORE any client link exists (the public link is stage 3, and is not this).
//
// Owner-only, through the same predicate archiveModule and settingsModule use —
// `profile.approved && profile.role === "owner"`. The hub filters on hasAccess,
// so a tech or bookkeeper never receives the card; the page and the route repeat
// the check for themselves, because a hidden card is not an authorisation.
export const availabilityModule: ModuleDef = {
  key: "availability",
  title: "זמינות אולפנים",
  // No calendar glyph exists in LineIcon and this is not the place to add one —
  // documentsModule already borrows "finance" and projectsModule "productions".
  icon: "productions",
  href: "/calendar/availability",
  hasAccess: (profile) => profile.approved && profile.role === "owner",
  // Static, like archiveModule's. The real metric — how many slots are free —
  // would mean fetching and parsing the whole ICS feed on every hub load for
  // every owner, to fill one number on a card nobody navigates by. The screen
  // itself is one click away and computes it properly.
  getMetric: async () => ({
    label: "גישה",
    value: "בדיקה פנימית",
    tone: "default",
  }),
};
