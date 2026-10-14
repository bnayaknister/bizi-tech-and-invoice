"use client";

import { useEffect } from "react";
import { isPerfClientOn, perfStart } from "@/lib/perf/client";

// T35 — the start of "click → productions screen on display". An in-app link
// click happens on whatever page the user is on, so the listener has to live
// in the root layout; ProductionsClient ends the measurement once it has
// painted. Renders nothing, and installs nothing unless
// NEXT_PUBLIC_PERF_TIMING=true.
export default function PerfClickProbe() {
  useEffect(() => {
    if (!isPerfClientOn()) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const path = new URL(a.href, window.location.href).pathname;
      if (path === "/productions" || path.startsWith("/productions/")) perfStart("productions_screen");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}
