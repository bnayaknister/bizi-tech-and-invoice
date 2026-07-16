import type { ModuleDef } from "@/modules/types";

export const archiveModule: ModuleDef = {
  key: "archive",
  title: "ארכיון",
  icon: "archive",
  href: "/archive",
  hasAccess: (profile) => profile.approved && profile.role === "owner",
  getMetric: async () => ({
    label: "גישה",
    value: "קריאה בלבד",
    tone: "default",
  }),
};
