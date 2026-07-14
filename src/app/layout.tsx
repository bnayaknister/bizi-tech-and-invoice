import type { Metadata } from "next";
import { Heebo } from "next/font/google";
import { DrawerProvider } from "@/components/EntityDrawer";
import "./globals.css";

const heebo = Heebo({
  subsets: ["hebrew", "latin"],
  variable: "--font-heebo",
  weight: ["300", "400", "500", "700", "900"],
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
      <body className={`${heebo.variable} antialiased`}>
        <DrawerProvider>{children}</DrawerProvider>
      </body>
    </html>
  );
}
