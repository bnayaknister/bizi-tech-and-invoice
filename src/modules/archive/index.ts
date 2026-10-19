import type { ModuleDef } from "@/modules/types";
import { hasOwnerAccess } from "@/lib/roles";

export const archiveModule: ModuleDef = {
  key: "archive",
  title: "ארכיון",
  icon: "archive",
  href: "/archive",
  hasAccess: (profile) => profile.approved && hasOwnerAccess(profile),
  getMetric: async () => ({
    label: "גישה",
    value: "קריאה בלבד",
    tone: "default",
  }),
};
