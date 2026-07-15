import type { Metadata } from "next";
import { Heebo, Roboto_Mono } from "next/font/google";
import { DrawerProvider } from "@/components/EntityDrawer";
import "./globals.css";

const heebo = Heebo({
  subsets: ["hebrew", "latin"],
  variable: "--font-heebo",
  weight: ["300", "400", "500", "700", "900"],
});

// Numbers are the instrument (DESIGN.md §3): money, days, counts render in
// Roboto Mono, tabular, calibrated.
const robotoMono = Roboto_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: "BIZI STUDIO · PODCLUB",
  description: "מערכת ענן לניהול בית הפודקאסטים",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="he" dir="rtl">
      <body className={`${heebo.variable} ${robotoMono.variable} antialiased`}>
        <DrawerProvider>{children}</DrawerProvider>
      </body>
    </html>
  );
}
