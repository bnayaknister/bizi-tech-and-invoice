"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * E17-5 — "יש X הרשמות שממתינות לאישור", for a studio_admin, on every screen,
 * ONCE PER SESSION (owner 11.10): not on every navigation. AppHeader mounts it
 * only for a studio_admin; the count route refuses everyone else anyway.
 *
 * "Once" is sessionStorage — one browser tab session. It is marked when the
 * count is FETCHED, not when the window is closed, so moving between screens
 * never asks again, and a count of zero does not come back to ask later in
 * the same session either. A blocked storage simply means it may show again.
 */
export const POPUP_KEY = "bizi:registrations-popup";

export function popupTitle(n: number): string {
  return n === 1 ? "יש הרשמה אחת שממתינה לאישור" : `יש ${n} הרשמות שממתינות לאישור`;
}

/** PURE: show the window? */
export function shouldShowPopup(alreadyAsked: boolean, count: number | null): boolean {
  return !alreadyAsked && (count ?? 0) > 0;
}

export default function RegistrationsPopup() {
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let asked = false;
    try {
      asked = window.sessionStorage.getItem(POPUP_KEY) === "1";
      if (!asked) window.sessionStorage.setItem(POPUP_KEY, "1");
    } catch {
      /* storage blocked: ask anyway */
    }
    if (asked) return;
    void fetch("/api/registrations/pending-count", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { count?: number } | null) => {
        const n = b?.count ?? 0;
        setCount(n);
        setOpen(shouldShowPopup(false, n));
      })
      .catch(() => {});
  }, []);

  if (!open || !count) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div dir="rtl" className="w-full max-w-sm rounded-2xl border border-[var(--rule)] bg-[var(--panel)] p-5 space-y-4 text-center">
        <div className="text-2xl">🆕</div>
        <p className="font-bold">{popupTitle(count)}</p>
        <div className="flex gap-2 justify-center">
          <Link
            href="/clients?tab=pending"
            onClick={() => setOpen(false)}
            className="rounded-xl px-4 py-2 text-sm font-bold"
            style={{ background: "rgba(139,92,246,0.85)", color: "#fff" }}
          >
            למסך הלקוחות
          </Link>
          <button onClick={() => setOpen(false)} className="rounded-xl px-4 py-2 text-sm border border-[var(--rule)]">
            אחר כך
          </button>
        </div>
      </div>
    </div>
  );
}
