import type { Metadata, Viewport } from "next";
import { Heebo, Space_Grotesk } from "next/font/google";
import { DrawerProvider } from "@/components/EntityDrawer";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import "./globals.css";

const heebo = Heebo({
  subsets: ["hebrew", "latin"],
  variable: "--font-heebo",
  weight: ["300", "400", "500", "700", "900"],
});

// Numbers + Latin headings are the instrument (DESIGN.md §1): every number
// (money, days, counts, dates) and the logo wordmark render in Space
// Grotesk, geometric, tabular, calibrated, always LTR.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-geo",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "BiziPodclub Manage",
  description: "מערכת ענן לניהול בית הפודקאסטים",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  // iOS standalone: full-screen chrome-less "app" when added to the home screen
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "BiziPodclub Manage" },
};

// dark app → dark browser chrome; disable tap-zoom-out surprises but keep
// pinch-zoom for accessibility
export const viewport: Viewport = {
  themeColor: "#080611",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="he" dir="rtl">
      <body className={`${heebo.variable} ${spaceGrotesk.variable} antialiased`}>
        <DrawerProvider>{children}</DrawerProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
