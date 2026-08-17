import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/job/", "/jobs"],
    },
    sitemap: "https://scenefixer.com/sitemap.xml",
  };
}
