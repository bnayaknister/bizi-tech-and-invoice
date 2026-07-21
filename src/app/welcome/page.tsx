"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import SoundWaveLogo from "@/components/SoundWaveLogo";

// First-login / set-password landing. An invited user's email link lands here
// (via /auth/callback, which exchanges the code for a session first), so all
// this screen has to do is take a password — no "guess that you must click
// forgot password" (owner, 2026-07-21). Also serves the forgot-password flow.
//
// It needs a live session (established by the callback). If there isn't one —
// an expired or reused link — it says so instead of failing silently.
export default function WelcomePage() {
  const router = useRouter();
  const supabase = createClient();

  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setHasSession(!!data.user);
      setName((data.user?.user_metadata?.name as string) ?? null);
      setReady(true);
    });
  }, [supabase]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("סיסמה חייבת להיות לפחות 8 תווים.");
      return;
    }
    if (password !== confirm) {
      setError("הסיסמאות אינן תואמות.");
      return;
    }
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password });
    setSaving(false);
    if (error) {
      setError("שגיאה בקביעת הסיסמה. ייתכן שהקישור פג — בקש הזמנה חדשה.");
      return;
    }
    setDone(true);
    // the middleware routes an unapproved account to /pending, an approved one
    // into the app — so a plain push home does the right thing either way
    setTimeout(() => {
      router.push("/");
      router.refresh();
    }, 1200);
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
          <div className="flex flex-col items-center gap-3 mb-5">
            <SoundWaveLogo size={40} animated />
            <div className="text-center">
              <h1 className="text-lg font-black">ברוך הבא ל-BiziPodclub Manage</h1>
              <p className="text-xs text-[var(--faint)] mt-1">
                {name ? `${name}, ` : ""}קבע סיסמה כדי להיכנס
              </p>
            </div>
          </div>

          {!ready ? (
            <div className="text-center text-sm text-[var(--faint)] py-4">טוען…</div>
          ) : !hasSession ? (
            <div className="text-center text-sm text-[var(--faint)] py-4">
              הקישור אינו תקין או שפג תוקפו.
              <br />
              בקש מהמנהל הזמנה חדשה.
            </div>
          ) : done ? (
            <div className="text-[var(--signal)] text-sm text-center py-3">הסיסמה נקבעה. מעביר אותך פנימה…</div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <input
                type="password"
                placeholder="סיסמה (8+ תווים)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
                className="border border-[var(--rule)] rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[var(--violet-light)] transition-colors"
                style={fieldStyle}
                dir="ltr"
              />
              <input
                type="password"
                placeholder="אימות סיסמה"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                className="border border-[var(--rule)] rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[var(--violet-light)] transition-colors"
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
                {saving ? "שומר…" : "קבע סיסמה והיכנס"}
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
