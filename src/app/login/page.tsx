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
      redirectTo: `${window.location.origin}/auth/callback?next=/welcome`,
    });
    if (error) {
      setError("שגיאה בשליחת מייל איפוס.");
      return;
    }
    setResetSent(true);
  }

  const fieldStyle = {
    background: "rgba(255,255,255,0.05)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
  } as React.CSSProperties;

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="glass-card w-full max-w-sm" style={{ padding: "34px 32px" }}>
        <span className="corner-glow" style={{ ["--glow-color" as string]: "rgba(192,132,252,0.26)" }} />
        <div className="glass-content">
          <div className="flex flex-col items-center gap-3 mb-2">
            <SoundWaveLogo size={40} animated />
            <h1 className="text-lg font-bold font-mono" dir="ltr">
              <span className="grad-text">BiziPodclub</span>{" "}
              <span className="text-[var(--faint)] font-normal">Manage</span>
            </h1>
          </div>
          <p className="text-center text-[11px] tracking-[0.08em] text-[var(--faint)] mb-7">THE SOUND OF TLV</p>

          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <input
              type="email"
              placeholder="אימייל"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="border border-[var(--rule)] rounded-xl px-3 py-2.5 text-sm focus:border-[var(--violet-light)] outline-none transition-colors"
              style={fieldStyle}
              dir="ltr"
            />
            <input
              type="password"
              placeholder="סיסמה"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="border border-[var(--rule)] rounded-xl px-3 py-2.5 text-sm focus:border-[var(--violet-light)] outline-none transition-colors"
              style={fieldStyle}
              dir="ltr"
            />
            {error && <div className="text-[var(--peak)] text-xs">{error}</div>}
            {resetSent && (
              <div className="text-[var(--violet-light)] text-xs">
                נשלח מייל איפוס סיסמה — בדוק את התיבה.
              </div>
            )}
            <button
              type="submit"
              disabled={loading}
              className="text-white font-bold rounded-xl px-3 py-2.5 text-sm mt-2 disabled:opacity-60"
              style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))", boxShadow: "0 4px 16px rgba(139,92,246,0.35)" }}
            >
              {loading ? "מתחבר…" : "התחברות"}
            </button>
            <button
              type="button"
              onClick={handleForgotPassword}
              className="text-[var(--dim)] text-xs underline mt-1 hover:text-[var(--violet-light)] transition-colors"
            >
              שכחתי סיסמה
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
