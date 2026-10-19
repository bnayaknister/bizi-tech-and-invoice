"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { roleLabel } from "@/lib/roles";

// U1-6: the user menu in the header, for every role — name, email, role,
// "החלפת סיסמה", "התנתקות" (moved here from the header's own button).
// Click to open (no hover): it holds a destructive action, and on touch a
// hover-open fights the tap. The panel hangs from the trigger's end edge
// (`end-0`: the left in RTL) and is capped to the viewport on a phone.
export default function UserMenu({
  name,
  email,
  role,
}: {
  name: string | null;
  email: string | null;
  role: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const display = name && name !== email ? name : email ?? "";
  const initial = (display.trim()[0] ?? "?").toUpperCase();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onOutside(e: Event) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("touchstart", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("touchstart", onOutside);
    };
  }, [open]);

  async function signOut() {
    setSigningOut(true);
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 text-xs text-[var(--dim)] border border-[var(--rule)] rounded-full ps-1 pe-1 sm:pe-3 py-1 hover:bg-[var(--panel3)] transition-colors"
      >
        <span
          className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold text-white"
          style={{ background: "linear-gradient(135deg, var(--violet), var(--violet-dk))" }}
        >
          {initial}
        </span>
        <span className="hidden sm:inline max-w-[160px] truncate">{display}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute end-0 top-full mt-2 w-64 max-w-[calc(100vw-2rem)] border border-[var(--rule2)] rounded-2xl p-2 shadow-2xl"
          style={{ background: "rgba(15,13,28,0.96)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
        >
          <div className="px-3 py-2 border-b border-[var(--rule)] mb-1">
            <div className="text-sm font-bold truncate">{display}</div>
            {email && (
              <div className="text-[11px] text-[var(--faint)] truncate" dir="ltr" style={{ textAlign: "right" }}>
                {email}
              </div>
            )}
            <div className="text-[11px] text-[var(--violet-light)] mt-0.5">{roleLabel(role)}</div>
          </div>
          <Link
            href="/account/password"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm rounded-xl hover:bg-[var(--panel3)]"
          >
            החלפת סיסמה
          </Link>
          <button
            role="menuitem"
            onClick={signOut}
            disabled={signingOut}
            className="block w-full text-start px-3 py-2 text-sm rounded-xl hover:bg-[var(--panel3)] disabled:opacity-50"
          >
            {signingOut ? "מתבצעת התנתקות…" : "התנתקות"}
          </button>
        </div>
      )}
    </div>
  );
}
