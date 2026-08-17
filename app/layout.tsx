import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import Script from "next/script";
import "./globals.css";
import Header from "@/components/Header";
import RedditPixel from "@/components/RedditPixel";

export const metadata: Metadata = {
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  metadataBase: new URL("https://scenefixer.com"),
  alternates: {
    canonical: "/",
  },
  title: "Scene Fixer — Finish your AI video",
  description:
    "Drop clips from Runway, Veo, or Kling. Scene Fixer matches lighting, locks wardrobe, fixes atmosphere, and unifies style across your AI video — without regenerating.",
  openGraph: {
    title: "Scene Fixer — The finish layer for AI video",
    description:
      "Drop clips from any AI video model. Match shots, fix wardrobe, adjust atmosphere, and unify style — without regenerating or reshooting.",
    url: "https://scenefixer.com",
    siteName: "Scene Fixer",
    type: "website",
    images: [{ url: "/opengraph-image", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Scene Fixer — Finish your AI video",
    description:
      "Drop clips from Runway, Veo, or Kling. Match shots, fix atmosphere, lock wardrobe — without regenerating.",
    images: ["/opengraph-image"],
  },
  keywords: [
    "AI video finishing",
    "AI video editing",
    "match shots AI video",
    "Runway Veo Kling fix",
    "video continuity",
    "AI clip consistency",
    "Runway Aleph",
    "AI video style unify",
    "video post-production AI",
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={GeistSans.variable}>
      <head>
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-M4J7FF60GN"
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-M4J7FF60GN');
          `}
        </Script>
      </head>
      <body className={`min-h-screen antialiased ${GeistSans.className}`}>
        <Header />
        {children}
        <RedditPixel />
      </body>
    </html>
  );
}
