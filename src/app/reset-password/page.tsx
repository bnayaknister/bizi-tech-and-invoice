"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const router = useRouter();
  const supabase = createClient();

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("סיסמה חייבת להיות לפחות 8 תווים.");
      return;
    }
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setError("שגיאה בעדכון הסיסמה.");
      return;
    }
    setDone(true);
    setTimeout(() => {
      router.push("/");
      router.refresh();
    }, 1500);
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm border border-[var(--rule)] rounded bg-[var(--panel2)] p-8">
        <h1 className="text-lg font-black mb-6 text-center">קביעת סיסמה חדשה</h1>
        {done ? (
          <div className="text-[var(--signal)] text-sm text-center">
            הסיסמה עודכנה. מעביר אותך פנימה…
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <input
              type="password"
              placeholder="סיסמה חדשה"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="bg-[var(--panel)] border border-[var(--rule)] rounded px-3 py-2 text-sm"
              dir="ltr"
            />
            {error && <div className="text-[var(--peak)] text-xs">{error}</div>}
            <button
              type="submit"
              className="bg-[var(--signal)] text-[#0C1410] font-bold rounded px-3 py-2 text-sm mt-2"
            >
              שמור סיסמה
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
