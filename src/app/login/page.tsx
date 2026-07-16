"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import SoundWaveLogo from "@/components/SoundWaveLogo";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError("אימייל או סיסמה שגויים.");
      return;
    }
    router.push("/");
    router.refresh();
  }

  async function handleForgotPassword() {
    if (!email) {
      setError("הזן קודם את כתובת המייל שלך למעלה.");
      return;
    }
    setError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });
    if (error) {
      setError("שגיאה בשליחת מייל איפוס.");
      return;
    }
    setResetSent(true);
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm border border-[var(--rule)] rounded bg-[var(--panel2)] p-8">
        <div className="flex items-center gap-3 mb-6 justify-center">
          <SoundWaveLogo size={28} animated />
          <h1 className="text-lg font-bold tracking-tight">
            ביזי <span className="grad-text">סטודיו</span>
          </h1>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="email"
            placeholder="אימייל"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="bg-[var(--panel)] border border-[var(--rule)] rounded px-3 py-2 text-sm"
            dir="ltr"
          />
          <input
            type="password"
            placeholder="סיסמה"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="bg-[var(--panel)] border border-[var(--rule)] rounded px-3 py-2 text-sm"
            dir="ltr"
          />
          {error && <div className="text-[var(--peak)] text-xs">{error}</div>}
          {resetSent && (
            <div className="text-[var(--signal)] text-xs">
              נשלח מייל איפוס סיסמה — בדוק את התיבה.
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="bg-[var(--signal)] text-[var(--on-accent)] font-bold rounded px-3 py-2 text-sm mt-2 disabled:opacity-60"
          >
            {loading ? "מתחבר…" : "התחברות"}
          </button>
          <button
            type="button"
            onClick={handleForgotPassword}
            className="text-[var(--dim)] text-xs underline mt-1"
          >
            שכחתי סיסמה
          </button>
        </form>
      </div>
    </main>
  );
}
