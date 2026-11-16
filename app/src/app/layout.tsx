import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SAPU — Silent Automated Purge Unit",
  description:
    "Fund a burner wallet. It empties itself before anyone can watch it fill. Reactive Omni sweeps stealth-address deposits to cold storage with no gas in the burner.",
  applicationName: "SAPU",
  keywords: ["privacy", "ERC-5564", "stealth address", "Reactive Network", "Base", "burner wallet"],
  authors: [{ name: "SAPU" }],
  openGraph: {
    title: "SAPU — Silent Automated Purge Unit",
    description: "Fund a burner wallet. It empties itself before anyone can watch it fill.",
    type: "website",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#080C14",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
