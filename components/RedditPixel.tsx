"use client";

import Script from "next/script";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/hooks/useAuth";

const PIXEL_ID = "a2_j1n34h17d81u";

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rdt?: (...args: any[]) => void;
  }
}

export default function RedditPixel() {
  const { user, loading } = useAuth();
  const pathname = usePathname();

  // Advanced matching: re-init with email + externalId once auth resolves
  useEffect(() => {
    if (loading || !window.rdt) return;
    if (user?.email) {
      window.rdt("init", PIXEL_ID, {
        email: user.email,
        externalId: user.uid,
      });
    }
  }, [loading, user]);

  // Track PageVisit on every SPA route change
  useEffect(() => {
    if (!window.rdt) return;
    window.rdt("track", "PageVisit");
  }, [pathname]);

  return (
    <Script
      id="reddit-pixel"
      strategy="afterInteractive"
      dangerouslySetInnerHTML={{
        __html: `
!function(w,d){if(!w.rdt){var p=w.rdt=function(){p.sendEvent?p.sendEvent.apply(p,arguments):p.callQueue.push(arguments)};p.callQueue=[];var t=d.createElement("script");t.src="https://www.redditstatic.com/ads/pixel.js?pixel_id=${PIXEL_ID}",t.async=!0;var s=d.getElementsByTagName("script")[0];s.parentNode.insertBefore(t,s)}}(window,document);
rdt('init','${PIXEL_ID}');
rdt('track','PageVisit');
        `.trim(),
      }}
    />
  );
}
