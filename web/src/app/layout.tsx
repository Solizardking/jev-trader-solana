import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clawd JEV Trader — SOL-USDC · Phoenix",
  description: "Clawd's TypeSafe Jev watches the Phoenix SOL-USDC book and answers buy or sell every slot.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#9945FF",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* vanilla CoinGecko card stylesheet (vanilla widget, reused as-is) */}
        <link rel="stylesheet" href="/coingecko-card.css" />
        <Script src="/coingecko-card.js" strategy="beforeInteractive" />
      </head>
      <body>{children}</body>
    </html>
  );
}
