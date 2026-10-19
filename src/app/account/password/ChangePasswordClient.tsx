"use client";

import { useState } from "react";
import PasswordForm from "@/components/PasswordForm";

export default function ChangePasswordClient() {
  const [done, setDone] = useState(false);

  return (
    <div className="w-full max-w-sm border border-[var(--rule)] rounded-2xl bg-[var(--panel2)] p-6">
      <h1 className="text-lg font-black mb-1">החלפת סיסמה</h1>
      <p className="text-[11px] text-[var(--faint)] mb-5">אחרי ההחלפה, החיבור במכשירים אחרים ינותק. כאן החיבור נשאר.</p>
      {done && (
        <div className="text-[var(--signal)] text-sm mb-4 border border-[var(--signal)] rounded-xl px-3 py-2">הסיסמה הוחלפה.</div>
      )}
      <PasswordForm withCurrent onSuccess={() => setDone(true)} />
    </div>
  );
}
