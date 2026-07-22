"use client";

import { useEffect } from "react";

// Registers the static-asset service worker (public/sw.js) in production only —
// in dev a SW just fights Next's HMR. Failures are swallowed: the SW is a
// progressive enhancement, never a hard dependency.
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const register = () => navigator.serviceWorker.register("/sw.js").catch(() => {});
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
