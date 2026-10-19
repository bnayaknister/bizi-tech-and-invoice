// U1-7: one Hebrew message per GoTrue password error code, shared by the
// in-app "החלפת סיסמה" form and /reset-password (both go through
// POST /api/account/password). Codes verified live on 19.10 with
// security_update_password_require_current_password ON:
//   current_password_required, current_password_invalid, same_password,
//   weak_password; rate limits come back as over_request_rate_limit / 429.
// Neutral wording (owner rule).

export const PASSWORD_MIN = 8;

export const PASSWORD_MESSAGES = {
  current_password_invalid: "הסיסמה הנוכחית שגויה.",
  // a normal (non-recovery) session on /reset-password: the in-app form is the way
  current_password_required: "כדי להחליף סיסמה מתוך המערכת, יש להשתמש ב'החלפת סיסמה' בתפריט המשתמש.",
  same_password: "הסיסמה החדשה זהה לסיסמה הנוכחית. יש לבחור סיסמה אחרת.",
  weak_password: `הסיסמה חלשה מדי. נדרשים לפחות ${PASSWORD_MIN} תווים.`,
  mismatch: "האימות לא תואם לסיסמה החדשה.",
  rate_limit: "היו יותר מדי ניסיונות. אפשר לנסות שוב בעוד כמה דקות.",
  no_session: "הקישור כבר לא בתוקף. יש לבקש קישור חדש ממנהל המערכת או להשתמש ב'שכחתי סיסמה'.",
  generic: "החלפת הסיסמה נכשלה. אפשר לנסות שוב בעוד רגע.",
} as const;

export type PasswordErrorKey = keyof typeof PASSWORD_MESSAGES;

/** GoTrue error → our key; null = unknown (the caller logs the original). */
export function passwordErrorKey(code: string | undefined, status: number | undefined): PasswordErrorKey | null {
  if (code === "current_password_invalid" || code === "current_password_mismatch") return "current_password_invalid";
  if (code === "current_password_required") return "current_password_required";
  if (code === "same_password") return "same_password";
  if (code === "weak_password") return "weak_password";
  if (status === 429 || code === "over_request_rate_limit" || code === "over_email_send_rate_limit") return "rate_limit";
  if (code === "session_not_found" || code === "session_expired" || code === "no_authorization" || code === "bad_jwt") {
    return "no_session";
  }
  return null;
}

/** The checks both forms make before calling the server. */
export function checkNewPassword(password: string, confirm: string): PasswordErrorKey | null {
  if (password.length < PASSWORD_MIN) return "weak_password";
  if (password !== confirm) return "mismatch";
  return null;
}
