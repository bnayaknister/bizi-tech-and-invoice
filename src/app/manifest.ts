import type { MetadataRoute } from "next";

// Web app manifest — lets the team "Add to Home Screen" and get a standalone,
// chrome-less app icon instead of a browser tab (owner 2026-07-22; no app
// stores). Next serves this at /manifest.webmanifest and links it automatically.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BiziPodclub Manage",
    short_name: "Bizi",
    description: "מערכת ענן לניהול בית הפודקאסטים",
    start_url: "/",
    display: "standalone",
    background_color: "#080611",
    theme_color: "#8B5CF6",
    dir: "rtl",
    lang: "he",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
