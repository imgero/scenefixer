import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "firebasestorage.googleapis.com",
      },
      {
        protocol: "https",
        hostname: "storage.googleapis.com",
      },
    ],
  },
  async rewrites() {
    return [
      // Firebase's sign-in handler served from our own domain. With the
      // handler on scenefixer.firebaseapp.com, iPhone Safari's tracking
      // protection breaks the popup handshake and the sign-in never lands.
      // Takes effect once NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN is scenefixer.com
      // and https://scenefixer.com/__/auth/handler is an authorised redirect
      // URI on the Google OAuth client.
      {
        source: "/__/auth/:path*",
        destination: "https://scenefixer.firebaseapp.com/__/auth/:path*",
      },
      {
        source: "/ingest/static/:path*",
        destination: "https://eu-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/array/:path*",
        destination: "https://eu-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://eu.i.posthog.com/:path*",
      },
    ];
  },
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
