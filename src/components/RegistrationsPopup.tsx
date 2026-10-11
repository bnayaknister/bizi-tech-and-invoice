"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * E17-5 — "יש X הרשמות שממתינות לאישור", for a studio_admin, on every screen.
 * AppHeader mounts it only for a studio_admin; the count route refuses
 * everyone else anyway.
 *
 * WHEN IT OPENS (owner 11.10, revised):
 *   · the first check of the session: when the count is above 0;
 *   · after that: ONLY when the count ROSE since the last check. Same or
 *     lower — it stays closed, so moving between screens never nags.
 * "The last check" is the last count SEEN, not the last one shown: after
 * three are approved and one arrives, 3 → 0 → 1 opens it, because 1 is new.
 *
 * WHEN IT CHECKS — no polling timer. A check happens on a screen change and
 * when the tab comes back into view, at most once a minute
 * (POPUP_RECHECK_MS). An idle tab asks nothing; a working admin is told
 * within a minute of the next click. The count is one head-count query.
 *
 * Memory is sessionStorage (one browser-tab session), mirrored in a module
 * variable so a blocked storage still remembers within the tab.
 */
export const POPUP_KEY = "bizi:registrations-popup";
export const POPUP_RECHECK_MS = 60_000;

export function popupTitle(n: number): string {
  return n === 1 ? "יש הרשמה אחת שממתינה לאישור" : `יש ${n} הרשמות שממתינות לאישור`;
}

/**
 * PURE: given the count seen last time (null = never this session) and the
 * count now — open the window? And what to remember.
 */
export function nextPopupState(lastSeen: number | null, count: number): { show: boolean; seen: number } {
  if (lastSeen === null) return { show: count > 0, seen: count };
  return { show: count > lastSeen, seen: count };
}

/** PURE: is it time to ask the server again? */
export function shouldRecheck(lastAt: number | null, now: number): boolean {
  return lastAt === null || now - lastAt >= POPUP_RECHECK_MS;
}

type Memory = { seen: number | null; at: number | null };
let memory: Memory = { seen: null, at: null };

function readMemory(): Memory {
  try {
    const raw = window.sessionStorage.getItem(POPUP_KEY);
    if (raw) {
      const m = JSON.parse(raw) as Partial<Memory>;
      return { seen: typeof m.seen === "number" ? m.seen : null, at: typeof m.at === "number" ? m.at : null };
    }
  } catch {
    /* storage blocked or an old value: the module copy */
  }
  return memory;
}

function writeMemory(m: Memory) {
  memory = m;
  try {
    window.sessionStorage.setItem(POPUP_KEY, JSON.stringify(m));
  } catch {
    /* storage blocked: the module copy is enough within the tab */
  }
}

export default function RegistrationsPopup() {
  const pathname = usePathname();
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    function check() {
      const m = readMemory();
      const now = Date.now();
      if (!shouldRecheck(m.at, now)) return;
      // marked BEFORE the fetch, so two triggers in the same moment ask once
      writeMemory({ ...m, at: now });
      void fetch("/api/registrations/pending-count", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { count?: number } | null) => {
          if (cancelled || typeof b?.count !== "number") return;
          const next = nextPopupState(readMemory().seen, b.count);
          writeMemory({ seen: next.seen, at: now });
          if (next.show) {
            setCount(b.count);
            setOpen(true);
          }
        })
        .catch(() => {});
    }
    check();
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pathname]);

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
