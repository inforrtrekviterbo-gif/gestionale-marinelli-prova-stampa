import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gestionale di Marinelli Stefano",
  description: "Cassa, clienti e magazzino per Viterbo e Gran Sasso.",
  manifest: "/manifest.webmanifest",
  applicationName: "Gestionale Stefano Marinelli",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Gestionale SM" },
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/pwa-icon-192.png",
    shortcut: "/pwa-icon-192.png",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#05090c",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="it">
      <body className="antialiased">{children}</body>
    </html>
  );
}
