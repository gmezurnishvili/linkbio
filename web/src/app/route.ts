import { createHash } from "node:crypto";
import { renderHomeDocument } from "@/lib/site/home";
import { publicOrigin } from "@/lib/site/public-origin";

/**
 * GET / — the homepage.
 *
 * There was no route here at all. Every handle under the root resolved and the
 * root itself answered Next's 404, which is the first thing anyone typing the
 * domain would have seen.
 *
 * A route handler rather than a page, for the same three reasons the public
 * profile is one, plus one of its own:
 *
 *   - **The response needs its own `Cache-Control`.** `/` falls on the
 *     distribution's *default* behaviour, which is `pageBehavior` — cached,
 *     keyed on `x-ctx`. A page component cannot set a response header, so the
 *     TTL would be whatever CloudFront defaulted to.
 *   - **It must not inherit `app/layout.tsx`.** That layout sets
 *     `robots: noindex` on everything it wraps and loads two Google webfonts.
 *     Both are right for the dashboard; on the one page that should be indexed
 *     and fast, both are wrong. A route handler renders its own document.
 *   - **Two inline blocks, hashed.** Same contract as `[handle]/route.ts`:
 *     `renderHomeDocument` hands back exactly what it inlined, and the hashes
 *     are computed from those bytes, so a style change cannot ship a page with
 *     its own CSS blocked.
 *   - **The canonical URL is per-request.** It comes from `x-forwarded-host`,
 *     which only exists at request time — hence `force-dynamic`. Prerendered
 *     at build time it would name the function URL, or nothing at all.
 *
 * No edge change was needed: `api/edge/page.js` splits `/` into an empty
 * handle and returns before the key-value store read, so this document is a
 * single cache entry rather than one per context. That is also why the demo on
 * the page reads the visitor in the browser and says so, instead of pretending
 * the edge resolved it.
 */

export const dynamic = "force-dynamic";

/**
 * Ten minutes at the edge, a day of stale-while-revalidate behind it.
 *
 * Deliberately short for a page that changes only on deploy, because nothing
 * in this repo issues a CloudFront invalidation — `npm run deploy` replaces
 * the Lambda and leaves the distribution's cache alone. A profile page does
 * not have this problem: publishing purges it. The homepage has no publish
 * event, so its TTL is the whole mechanism, and ten minutes is the difference
 * between "the new copy is live" and "the new copy is live tomorrow".
 *
 * `stale-while-revalidate` carries the cost: after ten minutes the edge still
 * answers instantly from the stale copy and refreshes behind the visitor, so
 * a short TTL buys freshness without putting a Lambda cold start in anyone's
 * path.
 */
const HOME_CACHE_CONTROL =
  "public, max-age=0, s-maxage=600, stale-while-revalidate=86400";

export async function GET(request: Request) {
  const origin = publicOrigin(request.headers, request.url);
  const page = renderHomeDocument({ origin });

  return new Response(page.html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": HOME_CACHE_CONTROL,
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      /**
       * `default-src 'none'` and two hashes, as on the public profile.
       *
       * Differences from that page's policy, each because this page is not
       * that one:
       *
       *   - `img-src 'self' data:`. There are no remote images here; the one
       *     graphic is an inline SVG and the only fetched image is
       *     `/icon.svg`, the app's own icon. A favicon is fetched under
       *     `img-src`, so `data:` alone would block it — silently, since a
       *     blocked favicon is a missing tab icon and nothing else.
       *   - `form-action 'self'`. The claim field is a real GET form to
       *     `/signup`, so it works with the script disabled — `'none'` would
       *     silently break the one conversion on the page.
       *   - `frame-ancestors 'none'`. A profile allows `'self'` because the
       *     simulator frames it. Nothing frames the homepage.
       *   - no `connect-src`. This page never makes a request after the HTML.
       *
       * The JSON-LD block is unhashed on purpose and for the same reason as on
       * the profile: a `type="application/ld+json"` block is data, never
       * executed, and so never blocked.
       */
      "content-security-policy": [
        "default-src 'none'",
        "base-uri 'none'",
        "img-src 'self' data:",
        `style-src '${sha256(page.style)}'`,
        `script-src '${sha256(page.script)}'`,
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    },
  });
}

/** A CSP hash-source for one inline block, over the exact bytes we emitted. */
function sha256(source: string): string {
  return `sha256-${createHash("sha256").update(source, "utf8").digest("base64")}`;
}
