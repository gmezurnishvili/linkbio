import type { MetadataRoute } from "next";

/**
 * There was no robots.txt at all, so crawling was undirected: the dashboard
 * sets `robots: noindex` in its own metadata, but nothing said anything about
 * the redirector or the machine-readable identity documents, and a crawler
 * that follows `/r/...` is asking the origin to count a click nobody made.
 *
 * Public profile pages are the thing worth indexing and are deliberately left
 * open. `/api/` is ours.
 */
export default function robots(): MetadataRoute.Robots {
  const origin = process.env.NEXT_PUBLIC_SITE_ORIGIN;
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/app/", "/r/", "/login", "/signup", "/logout"],
    },
    ...(origin ? { host: origin } : {}),
  };
}
