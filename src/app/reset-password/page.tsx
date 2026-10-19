"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import PasswordForm from "@/components/PasswordForm";
import { PASSWORD_MESSAGES } from "@/lib/auth/passwordErrors";

// Where the invite / recovery email link lands (via /auth/confirm, U1-2) with a
// fresh session. No current password here: Supabase exempts a recovery session
// and a user who has no password yet (U1-7). Without a session — an old link,
// or the URL typed by hand — it says so on load instead of failing on submit.
export default function ResetPasswordPage() {
  const router = useRouter();
  const [state, setState] = useState<"loading" | "no_session" | "form" | "done">("loading");

  useEffect(() => {
    createClient()
      .auth.getUser()
      .then(({ data }) => setState(data.user ? "form" : "no_session"));
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm border border-[var(--rule)] rounded bg-[var(--panel2)] p-8">
        <h1 className="text-lg font-black mb-6 text-center">קביעת סיסמה חדשה</h1>
        {state === "loading" ? (
          <div className="text-center text-sm text-[var(--faint)]">טוען…</div>
        ) : state === "no_session" ? (
          <div className="text-center text-sm text-[var(--faint)]">
            <p className="mb-4">{PASSWORD_MESSAGES.no_session}</p>
            <Link href="/login" className="text-[var(--violet-light)] underline">
              לדף ההתחברות
            </Link>
          </div>
        ) : state === "done" ? (
          <div className="text-[var(--signal)] text-sm text-center">הסיסמה נשמרה. מעביר אותך פנימה…</div>
        ) : (
          <PasswordForm
            withCurrent={false}
            onSuccess={() => {
              setState("done");
              setTimeout(() => {
                router.push("/");
                router.refresh();
              }, 1500);
            }}
          />
        )}
      </div>
    </main>
  );
}
