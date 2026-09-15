import type { Metadata } from "next";
import { IBM_Plex_Mono, Instrument_Sans } from "next/font/google";
import "./globals.css";

/**
 * This layout wraps the dashboard and sign-in only. The public profile is a
 * route handler and renders its own document, so nothing here reaches a
 * visitor's page — which is the point: the creator-facing app can carry a
 * webfont and a design system without putting either in a visitor's LCP path.
 */

const instrument = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
  display: "swap",
});

/* Mono is reserved for things that really are machine values: fractional ranks,
   rule expressions, TTLs, cache keys. It is a signal, not a label style. */
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Routing desk",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${instrument.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
