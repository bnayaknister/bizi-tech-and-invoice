import type { ModuleDef } from "@/modules/types";

// Visible only to a user-manager (the approver). The metric is the count of
// pending destructive-action requests waiting on them — the dashboard
// counter the owner asked for ("3 בקשות ממתינות").
export const approvalsModule: ModuleDef = {
  key: "approvals",
  title: "בקשות אישור",
  icon: "approvals",
  href: "/approvals",
  hasAccess: (profile) => profile.approved && profile.can_manage_users,
  getMetric: async (supabase) => {
    const { count } = await supabase
      .from("approval_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    const n = count ?? 0;
    return {
      label: "בקשות ממתינות",
      value: String(n),
      tone: n > 0 ? "warn" : "default",
    };
  },
};
