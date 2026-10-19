"use client";

import { useState } from "react";
import { PASSWORD_MESSAGES, PASSWORD_MIN, checkNewPassword } from "@/lib/auth/passwordErrors";

// U1-7: the new-password form. `withCurrent` = the in-app "החלפת סיסמה"
// (current password required, checked by Supabase); without it = the email
// link flow on /reset-password. Both post to /api/account/password, which maps
// every Supabase error code to one Hebrew message.
export default function PasswordForm({
  withCurrent,
  onSuccess,
}: {
  withCurrent: boolean;
  onSuccess: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (withCurrent && !current) {
      setError("יש להזין את הסיסמה הנוכחית.");
      return;
    }
    const local = checkNewPassword(password, confirm);
    if (local) {
      setError(PASSWORD_MESSAGES[local]);
      return;
    }
    setSaving(true);
    const res = await fetch("/api/account/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withCurrent ? { password, current_password: current } : { password }),
    }).catch(() => null);
    setSaving(false);
    if (!res) {
      setError(PASSWORD_MESSAGES.generic);
      return;
    }
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(d.error ?? PASSWORD_MESSAGES.generic);
      return;
    }
    setCurrent("");
    setPassword("");
    setConfirm("");
    onSuccess();
  }

  const field =
    "border border-[var(--rule)] rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[var(--violet-light)] transition-colors";
  const fieldStyle = { background: "rgba(255,255,255,0.05)" } as React.CSSProperties;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {withCurrent && (
        <input
          type="password"
          autoComplete="current-password"
          placeholder="סיסמה נוכחית"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
          className={field}
          style={fieldStyle}
          dir="ltr"
        />
      )}
      <input
        type="password"
        autoComplete="new-password"
        placeholder={`סיסמה חדשה (${PASSWORD_MIN}+ תווים)`}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        className={field}
        style={fieldStyle}
        dir="ltr"
      />
      <input
        type="password"
        autoComplete="new-password"
        placeholder="אימות סיסמה חדשה"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        required
        className={field}
        style={fieldStyle}
        dir="ltr"
      />
      {error && <div className="text-[var(--peak)] text-xs">{error}</div>}
      <button
        type="submit"
        disabled={saving}
        className="text-white font-bold rounded-xl px-3 py-2.5 text-sm mt-1 disabled:opacity-50"
        style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 14px rgba(139,92,246,0.3)" }}
      >
        {saving ? "שומר…" : "שמירת סיסמה"}
      </button>
    </form>
  );
}
