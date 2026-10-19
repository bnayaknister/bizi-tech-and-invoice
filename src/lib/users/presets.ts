// The role presets of the users screen (owner spec 2026-07-18; admin = U1-4).
// Shared by the screen (one-click presets) and by POST /api/users, which
// applies the chosen role's flags to a new user (U1-5). No server imports:
// UsersClient is a client component.

export type PermKey =
  | "can_view_money"
  | "can_edit_money"
  | "can_view_stages"
  | "can_edit_stages"
  | "can_manage_users"
  | "can_import";

export type PresetRole = "tech" | "bookkeeper" | "admin";

export const PRESETS: Record<PresetRole, { label: string; role: PresetRole; flags: Record<PermKey, boolean> }> = {
  tech: {
    label: "טכנאי",
    role: "tech",
    flags: {
      can_view_stages: true,
      can_edit_stages: true,
      can_view_money: false,
      can_edit_money: false,
      can_manage_users: false,
      can_import: false,
    },
  },
  bookkeeper: {
    // read-only on productions/shows, but marks paid + issues invoices
    label: "חשבונאית",
    role: "bookkeeper",
    flags: {
      can_view_stages: true,
      can_edit_stages: false,
      can_view_money: true,
      can_edit_money: true,
      can_manage_users: false,
      can_import: false,
    },
  },
  admin: {
    // U1-4: admin = everything but managing users (that stays role=owner).
    // role=owner is never a preset: it is set by hand only.
    label: "אדמין",
    role: "admin",
    flags: {
      can_view_stages: true,
      can_edit_stages: true,
      can_view_money: true,
      can_edit_money: true,
      can_manage_users: true,
      can_import: true,
    },
  },
};

export function isPresetRole(v: unknown): v is PresetRole {
  return v === "tech" || v === "bookkeeper" || v === "admin";
}
