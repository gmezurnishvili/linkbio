import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: { optimizePackageImports: ["@dnd-kit/sortable"] },
  async headers() {
    return [
      {
        // The dashboard must never be cached at the edge. The public profile
        // sets its own Cache-Control per request (see app/[handle]/route.ts),
        // so it is deliberately absent from this list.
        source: "/app/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default config;
