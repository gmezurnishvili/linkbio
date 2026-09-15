import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/**
 * The dashboard's policy. It is not as tight as the public page's — that one
 * emits two inline blocks it can hash, while this one is a streaming React app
 * whose RSC payload arrives as inline <script> and whose components set inline
 * style attributes. Locking those down needs a per-response nonce, which needs
 * middleware; until then 'unsafe-inline' stays and the value here is in the
 * source restrictions: nothing loads, connects or frames off this origin.
 *
 * Dev is looser because it has to be: webpack's HMR runtime is eval'd and its
 * socket is a websocket to localhost. Shipping either to production would give
 * an injected string somewhere to execute, so they are switched off there.
 */
const DASHBOARD_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // Creator avatars are arbitrary https URLs, and the editor previews them.
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:"
    : "script-src 'self' 'unsafe-inline'",
  isDev ? "connect-src 'self' ws: wss:" : "connect-src 'self'",
].join("; ");

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
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: DASHBOARD_CSP },
          // Not in dev: `next dev` is http, and a stray HSTS entry for
          // localhost would break every other http project on the machine.
          ...(isDev
            ? []
            : [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=63072000; includeSubDomains",
                },
              ]),
        ],
      },
    ];
  },
};

export default config;
