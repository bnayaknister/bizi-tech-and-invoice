import type { Metadata } from "next";
import { Heebo, Space_Grotesk } from "next/font/google";
import { DrawerProvider } from "@/components/EntityDrawer";
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
      </body>
    </html>
  );
}
