// Shared by the /auth/confirm page and its ./verify POST, so the two can't
// drift on which link types are accepted or where they may forward to.

export const CONFIRM_TYPES = {
  invite: "לחץ על המשך כדי לבחור סיסמה ולהיכנס.",
  recovery: "לחץ על המשך כדי לבחור סיסמה חדשה.",
} as const;

export type ConfirmType = keyof typeof CONFIRM_TYPES;

export function isConfirmType(v: string): v is ConfirmType {
  return v === "invite" || v === "recovery";
}

const DEFAULT_NEXT: Record<ConfirmType, string> = {
  invite: "/reset-password",
  recovery: "/reset-password",
};

// Only an internal path: starts with a single "/". "//host" and "/\host" are
// protocol-relative to browsers, so both are refused, as is anything with a
// scheme or a control character.
export function safeNext(raw: string, type: ConfirmType): string {
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return DEFAULT_NEXT[type];
  if (raw.includes("\\") || raw.split("").some((c) => c.charCodeAt(0) < 0x20)) return DEFAULT_NEXT[type];
  return raw;
}
