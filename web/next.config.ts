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
  /**
   * The deployable artifact is a Lambda, not a `next start` on a box, so the
   * build has to trace its own dependencies: `standalone` emits
   * `.next/standalone/server.js` plus only the files that are actually reached.
   * `scripts/package-lambda.mjs` assembles that into `dist/`, which is the
   * directory `api/infra/stack.ts` uploads.
   */
  output: "standalone",
  /**
   * Nothing in this app uses `next/image` — the public page is hand-rendered
   * HTML and an avatar is a plain `<img>` to an arbitrary https URL. Leaving
   * the optimizer on made the build trace `sharp` into the bundle: 37 MB of
   * native binaries, for a platform chosen by whichever machine ran the build.
   * The Lambda is arm64, so a build on an x64 laptop or a Windows desktop
   * traced binaries that could never load there — a latent runtime failure on a
   * route nothing calls.
   */
  images: { unoptimized: true },
  /**
   * Where dependency tracing considers the project to start.
   *
   * Next infers this by walking up looking for lockfiles and package.json
   * files, and it walks past the repo: a stray `package.json` in the user's
   * home directory is enough to make the home directory the root. The
   * standalone output is then written to `.next/standalone/<path-from-root>/`,
   * so `server.js` lands somewhere like
   * `.next/standalone/OneDrive/Desktop/linkbio/web/server.js` instead of
   * `.next/standalone/server.js` — and the packaging script, the Lambda handler
   * and `lambda.Code.fromAsset` all expect the latter.
   *
   * This was not hypothetical: the first build on the development machine put
   * it exactly there. Pinning the root makes the layout identical on every
   * machine, which is the whole point of building a deployable artifact.
   *
   * `process.cwd()` rather than `__dirname`/`import.meta.url` because a
   * TypeScript config is loaded in a way that makes only one of those two
   * available and which one depends on the Next version. Every path that builds
   * this app runs from `web/`.
   */
  outputFileTracingRoot: process.cwd(),
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
