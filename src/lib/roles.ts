// U1-4 (0119): "admin" is everything the owner has, except managing users and
// permissions. Mirrors the SQL pair: is_owner() = owner|admin,
// is_owner_strict() = owner only. A separate file (no server imports) because
// client components (NavMenu via the module registry) use it too.

type WithRole = { role?: string | null } | null | undefined;

/** Owner-level screens and actions: owner OR admin. Matches SQL is_owner(). */
export function hasOwnerAccess(profile: WithRole): boolean {
  return profile?.role === "owner" || profile?.role === "admin";
}

/** User management only: owner. Matches SQL is_owner_strict(). */
export function isStrictOwner(profile: WithRole): boolean {
  return profile?.role === "owner";
}

/** Hebrew role names (U1-6: the header's user menu, the users screen). */
export const ROLE_LABELS: Record<string, string> = {
  owner: "בעלים",
  admin: "אדמין",
  tech: "טכנאי",
  bookkeeper: "חשבונאית",
};

export function roleLabel(role: string | null | undefined): string {
  return (role && ROLE_LABELS[role]) || "ללא תפקיד";
}
