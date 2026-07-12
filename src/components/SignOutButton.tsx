"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function SignOutButton() {
  const router = useRouter();
  const supabase = createClient();

  return (
    <button
      onClick={async () => {
        await supabase.auth.signOut();
        router.push("/login");
        router.refresh();
      }}
      className="text-xs text-[var(--dim)] border border-[var(--rule)] rounded px-3 py-1.5 hover:bg-[var(--panel3)]"
    >
      התנתקות
    </button>
  );
}
